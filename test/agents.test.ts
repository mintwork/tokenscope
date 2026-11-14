import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, cpSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildReport } from '../src/analyze/report.js';
import { ampParser } from '../src/parsers/amp.js';
import { droidParser, normalizeDroidModel } from '../src/parsers/droid.js';
import { openCodeParser } from '../src/parsers/opencode.js';
import { Pricer } from '../src/pricing/index.js';
import type { Session } from '../src/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (...p: string[]) => path.join(here, 'fixtures', ...p);
const calls = (s: Session) => s.turns.flatMap((t) => t.calls);

describe('droid parser (experimental)', async () => {
  const sessions = await droidParser.load(fx('droid/sessions'));
  const s = sessions.find((x) => x.id.startsWith('3f2a'))!;

  it('normalizes custom model names', () => {
    expect(normalizeDroidModel('custom:Claude-Opus-4.5-Thinking-[Anthropic]-0')).toBe('claude-opus-4-5-thinking-0');
    expect(normalizeDroidModel('Claude-Sonnet-4-[Anthropic]')).toBe('claude-sonnet-4');
  });

  it('keeps the newest copy of a duplicated (archived) session', () => {
    expect(sessions.filter((x) => x.id === s.id)).toHaveLength(1);
    const total = calls(s).find((c) => c.id.endsWith(':total'))!;
    expect(total.usage).toMatchObject({ input: 18420, output: 6310 + 2100, cacheRead: 512300, cacheWrite5m: 40210, reasoning: 2100 });
  });

  it('reads title/cwd and tool calls from the transcript', () => {
    expect(s.title).toBe('Fix flaky auth test in ./api');
    expect(s.project).toBe('api');
    expect(calls(s).flatMap((c) => c.toolCalls).map((t) => t.name)).toEqual(['Read', 'Read', 'Read']);
  });

  it('declares session totals only: no per-request detectors', () => {
    expect(s.caps).toMatchObject({ perRequestTokens: false, timestamps: false, toolCalls: true, filePaths: true });
    const bare = sessions.find((x) => x.id.startsWith('9b9b'))!;
    expect(bare.caps.toolCalls).toBe(false); // no transcript -> tool detectors can't run
    expect(calls(bare)[0].model).toBe('gpt-unknown');
  });

  it('report: reread found, cache check unavailable, totals-only session marked unchecked', () => {
    const r = buildReport(sessions, new Pricer(), { sourceInfo: { droid: { name: 'Factory Droid', verified: false } } });
    expect(r.findings.some((f) => f.kind === 'reread')).toBe(true);
    const cov = r.coverage.find((c) => c.source === 'droid')!;
    expect(cov.detectors.find((d) => d.kind === 'cache-miss')).toMatchObject({ status: 'no' });
    expect(cov.detectors.find((d) => d.kind === 'reread')).toMatchObject({ status: 'partial' });
    expect(r.sessions.find((x) => x.id.startsWith('9b9b'))!.waste).toBeNull();
  });
});

describe('amp parser (experimental)', async () => {
  const sessions = await amp();
  async function amp() {
    return ampParser.load(fx('amp/threads'));
  }
  const cur = sessions.find((s) => s.id.startsWith('T-7c1e'))!;
  const legacy = sessions.find((s) => s.id.startsWith('T-1111'))!;

  it('skips half-written thread files', () => {
    expect(sessions).toHaveLength(2);
  });

  it('reads per-message usage (input excludes cache)', () => {
    expect(cur.project).toBe('api');
    expect(cur.title).toBe('Fix flaky auth test');
    expect(calls(cur)).toHaveLength(4);
    expect(calls(cur)[1].usage).toMatchObject({ input: 6, output: 40, cacheRead: 8400, cacheWrite5m: 300 });
  });

  it('prefers the legacy usage ledger and joins cache tokens by message id', () => {
    const [c] = calls(legacy);
    expect(c).toMatchObject({ model: 'gpt-5' });
    expect(c.usage).toMatchObject({ input: 12, output: 95, cacheWrite5m: 8400 });
  });

  it('detects the npm test loop and the cache rebuild after a break', () => {
    const r = buildReport(sessions, new Pricer());
    expect(r.findings.find((f) => f.kind === 'loop')).toMatchObject({ source: 'amp', count: 3 });
    expect(r.findings.find((f) => f.kind === 'cache-miss')).toMatchObject({ cause: 'idle', certainty: 'likely-avoidable' });
  });
});

