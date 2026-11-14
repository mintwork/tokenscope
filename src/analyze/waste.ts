import type { Pricer } from '../pricing/index.js';
import type { ApiCall, Session, ToolCall } from '../types.js';
import { CHARS_PER_TOKEN, estTokens } from '../types.js';

export type FindingKind = 'loop' | 'repeat' | 'reread' | 'huge-output' | 'cache-miss';
export type Severity = 'high' | 'medium' | 'low';

export interface Finding {
  kind: FindingKind;
  severity: Severity;
  sessionId: string;
  /** Subagent id when the finding is inside a subagent context. */
  agentId?: string;
  project: string;
  title: string;
  detail: string;
  /** Number of occurrences (calls, reads, misses...). */
  count: number;
  /** Estimated tokens that could have been avoided. */
  tokens: number;
  /** Estimated avoidable cost (USD). */
  cost: number;
}

export interface WasteOptions {
  /** Tool output size (est. tokens) considered "huge". */
  hugeOutputTokens: number;
  /** Identical calls within one context before we flag a repeat. */
  repeatThreshold: number;
  /** Consecutive identical calls that count as a loop. */
  loopThreshold: number;
  /** Redundant (unchanged) re-reads of the same file before we flag it. */
  rereadThreshold: number;
  /** Minimum tokens re-written to cache for a call to count as a miss. */
  cacheMissMinTokens: number;
}

export const defaultWasteOptions: WasteOptions = {
  hugeOutputTokens: 10_000,
  repeatThreshold: 3,
  loopThreshold: 3,
  rereadThreshold: 2,
  cacheMissMinTokens: 5_000,
};

const POLLING_TOOLS = new Set(['TaskList', 'TaskOutput', 'BashOutput', 'TaskGet', 'Monitor']);

interface Ctx {
  session: Session;
  root: Session;
  calls: ApiCall[];
}

/** Each session and every (nested) subagent is its own model context. */
export function contexts(root: Session): Ctx[] {
  const out: Ctx[] = [];
  const rec = (s: Session) => {
    const calls = s.turns.flatMap((t) => t.calls).sort((a, b) => a.timestamp - b.timestamp);
    out.push({ session: s, root, calls });
    for (const c of calls) for (const tc of c.toolCalls) if (tc.subagent) rec(tc.subagent);
  };
  rec(root);
  return out;
}

function severityFor(cost: number, floor: Severity = 'low'): Severity {
  const s: Severity = cost >= 5 ? 'high' : cost >= 0.5 ? 'medium' : 'low';
  const rank = { low: 0, medium: 1, high: 2 };
  return rank[s] >= rank[floor] ? s : floor;
}

const fmtTok = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));
const short = (p: string, n = 60) => (p.length > n ? '…' + p.slice(-(n - 1)) : p);

