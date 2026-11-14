import type { Pricer } from '../pricing/index.js';
import type { ApiCall, Capabilities, Session, SourceId, ToolCall } from '../types.js';
import { CHARS_PER_TOKEN, estTokens } from '../types.js';

export type FindingKind = 'loop' | 'repeat' | 'reread' | 'huge-output' | 'cache-miss';
export type Severity = 'high' | 'medium' | 'low';
/**
 * `avoidable`: the same work was clearly redone (identical calls/results, unchanged re-reads).
 * `likely-avoidable`: usually waste, but there can be good reasons (you took a break, the
 * agent compacted, the big output was actually needed).
 */
export type Certainty = 'avoidable' | 'likely-avoidable';

export const ALL_KINDS: FindingKind[] = ['cache-miss', 'loop', 'repeat', 'reread', 'huge-output'];

export const KIND_LABEL: Record<FindingKind, string> = {
  'cache-miss': 'Cache rebuilds',
  loop: 'Loops',
  repeat: 'Repeated calls',
  reread: 'Unchanged re-reads',
  'huge-output': 'Huge tool outputs',
};

/** Data each detector needs. A detector is skipped (and reported as unavailable) otherwise. */
export const DETECTOR_NEEDS: Record<FindingKind, Array<keyof Capabilities>> = {
  'cache-miss': ['perRequestTokens', 'cacheReads', 'timestamps'],
  loop: ['toolCalls', 'toolOutputs'],
  repeat: ['toolCalls', 'toolOutputs'],
  reread: ['toolCalls', 'filePaths', 'toolOutputs'],
  'huge-output': ['toolCalls', 'toolOutputs'],
};

export const CAP_LABEL: Record<keyof Capabilities, string> = {
  perRequestTokens: 'per-request token usage',
  cacheReads: 'cache token counts',
  cacheWrites: 'cache-write token counts',
  toolCalls: 'tool calls',
  toolOutputs: 'tool output',
  filePaths: 'file paths',
  timestamps: 'per-request timestamps',
};

export function detectorAvailable(kind: FindingKind, caps: Capabilities): boolean {
  return DETECTOR_NEEDS[kind].every((k) => caps[k]);
}

export function missingFor(kind: FindingKind, caps: Capabilities): string[] {
  return DETECTOR_NEEDS[kind].filter((k) => !caps[k]).map((k) => CAP_LABEL[k]);
}

/** The project-instructions file each agent reads, for tips. */
const MEMORY_FILE: Partial<Record<SourceId, string>> = {
  'claude-code': 'CLAUDE.md',
  codex: 'AGENTS.md',
  'gemini-cli': 'GEMINI.md',
  'qwen-code': 'QWEN.md',
  opencode: 'AGENTS.md',
  'kilo-cli': 'AGENTS.md',
  cline: '.clinerules',
  'roo-code': '.roo/rules',
  'kilo-code': '.kilocode/rules',
  'copilot-cli': '.github/copilot-instructions.md',
  droid: 'AGENTS.md',
  amp: 'AGENTS.md',
};
const memFile = (s: SourceId) => MEMORY_FILE[s] ?? 'AGENTS.md';

/**
 * Why a prompt cache was rebuilt:
 *  - pause:     the cache expired while you read / thought (gap 5-60 min after the agent's reply)
 *  - tool-wait: the cache expired while the agent waited on a long tool call
 *  - prefix:    no idle gap - the prompt prefix changed (instructions edited, tools toggled, compaction)
 *  - model:     a model switch (caches are per model)
 * Gaps longer than an hour are beyond any cache TTL and are reported as unavoidable, not waste.
 */
export type CacheCause = 'pause' | 'tool-wait' | 'model' | 'prefix';

