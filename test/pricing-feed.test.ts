import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cacheDir, readCachedFeed, updatePricing, validatePricing } from '../src/pricing/feed.js';
import { Pricer, loadPricing } from '../src/pricing/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const builtin = JSON.parse(readFileSync(path.join(root, 'src/pricing/pricing.json'), 'utf8'));
const clone = () => JSON.parse(JSON.stringify(builtin));
/** The built-in table, a year newer, with one price changed so we can tell which one is in use. */
const newer = () => {
  const t = clone();
  t.updated = '2099-01-01';
  t.models['claude-opus-5-5'].input = 3;
  return t;
};
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'tokenscope-feed-'));

describe('validatePricing', () => {
  it('accepts the shipped pricing.json', () => {
    expect(() => validatePricing(clone())).not.toThrow();
  });
  it.each<[string, (t: any) => unknown]>([
    ['not an object', () => []],
    ['missing updated', (t) => (delete t.updated, t)],
    ['bad updated date', (t) => ((t.updated = 'yesterday'), t)],
    ['missing defaults', (t) => (delete t.defaults, t)],
    ['non-numeric multiplier', (t) => ((t.defaults.cacheReadMultiplier = '0.1'), t)],
    ['empty models', (t) => ((t.models = {}), t)],
    ['negative price', (t) => ((t.models['claude-opus-5-5'].input = -1), t)],
    ['missing output price', (t) => (delete t.models['claude-opus-5-5'].output, t)],
    ['NaN-ish cache price', (t) => ((t.models['claude-opus-5-5'].cacheRead = null), t)],
    ['absurd price', (t) => ((t.models['claude-opus-5-5'].input = 1e9), t)],
    ['bad tier', (t) => ((t.models['claude-opus-5-5'].tiers = [{ aboveInputTokens: 'lots', input: 1, output: 2 }]), t)],
  ])('rejects %s', (_name, mutate) => {
    expect(() => validatePricing(mutate(clone()))).toThrow(/invalid pricing table/);
  });
});