export function detectWaste(sessions: Session[], pricer: Pricer, opts: Partial<WasteOptions> = {}): Finding[] {
  const o = { ...defaultWasteOptions, ...opts };
  const findings: Finding[] = [];

  for (const root of sessions) {
    for (const ctx of contexts(root)) {
      const base = {
        sessionId: root.id,
        agentId: ctx.session.isSubagent ? ctx.session.id : undefined,
        project: root.project,
      };
      const where = ctx.session.isSubagent ? ` (subagent: ${ctx.session.agentDescription ?? ctx.session.id})` : '';
      // Cost of adding `tokens` of content to this context at `call`: written to the cache once,
      // then carried (cache-read) by every later request in the same context.
      const pos = new Map(ctx.calls.map((c, i) => [c, i]));
      const inputCost = (tokens: number, call: ApiCall) => {
        const r = pricer.rates(call.model);
        if (!r) return 0;
        const later = ctx.calls.length - 1 - (pos.get(call) ?? ctx.calls.length - 1);
        return (tokens * (Math.max(r.cacheWrite5m, r.input) + r.cacheRead * later)) / 1e6;
      };
      const ordered: Array<{ tc: ToolCall; call: ApiCall }> = [];
      for (const call of ctx.calls) for (const tc of call.toolCalls) ordered.push({ tc, call });

      // --- loops: consecutive identical calls -------------------------------
      const loopedKeys = new Set<string>();
      // identity = same input AND same output: re-running `npm test` after an edit is fine,
      // getting the identical answer back again and again is not.
      const ident = (tc: ToolCall) => tc.key + '#' + (tc.resultHash ?? '');
      for (let i = 0; i < ordered.length; ) {
        let j = i + 1;
        while (j < ordered.length && ident(ordered[j].tc) === ident(ordered[i].tc)) j++;
        const run = j - i;
        // file reads are covered by the re-read detector, polling tools are expected to repeat
        if (run >= o.loopThreshold && !POLLING_TOOLS.has(ordered[i].tc.name) && ordered[i].tc.fileOp !== 'read') {
          const { tc, call } = ordered[i];
          loopedKeys.add(ident(tc));
          const wastedCalls = ordered.slice(i + 1, j);
          const tokens = wastedCalls.reduce((n, x) => n + estTokens(x.tc.resultChars) + x.call.usage.output, 0);
          // each wasted iteration is a full model round trip
          const cost = wastedCalls.reduce((n, x) => n + x.call.cost / Math.max(1, x.call.toolCalls.length), 0);
          findings.push({
            ...base,
            kind: 'loop',
            severity: severityFor(cost, 'medium'),
            title: `${tc.name} called ${run}× in a row, same input & same result${where}`,
            detail: `${tc.name}(${tc.target ?? '…'}) - the agent repeated the exact same call; ${run - 1} round trips were likely unnecessary.`,
            count: run,
            tokens,
            cost: cost || inputCost(tokens, call),
          });
        }
        i = j;
      }

      // --- repeated identical calls (non-consecutive) ------------------------
      const byKey = new Map<string, Array<{ tc: ToolCall; call: ApiCall }>>();
      for (const x of ordered) {
        if (x.tc.fileOp === 'read' || loopedKeys.has(ident(x.tc)) || POLLING_TOOLS.has(x.tc.name)) continue;
        const arr = byKey.get(ident(x.tc)) ?? [];
        arr.push(x);
        byKey.set(ident(x.tc), arr);
      }
      for (const arr of byKey.values()) {
        if (arr.length < o.repeatThreshold) continue;
        const { tc } = arr[0];
        const tokens = arr.slice(1).reduce((n, x) => n + estTokens(x.tc.resultChars), 0);
        const cost = arr.slice(1).reduce((n, x) => n + inputCost(estTokens(x.tc.resultChars), x.call), 0);
        findings.push({
          ...base,
          kind: 'repeat',
          severity: severityFor(cost),
          title: `${tc.name} repeated ${arr.length}× with the same result${where}`,
          detail: `${tc.name}(${tc.target ?? '…'}) returned ~${(tokens / (arr.length - 1) || 0).toFixed(0)} tokens each time.`,
          count: arr.length,
          tokens,
          cost,
        });
      }

      // --- redundant file re-reads (same file+range, no edit in between) -----
      const lastRead = new Map<string, number>(); // read key -> version
      const version = new Map<string, number>(); // file -> edit counter
      const perFile = new Map<string, { reads: number; redundant: number; chars: number; cost: number }>();
      for (const { tc, call } of ordered) {
        if (!tc.file) continue;
        const v = version.get(tc.file) ?? 0;
        if (tc.fileOp === 'edit') {
          version.set(tc.file, v + 1);
          continue;
        }
        const st = perFile.get(tc.file) ?? { reads: 0, redundant: 0, chars: 0, cost: 0 };
        st.reads++;
        if (lastRead.get(tc.key) === v) {
          st.redundant++;
          st.chars += tc.resultChars;
          st.cost += inputCost(estTokens(tc.resultChars), call);
        }
        lastRead.set(tc.key, v);
        perFile.set(tc.file, st);
      }
      for (const [file, st] of perFile) {
        if (st.redundant < o.rereadThreshold) continue;
        const tokens = Math.round(st.chars / CHARS_PER_TOKEN);
        const cost = st.cost;
        findings.push({
          ...base,
          kind: 'reread',
          severity: severityFor(cost),
          title: `${short(file)} read ${st.reads}× (${st.redundant} unchanged re-reads)${where}`,
          detail: `The file was re-read without being modified in between. Keeping a summary in context, or reading a narrower range, avoids ~${tokens.toLocaleString('en-US')} tokens.`,
          count: st.redundant,
          tokens,
          cost,
        });
      }

      // --- huge tool outputs -------------------------------------------------
      for (const { tc, call } of ordered) {
        const tokens = estTokens(tc.resultChars);
        if (tokens < o.hugeOutputTokens) continue;
        const cost = inputCost(tokens, call);
        findings.push({
          ...base,
          kind: 'huge-output',
          severity: severityFor(cost, tokens >= o.hugeOutputTokens * 5 ? 'medium' : 'low'),
          title: `${tc.name} returned ~${fmtTok(tokens)} tokens${where}`,
          detail: `${tc.name}(${tc.target ?? '…'}) dumped a very large result into context. Every later request in this context pays to carry it (cache reads), and it hastens compaction. Filter with head/grep/limit.`,
          count: 1,
          tokens,
          cost,
        });
      }

      // --- cache misses ------------------------------------------------------
      let misses = 0;
      let missTokens = 0;
      let missCost = 0;
      const causes = { idle: 0, model: 0, other: 0 };
      let worstGapMin = 0;
      for (let i = 1; i < ctx.calls.length; i++) {
        const prev = ctx.calls[i - 1];
        const cur = ctx.calls[i];
        const write = cur.usage.cacheWrite5m + cur.usage.cacheWrite1h;
        const prevCtx = prev.usage.input + prev.usage.cacheRead + prev.usage.cacheWrite5m + prev.usage.cacheWrite1h;
        if (write < o.cacheMissMinTokens || write < prevCtx * 0.5) continue;
        misses++;
        missTokens += write;
        const r = pricer.rates(cur.model, write + cur.usage.cacheRead);
        if (r) {
          const writeRate = (cur.usage.cacheWrite1h > cur.usage.cacheWrite5m ? r.cacheWrite1h : r.cacheWrite5m);
          missCost += (write * (writeRate - r.cacheRead)) / 1e6;
        }
        const gapMin = (cur.timestamp - prev.timestamp) / 60000;
        const ttlMin = cur.usage.cacheWrite1h > cur.usage.cacheWrite5m ? 60 : 5;
        if (gapMin > ttlMin) {
          causes.idle++;
          worstGapMin = Math.max(worstGapMin, gapMin);
        } else if (prev.model !== cur.model) causes.model++;
        else causes.other++;
      }
      if (misses > 0 && missCost > 0.01) {
        const why: string[] = [];
        if (causes.idle) why.push(`${causes.idle} after idle gaps longer than the cache TTL (longest ${Math.round(worstGapMin)} min)`);
        if (causes.model) why.push(`${causes.model} after a model switch`);
        if (causes.other) why.push(`${causes.other} with no idle gap - the prompt prefix changed (edited history, tool list, system prompt, compaction)`);
        findings.push({
          ...base,
          kind: 'cache-miss',
          severity: severityFor(missCost),
          title: `${misses} prompt-cache rebuild${misses > 1 ? 's' : ''} (${fmtTok(missTokens)} tokens re-written)${where}`,
          detail: `Context was re-sent at cache-write price instead of cache-read price: ${why.join('; ')}.${causes.idle ? ' Resuming a long session after a break re-writes the whole context - /compact or start fresh before stepping away.' : ''}`,
          count: misses,
          tokens: missTokens,
          cost: missCost,
        });
      }
    }
  }
  return findings.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
}
