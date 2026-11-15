import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

/**
 * The program and arguments that open `file` with its default app. The path is always a single argv
 * entry and no shell is involved, so characters such as `&`, `|`, `^`, `%` or quotes in it are never
 * interpreted (`cmd /c start` would have parsed them on Windows).
 */
export function openCommand(file: string, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: [file] };
  if (platform === 'win32') return { cmd: 'explorer.exe', args: [file] };
  return { cmd: 'xdg-open', args: [file] };
}

type Spawn = (cmd: string, args: string[], opts: SpawnOptions) => { unref(): void; on(event: 'error', cb: (err: Error) => void): unknown };

/**
 * Open an existing local file with the default app. Returns false (and spawns nothing) unless `file`
 * resolves to a regular file; the absolute path also can't be mistaken for a command-line option.
 */
export function openFile(file: string, opts: { platform?: NodeJS.Platform; spawn?: Spawn } = {}): boolean {
  const abs = path.resolve(file);
  let isFile = false;
  try {
    isFile = statSync(abs).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) return false;
  const { cmd, args } = openCommand(abs, opts.platform);
  const child = (opts.spawn ?? nodeSpawn)(cmd, args, { stdio: 'ignore', detached: true, shell: false, windowsHide: true });
  child.on('error', () => {}); // no opener installed (e.g. headless Linux): the report is still written
  child.unref();
  return true;
}
