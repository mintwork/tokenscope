import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Pricer } from '../pricing/index.js';
import { normalizeModel } from '../pricing/index.js';
import type { ApiCall, Session, SourceId, ToolCall, Usage } from '../types.js';
import { addUsage, emptyUsage, estTokens, totalTokens } from '../types.js';
import {
  ALL_KINDS,
  contexts,
  detectWaste,
  detectorAvailable,
  missingFor,
  type Finding,
  type FindingKind,
  type WasteOptions,
  type WasteStats,
} from './waste.js';
import type { Capabilities } from '../types.js';

export interface Breakdown {
  name: string;
  cost: number;
  usage: Usage;
  calls: number;
  sessions?: number;
}

export interface ToolStat {
  name: string;
  calls: number;
  errors: number;
  resultTokens: number;
  /** Cost of the API requests that issued this tool (split evenly across tools in a request). */
  cost: number;
}

export interface SessionSummary {
  id: string;
  source: SourceId;
  project: string;
  title?: string;
  start: number;
  end: number;
  turns: number;
  calls: number;
  subagents: number;
  usage: Usage;
  cost: number;
  subagentCost: number;
  cacheHitRate: number;
  models: string[];
  /** Estimated avoidable waste (USD); null when no waste detector could run on this session's data. */
  waste: number | null;
  /** Detectors that could run on this session. */
  checked: FindingKind[];
}

export interface DetectorStatus {
  kind: FindingKind;
  /** 'yes' = every session supports it, 'partial' = some, 'no' = none. */
  status: 'yes' | 'partial' | 'no';
  /** What the logs are missing, when not 'yes'. */
  missing: string[];
}

export interface SourceCoverage {
  source: SourceId;
  name: string;
  verified: boolean;
  sessions: number;
  cost: number;
  /** Cost that came from the agent's own recorded cost rather than our pricing table. */
  reportedCost: number;
  caps: Capabilities;
  detectors: DetectorStatus[];
}

/** Flame-graph node: name, value (USD, self + children), tokens, kind, children. */
export interface TreeNode {
  n: string;
  v: number;
  t: number;
  k: 'root' | 'project' | 'session' | 'turn' | 'call' | 'agent' | 'more';
  /** session id (session nodes only) */
  s?: string;
  /** dominant tool category, for coloring */
  g?: string;
  d?: string;
  c?: TreeNode[];
}

export interface Report {
  version: string;
  generatedAt: string;
  range: { start: number; end: number };
  sources: SourceId[];
  /** Per-agent data capabilities and which waste detectors could run. */
  coverage: SourceCoverage[];
  pricingUpdated?: string;
  /** 'builtin' = the table shipped with this version; 'feed' = a newer table cached by `--update-pricing`. */
  pricingSource?: 'builtin' | 'feed';
  unknownModels: string[];
  /** Models priced from the agent's recorded cost because they're not in the pricing table. */
  reportedModels: string[];
  totals: {
    sessions: number;
    subagents: number;
    turns: number;
    calls: number;
    toolCalls: number;
    usage: Usage;
    tokens: number;
    cost: number;
    cacheHitRate: number;
    /** What the same tokens would have cost with no prompt caching at all. */
    costWithoutCache: number;
    /** Everything flagged (avoidable + likely avoidable). Not the headline. */
    wasteCost: number;
    /**
     * The headline: realistic savings only - repeated work (loops, repeats, unchanged re-reads)
     * and the net saving a 1-hour cache TTL would have given (after its write premium).
     */
    avoidableCost: number;
    /** Arguable, shown separately: mid-session prompt changes, model switches, huge outputs. */
    likelyAvoidableCost: number;
    /** Cache rebuilds after gaps longer than any TTL - not waste, shown for context. */
    unavoidableRebuilds: number;
    unavoidableRebuildCost: number;
    /** Net effect of turning the 1h TTL on for every main conversation (premium included). */
    ttlGlobalNet: number;
    /** Sessions where at least one detector could not run (missing data). */
    partiallyCheckedSessions: number;
    /** Sessions where no detector could run at all. */
    uncheckedSessions: number;
  };
  byProject: Breakdown[];
  byModel: Breakdown[];
  byDay: Breakdown[];
  byTool: ToolStat[];
  /** Spend split by token type (input / cache write / cache read / output). */
  costByType: { input: number; cacheWrite: number; cacheRead: number; output: number };
  sessions: SessionSummary[];
  findings: Finding[];
  tree: TreeNode;
}

