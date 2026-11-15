import type { Report } from './report.js';
import type { Certainty, FindingKind } from './waste.js';

/**
 * A small, stable JSON summary for CI gates and bots: the headline numbers, waste by
 * pattern, the top findings and the result of `--fail-over`. The full report (`--json`)
 * is much larger and includes the flame-graph tree.
 */
export interface Summary {
  version: string;
  generatedAt: string;
  range: { start: string | null; end: string | null };
  sources: string[];
  sessions: number;
  sessionIds: string[];
  calls: number;
  tokens: number;
  cost: number;
  /** The headline: realistic savings only. This is what `--fail-over` compares. */
  avoidableCost: number;
  /** Shown separately, never added to the headline. */
  likelyAvoidableCost: number;
  cacheHitRate: number;
  byKind: Array<{ kind: FindingKind; certainty: Certainty; findings: number; cost: number }>;
  topFindings: Array<{ kind: FindingKind; certainty: Certainty; cost: number; tokens: number; title: string; tip: string; sessionId: string; project: string }>;
  /** Sessions where some detectors could not run because the logs lack the data. */
  partiallyCheckedSessions: number;
  uncheckedSessions: number;
  unknownModels: string[];
  failOver?: { threshold: number; exceeded: boolean };
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;
const iso = (ts: number) => (ts ? new Date(ts).toISOString() : null);

export function summarize(r: Report, opts: { failOver?: number; top?: number } = {}): Summary {
  const byKind = new Map<string, { kind: FindingKind; certainty: Certainty; findings: number; cost: number }>();
  for (const f of r.findings) {
    const k = f.kind + '/' + f.certainty;
    const e = byKind.get(k) ?? { kind: f.kind, certainty: f.certainty, findings: 0, cost: 0 };
    e.findings++;
    e.cost += f.cost;
    byKind.set(k, e);
  }
  const t = r.totals;
  const s: Summary = {
    version: r.version,
    generatedAt: r.generatedAt,
    range: { start: iso(r.range.start), end: iso(r.range.end) },
    sources: r.sources,
    sessions: t.sessions,
    sessionIds: r.sessions.map((x) => x.id),
    calls: t.calls,
    tokens: t.tokens,
    cost: round(t.cost),
    avoidableCost: round(t.avoidableCost),
    likelyAvoidableCost: round(t.likelyAvoidableCost),
    cacheHitRate: round(t.cacheHitRate),
    byKind: [...byKind.values()].sort((a, b) => b.cost - a.cost).map((e) => ({ ...e, cost: round(e.cost) })),
    topFindings: r.findings.slice(0, opts.top ?? 10).map((f) => ({
      kind: f.kind,
      certainty: f.certainty,
      cost: round(f.cost),
      tokens: f.tokens,
      title: f.title,
      tip: f.tip,
      sessionId: f.sessionId,
      project: f.project,
    })),
    partiallyCheckedSessions: t.partiallyCheckedSessions,
    uncheckedSessions: t.uncheckedSessions,
    unknownModels: r.unknownModels,
  };
  if (opts.failOver !== undefined) s.failOver = { threshold: opts.failOver, exceeded: exceeds(r, opts.failOver) };
  return s;
}

/** `--fail-over`: true when the headline (avoidable waste only) is above the threshold in USD. */
export const exceeds = (r: Report, threshold: number): boolean => r.totals.avoidableCost > threshold;
