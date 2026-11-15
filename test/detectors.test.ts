import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildReport } from '../src/analyze/report.js';
import { detectWaste, type WasteOptions } from '../src/analyze/waste.js';
import { claudeCodeParser } from '../src/parsers/claude-code.js';
import { codexParser } from '../src/parsers/codex.js';
import { Pricer } from '../src/pricing/index.js';
import type { ApiCall, Session, ToolCall } from '../src/types.js';
import { emptyUsage } from '../src/types.js';
import { CLAUDE_CAPS } from '../src/parsers/claude-code.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (p: string) => path.join(here, 'fixtures', p);
const pricer = () => new Pricer();

// --- synthetic sessions -------------------------------------------------------
const T0 = Date.parse('2026-11-01T10:00:00Z');
let n = 0;
function call(min: number, o: Partial<ApiCall> & { cr?: number; cw?: number; out?: number } = {}): ApiCall {
  return {
    id: `c${n++}`,
    timestamp: T0 + min * 60e3,
    model: o.model ?? 'claude-sonnet-4-5',
    usage: { ...emptyUsage(), input: 5, cacheRead: o.cr ?? 50_000, cacheWrite5m: o.cw ?? 500, output: o.out ?? 200 },
    toolCalls: o.toolCalls ?? [],
    cost: 0,
    visibleChars: o.visibleChars,
    toolSet: o.toolSet,
  };
}
function session(calls: ApiCall[], extra: Partial<Session> = {}): Session {
  return {
    id: 's1',
    source: 'claude-code',
    caps: { ...CLAUDE_CAPS },
    project: 'p',
    file: 'x',
    start: calls[0]?.timestamp ?? T0,
    end: calls[calls.length - 1]?.timestamp ?? T0,
    turns: [{ index: 0, timestamp: T0, prompt: 'go', calls }],
    ...extra,
  };
}
const edit = (file: string, opts: { error?: string; chars?: number; key?: string } = {}): ToolCall => ({
  id: `t${n++}`,
  name: 'Edit',
  target: file,
  file,
  fileOp: 'edit',
  key: opts.key ?? `Edit:${n}`,
  resultChars: 40,
  resultHash: opts.error ? 'err' : `ok${n}`,
  isError: !!opts.error,
  errorText: opts.error,
  inputChars: opts.chars ?? 120,
});
const run = (s: Session, o: Partial<WasteOptions> = {}) => {
  const p = pricer();
  for (const t of s.turns) for (const c of t.calls) p.price(c);
  return detectWaste([s], p, o);
};
const NOT_FOUND = 'String to replace not found in file.';

describe('Claude Code parser: data for the new detectors', async () => {
  const [s] = await claudeCodeParser.load(fx('claude-detectors/projects'));
  it('reads compactions, tool definitions, edit errors and output sizes', () => {
    expect(s.compactions).toEqual([{ timestamp: expect.any(Number), pre: 61000, post: 9000, trigger: 'manual' }]);
    expect(s.caps).toMatchObject({ compactions: true, toolDefinitions: true, toolInputs: true, editErrors: true });
    const calls = s.turns.flatMap((t) => t.calls);
    expect(calls.every((c) => c.toolSet === 'shape-1')).toBe(true);
    const defs = s.toolSets!['shape-1'];
    expect(defs.map((d) => d.name)).toContain('mcp__jira__search');
    expect(defs.find((d) => d.name === 'mcp__docs__fetch')!.deferred).toBe(true);
    const first = calls[0].toolCalls[0];
    expect(first).toMatchObject({ isError: true, fileOp: 'edit' });
    expect(first.errorText).toContain('String to replace not found');
    expect(first.inputChars).toBeGreaterThan(50);
    expect(calls[0].visibleChars).toBe(first.inputChars);
  });
  it('sessions from versions without request shapes are not checked for unused tools', async () => {
    const [old] = await claudeCodeParser.load(fx('claude/projects/-Users-demo-web'));
    expect(old.caps.toolDefinitions).toBe(false);
  });
});

