import type { Pricer } from '../pricing/index.js';
import type { ApiCall, Capabilities, Session, SourceId, ToolCall } from '../types.js';
import { CHARS_PER_TOKEN, estTokens, totalTokens } from '../types.js';

export type FindingKind =
  | 'loop'
  | 'repeat'
  | 'reread'
  | 'huge-output'
  | 'cache-miss'
  | 'context-bloat'
  | 'unused-tools'
  | 'overthinking'
  | 'edit-retry';
export type Severity = 'high' | 'medium' | 'low';
/**
 * `avoidable`: the same work was clearly redone (identical calls/results, unchanged re-reads).
 * `likely-avoidable`: usually waste, but there can be good reasons (you took a break, the
 * agent compacted, the big output was actually needed).
 */
export type Certainty = 'avoidable' | 'likely-avoidable';

export const ALL_KINDS: FindingKind[] = ['cache-miss', 'loop', 'repeat', 'reread', 'huge-output', 'edit-retry', 'context-bloat', 'unused-tools', 'overthinking'];

export const KIND_LABEL: Record<FindingKind, string> = {
  'cache-miss': 'Cache rebuilds',
  loop: 'Loops',
  repeat: 'Repeated calls',
  reread: 'Unchanged re-reads',
  'huge-output': 'Huge tool outputs',
  'edit-retry': 'Failed-edit retry storms',
  'context-bloat': 'Context bloat before compaction',
  'unused-tools': 'Unused tool definitions',
  overthinking: 'Over-thinking on tiny edits',
};

/** Data each detector needs. A detector is skipped (and reported as unavailable) otherwise. */
export const DETECTOR_NEEDS: Record<FindingKind, Array<keyof Capabilities>> = {
  'cache-miss': ['perRequestTokens', 'cacheReads', 'timestamps'],
  loop: ['toolCalls', 'toolOutputs'],
  repeat: ['toolCalls', 'toolOutputs'],
  reread: ['toolCalls', 'filePaths', 'toolOutputs'],
  'huge-output': ['toolCalls', 'toolOutputs'],
  'edit-retry': ['toolCalls', 'toolOutputs', 'filePaths', 'editErrors'],
  'context-bloat': ['perRequestTokens', 'cacheReads', 'compactions'],
  'unused-tools': ['perRequestTokens', 'toolCalls', 'toolDefinitions'],
  overthinking: ['perRequestTokens', 'toolCalls', 'filePaths', 'toolInputs'],
};

export const CAP_LABEL: Record<keyof Capabilities, string> = {
  perRequestTokens: 'per-request token usage',
  cacheReads: 'cache token counts',
  cacheWrites: 'cache-write token counts',
  toolCalls: 'tool calls',
  toolOutputs: 'tool output',
  filePaths: 'file paths',
  timestamps: 'per-request timestamps',
  compactions: 'compaction events',
  toolDefinitions: 'tool definitions',
  toolInputs: 'tool-call input sizes',
  editErrors: 'recognisable edit errors',
};

export function detectorAvailable(kind: FindingKind, caps: Capabilities): boolean {
  return DETECTOR_NEEDS[kind].every((k) => caps[k] === true);
}

export function missingFor(kind: FindingKind, caps: Capabilities): string[] {
  return DETECTOR_NEEDS[kind].filter((k) => caps[k] !== true).map((k) => CAP_LABEL[k]);
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
    case 'edit-retry':
      return `After a failed edit, re-read the exact lines before retrying. Add to ${mem}: "if an edit fails twice, re-read the file instead of guessing the text to replace".`;
    case 'context-bloat':
      return source === 'claude-code'
        ? 'Run /compact when you finish a task (or /clear before an unrelated one) instead of letting the context grow to the auto-compact limit; CLAUDE_AUTOCOMPACT_PCT_OVERRIDE makes auto-compaction happen earlier.'
        : 'Compact (or start a fresh session) when you finish a task instead of letting the context grow to the auto-compact limit.';
    case 'unused-tools':
      return 'Disable MCP servers you don\'t use in this project, or let the agent load their tools on demand (tool search / deferred loading) - every request carries the full schemas.';
    case 'overthinking':
      return source === 'claude-code'
        ? 'Use a lower effort level or a thinking budget (MAX_THINKING_TOKENS) for small, well-specified edits; save deep thinking for hard problems.'
        : 'Use a lower reasoning effort / thinking budget for small, well-specified edits.';
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
  /** Consecutive failed edits of one file that count as a retry storm. */
  editRetryThreshold: number;
  /** Context size the bloat counterfactual compacts at (and only compactions above 1.5x this are checked). */
  compactAtTokens: number;
  /** Tool definitions of one unused MCP server, in tokens, before they are flagged. */
  unusedToolsMinTokens: number;
  /** Hidden reasoning tokens on a tiny edit that count as over-thinking. */
  overthinkTokens: number;
  /** Reasoning allowance per tiny edit; only tokens above it are counted. */
  overthinkAllowance: number;
  /** Largest edit (characters of tool input) considered tiny. */
  tinyEditChars: number;
}

