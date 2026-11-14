import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PricingTable } from './index.js';

/**
 * Opt-in pricing updates. `tokenscope --update-pricing` downloads the repository's own
 * `src/pricing/pricing.json`, validates it, and caches it in the user's cache directory.
 * This is the only network access tokenscope ever makes, and it never happens by default:
 * normal runs only *read* the cached copy (when it is newer than the built-in table).
 */

export const DEFAULT_FEED_URL = 'https://raw.githubusercontent.com/mintwork/tokenscope/main/src/pricing/pricing.json';
/** Larger than any plausible price table; stops a bad mirror from filling memory or disk. */
export const MAX_FEED_BYTES = 1024 * 1024;
const MAX_MODELS = 2000;
const MAX_PRICE = 10_000; // USD per 1M tokens

/** Feed URL; `TOKENSCOPE_PRICING_URL` overrides it (for tests and mirrors). */
export const feedUrl = (): string => process.env.TOKENSCOPE_PRICING_URL || DEFAULT_FEED_URL;

/** Per-user cache dir: $TOKENSCOPE_CACHE_DIR, else %LOCALAPPDATA%\tokenscope, $XDG_CACHE_HOME/tokenscope or ~/.cache/tokenscope. */
export function cacheDir(): string {
  if (process.env.TOKENSCOPE_CACHE_DIR) return process.env.TOKENSCOPE_CACHE_DIR;
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'tokenscope');
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'tokenscope');
}

export const cachedFeedFile = (): string => path.join(cacheDir(), 'pricing.json');

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isPrice = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_PRICE;

/** Throw unless `x` is a well-formed pricing table; returns it typed. */
export function validatePricing(x: unknown): PricingTable {
  const fail = (msg: string): never => {
    throw new Error(`invalid pricing table: ${msg}`);
  };
  if (!isObj(x)) fail('not a JSON object');
  const t = x as Record<string, unknown>;
  if (typeof t.updated !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(t.updated) || Number.isNaN(Date.parse(t.updated)))
    fail('"updated" must be a YYYY-MM-DD date');
  if (!isObj(t.defaults)) fail('"defaults" missing');
  const d = t.defaults as Record<string, unknown>;
  for (const k of ['cacheReadMultiplier', 'cacheWrite5mMultiplier', 'cacheWrite1hMultiplier', 'fastMultiplier'])
    if (!isPrice(d[k]) || (d[k] as number) > 100) fail(`defaults.${k} must be a number between 0 and 100`);
  if (!isObj(t.models)) fail('"models" missing');
  const models = Object.entries(t.models as Record<string, unknown>);
  if (!models.length) fail('"models" is empty');
  if (models.length > MAX_MODELS) fail(`more than ${MAX_MODELS} models`);
  for (const [id, r] of models) {
    if (!id || id.length > 200) fail(`bad model id "${id.slice(0, 40)}"`);
    if (!isObj(r)) fail(`models["${id}"] is not an object`);
    const rate = r as Record<string, unknown>;
    if (!isPrice(rate.input) || !isPrice(rate.output)) fail(`models["${id}"] needs non-negative input and output prices`);
    for (const k of ['cacheRead', 'cacheWrite5m', 'cacheWrite1h'])
      if (rate[k] !== undefined && !isPrice(rate[k])) fail(`models["${id}"].${k} must be a non-negative number`);
    if (rate.fastMultiplier !== undefined && (!isPrice(rate.fastMultiplier) || rate.fastMultiplier > 100))
      fail(`models["${id}"].fastMultiplier must be a number between 0 and 100`);
    if (rate.tiers !== undefined) {
      if (!Array.isArray(rate.tiers)) fail(`models["${id}"].tiers must be an array`);
      for (const tier of rate.tiers as unknown[]) {
        if (!isObj(tier)) fail(`models["${id}"].tiers has a non-object entry`);
        const tr = tier as Record<string, unknown>;
        if (typeof tr.aboveInputTokens !== 'number' || !Number.isInteger(tr.aboveInputTokens) || tr.aboveInputTokens < 0)
          fail(`models["${id}"].tiers[].aboveInputTokens must be a non-negative integer`);
        if (!isPrice(tr.input) || !isPrice(tr.output)) fail(`models["${id}"].tiers[] needs input and output prices`);
        if (tr.cacheRead !== undefined && !isPrice(tr.cacheRead)) fail(`models["${id}"].tiers[].cacheRead must be a non-negative number`);
      }
    }
  }
  if (t.sources !== undefined && !isObj(t.sources)) fail('"sources" must be an object');
  return x as unknown as PricingTable;
}

/** The cached feed, or undefined when there is none or it doesn't validate (a corrupt cache is ignored). */
export function readCachedFeed(file = cachedFeedFile()): PricingTable | undefined {
  try {
    return validatePricing(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return undefined;
  }
}

export interface UpdateResult {
  table: PricingTable;
  file: string;
  url: string;
  models: number;
}

/** Download, validate and cache the published pricing table. Throws on any failure; the old cache is kept. */
export async function updatePricing(url = feedUrl(), file = cachedFeedFile(), timeoutMs = 10_000): Promise<UpdateResult> {
  if (!/^https?:\/\//i.test(url)) throw new Error(`pricing feed URL must be http(s): ${url}`);
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow', headers: { accept: 'application/json' } });
  } catch (err) {
    throw new Error(`could not fetch ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(`could not fetch ${url}: HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_FEED_BYTES) throw new Error(`pricing feed is too large (${declared} bytes)`);
  const body = await res.text();
  if (Buffer.byteLength(body) > MAX_FEED_BYTES) throw new Error('pricing feed is too large');
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`pricing feed at ${url} is not valid JSON`);
  }
  const table = validatePricing(json);
  mkdirSync(path.dirname(file), { recursive: true });
  // write then rename, so a crash never leaves a half-written cache
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(table, null, 2));
  renameSync(tmp, file);
  return { table, file, url, models: Object.keys(table.models).length };
}