describe('new detectors on the synthetic fixture', async () => {
  const report = buildReport(await claudeCodeParser.load(fx('claude-detectors/projects')), pricer());
  const kind = (k: string) => report.findings.filter((f) => f.kind === k);

  it('failed-edit retry storm: 4 failures in a row, a denied edit ignored, 2 attempts counted', () => {
    const [f] = kind('edit-retry');
    expect(f).toMatchObject({ certainty: 'avoidable', count: 4 });
    expect(f.title).toContain('config.ts: 4 failed edits in a row');
    const calls = report.tree.c![0].c![0].c![0].c!; // project -> session -> turn -> calls
    // the 3rd and 4th attempts (each a single-tool request)
    expect(f.cost).toBeCloseTo(calls[2].v + calls[3].v, 8);
    expect(kind('loop')).toHaveLength(0);
  });

  it('over-thinking: a one-line edit with 12k output tokens, counted above a 2k allowance', () => {
    const [f] = kind('overthinking');
    expect(f).toMatchObject({ certainty: 'likely-avoidable', count: 1 });
    // 12000 output - ~32 visible tokens - 2000 allowance, at Sonnet 4.5 output ($15/M)
    expect(f.tokens).toBeGreaterThan(9900);
    expect(f.tokens).toBeLessThan(10000);
    expect(f.cost).toBeCloseTo((f.tokens * 15) / 1e6, 8);
  });

  it('unused tools: only the MCP server that was loaded and never called', () => {
    const fs = kind('unused-tools');
    expect(fs).toHaveLength(1);
    expect(fs[0].title).toContain('"jira"');
    expect(fs[0]).toMatchObject({ certainty: 'likely-avoidable', count: 9 });
    // git was called, docs is deferred, built-ins are never flagged
    expect(JSON.stringify(fs)).not.toMatch(/"git"|"docs"|Read|Bash/);
  });

  it('a small compaction (61k -> 9k) is not context bloat', () => {
    expect(kind('context-bloat')).toHaveLength(0);
  });

  it('keeps the new kinds out of the headline when likely avoidable', () => {
    const likely = report.findings.filter((f) => f.certainty === 'likely-avoidable').reduce((x, f) => x + f.cost, 0);
    expect(report.totals.likelyAvoidableCost).toBeCloseTo(likely, 10);
    expect(report.totals.avoidableCost).toBeCloseTo(kind('edit-retry')[0].cost, 10);
  });

  it('redaction keeps the edit-retry finding but drops the error text', async () => {
    const r = buildReport(await claudeCodeParser.load(fx('claude-detectors/projects')), pricer(), { redact: true });
    const f = r.findings.find((x) => x.kind === 'edit-retry')!;
    expect(f).toBeDefined();
    expect(JSON.stringify(r)).not.toContain('PORT');
  });
});

describe('edit-retry edge cases', () => {
  it('two failures, or failures broken by a successful edit, are not a storm', () => {
    expect(run(session([call(0, { toolCalls: [edit('a', { error: NOT_FOUND })] }), call(1, { toolCalls: [edit('a', { error: NOT_FOUND })] })]))).toHaveLength(0);
    const s = session([
      call(0, { toolCalls: [edit('a', { error: NOT_FOUND })] }),
      call(1, { toolCalls: [edit('a', { error: NOT_FOUND })] }),
      call(2, { toolCalls: [edit('a')] }),
      call(3, { toolCalls: [edit('a', { error: NOT_FOUND })] }),
    ]);
    expect(run(s).filter((f) => f.kind === 'edit-retry')).toHaveLength(0);
  });
  it('permission denials and classifier errors are not edit failures', () => {
    const denied = 'Permission to use Edit has been denied. String to replace not found';
    const s = session([0, 1, 2, 3].map((m) => call(m, { toolCalls: [edit('a', { error: denied })] })));
    expect(run(s).filter((f) => f.kind === 'edit-retry')).toHaveLength(0);
  });
  it('identical failing edits are counted once, as a retry storm, not also as a loop', () => {
    const s = session([0, 1, 2].map((m) => call(m, { toolCalls: [edit('a', { error: NOT_FOUND, key: 'same' })] })));
    const kinds = run(s).map((f) => f.kind);
    expect(kinds).toContain('edit-retry');
    expect(kinds).not.toContain('loop');
  });
  it('different files are tracked separately', () => {
    const s = session([0, 1, 2].map((m) => call(m, { toolCalls: [edit(m % 2 ? 'a' : 'b', { error: NOT_FOUND })] })));
    expect(run(s).filter((f) => f.kind === 'edit-retry')).toHaveLength(0);
  });
});

