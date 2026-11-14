import { createReadStream, promises as fs } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

/** Stream a JSONL file, yielding parsed objects and silently skipping malformed lines. */
export async function* readJsonl(file: string): AsyncGenerator<any> {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || line.charCodeAt(0) !== 123 /* { */) continue;
    try {
      yield JSON.parse(line);
    } catch {
      /* partial line from a live session - ignore */
    }
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Recursively list files under `dir` matching `pred`. */
export async function walk(dir: string, pred: (p: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  async function rec(d: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await rec(p);
      else if (pred(p)) out.push(p);
    }
  }
  await rec(dir);
  return out.sort();
}

export function parseTime(v: unknown): number {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? 0 : t;
  }
  return 0;
}

/** JSON.stringify with sorted keys, for stable identity of tool inputs. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
}

export function oneLine(s: string, max = 120): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Length of text inside a tool_result-ish content value. */
export function contentChars(c: unknown): number {
  if (typeof c === 'string') return c.length;
  if (Array.isArray(c)) {
    let n = 0;
    for (const b of c) {
      if (typeof b === 'string') n += b.length;
      else if (b && typeof b === 'object') {
        const o = b as Record<string, unknown>;
        if (typeof o.text === 'string') n += o.text.length;
        else if (o.type === 'image') n += 6000; // ~1.5k tokens per image, rough
        else if ('content' in o) n += contentChars(o.content);
      }
    }
    return n;
  }
  if (c && typeof c === 'object') {
    const o = c as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text.length;
    if ('content' in o) return contentChars(o.content);
    if ('output' in o) return contentChars(o.output);
  }
  return 0;
}

/** Summarize a tool call's target for display (file, command, url...). */
export function toolTarget(name: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return typeof input === 'string' ? oneLine(input, 80) : undefined;
  const i = input as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = i[k];
      if (typeof v === 'string' && v) return v;
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return (v as string[]).join(' ');
    }
    return undefined;
  };
  const v =
    pick('file_path', 'path', 'notebook_path') ??
    pick('command', 'cmd') ??
    pick('url') ??
    pick('pattern', 'query') ??
    pick('description', 'subject', 'skill', 'prompt');
  if (v) return oneLine(v, 80);
  for (const val of Object.values(i)) if (typeof val === 'string' && val) return oneLine(val, 80);
  return undefined;
}

/** Strip shell wrappers like `bash -lc "..."` that Codex uses. */
export function unwrapShell(cmd: string): string {
  const m = cmd.match(/^(?:ba|z)?sh\s+-l?c\s+(.*)$/s);
  if (!m) return cmd;
  let s = m[1].trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  return s;
}

/** If a shell command is a plain file read (cat/head/tail/sed -n/nl/less), return the path. */
export function shellReadTarget(cmd: string): string | undefined {
  const c = unwrapShell(cmd).trim();
  if (/[|;&><]/.test(c)) return undefined;
  const m = c.match(/^(?:cat|head|tail|less|more|nl|bat)\s+(?:-[\w]+\s+(?:\d+\s+)?)*([^\s-][^\s]*)$/) ??
    c.match(/^sed\s+-n\s+['"]?[\d,]+p['"]?\s+([^\s]+)$/);
  return m?.[1];
}

// Tool names across agents (Claude Code, Codex, Gemini/Qwen, OpenCode, Cline/Roo/Kilo, Droid, Amp, Copilot)
const READ_TOOLS = new Set(['Read', 'read', 'read_file', 'readFile', 'view', 'View', 'ReadFile', 'read_many_files']);
const EDIT_TOOLS = new Set([
  'Edit', 'edit', 'MultiEdit', 'multiedit', 'Write', 'write', 'NotebookEdit', 'write_file', 'write_to_file', 'edit_file',
  'create_file', 'Create', 'replace', 'replace_in_file', 'apply_diff', 'insert_content', 'search_and_replace',
  'str_replace_based_edit_tool', 'str_replace_editor', 'editedExistingFile', 'newFileCreated', 'appliedDiff', 'create', 'ApplyPatch', 'patch',
]);
const SHELL_TOOLS = new Set(['Bash', 'bash', 'shell', 'exec_command', 'local_shell', 'run_shell_command', 'Execute', 'execute_command', 'powershell']);

/** Classify a tool call as a file read / edit, returning the full path. */
export function fileAccess(name: string, input: unknown): { file: string; op: 'read' | 'edit' } | undefined {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const p = [i.file_path, i.filePath, i.absolute_path, i.path, i.notebook_path, i.target_file].find((v) => typeof v === 'string') as string | undefined;
  if (READ_TOOLS.has(name) && p) return { file: p, op: 'read' };
  if (EDIT_TOOLS.has(name) && p) return { file: p, op: 'edit' };
  if (name === 'apply_patch' || name === 'ApplyPatch' || name === 'patch') {
    const patch = typeof input === 'string' ? input : typeof i.input === 'string' ? i.input : '';
    const m = patch.match(/\*\*\* (?:Update|Add) File: (.+)/);
    if (m) return { file: m[1].trim(), op: 'edit' };
  }
  if (SHELL_TOOLS.has(name)) {
    const raw = i.command ?? i.cmd ?? i.commandLine ?? input;
    const cmd = Array.isArray(raw) ? raw.join(' ') : typeof raw === 'string' ? raw : undefined;
    const f = cmd ? shellReadTarget(cmd) : undefined;
    if (f) return { file: f, op: 'read' };
  }
  return undefined;
}

/** Parse "7d" / "24h" / "2w" / "30m" or an ISO-ish date into epoch ms. */
export function parseWhen(s: string | undefined, now = Date.now()): number | undefined {
  if (!s) return undefined;
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*(m|h|d|w)$/i);
  if (m) {
    const mult = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[m[2].toLowerCase() as 'm' | 'h' | 'd' | 'w'];
    return now - Number(m[1]) * mult;
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`Cannot parse time "${s}" (try 7d, 24h or 2026-11-01)`);
  return t;
}


/** Short content hash for tool results. */
export function contentHash(c: unknown): string {
  return createHash('sha1').update(typeof c === 'string' ? c : stableStringify(c)).digest('base64').slice(0, 12);
}

/** "~/x" -> "/home/me/x" */
export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(1)) : p;
}