describe('opencode parser (experimental)', () => {
  it('reads legacy JSON storage', async () => {
    const [s] = await openCodeParser.load(fx('opencode/json-data'));
    expect(s.id).toBe('ses_OLD1');
    expect(s.project).toBe('legacy');
    expect(s.turns[0].prompt).toBe('Summarize the legacy module');
    expect(calls(s)[0].usage).toMatchObject({ input: 20000, output: 700, reasoning: 200 });
    expect(s.caps.cacheWrites).toBe(false);
    const r = buildReport([s], new Pricer());
    expect(r.findings.filter((f) => f.kind === 'huge-output')).toHaveLength(2);
    expect(r.findings.some((f) => f.kind === 'cache-miss')).toBe(false); // provider never cached: no claim
  });

  let sqlite: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sqlite = (process as any).getBuiltinModule?.('node:sqlite');
  } catch {
    sqlite = undefined;
  }
  it.skipIf(!sqlite)('reads SQLite G1 + G2 with id de-duplication (Node 22.13+)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ts-oc-'));
    const db = new sqlite.DatabaseSync(path.join(dir, 'opencode.db'));
    db.exec(readFileSync(fx('opencode/sql/g1-g2.sql'), 'utf8'));
    db.close();
    cpSync(fx('opencode/json-data/storage'), path.join(dir, 'storage'), { recursive: true });
    const sessions = await openCodeParser.load(dir);
    const s = sessions.find((x) => x.id === 'ses_01JAAA')!;
    expect(sessions.map((x) => x.id).sort()).toEqual(['ses_01JAAA', 'ses_OLD1']);
    const cs = calls(s);
    expect(cs.map((c) => c.id)).toEqual(['msg_01JA01', 'msg_01JA02', 'msg_01JA03']);
    expect(cs[1].reportedCost).toBeCloseTo(0.0181); // G2 copy wins
    expect(cs[0].usage).toMatchObject({ input: 1200, cacheRead: 12000, cacheWrite5m: 4000 });
    expect(cs[2].usage).toMatchObject({ input: 900, output: 100 }); // step-finish fallback
    const task = cs[0].toolCalls.find((t) => t.name === 'task')!;
    expect(task.subagent?.id).toBe('ses_01JCHILD');
    expect(cs[0].toolCalls.find((t) => t.name === 'bash')!.isError).toBe(true);
    const pricer = new Pricer();
    const r = buildReport(sessions, pricer);
    expect(r.reportedModels).toEqual(['mystery-local-model']);
    expect(r.unknownModels).toEqual([]);
  });
});

describe('cli', () => {
  const dist = path.join(here, '..', 'dist', 'cli.js');
  let built = true;
  try {
    readFileSync(dist);
  } catch {
    built = false;
  }
  it.skipIf(!built)('--list-sources prints every agent', () => {
    const out = execFileSync(process.execPath, [dist, '--list-sources'], { encoding: 'utf8', env: { ...process.env, HOME: os.tmpdir(), USERPROFILE: os.tmpdir() } });
    for (const id of ['claude-code', 'codex', 'opencode', 'droid', 'amp']) expect(out).toContain(id);
  });
});

import { codexParser } from '../src/parsers/codex.js';
import { geminiParser } from '../src/parsers/gemini.js';
import { qwenParser } from '../src/parsers/qwen.js';

