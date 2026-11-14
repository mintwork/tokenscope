import { describe, expect, it } from 'vitest';
import { buildReport } from '../src/analyze/report.js';
import { detectWaste, type WasteStats } from '../src/analyze/waste.js';
import { Pricer } from '../src/pricing/index.js';
import type { Session } from '../src/types.js';
import { FULL_CAPS, emptyUsage } from '../src/types.js';

/**
 * Synthetic sessions for the cache-rebuild counterfactual.
 * Model claude-opus-4-5: input $5, cache read $0.50, 5m write $6.25, 1h write $10 per 1M.
 */
interface Step {
  min: number; // minutes since start
  cw?: number;
  cr?: number;
  turn?: string; // starts a new user turn (a human message preceded this call)
  tool?: { name: string; cmd: string; doneMin: number };
}

const T0 = Date.parse('2026-11-01T10:00:00Z');
function session(steps: Step[]): Session {
  const s: Session = { id: 's', source: 'claude-code', caps: { ...FULL_CAPS }, project: 'p', file: 'x', start: T0, end: T0, turns: [] };
  let i = 0;
  let pendingTool: Step['tool'];
  for (const st of steps) {
    if (st.turn || !s.turns.length) s.turns.push({ index: s.turns.length, timestamp: T0 + st.min * 60e3, prompt: st.turn ?? 'start', calls: [] });
    const call = {
      id: `c${i++}`,
      timestamp: T0 + st.min * 60e3,
      model: 'claude-opus-4-5',
      usage: { ...emptyUsage(), cacheWrite5m: st.cw ?? 0, cacheRead: st.cr ?? 0, output: 10 },
      toolCalls: [] as Session['turns'][0]['calls'][0]['toolCalls'],
      cost: 0,
    };
    if (st.tool) pendingTool = st.tool;
    if (st.tool)
      call.toolCalls.push({ id: `t${i}`, name: st.tool.name, target: st.tool.cmd, key: st.tool.cmd, resultChars: 10, resultHash: `h${i}`, isError: false, resultAt: T0 + st.tool.doneMin * 60e3 });
    s.turns[s.turns.length - 1].calls.push(call);
    s.end = call.timestamp;
  }
  void pendingTool;
  return s;
}

const cacheFindings = (s: Session, stats?: WasteStats) => detectWaste([s], new Pricer(), {}, stats).filter((f) => f.kind === 'cache-miss');

describe('cache rebuilds: 1-hour TTL counterfactual', () => {
  it('human reply after 12 min: net saving of a 1h TTL, after its write premium', () => {
    const s = session([
      { min: 0, cw: 100_000, turn: 'go' },
      { min: 1, cw: 1_000, cr: 100_000 },
      { min: 13, cw: 101_000, turn: 'thanks, now do X' },
    ]);
    const [f] = cacheFindings(s);
    expect(f).toMatchObject({ cause: 'pause', certainty: 'avoidable', count: 1 });
    // actual: 0.625 + 0.05625 + 0.63125 = 1.3125 ; 1h TTL: 1.0 + 0.06 + 0.0505 = 1.1105
    expect(f.cost).toBeCloseTo(1.3125 - 1.1105, 6);
    expect(f.tip).toContain('promptCacheTtl');
    expect(f.tip).not.toMatch(/^.*\/clear or start/);
    expect(f.detail).toContain('median 12 min');
  });

  it('long tool wait: attributed to the tool that ran long', () => {
    const s = session([
      { min: 0, cw: 100_000, turn: 'build it' },
      { min: 1, cw: 1_000, cr: 100_000, tool: { name: 'Bash', cmd: 'npm run build', doneMin: 12 } },
      { min: 12.2, cw: 101_000 },
    ]);
    const [f] = cacheFindings(s);
    expect(f).toMatchObject({ cause: 'tool-wait', certainty: 'avoidable' });
    expect(f.detail).toContain('Bash(npm run build) 11 min');
    expect(f.tip).toContain('background');
  });

  it('gap over an hour: unavoidable, never counted as waste', () => {
    const stats: WasteStats = { unavoidableRebuilds: 0, unavoidableTokens: 0, unavoidableCost: 0, ttlGlobalNet: 0 };
    const s = session([
      { min: 0, cw: 100_000, turn: 'go' },
      { min: 1, cw: 1_000, cr: 100_000 },
      { min: 95, cw: 101_000, turn: 'back from lunch' },
    ]);
    expect(cacheFindings(s, stats)).toHaveLength(0);
    expect(stats.unavoidableRebuilds).toBe(1);
    const r = buildReport([session([
      { min: 0, cw: 100_000, turn: 'go' },
      { min: 1, cw: 1_000, cr: 100_000 },
      { min: 95, cw: 101_000, turn: 'back from lunch' },
    ])], new Pricer());
    expect(r.totals.avoidableCost).toBe(0);
    expect(r.totals.unavoidableRebuilds).toBe(1);
  });

  it('net-negative case: no finding when the 1h write premium outweighs the saving', () => {
    // the context is re-written after several >1h breaks; each of those writes would pay the 1h premium
    const s = session([
      { min: 0, cw: 100_000, turn: 'a' },
      { min: 1, cr: 100_000 },
      { min: 70, cw: 100_000, turn: 'b' },
      { min: 140, cw: 100_000, turn: 'c' },
      { min: 210, cw: 100_000, turn: 'd' },
      { min: 280, cw: 100_000, turn: 'e' },
      { min: 292, cw: 100_000, turn: 'f' }, // a 12-min pause - TTL-addressable, but not worth it here
    ]);
    expect(cacheFindings(s)).toHaveLength(0);
  });

  it('prefix change with no gap stays a likely-avoidable finding', () => {
    const s = session([
      { min: 0, cw: 100_000, turn: 'go' },
      { min: 1, cw: 1_000, cr: 100_000 },
      { min: 2, cw: 101_000 },
    ]);
    const [f] = cacheFindings(s);
    expect(f).toMatchObject({ cause: 'prefix', certainty: 'likely-avoidable' });
    expect(f.cost).toBeCloseTo((101_000 * (6.25 - 0.5)) / 1e6, 6);
  });

  it('headline counts realistic savings only', () => {
    const r = buildReport(
      [
        session([
          { min: 0, cw: 100_000, turn: 'go' },
          { min: 1, cw: 1_000, cr: 100_000 },
          { min: 2, cw: 101_000 }, // prefix change -> likely
          { min: 14, cw: 102_000, turn: 'next' }, // pause -> realistic
        ]),
      ],
      new Pricer(),
    );
    const realistic = r.findings.filter((f) => f.certainty === 'avoidable').reduce((n, f) => n + f.cost, 0);
    expect(r.totals.avoidableCost).toBeCloseTo(realistic, 10);
    expect(r.totals.likelyAvoidableCost).toBeGreaterThan(0);
    expect(r.totals.avoidableCost + r.totals.likelyAvoidableCost).toBeCloseTo(r.totals.wasteCost, 10);
  });
});
