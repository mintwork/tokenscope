import type { Pricer } from '../pricing/index.js';
import type { Session } from '../types.js';
import { buildReport, filterByTime, type BuildOptions, type Report } from './report.js';
import { KIND_LABEL, type Certainty, type Finding } from './waste.js';

/**
 * Compare two time ranges ("what got more wasteful this week?"). Each range gets its own
 * full report (same pricing, same detectors); the diff lines them up by waste pattern,
 * project and model.
 */
export interface DiffSide {
  start: number;
  end: number;
  sessions: number;
  calls: number;
  cost: number;
  /** The headline: realistic savings only. */
  avoidableCost: number;
  likelyAvoidableCost: number;
  /** avoidableCost / cost (0 when nothing was spent). */
  wasteShare: number;
  cacheHitRate: number;
}

export interface DiffRow {
  key: string;
  label: string;
  before: number;
  after: number;
  /** after − before */
  delta: number;
}

export interface PatternRow extends DiffRow {
  certainty: Certainty;
  beforeCount: number;
  afterCount: number;
}

export interface ProjectRow extends DiffRow {
  /** Spend in each range; `before` / `after` / `delta` are the avoidable waste. */
  costBefore: number;
  costAfter: number;
}

export interface DiffReport {
  version: string;
  generatedAt: string;
  before: DiffSide;
  after: DiffSide;
  /** Waste per pattern (cache rebuilds split by cause), largest change first. */
  byPattern: PatternRow[];
  /** Avoidable waste per project, largest increase first. */
  byProject: ProjectRow[];
  /** Spend per model, largest change first. */
  byModel: DiffRow[];
}

export interface Range {
  start: number;
  end: number;
}

const CAUSE_LABEL: Record<string, string> = {
  pause: 'while you read/replied',
  'tool-wait': 'while waiting on tools',
  prefix: 'mid-session prompt changes',
  model: 'model switches',
};

const patternKey = (f: Finding) => f.kind + (f.cause ? ':' + f.cause : '') + '/' + f.certainty;
const patternLabel = (f: Finding) => KIND_LABEL[f.kind] + (f.cause ? ` (${CAUSE_LABEL[f.cause] ?? f.cause})` : '');

function side(r: Report, range: Range): DiffSide {
  const t = r.totals;
  return {
    start: range.start,
    end: range.end,
    sessions: t.sessions,
    calls: t.calls,
    cost: t.cost,
    avoidableCost: t.avoidableCost,
    likelyAvoidableCost: t.likelyAvoidableCost,
    wasteShare: t.cost ? t.avoidableCost / t.cost : 0,
    cacheHitRate: t.cacheHitRate,
  };
}

/** Report for one range (an empty range gives an empty report). */
function rangeReport(sessions: Session[], range: Range, pricer: Pricer, opts: BuildOptions): Report {
  // filterByTime mutates, so each range works on its own copy
  return buildReport(filterByTime(structuredClone(sessions), range.start, range.end), pricer, opts);
}

function rows<T extends DiffRow>(keys: Iterable<string>, make: (k: string) => T): T[] {
  return [...new Set(keys)].map(make).sort((a, b) => b.delta - a.delta || b.after - a.after);
}

export function diffReports(before: Report, after: Report, ranges: { before: Range; after: Range }, version = '0.0.0'): DiffReport {
  const group = (r: Report) => {
    const m = new Map<string, { label: string; certainty: Certainty; cost: number; n: number }>();
    for (const f of r.findings) {
      const k = patternKey(f);
      const e = m.get(k) ?? { label: patternLabel(f), certainty: f.certainty, cost: 0, n: 0 };
      e.cost += f.cost;
      e.n++;
      m.set(k, e);
    }
    return m;
  };
  const pb = group(before);
  const pa = group(after);
  const byPattern = rows([...pb.keys(), ...pa.keys()], (k): PatternRow => {
    const b = pb.get(k);
    const a = pa.get(k);
    const e = (a ?? b)!;
    return { key: k, label: e.label, certainty: e.certainty, before: b?.cost ?? 0, after: a?.cost ?? 0, delta: (a?.cost ?? 0) - (b?.cost ?? 0), beforeCount: b?.n ?? 0, afterCount: a?.n ?? 0 };
  });

  const projWaste = (r: Report) => {
    const m = new Map<string, number>();
    for (const f of r.findings) if (f.certainty === 'avoidable') m.set(f.project, (m.get(f.project) ?? 0) + f.cost);
    return m;
  };
  const wb = projWaste(before);
  const wa = projWaste(after);
  const cb = new Map(before.byProject.map((p) => [p.name, p.cost]));
  const ca = new Map(after.byProject.map((p) => [p.name, p.cost]));
  const byProject = rows([...cb.keys(), ...ca.keys()], (k): ProjectRow => ({
    key: k,
    label: k,
    before: wb.get(k) ?? 0,
    after: wa.get(k) ?? 0,
    delta: (wa.get(k) ?? 0) - (wb.get(k) ?? 0),
    costBefore: cb.get(k) ?? 0,
    costAfter: ca.get(k) ?? 0,
  }));

  const mb = new Map(before.byModel.map((p) => [p.name, p.cost]));
  const ma = new Map(after.byModel.map((p) => [p.name, p.cost]));
  const byModel = rows([...mb.keys(), ...ma.keys()], (k): DiffRow => ({ key: k, label: k, before: mb.get(k) ?? 0, after: ma.get(k) ?? 0, delta: (ma.get(k) ?? 0) - (mb.get(k) ?? 0) }));

  return {
    version,
    generatedAt: new Date().toISOString(),
    before: side(before, ranges.before),
    after: side(after, ranges.after),
    byPattern,
    byProject,
    byModel,
  };
}

/** Build both range reports from one set of loaded sessions and diff them. */
export function diffRanges(sessions: Session[], ranges: { before: Range; after: Range }, pricer: Pricer, opts: BuildOptions = {}): DiffReport {
  const before = rangeReport(sessions, ranges.before, pricer, opts);
  const after = rangeReport(sessions, ranges.after, pricer, opts);
  return diffReports(before, after, ranges, opts.version);
}

/**
 * Resolve the two ranges. `diff --from 14d --to 7d` compares [14d ago, 7d ago) with [7d ago, now];
 * `--since 7d --compare` compares the last 7 days with the 7 days before.
 */
export function resolveRanges(o: { from?: number; to?: number; until?: number; now?: number }): { before: Range; after: Range } {
  const now = o.now ?? Date.now();
  const end = o.until ?? now;
  const to = o.to ?? end - 7 * 86400e3;
  const from = o.from ?? to - (end - to);
  if (!(from < to && to < end)) throw new Error('diff needs --from < --to < --until (e.g. --from 14d --to 7d)');
  return { before: { start: from, end: to - 1 }, after: { start: to, end } };
}