describe('over-thinking edge cases', () => {
  const big = (o: Parameters<typeof call>[1]) => run(session([call(0, { out: 20_000, ...o })])).filter((f) => f.kind === 'overthinking');
  it('needs a tiny edit as the only output', () => {
    expect(big({ toolCalls: [edit('a')], visibleChars: 120 })).toHaveLength(1);
    expect(big({ toolCalls: [edit('a', { chars: 5_000 })], visibleChars: 5_000 })).toHaveLength(0); // not tiny
    expect(big({ toolCalls: [edit('a'), { ...edit('b'), name: 'Bash', fileOp: undefined }], visibleChars: 200 })).toHaveLength(0); // not only edits
    expect(big({ toolCalls: [], visibleChars: 100 })).toHaveLength(0); // text replies are not checked
    expect(big({ toolCalls: [edit('a')], visibleChars: 60_000 })).toHaveLength(0); // the output was visible text, not reasoning
  });
  it('ignores moderate reasoning', () => {
    expect(run(session([call(0, { out: 6_000, toolCalls: [edit('a')], visibleChars: 120 })])).filter((f) => f.kind === 'overthinking')).toHaveLength(0);
  });
});

describe('context bloat before compaction', () => {
  // context grows from 30k to 600k in 10k steps, then auto-compacts to 30k
  const growing = (model = 'claude-opus-4-5') => {
    const calls: ApiCall[] = [];
    for (let i = 0; i <= 57; i++) calls.push(call(i, { model, cr: 30_000 + i * 10_000 - 500, cw: 500 }));
    return session(calls, { compactions: [{ timestamp: T0 + 58 * 60e3, pre: 600_000, post: 30_000, trigger: 'auto' }] });
  };
  const bloat = (s: Session, o: Partial<WasteOptions> = {}) => run(s, o).filter((f) => f.kind === 'context-bloat');

  it('values compacting at 200k, net of the extra compactions', () => {
    const [f] = bloat(growing());
    expect(f.certainty).toBe('likely-avoidable');
    expect(f.title).toContain('~600k tokens before auto-compaction');
    expect(f.count).toBe(3); // compactions at ~200k, ~370k, ~540k
    // independent re-computation (Opus 4.5: cache read $0.50, output $25, 5m write $6.25)
    let off = 0;
    let saved = 0;
    let comp = 0;
    let prev = 0;
    for (let i = 0; i <= 57; i++) {
      const size = 30_000 + i * 10_000 + 5;
      if (i > 0 && size - off > 200_000) {
        comp += (prev * 0.5 + 30_000 * (25 + 6.25)) / 1e6;
        off = prev - 30_000;
      }
      const lean = Math.max(Math.min(size, 30_000), size - off);
      saved += ((size - lean) * 0.5) / 1e6;
      prev = size;
    }
    expect(f.cost).toBeCloseTo(saved - comp, 8);
    expect(f.cost).toBeGreaterThan(0);
  });
  it('no finding when compaction happened near the threshold, without compactions, or when it would not pay', () => {
    expect(bloat(growing(), { compactAtTokens: 450_000 })).toHaveLength(0); // 600k < 1.5 x 450k
    expect(bloat({ ...growing(), compactions: undefined })).toHaveLength(0);
    // Haiku 4.5 cache reads are cheap and the counterfactual's extra compactions dominate
    expect(bloat(growing('claude-haiku-4-5'), { compactAtTokens: 100_000 })).toHaveLength(0);
  });
});

describe('coverage of the new detectors', async () => {
  it('other agents report them as not checked, never $0', async () => {
    const r = buildReport(await codexParser.load(fx('codex/sessions/2026/11')), pricer());
    const cov = r.coverage[0].detectors;
    for (const k of ['edit-retry', 'context-bloat', 'unused-tools', 'overthinking']) {
      const d = cov.find((x) => x.kind === k)!;
      expect(d.status).toBe('no');
      expect(d.missing.length).toBeGreaterThan(0);
    }
  });
});