/** One-line "how to avoid this" for each finding type. */
export function tipFor(kind: FindingKind, source: SourceId, cause?: CacheCause): string {
  const mem = memFile(source);
  switch (kind) {
    case 'cache-miss':
      if (cause === 'pause')
        return source === 'claude-code'
          ? 'Use the 1-hour cache TTL for long interactive sessions: "promptCacheTtl": "1h" in ~/.claude/settings.json (or ENABLE_PROMPT_CACHING_1H=1). Don\'t /clear - you would lose the context and pay to rebuild it anyway.'
          : 'Use a 1-hour prompt-cache TTL if your agent/provider supports it. Don\'t clear the session - rebuilding the context costs about the same.';
      if (cause === 'tool-wait')
        return source === 'claude-code'
          ? 'Have long commands run in the background (ask Claude to use run_in_background; manage them with /tasks) so the conversation keeps the cache warm, or set "promptCacheTtl": "1h".'
          : 'Run long commands in the background so the agent keeps working while they finish, or use a 1-hour prompt-cache TTL if supported.';
      if (cause === 'model') return 'Stick to one model per session - switching models throws the prompt cache away.';
      return `Avoid changing the prompt prefix mid-session (editing ${mem}, toggling MCP servers/tools, switching modes); compaction also forces one rebuild.`;
    case 'loop':
      return `Interrupt as soon as the same result comes back twice, and add a rule to ${mem}: "if a command fails the same way twice, stop and ask".`;
    case 'repeat':
      return `Same call, same answer: tell the agent to reuse earlier results, or note slow-changing facts (versions, layout, commands) in ${mem}.`;
    case 'reread':
      return `Put the key facts about this file in ${mem} (or a short notes file), or ask for a specific line range instead of re-reading the whole file.`;
    case 'huge-output':
      return `Filter big outputs (head, tail, grep, --limit) and add a rule to ${mem} like "never cat logs or lockfiles; grep them".`;
  }
}

export interface Finding {
  kind: FindingKind;
  severity: Severity;
  certainty: Certainty;
  source: SourceId;
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
  /** One-line advice on how to avoid it next time. */
  tip: string;
  /** For cache rebuilds: what triggered them. */
  cause?: CacheCause;
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

const usd = (n: number) => (n < 0.01 ? '<$0.01' : '$' + n.toFixed(2));
const fmtTok = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));
const short = (p: string, n = 60) => (p.length > n ? '…' + p.slice(-(n - 1)) : p);

/** Side statistics that are informative but are NOT waste. */
export interface WasteStats {
  /** Cache rebuilds after gaps longer than any cache TTL (or on providers without a TTL setting). */
  unavoidableRebuilds: number;
  unavoidableTokens: number;
  /** What those rebuilds cost above cache-read price - shown for context only. */
  unavoidableCost: number;
  /** Net effect of a 1h TTL on every main conversation (positive = saving), incl. sessions that only pay the premium. */
  ttlGlobalNet: number;
}

