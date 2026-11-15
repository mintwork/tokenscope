import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { diffRanges, resolveRanges } from '../src/analyze/diff.js';
import { buildReport, filterByTime } from '../src/analyze/report.js';
import { claudeCodeParser } from '../src/parsers/claude-code.js';
import { codexParser } from '../src/parsers/codex.js';
import { Pricer } from '../src/pricing/index.js';
import { renderDiffTerminal } from '../src/render/diff.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (p: string) => path.join(here, 'fixtures', p);
const load = async () => [...(await claudeCodeParser.load(fx('claude/projects'))), ...(await codexParser.load(fx('codex/sessions/2026/11')))];
const SPLIT = Date.parse('2026-11-03T00:00:00Z');
const ranges = { before: { start: Date.parse('2026-11-01T00:00:00Z'), end: SPLIT - 1 }, after: { start: SPLIT, end: Date.parse('2026-11-04T00:00:00Z') } };

describe('resolveRanges', () => {
  const now = Date.parse('2026-11-15T00:00:00Z');
  const day = 86400e3;
  it('defaults to the last 7 days vs the 7 days before', () => {
    expect(resolveRanges({ now })).toEqual({ before: { start: now - 14 * day, end: now - 7 * day - 1 }, after: { start: now - 7 * day, end: now } });
  });
  it('--from/--to, and --since --compare (equal length, just before)', () => {
    expect(resolveRanges({ from: now - 30 * day, to: now - 10 * day, now }).before.start).toBe(now - 30 * day);
    const r = resolveRanges({ to: now - 3 * day, now });
    expect(r.before).toEqual({ start: now - 6 * day, end: now - 3 * day - 1 });
  });
  it('rejects ranges in the wrong order', () => {
    expect(() => resolveRanges({ from: now - day, to: now - 2 * day, now })).toThrow(/--from < --to/);
  });
});

describe('diffRanges', async () => {
  const sessions = await load();
  const callCount = () => sessions.flatMap((s) => s.turns.flatMap((t) => t.calls)).length;
  const calls0 = callCount();
  const d = diffRanges(sessions, ranges, new Pricer(), { version: 'test' });

  it('each side equals a standalone report of that range', async () => {
    const before = buildReport(filterByTime(await load(), ranges.before.start, ranges.before.end), new Pricer());
    expect(d.before.cost).toBeCloseTo(before.totals.cost, 10);
    expect(d.before.avoidableCost).toBeCloseTo(before.totals.avoidableCost, 10);
    expect(d.before.sessions).toBe(2);
    expect(d.after.sessions).toBe(1);
    expect(d.after.wasteShare).toBe(0);
  });

  it('does not mutate the loaded sessions', () => {
    expect(callCount()).toBe(calls0);
    expect(sessions.every((s) => s.turns.every((t) => t.calls.every((c) => c.cost === 0)))).toBe(true);
  });

  it('lines up waste by pattern, project and model', () => {
    const huge = d.byPattern.find((r) => r.key === 'huge-output/likely-avoidable')!;
    expect(huge).toMatchObject({ beforeCount: 0, afterCount: 1 });
    expect(huge.delta).toBeGreaterThan(0);
    expect(d.byPattern[0].key).toBe('huge-output/likely-avoidable'); // biggest increase first
    const loop = d.byPattern.find((r) => r.key === 'loop/avoidable')!;
    expect(loop.delta).toBeLessThan(0);
    expect(d.byPattern.find((r) => r.key === 'cache-miss:pause/avoidable')!.label).toContain('read/replied');
    const acme = d.byProject.find((r) => r.key === 'acme-api')!;
    expect(acme.before).toBeCloseTo(d.before.avoidableCost, 10);
    expect(acme.after).toBe(0);
    expect(acme.costAfter).toBe(0);
    expect(d.byModel.find((r) => r.key === 'claude-sonnet-4-5')!.before).toBe(0);
  });

  it('renders a terminal diff', () => {
    const out = renderDiffTerminal(d, { color: false, width: 100, top: 8 });
    expect(out).toContain('tokenscope diff');
    expect(out).toContain('could have been saved');
    expect(out).toContain('Huge tool outputs (likely)');
    expect(out).toContain('Improved');
    expect(out).not.toMatch(/\x1b\[/);
  });

  it('an empty range is a zero side, not an error', () => {
    const e = diffRanges(sessions, { before: { start: 0, end: 1000 }, after: ranges.after }, new Pricer());
    expect(e.before).toMatchObject({ sessions: 0, cost: 0, avoidableCost: 0 });
  });
});

describe('CLI', () => {
  const cli = path.join(here, '../dist/cli.js');
  const run = (...args: string[]) => {
    const argv = args[0] === 'diff' ? ['diff', '--dir', fx('claude/projects'), ...args.slice(1)] : ['--dir', fx('claude/projects'), ...args];
    const r = spawnSync(process.execPath, [cli, ...argv], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  it('tokenscope diff --from --to --until --json', () => {
    const { code, out } = run('diff', '--from', '2026-11-01', '--to', '2026-11-03', '--until', '2026-11-04', '--json');
    expect(code).toBe(0);
    const d = JSON.parse(out);
    expect(d.before.sessions).toBe(1);
    expect(d.after.sessions).toBe(1);
    expect(d.byPattern.length).toBeGreaterThan(0);
  });
  it('--since --compare', () => {
    const { code, out } = run('--since', '2026-11-03', '--until', '2026-11-04', '--compare');
    expect(code).toBe(0);
    expect(out).toContain('tokenscope diff');
  });
  it('rejects mixed flags', () => {
    expect(run('diff', '--since', '7d').err).toContain('not --since');
    expect(run('--compare').err).toContain('--compare needs --since');
    expect(run('--from', '7d').err).toContain('tokenscope diff');
    expect(run('diff', '--html').err).toContain('terminal and --json');
  });
});
