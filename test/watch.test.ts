import { spawn } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { Pricer } from '../src/pricing/index.js';
import type { ApiCall, Session, ToolCall } from '../src/types.js';
import { FULL_CAPS, emptyUsage } from '../src/types.js';
import { Watcher, listSessionFiles, loadSession, pickSession } from '../src/watch.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const T0 = Date.parse('2026-11-01T10:00:00Z');
const MIN = 60_000;

/** claude-opus-4-5: input $5, cache read $0.50, 5m write $6.25, 1h write $10 per 1M. */
function call(id: string, min: number, u: Partial<ApiCall['usage']>, tools: ToolCall[] = []): ApiCall {
  return { id, timestamp: T0 + min * MIN, model: 'claude-opus-4-5', usage: { ...emptyUsage(), output: 10, ...u }, toolCalls: tools, cost: 0 };
}
function session(calls: ApiCall[], id = 's1'): Session {
  return {
    id,
    source: 'claude-code',
    caps: { ...FULL_CAPS },
    project: 'p',
    file: 'x',
    start: T0,
    end: T0,
    turns: [{ index: 0, timestamp: T0, prompt: 'go', calls }],
  };
}
const bash = (i: number): ToolCall => ({ id: `t${i}`, name: 'Bash', target: 'npm test', key: 'Bash:npm test', resultChars: 400, resultHash: 'same', isError: true });
const texts = (a: { text: string }[]) => a.map((x) => x.text);

describe('Watcher: cache expiry', () => {
  it('warns ~1 min before a 5-minute cache expires, then once when it has', () => {
    const w = new Watcher(new Pricer());
    const s = session([call('a', 0, { cacheWrite5m: 180_000 })]);
    expect(w.check(s, T0 + 1 * MIN).map((a) => a.kind)).toEqual(['summary']);
    expect(w.check(s, T0 + 3 * MIN)).toEqual([]);
    const soon = w.check(s, T0 + 4.2 * MIN);
    expect(soon).toHaveLength(1);
    expect(soon[0]).toMatchObject({ kind: 'expiring' });
    expect(soon[0].text).toContain('cache expires in ~1 min');
    expect(w.check(s, T0 + 4.5 * MIN)).toEqual([]);
    const expired = w.check(s, T0 + 6 * MIN);
    expect(expired).toHaveLength(1);
    // 180k x (6.25 - 0.50) / 1M = $1.035
    expect(expired[0].text).toBe('cache likely expired (5-minute TTL, idle 6 min): the next message re-writes ~180k tokens (~$1.04) instead of reading them from cache');
    expect(w.check(s, T0 + 10 * MIN)).toEqual([]);
  });

  it('re-arms after the next API call', () => {
    const w = new Watcher(new Pricer());
    const calls = [call('a', 0, { cacheWrite5m: 50_000 })];
    w.check(session(calls), T0);
    expect(w.check(session(calls), T0 + 7 * MIN).map((a) => a.kind)).toEqual(['expired']);
    calls.push(call('b', 8, { cacheWrite5m: 50_000 }));
    expect(w.check(session(calls), T0 + 9 * MIN)).toEqual([]);
    expect(w.check(session(calls), T0 + 14 * MIN).map((a) => a.kind)).toEqual(['expired']);
  });

  it('respects a 1-hour TTL, judged by the latest cache write', () => {
    const w = new Watcher(new Pricer());
    const s = session([call('a', 0, { cacheWrite1h: 100_000 }), call('b', 1, { cacheRead: 100_000 })]);
    w.check(s, T0 + 1 * MIN);
    expect(w.check(s, T0 + 10 * MIN)).toEqual([]);
    expect(texts(w.check(s, T0 + 60.5 * MIN))[0]).toContain('cache expires in ~1 min');
    const [a] = w.check(s, T0 + 62 * MIN);
    // 100k x (10 - 0.50) / 1M = $0.95
    expect(a.text).toContain('1-hour TTL');
    expect(a.text).toContain('~100k tokens (~$0.95)');
  });

  it('stays quiet for small contexts, uncached calls and long-dead sessions', () => {
    const p = new Pricer();
    const small = new Watcher(p);
    small.check(session([call('a', 0, { cacheWrite5m: 3_000 })]), T0);
    expect(small.check(session([call('a', 0, { cacheWrite5m: 3_000 })]), T0 + 6 * MIN)).toEqual([]);
    const uncached = new Watcher(p);
    uncached.check(session([call('a', 0, { input: 90_000 })]), T0);
    expect(uncached.check(session([call('a', 0, { input: 90_000 })]), T0 + 6 * MIN)).toEqual([]);
    const old = new Watcher(p);
    expect(old.check(session([call('a', 0, { cacheWrite5m: 90_000 })]), T0 + 5 * 3600e3).map((a) => a.kind)).toEqual(['summary']);
  });
});

