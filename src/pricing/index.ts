import { readFileSync } from 'node:fs';

// pricing.json sits next to this module in both src/ and dist/ (copied at build time)
const builtin: unknown = JSON.parse(readFileSync(new URL('./pricing.json', import.meta.url), 'utf8'));
import type { ApiCall, Usage } from '../types.js';

export interface Rate {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  fastMultiplier?: number;
  tiers?: Array<{ aboveInputTokens: number; input: number; output: number; cacheRead?: number }>;
}

export interface PricingTable {
  updated?: string;
  defaults: { cacheReadMultiplier: number; cacheWrite5mMultiplier: number; cacheWrite1hMultiplier: number; fastMultiplier: number };
  models: Record<string, Rate>;
}

export interface ResolvedRate {
  key: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export function loadPricing(file?: string): PricingTable {
  const base = builtin as unknown as PricingTable;
  if (!file) return base;
  const custom = JSON.parse(readFileSync(file, 'utf8')) as Partial<PricingTable>;
  return {
    updated: custom.updated ?? base.updated,
    defaults: { ...base.defaults, ...(custom.defaults ?? {}) },
    models: { ...base.models, ...(custom.models ?? {}) },
  };
}

/** "us.anthropic.claude-opus-4-8-20260101-v1:0" -> "claude-opus-4-8" */
export function normalizeModel(id: string): string {
  let m = id.toLowerCase().trim();
  m = m.replace(/\[[^\]]*\]$/, ''); // [1m]
  m = m.replace(/^(?:[a-z]{2,6}\.)?anthropic\./, ''); // bedrock: us.anthropic. / anthropic.
  m = m.replace(/^(?:anthropic|openai)\//, ''); // openrouter-style
  m = m.replace(/-v\d+(?::\d+)?$/, '');
  m = m.replace(/@\d{8}$/, ''); // vertex
  m = m.replace(/-\d{8}$/, ''); // dated snapshot
  return m;
}

export class Pricer {
  private cache = new Map<string, Rate | null>();
  readonly unknownModels = new Set<string>();
  constructor(readonly table: PricingTable = loadPricing()) {}

  lookup(model: string): { key: string; rate: Rate } | undefined {
    const norm = normalizeModel(model);
    if (!this.cache.has(norm)) {
      let key: string | undefined = this.table.models[norm] ? norm : undefined;
      if (!key) {
        // longest key that is a prefix of the id (e.g. "claude-opus-4" for "claude-opus-4-0")
        for (const k of Object.keys(this.table.models))
          if (norm.startsWith(k) && (!key || k.length > key.length)) key = k;
      }
      this.cache.set(norm, key ? { ...this.table.models[key], key } as Rate & { key: string } : null);
    }
    const r = this.cache.get(norm) as (Rate & { key: string }) | null;
    return r ? { key: r.key, rate: r } : undefined;
  }

  /** Resolve per-1M rates for a request with the given prompt size. */
  rates(model: string, promptTokens = 0, fast = false): ResolvedRate | undefined {
    const hit = this.lookup(model);
    if (!hit) return undefined;
    const d = this.table.defaults;
    const r = hit.rate;
    let input = r.input;
    let output = r.output;
    let cacheRead = r.cacheRead ?? input * d.cacheReadMultiplier;
    const tier = (r.tiers ?? [])
      .filter((t) => promptTokens > t.aboveInputTokens)
      .sort((a, b) => b.aboveInputTokens - a.aboveInputTokens)[0];
    if (tier) {
      input = tier.input;
      output = tier.output;
      cacheRead = tier.cacheRead ?? input * d.cacheReadMultiplier;
    }
    const fm = fast ? (r.fastMultiplier ?? d.fastMultiplier) : 1;
    return {
      key: hit.key,
      input: input * fm,
      output: output * fm,
      cacheRead: cacheRead * fm,
      cacheWrite5m: (tier ? input * d.cacheWrite5mMultiplier : r.cacheWrite5m ?? input * d.cacheWrite5mMultiplier) * fm,
      cacheWrite1h: (tier ? input * d.cacheWrite1hMultiplier : r.cacheWrite1h ?? input * d.cacheWrite1hMultiplier) * fm,
    };
  }

  costOf(model: string, u: Usage, fast = false): number | undefined {
    const prompt = u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
    const r = this.rates(model, prompt, fast);
    if (!r) {
      this.unknownModels.add(model);
      return undefined;
    }
    return (
      (u.input * r.input +
        u.output * r.output +
        u.cacheRead * r.cacheRead +
        u.cacheWrite5m * r.cacheWrite5m +
        u.cacheWrite1h * r.cacheWrite1h) /
      1e6
    );
  }

  /** Mutates `call.cost` / `call.unpriced`. */
  price(call: ApiCall): void {
    const c = this.costOf(call.model, call.usage, call.fast);
    call.cost = c ?? 0;
    call.unpriced = c === undefined;
  }
}