export function detectWaste(sessions: Session[], pricer: Pricer, opts: Partial<WasteOptions> = {}, stats?: WasteStats): Finding[] {
  const o = { ...defaultWasteOptions, ...opts };
  const findings: Finding[] = [];

  for (const root of sessions) {
    const caps = root.caps;
    const can = (k: FindingKind) => detectorAvailable(k, caps);
    for (const ctx of contexts(root)) {
      const base = {
        source: root.source,
        sessionId: root.id,
        agentId: ctx.session.isSubagent ? ctx.session.id : undefined,
        project: root.project,
      };
      const push = (f: Omit<Finding, keyof typeof base | 'tip'> & { tip?: string }) =>
        findings.push({ ...base, ...f, tip: f.tip ?? tipFor(f.kind, root.source, f.cause) });
      const where = ctx.session.isSubagent ? ` (subagent: ${ctx.session.agentDescription ?? ctx.session.id})` : '';
      // Cost of adding `tokens` of content to this context at `call`: written to the cache once
      // (or sent as fresh input), then carried by every later request in the same context.
      const pos = new Map(ctx.calls.map((c, i) => [c, i]));
      const inputCost = (tokens: number, call: ApiCall) => {
        const r = pricer.rates(call.model);
        if (!r) return 0;
        const later = ctx.calls.length - 1 - (pos.get(call) ?? ctx.calls.length - 1);
        const first = caps.cacheWrites ? Math.max(r.cacheWrite5m, r.input) : r.input;
        const carry = caps.cacheReads ? r.cacheRead : r.input;
        return (tokens * (first + carry * later)) / 1e6;
      };
      const ordered: Array<{ tc: ToolCall; call: ApiCall }> = [];
      for (const call of ctx.calls) for (const tc of call.toolCalls) ordered.push({ tc, call });

      // --- loops: consecutive identical calls -------------------------------
      const loopedKeys = new Set<string>();
      // identity = same input AND same output: re-running `npm test` after an edit is fine,
      // getting the identical answer back again and again is not.
      const ident = (tc: ToolCall) => tc.key + '#' + (tc.resultHash ?? '');
      if (can('loop')) {
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
            push({
              kind: 'loop',
              certainty: 'avoidable',
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
      }

      // --- repeated identical calls (non-consecutive) ------------------------
      if (can('repeat')) {
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
          push({
            kind: 'repeat',
            certainty: 'avoidable',
            severity: severityFor(cost),
            title: `${tc.name} repeated ${arr.length}× with the same result${where}`,
            detail: `${tc.name}(${tc.target ?? '…'}) returned ~${(tokens / (arr.length - 1) || 0).toFixed(0)} tokens each time.`,
            count: arr.length,
            tokens,
            cost,
          });
        }
      }

      // --- redundant file re-reads (same file+range, no edit in between) -----
      if (can('reread')) {
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
          push({
            kind: 'reread',
            certainty: 'avoidable',
            severity: severityFor(st.cost),
            title: `${short(file)} read ${st.reads}× (${st.redundant} unchanged re-reads)${where}`,
            detail: `The file was re-read without being modified in between - ~${tokens.toLocaleString('en-US')} tokens of identical content added to context again.`,
            count: st.redundant,
            tokens,
            cost: st.cost,
          });
        }
      }

      // --- huge tool outputs -------------------------------------------------
      if (can('huge-output')) {
        for (const { tc, call } of ordered) {
          const tokens = estTokens(tc.resultChars);
          if (tokens < o.hugeOutputTokens) continue;
          const cost = inputCost(tokens, call);
          push({
            kind: 'huge-output',
            certainty: 'likely-avoidable',
            severity: severityFor(cost, tokens >= o.hugeOutputTokens * 5 ? 'medium' : 'low'),
            title: `${tc.name} returned ~${fmtTok(tokens)} tokens${where}`,
            detail: `${tc.name}(${tc.target ?? '…'}) put a very large result into context; every later request in this context pays to carry it, and it hastens compaction.`,
            count: 1,
            tokens,
            cost,
          });
        }
      }

      // --- cache rebuilds ----------------------------------------------------
      // only meaningful where caching demonstrably works for this model/provider
      if (can('cache-miss') && ctx.calls.some((c) => c.usage.cacheRead > 0)) {
        const firstOfTurn = new Set(ctx.session.turns.map((t) => t.calls[0]).filter(Boolean));
        interface Rebuild {
          call: ApiCall;
          rebuilt: number;
          carried: number;
          gapMin: number;
          cause: CacheCause | 'unavoidable';
          tool?: ToolCall;
          toolMin?: number;
        }
        const rebuilds = new Map<ApiCall, Rebuild>();
        for (let i = 1; i < ctx.calls.length; i++) {
          const prev = ctx.calls[i - 1];
          const cur = ctx.calls[i];
          const prevCtx = prev.usage.input + prev.usage.cacheRead + prev.usage.cacheWrite5m + prev.usage.cacheWrite1h;
          // Anthropic-style logs report cache writes; OpenAI/Gemini-style logs only report
          // cached input, so a miss shows up as a large uncached `input`.
          const rebuilt = caps.cacheWrites ? cur.usage.cacheWrite5m + cur.usage.cacheWrite1h : cur.usage.input;
          if (rebuilt < o.cacheMissMinTokens || rebuilt < prevCtx * 0.5) continue;
          const gapMin = (cur.timestamp - prev.timestamp) / 60000;
          const ttlMin = cur.usage.cacheWrite1h > cur.usage.cacheWrite5m ? 60 : 5;
          const rb: Rebuild = { call: cur, rebuilt, carried: Math.min(rebuilt, prevCtx), gapMin, cause: 'prefix' };
          if (gapMin <= ttlMin) rb.cause = prev.model !== cur.model ? 'model' : 'prefix';
          else if (gapMin > 60 || ttlMin >= 60 || !caps.cacheWrites) {
            // beyond any cache TTL (or a provider with no TTL knob): unavoidable, not waste
            rb.cause = 'unavoidable';
          } else if (firstOfTurn.has(cur)) rb.cause = 'pause';
          else {
            rb.cause = 'tool-wait';
            let best = 0;
            for (const tc of prev.toolCalls) {
              const dur = tc.resultAt ? (tc.resultAt - prev.timestamp) / 60000 : gapMin;
              if (!rb.tool || dur > best) {
                rb.tool = tc;
                best = dur;
              }
            }
            rb.toolMin = best;
          }
          rebuilds.set(cur, rb);
        }
        const rates = (c: ApiCall) => pricer.rates(c.model, c.usage.input + c.usage.cacheRead + c.usage.cacheWrite5m + c.usage.cacheWrite1h, c.fast);

        // (1) prefix changes / model switches: rebuilt at write price instead of read price
        for (const cause of ['prefix', 'model'] as CacheCause[]) {
          const list = [...rebuilds.values()].filter((r) => r.cause === cause);
          let cost = 0;
          let tokens = 0;
          for (const r of list) {
            const rt = rates(r.call);
            if (!rt) continue;
            const paid = caps.cacheWrites ? (r.call.usage.cacheWrite1h > r.call.usage.cacheWrite5m ? rt.cacheWrite1h : rt.cacheWrite5m) : rt.input;
            cost += (r.carried * Math.max(0, paid - rt.cacheRead)) / 1e6;
            tokens += r.rebuilt;
          }
          if (!list.length || cost < 0.01) continue;
          push({
            kind: 'cache-miss',
            certainty: 'likely-avoidable',
            cause,
            severity: severityFor(cost),
            title: `${list.length} prompt-cache rebuild${list.length > 1 ? 's' : ''} ${cause === 'model' ? 'after model switches' : 'mid-session, with no idle gap'} (${fmtTok(tokens)} tokens)${where}`,
            detail:
              cause === 'model'
                ? 'Caches are per model, so the context was re-written right after switching models.'
                : 'The prompt prefix changed (edited instructions, tool list, compaction or history rewrite), so the cached context could not be reused.',
            count: list.length,
            tokens,
            cost,
          });
        }

        // (2) gaps of 5-60 min: counterfactual = this whole context on a 1-hour TTL.
        //     Those rebuilds become cache reads, but every cache write pays the 1h premium (2x vs 1.25x).
        const ttl = [...rebuilds.values()].filter((r) => r.cause === 'pause' || r.cause === 'tool-wait');
        if (caps.cacheWrites) {
          let actual = 0;
          let counter = 0;
          const gross = new Map<Rebuild, number>();
          for (const c of ctx.calls) {
            const rt = rates(c);
            if (!rt) continue;
            const u = c.usage;
            const a = (u.cacheWrite5m * rt.cacheWrite5m + u.cacheWrite1h * rt.cacheWrite1h + u.cacheRead * rt.cacheRead) / 1e6;
            const r = rebuilds.get(c);
            const writes = u.cacheWrite5m + u.cacheWrite1h;
            const b =
              r && (r.cause === 'pause' || r.cause === 'tool-wait')
                ? ((u.cacheRead + r.carried) * rt.cacheRead + (writes - r.carried) * rt.cacheWrite1h) / 1e6
                : (u.cacheRead * rt.cacheRead + writes * rt.cacheWrite1h) / 1e6;
            actual += a;
            counter += b;
            if (r && (r.cause === 'pause' || r.cause === 'tool-wait')) gross.set(r, a - b);
          }
          const net = actual - counter;
          // what a global 1h setting would do to this context, even if it has nothing to gain
          if (stats && !ctx.session.isSubagent) stats.ttlGlobalNet += net;
          const grossSum = [...gross.values()].reduce((x, y) => x + y, 0);
          if (net > 0.01 && grossSum > 0) {
            const premium = grossSum - net;
            for (const cause of ['pause', 'tool-wait'] as CacheCause[]) {
              const list = ttl.filter((r) => r.cause === cause);
              if (!list.length) continue;
              const g = list.reduce((x, r) => x + (gross.get(r) ?? 0), 0);
              const cost = (g / grossSum) * net;
              if (cost < 0.01) continue;
              const tokens = list.reduce((x, r) => x + r.carried, 0);
              const gaps = list.map((r) => r.gapMin).sort((a, b) => a - b);
              const median = Math.round(gaps[Math.floor(gaps.length / 2)]);
              let detail: string;
              if (cause === 'pause') {
                detail = `You took 5-60 min to read and reply ${list.length}× (median ${median} min), longer than the 5-minute cache TTL, so the context was re-written each time. With a 1-hour TTL these would have been cache reads: net saving ≈ ${usd(cost)} after paying the 1h write premium on every cache write in this context${premium > 0.01 ? ` (${usd(premium)} total premium)` : ''}.`;
              } else {
                const byTool = new Map<string, { n: number; min: number }>();
                for (const r of list) {
                  const label = r.tool ? `${r.tool.name}(${r.tool.target ?? '…'})` : 'a tool';
                  const e = byTool.get(label) ?? { n: 0, min: 0 };
                  e.n++;
                  e.min = Math.max(e.min, r.toolMin ?? r.gapMin);
                  byTool.set(label, e);
                }
                const top = [...byTool.entries()].sort((a, b) => b[1].min - a[1].min).slice(0, 3);
                // lead with the tools, so a truncated terminal line still names the command
                detail = `Waited on ${top.map(([l, e]) => `${l} ${Math.round(e.min)} min${e.n > 1 ? ` ×${e.n}` : ''}`).join(', ')}: the cache expired ${list.length}× while the agent waited 5-60 min on a tool (or on your approval). Net saving with a 1-hour TTL ≈ ${usd(cost)} after the 1h write premium.`;
              }
              push({
                kind: 'cache-miss',
                certainty: 'avoidable',
                cause,
                severity: severityFor(cost),
                title: `${list.length} cache rebuild${list.length > 1 ? 's' : ''} ${cause === 'pause' ? 'while you were reading/replying' : 'while the agent waited on tools'} (${fmtTok(tokens)} tokens)${where}`,
                detail,
                count: list.length,
                tokens,
                cost,
              });
            }
          }
        }

        // (3) gaps over an hour: unavoidable - recorded for context, never counted as waste
        if (stats)
          for (const r of rebuilds.values())
            if (r.cause === 'unavoidable') {
              const rt = rates(r.call);
              stats.unavoidableRebuilds++;
              stats.unavoidableTokens += r.rebuilt;
              if (rt) stats.unavoidableCost += (r.carried * Math.max(0, (caps.cacheWrites ? rt.cacheWrite5m : rt.input) - rt.cacheRead)) / 1e6;
            }
      }
    }
  }
  return findings.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
}