describe('Watcher: waste findings', () => {
  it('summarizes existing findings on start, then prints each new one once', () => {
    const w = new Watcher(new Pricer());
    const calls = [call('a', 0, { cacheWrite5m: 10_000 }, [bash(1)]), call('b', 1, { cacheRead: 10_000 }, [bash(2)])];
    expect(texts(w.check(session(calls), T0 + 1 * MIN))).toEqual(['no waste patterns so far in this session']);
    calls.push(call('c', 2, { cacheRead: 10_000 }, [bash(3)]));
    const [loop, ...rest] = w.check(session(calls), T0 + 2 * MIN);
    expect(rest).toEqual([]);
    expect(loop.kind).toBe('finding');
    expect(loop.text).toContain('Bash called 3× in a row, same input & same result');
    expect(loop.text).toContain('↳ Interrupt as soon as');
    expect(w.check(session(calls), T0 + 2.5 * MIN)).toEqual([]);
    // the loop keeps going: one update, not a duplicate per poll
    calls.push(call('d', 3, { cacheRead: 10_000 }, [bash(4)]));
    const [more] = w.check(session(calls), T0 + 3 * MIN);
    expect(more.text).toMatch(/^still Bash called 4×/);
    expect(w.check(session(calls), T0 + 3.5 * MIN)).toEqual([]);
  });

  it('reports a running total when a new turn starts, and resets on a new session', () => {
    const w = new Watcher(new Pricer());
    const s = session([call('a', 0, { cacheWrite5m: 10_000 })]);
    w.check(s, T0);
    s.turns.push({ index: 1, timestamp: T0 + MIN, prompt: 'next', calls: [call('b', 1, { cacheRead: 10_000 })] });
    const [turn] = w.check(s, T0 + MIN);
    expect(turn).toMatchObject({ kind: 'turn' });
    expect(turn.text).toMatch(/^turn 2 started · session so far \$0\.\d\d in 2 API calls$/);
    expect(w.check(session([call('z', 0, { cacheWrite5m: 10_000 })], 's2'), T0).map((a) => a.kind)).toEqual(['summary']);
  });
});

const FIXTURES = path.join(here, 'fixtures/claude/projects');

describe('session discovery', () => {
  it('lists top-level session files newest first, never subagent transcripts', async () => {
    const files = await listSessionFiles([FIXTURES]);
    expect(files.map((f) => path.basename(f.file)).sort()).toEqual(['sess-alpha.jsonl', 'sess-beta.jsonl']);
  });
  it('pins by id prefix and filters by project', async () => {
    expect(path.basename((await pickSession([FIXTURES], { session: 'sess-al' }))!)).toBe('sess-alpha.jsonl');
    expect(path.basename((await pickSession([FIXTURES], { project: 'web' }))!)).toBe('sess-beta.jsonl');
    expect(await pickSession([FIXTURES], { session: 'nope' })).toBeUndefined();
  });
  it('loads a session with its subagents attached', async () => {
    const s = (await loadSession(path.join(FIXTURES, '-Users-demo-acme-api/sess-alpha.jsonl')))!;
    expect(s.id).toBe('sess-alpha');
    expect(s.turns.flatMap((t) => t.calls).some((c) => c.toolCalls.some((tc) => tc.subagent))).toBe(true);
  });
});

describe('tokenscope watch (CLI)', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'tokenscope-watch-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const cli = path.join(here, '..', 'dist', 'cli.js');

  it('prints help', async () => {
    const out = await new Promise<string>((resolve) => {
      const p = spawn(process.execPath, [cli, 'watch', '--help']);
      let s = '';
      p.stdout.on('data', (d) => (s += d));
      p.on('close', () => resolve(s));
    });
    expect(out).toContain('live waste alerts for the active Claude Code session');
  });

  it('tails the newest session, picks up new API calls, and exits cleanly on Ctrl-C', { timeout: 20_000, skip: process.platform === 'win32' }, async () => {
    cpSync(FIXTURES, tmp, { recursive: true });
    const beta = path.join(tmp, '-Users-demo-web', 'sess-beta.jsonl');
    const alpha = path.join(tmp, '-Users-demo-acme-api', 'sess-alpha.jsonl');
    utimesSync(alpha, new Date(T0), new Date(T0)); // make beta the newest
    const p = spawn(process.execPath, [cli, 'watch', '--dir', tmp, '--interval', '0.2', '--no-color']);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const waitFor = async (re: RegExp) => {
      for (let i = 0; i < 100 && !re.test(out); i++) await new Promise((r) => setTimeout(r, 100));
      expect(out, err).toMatch(re);
    };
    await waitFor(/tokenscope watch · web/);
    await waitFor(/so far in this session/);
    // a new prompt and a fresh API call land in the log (cached 3 minutes ago)
    const ts = new Date(Date.now() - 4.5 * MIN).toISOString();
    const base = { sessionId: 'sess-beta', cwd: '/Users/demo/web', timestamp: ts };
    appendFileSync(
      beta,
      JSON.stringify({ ...base, type: 'user', message: { role: 'user', content: 'and now the footer' } }) +
        '\n' +
        JSON.stringify({
          ...base,
          type: 'assistant',
          message: { id: 'msg_live', model: 'claude-opus-4-5-20251101', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 5, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 2_000, output_tokens: 20 } },
        }) +
        '\n',
    );
    await waitFor(/turn \d+ started · session so far/);
    await waitFor(/cache expires in ~1 min: ~42k tokens are cached/);
    p.kill('SIGINT');
    const code = await new Promise<number | null>((resolve) => p.on('close', resolve));
    expect(code).toBe(0);
    expect(out).toMatch(/stopped after \d+ min · 1 alert · session spend \$/);
  });
});