describe('codex parser (experimental, hardened)', async () => {
  const notes: string[] = [];
  const sessions = await codexParser.load(fx('codex/sessions'), { notes });
  const main = sessions.find((s) => s.id === '019cd3a1-6f2e-7b40-9c1d-5e8a2b3c4d5e')!;
  const fork = sessions.find((s) => s.id === '019cd3a1-0000-7b40-9c1d-000000000002')!;

  it('ignores pre-wrapper rollouts without usage', () => {
    expect(sessions.some((s) => s.id.includes('legacy'))).toBe(false);
  });

  it('computes per-request usage: skips null info and repeated totals', () => {
    const cs = calls(main);
    expect(cs).toHaveLength(3);
    const sum = cs.reduce((a, c) => ({ in: a.in + c.usage.input + c.usage.cacheRead, cached: a.cached + c.usage.cacheRead, out: a.out + c.usage.output, r: a.r + c.usage.reasoning }), { in: 0, cached: 0, out: 0, r: 0 });
    expect(sum).toEqual({ in: 29400, cached: 22016, out: 431, r: 192 });
    expect(cs[0].model).toBe('gpt-5.3-codex');
  });

  it('reads titles from session_index.jsonl (last rename wins) and skips injected context prompts', () => {
    expect(main.title).toBe('Fix parse() for undefined input');
    expect(main.turns[0].prompt).toBe('Fix the failing test in src/parse.ts');
    expect(main.project).toBe('widget');
  });

  it('parses exec_command reads, apply_patch edits and exit codes', () => {
    const [read, patch] = calls(main).flatMap((c) => c.toolCalls);
    expect(read).toMatchObject({ name: 'exec_command', file: 'src/parse.ts', fileOp: 'read', isError: false });
    expect(patch).toMatchObject({ name: 'apply_patch', file: 'src/parse.ts', fileOp: 'edit', isError: true });
  });

  it('drops usage replayed from the parent into a forked thread', () => {
    expect(calls(fork)).toHaveLength(1);
    expect(calls(fork)[0].usage).toMatchObject({ input: 10880 - 5928, cacheRead: 5928 });
  });
});

describe('gemini parser (experimental)', async () => {
  const sessions = await geminiParser.load(fx('gemini/tmp'));
  const s = sessions[0];

  it('keeps the last copy of each message, prefers .jsonl over legacy .json, ignores rewinds', () => {
    expect(sessions).toHaveLength(1);
    expect(s.title).toBe('Diagnose failing npm test');
    expect(s.project).toBe('widget');
    expect(s.projectPath).toBe('/Users/demo/code/widget');
    expect(s.turns.map((t) => t.prompt)).toEqual(['Why does `npm test` fail?', 'never mind'].slice(0, 1));
    const cs = calls(s);
    expect(cs).toHaveLength(2);
    // input includes cached; output excludes thoughts
    expect(cs[0].usage).toMatchObject({ input: 8450 - 6144, cacheRead: 6144, output: 42 + 180, reasoning: 180 });
    expect(cs[0].toolCalls[0]).toMatchObject({ name: 'run_shell_command', isError: true });
  });

  it('attaches subagent recordings to invoke_agent', () => {
    const agent = calls(s)[1].toolCalls[0];
    expect(agent.subagent?.isSubagent).toBe(true);
    expect(calls(agent.subagent!)[0].model).toBe('gemini-2.5-flash');
  });

  it('prices Gemini models', () => {
    const r = buildReport(sessions, new Pricer());
    expect(r.unknownModels).toEqual([]);
    expect(r.totals.cost).toBeGreaterThan(0);
  });
});

describe('qwen parser (experimental)', async () => {
  const sessions = await qwenParser.load(fx('qwen/projects'));
  const s = sessions.find((x) => x.id === '3b9e2f10-8a4c-4d1e-b7f2-6c0a9d8e1f23')!;
  const branch = sessions.find((x) => x.id === '99999999-branch')!;

  it('reads turns, title, tools and maps the OAuth model alias', () => {
    expect(s.title).toBe('Rename fooBar');
    expect(s.project).toBe('widget');
    expect(calls(s)).toHaveLength(3);
    expect(calls(s)[0].model).toBe('qwen3-coder-plus');
    const [read, edit] = calls(s).flatMap((c) => c.toolCalls);
    expect(read).toMatchObject({ fileOp: 'read', isError: false });
    expect(edit).toMatchObject({ fileOp: 'edit', isError: true });
  });

  it('does not double-count reasoning on OpenAI-compatible backends, but adds it for Gemini-native totals', () => {
    expect(calls(s)[0].usage).toMatchObject({ input: 12040 - 11008, cacheRead: 11008, output: 61 });
    expect(calls(s)[2].usage.output).toBe(9 + 5);
  });

  it('ignores ui_telemetry duplicates and records copied by /branch', () => {
    expect(calls(branch)).toHaveLength(1);
    expect(calls(branch)[0].id).toBe('b1');
  });
});

import { clineParser, kiloCodeParser, rooParser } from '../src/parsers/cline.js';
import { copilotParser } from '../src/parsers/copilot.js';