export const defaultWasteOptions: WasteOptions = {
  hugeOutputTokens: 10_000,
  repeatThreshold: 3,
  loopThreshold: 3,
  rereadThreshold: 2,
  cacheMissMinTokens: 5_000,
  editRetryThreshold: 3,
  compactAtTokens: 200_000,
  unusedToolsMinTokens: 1_000,
  overthinkTokens: 8_000,
  overthinkAllowance: 2_000,
  tinyEditChars: 1_000,
};

/** Error messages of a failed file edit (old text not found / not unique / stale read), across agents. */
const EDIT_FAILURE =
  /string to replace not found|old_string|not found in (?:the )?file|has not been read yet|read it first|modified since (?:it was )?(?:last )?read|found \d+ matches|not unique|no changes to make|could not find the (?:string|text)|failed to (?:apply|edit|find)|does not match|search block|patch (?:failed|did not apply)/i;
/** Failures that are not the agent's mistake: denied permissions, hooks, safety classifiers. */
const NOT_AGENT_FAILURE = /permission|denied|doesn't want to proceed|rejected|classifier|hook|interrupted/i;

export const isEditFailure = (tc: ToolCall): boolean =>
  tc.isError && !!tc.errorText && EDIT_FAILURE.test(tc.errorText) && !NOT_AGENT_FAILURE.test(tc.errorText);

