import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildReport, filterByTime } from '../src/analyze/report.js';
import { claudeCodeParser } from '../src/parsers/claude-code.js';
import { codexParser } from '../src/parsers/codex.js';
import { Pricer } from '../src/pricing/index.js';
import { renderHtml } from '../src/render/html.js';
import { renderTerminal } from '../src/render/terminal.js';
import { parseWhen } from '../src/util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const load = async () => [
  ...(await claudeCodeParser.load(path.join(here, 'fixtures/claude/projects'))),
  ...(await codexParser.load(path.join(here, 'fixtures/codex/sessions'))),
];

describe('buildReport', async () => {
  const report = buildReport(await load(), new Pricer(), { version: 'test' });

  it('totals calls across sessions and subagents', () => {
    expect(report.totals.sessions).toBe(3);
    expect(report.totals.subagents).toBe(1);
    expect(report.totals.calls).toBe(8 + 2 + 3 + 3);
  });

  it('prices calls (first alpha call on Opus 4.5)', () => {
    // 10 in * $5 + 20k cache write * $6.25 + 350 out * $25, per 1M
    const alpha = report.sessions.find((s) => s.id === 'sess-alpha')!;
    expect(alpha.cost).toBeGreaterThan(0.1338);
    expect(alpha.subagentCost).toBeGreaterThan(0);
    expect(alpha.models.sort()).toEqual(['claude-haiku-4-5', 'claude-opus-4-5']);
  });

  it('prices codex with cached input', () => {
    const cdx = report.sessions.find((s) => s.id === 'cdx-0001')!;
    const expected = (12000 * 1.25 + 300 * 10 + 2500 * 1.25 + 12000 * 0.125 + 150 * 10 + 2500 * 1.25 + 14000 * 0.125 + 200 * 10) / 1e6;
    expect(cdx.cost).toBeCloseTo(expected, 8);
  });

  it('flags unknown models instead of guessing', () => {
    expect(report.unknownModels).toEqual(['mystery-model-1']);
  });

  it('breaks spend down by project, model, day and tool', () => {
    expect(report.byProject.map((p) => p.name).sort()).toEqual(['acme-api', 'ml-pipeline', 'web']);
    expect(report.byModel.map((m) => m.name)).toContain('claude-sonnet-4-5');
    expect(report.byDay.map((d) => d.name)).toEqual(['2026-11-02', '2026-11-03']);
    const bash = report.byTool.find((t) => t.name === 'Bash')!;
    expect(bash).toMatchObject({ calls: 4, errors: 3 });
  });

  it('cost by token type sums to total cost', () => {
    const c = report.costByType;
    expect(c.input + c.cacheWrite + c.cacheRead + c.output).toBeCloseTo(report.totals.cost, 8);
    expect(report.totals.costWithoutCache).toBeGreaterThan(report.totals.cost);
  });

  it('builds a flame-graph tree whose values add up', () => {
    expect(report.tree.v).toBeCloseTo(report.totals.cost, 8);
    const proj = report.tree.c!.find((p) => p.n === 'acme-api')!;
    const sess = proj.c![0];
    expect(sess.k).toBe('session');
    expect(sess.s).toBe('sess-alpha');
    const agentCall = sess.c!.flatMap((t) => t.c!).find((c) => c.c?.some((k) => k.k === 'agent'))!;
    expect(agentCall.c![0].n).toContain('Audit middleware');
  });

  describe('waste detection', () => {
    const kinds = (k: string) => report.findings.filter((f) => f.kind === k);
    it('detects the npm test loop', () => {
      const [loop] = kinds('loop');
      expect(loop).toMatchObject({ sessionId: 'sess-alpha', count: 3 });
      expect(loop.title).toContain('Bash called 3× in a row, same input & same result');
      expect(kinds('repeat')).toHaveLength(0); // the loop is not double-counted
    });
    it('detects unchanged re-reads', () => {
      const [r] = kinds('reread');
      expect(r).toMatchObject({ count: 2, tokens: 2000 });
      expect(r.title).toContain('server.ts read 3×');
    });
    it('detects huge tool outputs', () => {
      const [h] = kinds('huge-output');
      expect(h).toMatchObject({ sessionId: 'sess-beta', tokens: 20000 });
    });
    it('detects cache rebuilds after idle gaps', () => {
      const [m] = kinds('cache-miss');
      expect(m).toMatchObject({ sessionId: 'sess-alpha', count: 1, tokens: 25000 });
      expect(m.detail).toContain('idle');
      // Opus 4.5: (6.25 - 0.5) * 25k / 1M
      expect(m.cost).toBeCloseTo(0.14375, 6);
    });
  });

  it('renders terminal output without colors', () => {
    const out = renderTerminal(report, { color: false, width: 100, top: 5 });
    expect(out).toContain('tokenscope');
    expect(out).toContain('acme-api');
    expect(out).toContain('LOOP');
    expect(out).not.toMatch(/\x1b\[/);
  });

  it('renders a self-contained HTML report', () => {
    const html = renderHtml(report);
    expect(html).toContain('<script id="ts-data" type="application/json">');
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+stylesheet/);
    const json = html.match(/<script id="ts-data" type="application\/json">([\s\S]*?)<\/script>/)![1];
    expect(JSON.parse(json).totals.calls).toBe(16);
  });
});

describe('redaction', async () => {
  const report = buildReport(await load(), new Pricer(), { redact: true });
  const blob = JSON.stringify(report);
  it('removes prompts, paths and titles', () => {
    for (const secret of ['rate limiting', '/Users/demo', 'server.ts', 'acme-api', 'npm test', 'Audit middleware', 'train.py'])
      expect(blob).not.toContain(secret);
    expect(report.findings.length).toBeGreaterThan(0);
  });
});

describe('time filters', async () => {
  it('parses relative and absolute times', () => {
    const now = Date.parse('2026-11-14T00:00:00Z');
    expect(parseWhen('7d', now)).toBe(now - 7 * 86400e3);
    expect(parseWhen('24h', now)).toBe(now - 86400e3);
    expect(parseWhen('2026-11-01')).toBe(Date.parse('2026-11-01'));
    expect(() => parseWhen('yesterday-ish')).toThrow();
  });
  it('keeps only calls inside the window', async () => {
    const s = filterByTime(await load(), Date.parse('2026-11-03T00:00:00Z'));
    expect(s.map((x) => x.id)).toEqual(['sess-beta']);
  });
});
