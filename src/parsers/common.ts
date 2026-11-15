import type { ApiCall, Capabilities, Session, SourceId, ToolCall, Turn, Usage } from '../types.js';
import { emptyUsage } from '../types.js';
import { contentChars, contentHash, fileAccess, oneLine, stableStringify, toolTarget, unwrapShell } from '../util.js';

/** Shared helpers so every parser builds the normalized model the same way. */

export function newSession(source: SourceId, id: string, file: string, caps: Capabilities): Session {
  return { id, source, caps: { ...caps }, project: source, file, start: 0, end: 0, turns: [] };
}

export function touch(s: Session, ts: number): void {
  if (!ts) return;
  if (!s.start || ts < s.start) s.start = ts;
  if (ts > s.end) s.end = ts;
}

export function setCwd(s: Session, cwd: unknown): void {
  if (typeof cwd !== 'string' || !cwd || s.projectPath) return;
  s.projectPath = cwd;
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  s.project = parts[parts.length - 1] ?? s.project;
}

export function newTurn(s: Session, ts: number, prompt: string): Turn {
  const t: Turn = { index: s.turns.length, timestamp: ts, prompt, calls: [] };
  s.turns.push(t);
  return t;
}

export function lastTurn(s: Session, ts: number): Turn {
  return s.turns[s.turns.length - 1] ?? newTurn(s, ts, '(session start)');
}

export function newCall(id: string, ts: number, model: string, usage: Partial<Usage> = {}): ApiCall {
  return { id, timestamp: ts, model, usage: { ...emptyUsage(), ...usage }, toolCalls: [], cost: 0 };
}

const SHELL = new Set(['shell', 'exec_command', 'local_shell', 'run_shell_command', 'bash', 'Bash', 'Execute', 'execute_command']);

export function newToolCall(id: string, name: string, input: unknown): ToolCall {
  let target = toolTarget(name, input);
  if (target && SHELL.has(name)) target = oneLine(unwrapShell(target), 80);
  const tc: ToolCall = {
    id,
    name,
    target,
    key: name + ':' + stableStringify(input ?? null),
    resultChars: 0,
    isError: false,
    inputChars: typeof input === 'string' ? input.length : input == null ? 0 : stableStringify(input).length,
  };
  const fa = fileAccess(name, input);
  if (fa) {
    tc.file = fa.file;
    tc.fileOp = fa.op;
  }
  return tc;
}

/** First 200 characters of an error result, used to classify failures (never shown in reports). */
export function errorSnippet(output: unknown): string {
  const t = typeof output === 'string' ? output : Array.isArray(output) ? output.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join(' ') : stableStringify(output ?? '');
  return t.slice(0, 200);
}

export function setResult(tc: ToolCall, output: unknown, isError = false): void {
  tc.resultChars = typeof output === 'string' ? output.length : contentChars(output) || (output == null ? 0 : stableStringify(output).length);
  tc.resultHash = contentHash(output ?? '');
  tc.isError = isError;
  if (isError) tc.errorText = errorSnippet(output);
}

/**
 * Remove empty turns and re-index. Pass `seen` only for formats where we are not
 * sure tool calls are recorded at all (Droid, Amp): if a session shows no tool
 * data, its tool-based checks are reported as unavailable rather than "no waste".
 * (For well-understood formats a session without tool calls is simply clean.)
 */
export function finish(s: Session, seen?: { tools: boolean; outputs: boolean; files: boolean }): Session {
  s.turns = s.turns.filter((t) => t.calls.length > 0);
  s.turns.forEach((t, i) => (t.index = i));
  if (seen && !seen.tools) {
    s.caps.toolCalls = false;
    s.caps.toolOutputs = false;
    s.caps.filePaths = false;
  }
  return s;
}

/** Track which tool data a session really contained (for honest capability flags). */
export function toolSeen(s: Session): { tools: boolean; outputs: boolean; files: boolean } {
  const seen = { tools: false, outputs: false, files: false };
  for (const t of s.turns)
    for (const c of t.calls)
      for (const tc of c.toolCalls) {
        seen.tools = true;
        if (tc.resultHash !== undefined) seen.outputs = true;
        if (tc.file) seen.files = true;
      }
  return seen;
}

/** Text of a user prompt in common content shapes (string | [{type:text,text}] | {text}). */
export function promptText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (typeof b === 'string') parts.push(b);
      else if (b && typeof b === 'object') {
        const o = b as Record<string, unknown>;
        if (o.type === 'tool_result' || o.type === 'function_response' || 'functionResponse' in o) return undefined;
        if (typeof o.text === 'string') parts.push(o.text);
      }
    }
    return parts.length ? parts.join(' ') : undefined;
  }
  if (content && typeof content === 'object' && typeof (content as { text?: unknown }).text === 'string') return (content as { text: string }).text;
  return undefined;
}

export const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : 0);

/** Split an env var holding one or more comma-separated directories. */
export function envDirs(name: string): string[] | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const dirs = v.split(',').map((x) => x.trim()).filter(Boolean);
  return dirs.length ? dirs : undefined;
}