describe('cline parser (experimental)', async () => {
  const legacy = await clineParser.load(fx('cline/globalStorage/saoudrizwan.claude-dev'));
  const sdk = await clineParser.load(fx('cline/data'));
  const s = legacy[0];

  it('reads per-request usage from api_req_started rows, skipping partial placeholders', () => {
    const cs = calls(s);
    expect(cs).toHaveLength(4); // 3 requests (incl. a cancelled one - still billed) + subagent_usage
    expect(cs[0].usage).toMatchObject({ input: 12, output: 180, cacheWrite5m: 9100 });
    expect(cs[1].usage).toMatchObject({ input: 850, cacheRead: 9100 }); // Cline: tokensIn excludes cache
    expect(cs[0].reportedCost).toBeCloseTo(0.0369);
    expect(cs[0].model).toBe('claude-sonnet-4-5');
  });

  it('recovers cwd, title and turns', () => {
    expect(s.project).toBe('app');
    expect(s.title).toBe('Add a /health endpoint');
    expect(s.turns.map((t) => t.prompt)).toEqual(['Add a /health endpoint', 'tests still fail']);
  });

  it('attaches XML-mode tool results to the request that issued them', () => {
    const cs = calls(s);
    expect(cs[0].toolCalls.map((t) => [t.name, t.target, t.fileOp])).toEqual([['read_file', 'src/server.ts', 'read']]);
    expect(cs[0].toolCalls[0].resultChars).toBeGreaterThan(5000);
    expect(cs[1].toolCalls.map((t) => t.name)).toEqual(['execute_command']);
  });

  it('reads Cline SDK sessions (inputTokens include cache)', () => {
    const [x] = sdk;
    expect(x.project).toBe('app');
    expect(calls(x)[0].usage).toMatchObject({ input: 50, cacheRead: 9100, cacheWrite5m: 150 });
    expect(calls(x)[0].toolCalls[0].resultChars).toBe(20);
  });
});

describe('roo code / kilo code parsers (experimental)', async () => {
  const [roo] = await rooParser.load(fx('roo/globalStorage/rooveterinaryinc.roo-cline'));
  const [kilo] = await kiloCodeParser.load(fx('kilo-code/globalStorage/kilocode.kilo-code'));

  it('treats Roo tokensIn as inclusive of cache reads and writes', () => {
    const cs = calls(roo);
    expect(cs[0].usage).toMatchObject({ input: 30, cacheWrite5m: 15200 });
    expect(cs[1].usage).toMatchObject({ input: 20, cacheRead: 15200, cacheWrite5m: 480 });
    expect(cs[0].model).toBe('claude-sonnet-4-5'); // from <model> in environment_details
    expect(roo.project).toBe('app');
  });

  it('keeps condense-context cost and native tool results', () => {
    const r = buildReport([roo], new Pricer());
    const condense = calls(roo).find((c) => c.id.includes('condense'))!;
    expect(condense.cost).toBeCloseTo(0.02);
    expect(calls(roo)[0].toolCalls[0]).toMatchObject({ name: 'apply_diff', fileOp: 'edit' });
    expect(r.totals.cost).toBeGreaterThan(0.02);
  });

  it('reads Kilo Code legacy tasks (OpenAI protocol)', () => {
    expect(calls(kilo)[0]).toMatchObject({ model: 'gpt-5' });
    expect(calls(kilo)[0].usage).toMatchObject({ input: 600, cacheRead: 19800 });
  });
});

describe('copilot cli parser (experimental)', async () => {
  const [s] = await copilotParser.load(fx('copilot/session-state'));

  it('uses session.shutdown totals (input includes cache) and Copilot model ids', () => {
    const total = calls(s).find((c) => c.id.includes(':total:'))!;
    expect(total.usage).toMatchObject({ input: 500, output: 310, cacheRead: 36000, cacheWrite5m: 4500 });
    expect(s.project).toBe('app');
    expect(s.caps.perRequestTokens).toBe(false);
  });

  it('runs tool-based detectors but reports the cache check as unavailable', () => {
    const r = buildReport([s], new Pricer());
    expect(r.unknownModels).toEqual([]); // claude-sonnet-4.5 -> claude-sonnet-4-5
    expect(r.findings.some((f) => f.kind === 'reread')).toBe(true);
    const cov = r.coverage[0];
    expect(cov.detectors.find((d) => d.kind === 'cache-miss')!.missing).toContain('per-request token usage');
    expect(calls(s).flatMap((c) => c.toolCalls).find((t) => t.name === 'bash')!.isError).toBe(true);
  });
});
