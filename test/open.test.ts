import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openCommand, openFile } from '../src/open.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'tokenscope-open-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// cmd.exe metacharacters, quotes and an option-like prefix. Kept to characters every OS allows in names.
const HOSTILE = `-x & calc ^ %PATH% ;$(id) 'q' report.html`;

function fakeSpawn() {
  const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
  const spawn = (cmd: string, args: string[], opts: object) => {
    calls.push({ cmd, args, opts: opts as Record<string, unknown> });
    return { unref() {}, on() {} };
  };
  return { calls, spawn };
}

describe('--open', () => {
  it('uses a shell-free opener on every platform, with the path as one argument', () => {
    const file = path.resolve(tmp, HOSTILE);
    expect(openCommand(file, 'darwin')).toEqual({ cmd: 'open', args: [file] });
    expect(openCommand(file, 'linux')).toEqual({ cmd: 'xdg-open', args: [file] });
    expect(openCommand(file, 'win32')).toEqual({ cmd: 'explorer.exe', args: [file] });
    for (const p of ['darwin', 'linux', 'win32', 'freebsd'] as const) {
      const { cmd } = openCommand(file, p);
      expect(cmd).not.toMatch(/^(cmd|sh|bash|powershell|pwsh)(\.exe)?$/i);
    }
  });

  it('spawns without a shell and passes the absolute path verbatim', () => {
    const file = path.join(tmp, HOSTILE);
    writeFileSync(file, '<!doctype html>');
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const { calls, spawn } = fakeSpawn();
      const rel = path.relative(process.cwd(), file);
      expect(openFile(rel, { platform, spawn })).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args).toEqual([path.resolve(file)]);
      expect(path.isAbsolute(calls[0]!.args[0]!)).toBe(true); // can't be read as an option
      expect(calls[0]!.opts.shell).toBe(false);
    }
  });

  it('refuses paths that are not an existing regular file', () => {
    const dir = path.join(tmp, 'a-dir');
    mkdirSync(dir);
    for (const bad of [path.join(tmp, 'missing.html'), dir, `${tmp}${path.sep}" & calc & ".html`]) {
      const { calls, spawn } = fakeSpawn();
      expect(openFile(bad, { platform: 'win32', spawn })).toBe(false);
      expect(calls).toEqual([]);
    }
  });
});