/** Prompt size of a request (everything it sent: uncached input + cache reads + cache writes). */
const promptOf = (c: ApiCall) => c.usage.input + c.usage.cacheRead + c.usage.cacheWrite5m + c.usage.cacheWrite1h;
const mcpServer = (name: string): string | undefined => name.match(/^mcp__(.+?)__/)?.[1];

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
const oneLine = (t: string, n: number) => {
  // Claude Code wraps tool errors in <tool_use_error>; plain text, never rendered as HTML unescaped
  const x = t.split('<tool_use_error>').join('').split('</tool_use_error>').join('').replace(/\s+/g, ' ').trim();
  return x.length > n ? x.slice(0, n - 1) + '…' : x;
};
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

    // --- unused tool definitions (per session tree) ----------------------------
    // MCP servers whose tool schemas were sent with every request but never called anywhere in the
    // session (subagents included). Built-in tools are left out: you can't remove them.
    if (can('unused-tools')) {
      const ctxs = contexts(root);
      const used = new Set<string>();
      for (const ctx of ctxs) for (const c of ctx.calls) for (const tc of c.toolCalls) used.add(mcpServer(tc.name) ?? '');
      const per = new Map<string, { tokens: number; tools: number; calls: number; cost: number }>();
      for (const ctx of ctxs)
        for (const c of ctx.calls) {
          const defs = c.toolSet ? ctx.session.toolSets?.[c.toolSet] : undefined;
          if (!defs) continue;
          const bySrv = new Map<string, { tokens: number; tools: number }>();
          for (const d of defs) {
            const srv = mcpServer(d.name);
            if (!srv || d.deferred || used.has(srv)) continue;
            const e = bySrv.get(srv) ?? { tokens: 0, tools: 0 };
            e.tokens += d.tokens;
            e.tools++;
            bySrv.set(srv, e);
          }
          const r = bySrv.size ? pricer.rates(c.model, promptOf(c), c.fast) : undefined;
          if (!r) continue;
          const u = c.usage;
          for (const [srv, e] of bySrv) {
            // tool schemas are the start of the prompt: read from cache when the prefix was cached, else written or sent fresh
            const rate = u.cacheRead >= e.tokens ? r.cacheRead : u.cacheWrite1h >= e.tokens ? r.cacheWrite1h : u.cacheWrite5m >= e.tokens ? r.cacheWrite5m : r.input;
            const acc = per.get(srv) ?? { tokens: 0, tools: 0, calls: 0, cost: 0 };
            acc.tokens = Math.max(acc.tokens, e.tokens);
            acc.tools = Math.max(acc.tools, e.tools);
            acc.calls++;
            acc.cost += (e.tokens * rate) / 1e6;
            per.set(srv, acc);
          }
        }
      for (const [srv, e] of per) {
        if (e.tokens < o.unusedToolsMinTokens || e.cost < 0.01) continue;
        findings.push({
          kind: 'unused-tools',
          certainty: 'likely-avoidable',
          severity: severityFor(e.cost),
          source: root.source,
          sessionId: root.id,
          project: root.project,
          title: `MCP server "${srv}": ${e.tools} tool definitions (~${fmtTok(e.tokens)} tokens) sent with ${e.calls} requests, never called`,
          detail: `None of its tools was called in this session (subagents included), but their schemas were part of every request's prompt.`,
          count: e.calls,
          tokens: e.tokens * e.calls,
          cost: e.cost,
          tip: tipFor('unused-tools', root.source),
        });
      }
    }
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
      // failed edits are valued by the retry-storm detector, so they're not counted twice
      const ownedByEditRetry = (tc: ToolCall) => can('edit-retry') && tc.fileOp === 'edit' && isEditFailure(tc);
      if (can('loop')) {
        for (let i = 0; i < ordered.length; ) {
          let j = i + 1;
          while (j < ordered.length && ident(ordered[j].tc) === ident(ordered[i].tc)) j++;
          const run = j - i;
          // file reads are covered by the re-read detector, polling tools are expected to repeat
          if (run >= o.loopThreshold && !POLLING_TOOLS.has(ordered[i].tc.name) && ordered[i].tc.fileOp !== 'read' && !ownedByEditRetry(ordered[i].tc)) {
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
          if (x.tc.fileOp === 'read' || loopedKeys.has(ident(x.tc)) || POLLING_TOOLS.has(x.tc.name) || ownedByEditRetry(x.tc)) continue;
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

      // --- failed-edit retry storms -------------------------------------------
      // the same file edited again and again, each attempt failing (text not found, not unique, stale read)
      if (can('edit-retry')) {
        const runs = new Map<string, Array<{ tc: ToolCall; call: ApiCall }>>();
        const flush = (file: string) => {
          const run = runs.get(file) ?? [];
          runs.delete(file);
          if (run.length < o.editRetryThreshold) return;
          // a good recovery (re-read the lines, then edit) still costs a round trip, so the first two attempts are free
          const wasted = run.slice(2);
          const share = (x: { call: ApiCall }) => 1 / Math.max(1, x.call.toolCalls.length);
          const cost = wasted.reduce((n, x) => n + x.call.cost * share(x), 0);
          const tokens = wasted.reduce((n, x) => n + Math.round(totalTokens(x.call.usage) * share(x)), 0);
          push({
            kind: 'edit-retry',
            certainty: 'avoidable',
            severity: severityFor(cost, 'medium'),
            title: `${short(file)}: ${run.length} failed edits in a row${where}`,
            detail: `${run[0].tc.name} kept failing on the same file (${oneLine(run[run.length - 1].tc.errorText ?? 'error', 70)}); ${wasted.length} attempt${wasted.length > 1 ? 's' : ''} after the first retry produced nothing.`,
            count: run.length,
            tokens,
            cost,
          });
        };
        for (const x of ordered) {
          const { tc } = x;
          if (tc.fileOp !== 'edit' || !tc.file) continue;
          if (isEditFailure(tc)) runs.set(tc.file, [...(runs.get(tc.file) ?? []), x]);
          else if (!tc.isError) flush(tc.file); // a successful edit ends the storm; denied permissions don't count either way
        }
        for (const file of [...runs.keys()]) flush(file);
      }

      // --- over-thinking on tiny edits -----------------------------------------
      // requests whose only visible output is a tiny edit but that billed thousands of hidden reasoning tokens
      if (can('overthinking')) {
        let cost = 0;
        let tokens = 0;
        let maxHidden = 0;
        let n = 0;
        for (const call of ctx.calls) {
          if (call.visibleChars === undefined || !call.toolCalls.length) continue;
          if (!call.toolCalls.every((tc) => tc.fileOp === 'edit' && tc.inputChars !== undefined)) continue;
          if (call.toolCalls.reduce((x, tc) => x + (tc.inputChars ?? 0), 0) > o.tinyEditChars) continue;
          const hidden = call.usage.output - estTokens(call.visibleChars);
          if (hidden < o.overthinkTokens) continue;
          const r = pricer.rates(call.model, promptOf(call), call.fast);
          if (!r) continue;
          const extra = hidden - o.overthinkAllowance;
          n++;
          tokens += extra;
          cost += (extra * r.output) / 1e6;
          maxHidden = Math.max(maxHidden, hidden);
        }
        if (n && cost >= 0.01)
          push({
            kind: 'overthinking',
            certainty: 'likely-avoidable',
            severity: severityFor(cost),
            title: `${n} tiny edit${n > 1 ? 's' : ''} that took ${n > 1 ? 'up to ' : ''}~${fmtTok(maxHidden)} reasoning tokens${where}`,
            detail: `Requests whose only output was an edit of at most ${o.tinyEditChars.toLocaleString('en-US')} characters billed ${fmtTok(o.overthinkTokens)}+ hidden reasoning tokens each; counted: the tokens above a ${fmtTok(o.overthinkAllowance)} allowance, at output price.`,
            count: n,
            tokens,
            cost,
          });
      }

      // --- context bloat before compaction -------------------------------------
      // counterfactual: compact when the context first passes `compactAtTokens` (and again each time it
      // grows back past it) instead of at the auto-compact limit, paying for every extra compaction
      if (can('context-bloat') && ctx.session.compactions?.length) {
        const T = o.compactAtTokens;
        let prevTs = -Infinity;
        for (const comp of [...ctx.session.compactions].sort((a, b) => a.timestamp - b.timestamp)) {
          const window = ctx.calls.filter((c) => c.timestamp > prevTs && c.timestamp <= comp.timestamp);
          prevTs = comp.timestamp;
          if (comp.pre < T * 1.5 || !comp.post || comp.post >= T / 2 || window.length < 2) continue;
          let off = 0;
          let extra = 0;
          let saved = 0;
          let compactCost = 0;
          let tokens = 0;
          let peak = 0;
          for (let i = 0; i < window.length; i++) {
            const c = window[i];
            const size = promptOf(c);
            peak = Math.max(peak, size);
            if (i > 0 && size - off > T) {
              // compact before this request: summarize the previous context, write the summary, re-cache it
              const prev = promptOf(window[i - 1]);
              const r = pricer.rates(c.model, prev, c.fast);
              if (r) compactCost += (prev * r.cacheRead + comp.post * (r.output + r.cacheWrite5m)) / 1e6;
              off = Math.max(0, prev - comp.post);
              extra++;
            }
            const lean = Math.max(Math.min(size, comp.post), size - off);
            if (lean >= size) continue;
            const ra = pricer.rates(c.model, size, c.fast);
            const rb = pricer.rates(c.model, lean, c.fast);
            if (!ra || !rb) continue;
            saved += (size * ra.cacheRead - lean * rb.cacheRead) / 1e6;
            tokens += size - lean;
          }
          const cost = saved - compactCost;
          if (cost < 0.01) continue;
          push({
            kind: 'context-bloat',
            certainty: 'likely-avoidable',
            severity: severityFor(cost),
            title: `Context grew to ~${fmtTok(peak)} tokens before ${comp.trigger === 'manual' ? 'compaction' : 'auto-compaction'} (to ~${fmtTok(comp.post)})${where}`,
            detail: `Compacting each time the context passed ${fmtTok(T)} (${extra} compaction${extra > 1 ? 's' : ''} instead of 1) would have carried ~${fmtTok(tokens)} fewer cached tokens: ${usd(saved)} less in cache reads, minus ~${usd(compactCost)} for the extra compactions.`,
            count: extra,
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