export interface BuildOptions {
  waste?: Partial<WasteOptions>;
  /** Display info per source (name, verified) - defaults to the id. */
  sourceInfo?: Partial<Record<SourceId, { name: string; verified: boolean }>>;
  redact?: boolean;
  /** Max call nodes per turn in the flame graph before collapsing. */
  maxCallsPerTurn?: number;
  version?: string;
}

export const cacheHitRate = (u: Usage): number => {
  const denom = u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
  return denom ? u.cacheRead / denom : 0;
};

/** Visit every API call in a session tree (including subagents). */
export function forEachCall(s: Session, fn: (c: ApiCall, owner: Session) => void): void {
  for (const t of s.turns)
    for (const c of t.calls) {
      fn(c, s);
      for (const tc of c.toolCalls) if (tc.subagent) forEachCall(tc.subagent, fn);
    }
}

/** Keep only calls whose timestamp is in [since, until]. Mutates and returns surviving sessions. */
export function filterByTime(sessions: Session[], since?: number, until?: number): Session[] {
  if (!since && !until) return sessions;
  const keep = (c: ApiCall) => (!since || c.timestamp >= since) && (!until || c.timestamp <= until);
  const rec = (s: Session): boolean => {
    for (const t of s.turns) {
      t.calls = t.calls.filter((c) => {
        for (const tc of c.toolCalls) if (tc.subagent && !rec(tc.subagent)) tc.subagent = undefined;
        return keep(c) || c.toolCalls.some((tc) => tc.subagent);
      });
    }
    s.turns = s.turns.filter((t) => t.calls.length);
    return s.turns.length > 0;
  };
  return sessions.filter(rec);
}

export function toolCategory(name: string): string {
  if (/^(Read|read_file|view|Grep|Glob|LS|grep|glob|NotebookRead|ToolSearch)$/.test(name)) return 'read';
  if (/^(Edit|MultiEdit|Write|NotebookEdit|apply_patch|write_file|edit_file)$/.test(name)) return 'edit';
  if (/^(Bash|shell|exec_command|local_shell|BashOutput|KillShell)$/.test(name)) return 'shell';
  if (/^(Agent|Task|SendMessage|SubagentHandback)$/.test(name)) return 'agent';
  if (/^(WebFetch|WebSearch|web_search|web_fetch)$/i.test(name) || name.startsWith('mcp__')) return 'web';
  return 'other';
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 6);

/** Replace prompts, titles, paths and commands with stable placeholders. */
export function redactSessions(sessions: Session[]): void {
  const projects = new Map<string, string>();
  const rec = (s: Session) => {
    if (!projects.has(s.project)) projects.set(s.project, `project-${projects.size + 1}`);
    s.project = projects.get(s.project)!;
    s.projectPath = undefined;
    s.title = s.title ? `session ${hash(s.id)}` : undefined;
    s.agentDescription = s.agentDescription ? `subagent ${hash(s.id)}` : undefined;
    for (const t of s.turns) {
      t.prompt = `prompt #${t.index + 1}`;
      for (const c of t.calls)
        for (const tc of c.toolCalls) {
          if (tc.file) {
            const ext = path.extname(tc.file);
            tc.file = `file-${hash(tc.file)}${ext}`;
          }
          tc.target = tc.file ?? (tc.target ? `#${hash(tc.target)}` : undefined);
          if (tc.subagent) rec(tc.subagent);
        }
    }
  };
  sessions.forEach(rec);
}

function bump(map: Map<string, Breakdown>, name: string, c: ApiCall): Breakdown {
  let b = map.get(name);
  if (!b) map.set(name, (b = { name, cost: 0, usage: emptyUsage(), calls: 0 }));
  b.cost += c.cost;
  addUsage(b.usage, c.usage);
  b.calls++;
  return b;
}

