import { describe, expect, it } from 'vitest';
import { Pricer, normalizeModel } from '../src/pricing/index.js';
import { emptyUsage } from '../src/types.js';

describe('normalizeModel', () => {
  it.each([
    ['claude-opus-4-5-20251101', 'claude-opus-4-5'],
    ['us.anthropic.claude-opus-5-5', 'claude-opus-5-5'],
    ['anthropic.claude-haiku-4-5-20251001-v1:0', 'claude-haiku-4-5'],
    ['claude-sonnet-4-5@20250929', 'claude-sonnet-4-5'],
    ['claude-opus-4-8[1m]', 'claude-opus-4-8'],
    ['GPT-5-Codex', 'gpt-5-codex'],
  ])('%s -> %s', (id, want) => expect(normalizeModel(id)).toBe(want));
});

describe('Pricer', () => {
  const p = new Pricer();

  it('uses explicit cache-read price when given (Opus 5.5 = $0.20)', () => {
    const r = p.rates('claude-opus-5-5')!;
    expect(r).toMatchObject({ input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 });
  });

  it('derives cache prices from multipliers', () => {
    const r = p.rates('claude-haiku-4-5-20251001')!;
    expect(r.cacheRead).toBeCloseTo(0.1);
    expect(r.cacheWrite5m).toBeCloseTo(1.25);
    expect(r.cacheWrite1h).toBeCloseTo(2);
  });

  it('matches by longest prefix', () => {
    expect(p.lookup('claude-opus-4-1-20250805')?.key).toBe('claude-opus-4-1');
    expect(p.lookup('claude-opus-4-0')?.key).toBe('claude-opus-4');
    expect(p.lookup('gpt-5-codex-preview')?.key).toBe('gpt-5-codex');
  });

  it('applies long-context tiers', () => {
    expect(p.rates('claude-sonnet-4-5', 100_000)!.input).toBe(3);
    expect(p.rates('claude-sonnet-4-5', 250_000)!.input).toBe(6);
    expect(p.rates('claude-sonnet-4-5', 250_000)!.cacheWrite5m).toBeCloseTo(7.5);
  });

  it('applies the fast-mode multiplier', () => {
    expect(p.rates('claude-opus-5-5', 0, true)!.output).toBe(40);
  });

  it('prices every token type', () => {
    const u = { ...emptyUsage(), input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 };
    // 4 + 20 + 0.2 + 5 + 8
    expect(p.costOf('claude-opus-5-5', u)).toBeCloseTo(37.2);
  });

  it('reports unknown models', () => {
    const q = new Pricer();
    expect(q.costOf('mystery-model', emptyUsage())).toBeUndefined();
    expect([...q.unknownModels]).toEqual(['mystery-model']);
  });

  it('merges a custom pricing file over the built-in table', () => {
    const q = new Pricer({ ...p.table, models: { ...p.table.models, 'mystery-model': { input: 1, output: 2 } } });
    expect(q.rates('mystery-model')!.cacheRead).toBeCloseTo(0.1);
  });
});