describe('cached feed precedence', () => {
  it('uses a cached feed only when enabled and newer than the built-in table', () => {
    const dir = tmp();
    const file = path.join(dir, 'pricing.json');
    writeFileSync(file, JSON.stringify(newer()));
    const feed = loadPricing(undefined, { useFeed: true, feedFile: file });
    expect(feed).toMatchObject({ source: 'feed', updated: '2099-01-01' });
    expect(new Pricer(feed).rates('claude-opus-5-5')!.input).toBe(3);
    // not enabled -> built-in
    expect(loadPricing(undefined, { feedFile: file }).source).toBe('builtin');
    rmSync(dir, { recursive: true, force: true });
  });

  it('ignores a cached feed older than (or as old as) the built-in table', () => {
    const dir = tmp();
    const file = path.join(dir, 'pricing.json');
    const old = newer();
    old.updated = '2000-01-01';
    writeFileSync(file, JSON.stringify(old));
    expect(loadPricing(undefined, { useFeed: true, feedFile: file }).source).toBe('builtin');
    writeFileSync(file, JSON.stringify({ ...newer(), updated: builtin.updated }));
    expect(loadPricing(undefined, { useFeed: true, feedFile: file }).source).toBe('builtin');
    rmSync(dir, { recursive: true, force: true });
  });

  it('ignores a corrupt or invalid cache', () => {
    const dir = tmp();
    const file = path.join(dir, 'pricing.json');
    writeFileSync(file, '{ not json');
    expect(readCachedFeed(file)).toBeUndefined();
    writeFileSync(file, JSON.stringify({ ...newer(), models: { x: { input: -5, output: 1 } } }));
    expect(readCachedFeed(file)).toBeUndefined();
    expect(loadPricing(undefined, { useFeed: true, feedFile: file }).source).toBe('builtin');
    expect(readCachedFeed(path.join(dir, 'missing.json'))).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('merges --pricing overrides on top of the feed', () => {
    const dir = tmp();
    const file = path.join(dir, 'pricing.json');
    writeFileSync(file, JSON.stringify(newer()));
    const custom = path.join(dir, 'custom.json');
    writeFileSync(custom, JSON.stringify({ models: { 'my-model': { input: 1, output: 2 } } }));
    const t = loadPricing(custom, { useFeed: true, feedFile: file });
    expect(t.source).toBe('feed');
    expect(t.models['claude-opus-5-5'].input).toBe(3);
    expect(t.models['my-model']).toEqual({ input: 1, output: 2 });
    rmSync(dir, { recursive: true, force: true });
  });

  it('honors TOKENSCOPE_CACHE_DIR', () => {
    const prev = process.env.TOKENSCOPE_CACHE_DIR;
    process.env.TOKENSCOPE_CACHE_DIR = '/somewhere/else';
    expect(cacheDir()).toBe('/somewhere/else');
    if (prev === undefined) delete process.env.TOKENSCOPE_CACHE_DIR;
    else process.env.TOKENSCOPE_CACHE_DIR = prev;
  });
});

describe('--update-pricing against a local server (no real network)', () => {
  let server: Server;
  let base = '';
  const routes = new Map<string, () => { status: number; body: string }>([
    ['/good.json', () => ({ status: 200, body: JSON.stringify(newer()) })],
    ['/bad.json', () => ({ status: 200, body: JSON.stringify({ ...newer(), defaults: {} }) })],
    ['/garbage.json', () => ({ status: 200, body: '<html>rate limited</html>' })],
    ['/huge.json', () => ({ status: 200, body: ' '.repeat(1024 * 1024 + 10) })],
  ]);
  beforeAll(async () => {
    server = createServer((req, res) => {
      const route = routes.get(req.url ?? '');
      const r = route ? route() : { status: 404, body: 'not found' };
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(r.body);
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

  it('downloads, validates and caches the table', async () => {
    const dir = tmp();
    const file = path.join(dir, 'sub', 'pricing.json');
    const r = await updatePricing(`${base}/good.json`, file);
    expect(r.table.updated).toBe('2099-01-01');
    expect(r.models).toBe(Object.keys(builtin.models).length);
    expect(readCachedFeed(file)?.updated).toBe('2099-01-01');
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the previous cache when the download is invalid, unreachable or too large', async () => {
    const dir = tmp();
    const file = path.join(dir, 'pricing.json');
    await updatePricing(`${base}/good.json`, file);
    await expect(updatePricing(`${base}/bad.json`, file)).rejects.toThrow(/invalid pricing table/);
    await expect(updatePricing(`${base}/garbage.json`, file)).rejects.toThrow(/not valid JSON/);
    await expect(updatePricing(`${base}/huge.json`, file)).rejects.toThrow(/too large/);
    await expect(updatePricing(`${base}/missing.json`, file)).rejects.toThrow(/HTTP 404/);
    await expect(updatePricing('file:///etc/passwd', file)).rejects.toThrow(/http/);
    expect(readCachedFeed(file)?.updated).toBe('2099-01-01');
    rmSync(dir, { recursive: true, force: true });
  });

  it('CLI: --update-pricing alone updates and exits; later runs use the cache, --no-pricing-cache skips it', async () => {
    const run = promisify(execFile);
    const dir = tmp();
    const env = { ...process.env, TOKENSCOPE_CACHE_DIR: dir, TOKENSCOPE_PRICING_URL: `${base}/good.json`, NO_COLOR: '1' };
    const cli = path.join(root, 'dist/cli.js');
    const up = await run(process.execPath, [cli, '--update-pricing'], { env });
    expect(up.stdout).toBe('');
    expect(up.stderr).toContain('pricing table updated 2099-01-01');
    const fixtures = ['--dir', path.join(here, 'fixtures/claude/projects'), '--json'];
    const withFeed = JSON.parse((await run(process.execPath, [cli, ...fixtures], { env, maxBuffer: 1 << 26 })).stdout);
    expect(withFeed).toMatchObject({ pricingSource: 'feed', pricingUpdated: '2099-01-01' });
    const without = JSON.parse((await run(process.execPath, [cli, ...fixtures, '--no-pricing-cache'], { env, maxBuffer: 1 << 26 })).stdout);
    expect(without).toMatchObject({ pricingSource: 'builtin', pricingUpdated: builtin.updated });
    rmSync(dir, { recursive: true, force: true });
  });
});