const day = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function callLabel(c: ApiCall): { label: string; group: string; detail: string } {
  if (!c.toolCalls.length) return { label: 'response', group: 'text', detail: `${c.model} · text/thinking only` };
  const names = c.toolCalls.map((tc) => (tc.target ? `${tc.name}(${tc.target})` : tc.name));
  const cats = new Map<string, number>();
  for (const tc of c.toolCalls) cats.set(toolCategory(tc.name), (cats.get(toolCategory(tc.name)) ?? 0) + 1);
  const group = [...cats.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const label = c.toolCalls.length === 1 ? names[0] : `${c.toolCalls[0].name} +${c.toolCalls.length - 1}`;
  return { label, group, detail: names.slice(0, 6).join('\n') + (names.length > 6 ? `\n… +${names.length - 6} more` : '') };
}

function sessionTree(s: Session, maxCalls: number): TreeNode {
  const turns: TreeNode[] = s.turns.map((t) => {
    const callNodes: TreeNode[] = t.calls.map((c) => {
      const { label, group, detail } = callLabel(c);
      const kids: TreeNode[] = [];
      for (const tc of c.toolCalls)
        if (tc.subagent) {
          const sub = sessionTree(tc.subagent, maxCalls);
          sub.k = 'agent';
          sub.n = `⤷ ${tc.subagent.agentDescription ?? tc.subagent.agentType ?? 'subagent'}`;
          sub.g = 'agent';
          kids.push(sub);
        }
      const node: TreeNode = {
        n: label,
        v: c.cost + kids.reduce((n, k) => n + k.v, 0),
        t: totalTokens(c.usage) + kids.reduce((n, k) => n + k.t, 0),
        k: 'call',
        g: group,
        d: detail + `\n${fmtTok(c.usage)}` + (c.toolCalls.some((x) => x.resultChars) ? `\ntool output ≈ ${estTokens(c.toolCalls.reduce((n, x) => n + x.resultChars, 0)).toLocaleString('en-US')} tok` : ''),
      };
      if (kids.length) node.c = kids;
      return node;
    });
    let kids = callNodes;
    if (callNodes.length > maxCalls) {
      const sorted = [...callNodes].sort((a, b) => b.v - a.v);
      const top = new Set(sorted.slice(0, maxCalls));
      const rest = callNodes.filter((n) => !top.has(n));
      kids = callNodes.filter((n) => top.has(n));
      kids.push({ n: `${rest.length} smaller calls`, v: sum(rest, 'v'), t: sum(rest, 't'), k: 'more', g: 'other' });
    }
    return { n: t.prompt || `turn ${t.index + 1}`, v: sum(kids, 'v'), t: sum(kids, 't'), k: 'turn', c: kids, d: `turn ${t.index + 1} · ${t.calls.length} API calls` };
  });
  return {
    n: s.title ?? s.agentDescription ?? s.id.slice(0, 8),
    v: sum(turns, 'v'),
    t: sum(turns, 't'),
    k: 'session',
    s: s.id,
    c: turns,
    d: `${s.source} · ${new Date(s.start).toISOString().slice(0, 16).replace('T', ' ')} · ${s.turns.length} turns`,
  };
}

const sum = (a: TreeNode[], k: 'v' | 't') => a.reduce((n, x) => n + x[k], 0);
const fmtTok = (u: Usage) =>
  `in ${u.input.toLocaleString('en-US')} · cache w ${(u.cacheWrite5m + u.cacheWrite1h).toLocaleString('en-US')} · cache r ${u.cacheRead.toLocaleString('en-US')} · out ${u.output.toLocaleString('en-US')}`;

export function buildReport(sessions: Session[], pricer: Pricer, opts: BuildOptions = {}): Report {
  if (opts.redact) redactSessions(sessions);
  for (const s of sessions) forEachCall(s, (c) => pricer.price(c));

  const byProject = new Map<string, Breakdown>();
  const byModel = new Map<string, Breakdown>();
  const byDay = new Map<string, Breakdown>();
  const byTool = new Map<string, ToolStat>();
  const totals = emptyUsage();
  const costByType = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  let cost = 0;
  let calls = 0;
  let toolCalls = 0;
  let turns = 0;
  let subagents = 0;
  let costWithoutCache = 0;
  let start = Infinity;
  let end = 0;
  const summaries: SessionSummary[] = [];
  const projectSessions = new Map<string, number>();

  const wstats: WasteStats = { unavoidableRebuilds: 0, unavoidableTokens: 0, unavoidableCost: 0, ttlGlobalNet: 0 };
  const findings = detectWaste(sessions, pricer, opts.waste, wstats);
  let partially = 0;
  let unchecked = 0;
  type CovAcc = Omit<SourceCoverage, 'caps' | 'detectors'> & { capsList: Capabilities[] };
  const covMap = new Map<SourceId, CovAcc>();
  const covBySource = (s: Session): CovAcc => {
    let c = covMap.get(s.source);
    if (!c) {
      const info = opts.sourceInfo?.[s.source];
      covMap.set(s.source, (c = { source: s.source, name: info?.name ?? s.source, verified: info?.verified ?? false, sessions: 0, cost: 0, reportedCost: 0, capsList: [] }));
    }
    return c;
  };
  const wasteBySession = new Map<string, number>();
  for (const f of findings) if (f.certainty === 'avoidable') wasteBySession.set(f.sessionId, (wasteBySession.get(f.sessionId) ?? 0) + f.cost);

  for (const s of sessions) {
    const su = emptyUsage();
    let sc = 0;
    let subCost = 0;
    let sCalls = 0;
    const models = new Set<string>();
    const ctxs = contexts(s);
    subagents += ctxs.length - 1;
    for (const ctx of ctxs) turns += ctx.session.turns.length;
    let sReported = 0;
    forEachCall(s, (c, owner) => {
      if (c.costSource === 'reported') sReported += c.cost;
      calls++;
      sCalls++;
      cost += c.cost;
      sc += c.cost;
      if (owner !== s) subCost += c.cost;
      addUsage(su, c.usage);
      addUsage(totals, c.usage);
      models.add(normalizeModel(c.model));
      if (c.timestamp) {
        start = Math.min(start, c.timestamp);
        end = Math.max(end, c.timestamp);
      }
      bump(byProject, s.project, c);
      bump(byModel, pricer.lookup(c.model)?.key ?? normalizeModel(c.model), c);
      if (c.timestamp) bump(byDay, day(c.timestamp), c);
      const r = pricer.rates(c.model, c.usage.input + c.usage.cacheRead + c.usage.cacheWrite5m + c.usage.cacheWrite1h, c.fast);
      if (r) {
        costByType.input += (c.usage.input * r.input) / 1e6;
        costByType.output += (c.usage.output * r.output) / 1e6;
        costByType.cacheRead += (c.usage.cacheRead * r.cacheRead) / 1e6;
        costByType.cacheWrite += (c.usage.cacheWrite5m * r.cacheWrite5m + c.usage.cacheWrite1h * r.cacheWrite1h) / 1e6;
        costWithoutCache += ((c.usage.input + c.usage.cacheRead + c.usage.cacheWrite5m + c.usage.cacheWrite1h) * r.input + c.usage.output * r.output) / 1e6;
      }
      const share = c.toolCalls.length ? c.cost / c.toolCalls.length : 0;
      for (const tc of c.toolCalls as ToolCall[]) {
        toolCalls++;
        let t = byTool.get(tc.name);
        if (!t) byTool.set(tc.name, (t = { name: tc.name, calls: 0, errors: 0, resultTokens: 0, cost: 0 }));
        t.calls++;
        if (tc.isError) t.errors++;
        t.resultTokens += estTokens(tc.resultChars);
        t.cost += share;
      }
    });
    projectSessions.set(s.project, (projectSessions.get(s.project) ?? 0) + 1);
    const checked = ALL_KINDS.filter((k) => detectorAvailable(k, s.caps));
    if (checked.length < ALL_KINDS.length) partially++;
    if (!checked.length) unchecked++;
    const cov = covBySource(s);
    cov.sessions++;
    cov.cost += sc;
    cov.reportedCost += sReported;
    cov.capsList.push(s.caps);
    summaries.push({
      id: s.id,
      source: s.source,
      project: s.project,
      title: s.title ?? (s.agentDescription ? `subagent: ${s.agentDescription}` : undefined),
      start: s.start,
      end: s.end,
      turns: s.turns.length,
      calls: sCalls,
      subagents: ctxs.length - 1,
      usage: su,
      cost: sc,
      subagentCost: subCost,
      cacheHitRate: cacheHitRate(su),
      models: [...models],
      waste: checked.length ? wasteBySession.get(s.id) ?? 0 : null,
      checked,
    });
  }

  const sortCost = <T extends { cost: number }>(a: T[]) => a.sort((x, y) => y.cost - x.cost);
  const projects = sortCost([...byProject.values()]).map((b) => ({ ...b, sessions: projectSessions.get(b.name) }));
  const maxCalls = opts.maxCallsPerTurn ?? 60;

  // tree: root -> project -> session -> turn -> call -> subagent...
  const projNodes = new Map<string, TreeNode>();
  for (const s of [...sessions].sort((a, b) => a.start - b.start)) {
    let p = projNodes.get(s.project);
    if (!p) projNodes.set(s.project, (p = { n: s.project, v: 0, t: 0, k: 'project', c: [], d: s.projectPath }));
    const st = sessionTree(s, maxCalls);
    p.c!.push(st);
    p.v += st.v;
    p.t += st.t;
  }
  const projList = [...projNodes.values()].sort((a, b) => b.v - a.v);
  const tree: TreeNode = { n: 'All sessions', v: sum(projList, 'v'), t: sum(projList, 't'), k: 'root', c: projList };

  return {
    version: opts.version ?? '0.0.0',
    generatedAt: new Date().toISOString(),
    range: { start: start === Infinity ? 0 : start, end },
    sources: [...new Set(sessions.map((s) => s.source))],
    coverage: [...covMap.values()]
      .sort((a, b) => b.cost - a.cost)
      .map(({ capsList, ...c }) => {
        const caps = Object.fromEntries(
          (Object.keys(capsList[0]) as Array<keyof Capabilities>).map((k) => [k, capsList.every((x) => x[k])]),
        ) as unknown as Capabilities;
        const detectors: DetectorStatus[] = ALL_KINDS.map((kind) => {
          const n = capsList.filter((x) => detectorAvailable(kind, x)).length;
          const status = n === capsList.length ? 'yes' : n === 0 ? 'no' : 'partial';
          const worst = capsList.find((x) => !detectorAvailable(kind, x));
          return { kind, status, missing: worst ? missingFor(kind, worst) : [] };
        });
        return { ...c, caps, detectors };
      }),
    pricingUpdated: pricer.table.updated,
    pricingSource: pricer.table.source ?? 'builtin',
    unknownModels: [...pricer.unknownModels],
    reportedModels: [...pricer.reportedModels],
    totals: {
      sessions: sessions.length,
      subagents,
      turns,
      calls,
      toolCalls,
      usage: totals,
      tokens: totalTokens(totals),
      cost,
      cacheHitRate: cacheHitRate(totals),
      costWithoutCache,
      wasteCost: findings.reduce((n, f) => n + f.cost, 0),
      avoidableCost: findings.filter((f) => f.certainty === 'avoidable').reduce((n, f) => n + f.cost, 0),
      likelyAvoidableCost: findings.filter((f) => f.certainty === 'likely-avoidable').reduce((n, f) => n + f.cost, 0),
      unavoidableRebuilds: wstats.unavoidableRebuilds,
      unavoidableRebuildCost: wstats.unavoidableCost,
      ttlGlobalNet: wstats.ttlGlobalNet,
      partiallyCheckedSessions: partially,
      uncheckedSessions: unchecked,
    },
    byProject: projects,
    byModel: sortCost([...byModel.values()]),
    byDay: [...byDay.values()].sort((a, b) => a.name.localeCompare(b.name)),
    byTool: [...byTool.values()].sort((a, b) => b.cost - a.cost || b.calls - a.calls),
    costByType,
    sessions: sortCost(summaries),
    findings,
    tree,
  };
}
