import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '../dist/cli.js');
const claude = path.join(here, 'fixtures/claude/projects');

function run(...args: string[]) {
  const r = spawnSync(process.execPath, [cli, '--dir', claude, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('CI mode', () => {
  it('--summary prints a compact JSON summary', () => {
    const { code, out } = run('--summary');
    expect(code).toBe(0);
    const s = JSON.parse(out);
    expect(s.sessions).toBe(2);
    expect(s.sessionIds.sort()).toEqual(['sess-alpha', 'sess-beta']);
    expect(s.avoidableCost).toBeGreaterThan(0);
    expect(s.byKind.map((k: { kind: string }) => k.kind)).toContain('loop');
    expect(s.topFindings[0]).toHaveProperty('tip');
    expect(s).not.toHaveProperty('tree');
    expect(s.failOver).toBeUndefined();
  });

  it('--fail-over exits 1 when avoidable waste exceeds the threshold', () => {
    const over = run('--summary', '--fail-over', '0.01');
    expect(over.code).toBe(1);
    expect(JSON.parse(over.out).failOver).toEqual({ threshold: 0.01, exceeded: true });
    expect(over.err).toMatch(/exceeds --fail-over \$0\.01/);

    const under = run('--fail-over', '$50');
    expect(under.code).toBe(0);
    expect(under.out).toContain('could have been saved'); // terminal report still printed
    expect(under.err).toMatch(/is within --fail-over \$50\.00/);
  });

  it('--fail-over compares the headline only, not likely-avoidable waste', () => {
    // sess-beta only has a huge output (likely avoidable)
    const { code, out } = run('--session', 'sess-beta', '--summary', '--fail-over', '0');
    const s = JSON.parse(out);
    expect(s.likelyAvoidableCost).toBeGreaterThan(0);
    expect(s.avoidableCost).toBe(0);
    expect(code).toBe(0);
  });

  it('--session filters by id or prefix, comma-separated', () => {
    expect(JSON.parse(run('--session', 'sess-al', '--summary').out).sessionIds).toEqual(['sess-alpha']);
    expect(JSON.parse(run('--session', 'sess-alpha,sess-beta', '--summary').out).sessions).toBe(2);
    const none = run('--session', 'nope');
    expect(none.code).toBe(1);
    expect(none.err).toContain('No sessions matched --session nope');
  });

  it('--since scopes to the current run (ISO timestamp)', () => {
    const s = JSON.parse(run('--since', '2026-11-03T00:00:00Z', '--summary').out);
    expect(s.sessionIds).toEqual(['sess-beta']);
  });

  it('--summary <file> writes the file and still prints the terminal report', () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'tokenscope-')), 'summary.json');
    const { code, out, err } = run('--summary', file);
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8')).sessions).toBe(2);
    expect(out).toContain('could have been saved');
    expect(err).toContain('JSON summary written to');
  });

  it('rejects a bad --fail-over value', () => {
    const { code, err } = run('--fail-over', 'lots');
    expect(code).toBe(1);
    expect(err).toContain('--fail-over expects a dollar amount');
  });
});
