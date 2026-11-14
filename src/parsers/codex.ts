import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ApiCall, Session, ToolCall, Turn } from '../types.js';
import { contentChars, contentHash, fileAccess, oneLine, parseTime, readJsonl, stableStringify, toolTarget, unwrapShell, walk } from '../util.js';
import type { LoadOptions, Parser } from './types.js';

/**
 * EXPERIMENTAL - Codex CLI "rollout" files:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
 * Each line is {timestamp, type, payload}:
 *   session_meta  payload {id, cwd, cli_version, ...}
 *   turn_context  payload {cwd, model, ...}
 *   response_item payload {type:"function_call", name, arguments, call_id}
 *                         {type:"function_call_output", call_id, output}
 *                         {type:"custom_tool_call", name, input, call_id} (+ _output)
 *   event_msg     payload {type:"user_message", message}
 *                         {type:"token_count", info:{last_token_usage:{input_tokens,
 *                            cached_input_tokens, output_tokens, reasoning_output_tokens}, total_token_usage}}
 *
 * OpenAI's input_tokens INCLUDES cached tokens, so uncached = input - cached.
 * Each token_count event is treated as one model request; tool calls seen
 * since the previous token_count are attributed to it.
 *
 * Built from the public Codex CLI source/docs and synthetic fixtures; it has
 * not yet been validated against a large corpus of real rollouts.
 */

export function codexDefaultDir(): string {
  const base = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(base, 'sessions');
}

function parseArgs(a: unknown): unknown {
  if (typeof a !== 'string') return a;
  try {
    return JSON.parse(a);
  } catch {
    return a;
  }
}

export async function parseCodexFile(file: string): Promise<Session> {
  const session: Session = {
    id: path.basename(file, '.jsonl').replace(/^rollout-/, ''),
    source: 'codex',
    project: 'codex',
    file,
    start: 0,
    end: 0,
    turns: [],
  };
  let model = 'unknown';
  let turn: Turn | undefined;
  let pending: ToolCall[] = [];
  const byCallId = new Map<string, ToolCall>();
  let lastTotal = -1;
  let n = 0;

  const ensureTurn = (ts: number, prompt = '(session start)'): Turn => {
    if (!turn) {
      turn = { index: session.turns.length, timestamp: ts, prompt, calls: [] };
      session.turns.push(turn);
    }
    return turn;
  };

  for await (const e of readJsonl(file)) {
    const ts = parseTime(e.timestamp);
    if (ts) {
      if (!session.start || ts < session.start) session.start = ts;
      if (ts > session.end) session.end = ts;
    }
    const p = e.payload ?? {};
    switch (e.type) {
      case 'session_meta':
        if (typeof p.id === 'string') session.id = p.id;
        if (typeof p.cwd === 'string') {
          session.projectPath = p.cwd;
          session.project = path.basename(p.cwd) || 'codex';
        }
        break;
      case 'turn_context':
        if (typeof p.model === 'string') model = p.model;
        if (typeof p.cwd === 'string' && !session.projectPath) {
          session.projectPath = p.cwd;
          session.project = path.basename(p.cwd) || 'codex';
        }
        break;
      case 'response_item': {
        if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
          const input = p.type === 'local_shell_call' ? p.action : parseArgs(p.arguments ?? p.input);
          const name = String(p.name ?? (p.type === 'local_shell_call' ? 'shell' : 'tool'));
          let target = toolTarget(name, input);
          if (target && (name === 'shell' || name === 'exec_command' || name === 'local_shell')) target = oneLine(unwrapShell(target), 80);
          const tc: ToolCall = {
            id: String(p.call_id ?? p.id ?? `call-${n++}`),
            name,
            target,
            key: name + ':' + stableStringify(input ?? null),
            resultChars: 0,
            isError: false,
          };
          const fa = fileAccess(name, input);
          if (fa) {
            tc.file = fa.file;
            tc.fileOp = fa.op;
          }
          byCallId.set(tc.id, tc);
          pending.push(tc);
        } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
          const tc = byCallId.get(String(p.call_id));
          if (tc) {
            const out = typeof p.output === 'string' ? parseArgs(p.output) : p.output;
            tc.resultChars = contentChars(out) || (typeof p.output === 'string' ? p.output.length : 0);
            tc.resultHash = contentHash((out as any)?.output ?? out ?? '');
            const code = (out as any)?.metadata?.exit_code;
            tc.isError = typeof code === 'number' && code !== 0;
          }
        } else if (p.type === 'message' && p.role === 'user' && !turn) {
          // fallback for rollouts without event_msg.user_message
          const text = Array.isArray(p.content) ? p.content.find((c: any) => typeof c?.text === 'string')?.text : undefined;
          if (text && !text.startsWith('<')) ensureTurn(ts, oneLine(text));
        }
        break;
      }
      case 'event_msg': {
        if (p.type === 'user_message') {
          turn = undefined;
          ensureTurn(ts, oneLine(String(p.message ?? '')) || '[empty prompt]');
        } else if (p.type === 'token_count' && p.info) {
          const total = p.info.total_token_usage?.total_tokens;
          if (typeof total === 'number' && total === lastTotal) break; // duplicate event
          if (typeof total === 'number') lastTotal = total;
          const u = p.info.last_token_usage;
          if (!u) break;
          const cached = Number(u.cached_input_tokens ?? 0);
          const call: ApiCall = {
            id: `${session.id}:${n++}`,
            timestamp: ts,
            model,
            usage: {
              input: Math.max(0, Number(u.input_tokens ?? 0) - cached),
              output: Number(u.output_tokens ?? 0),
              cacheRead: cached,
              cacheWrite5m: 0,
              cacheWrite1h: 0,
              reasoning: Number(u.reasoning_output_tokens ?? 0),
            },
            toolCalls: pending,
            cost: 0,
          };
          pending = [];
          ensureTurn(ts).calls.push(call);
        }
        break;
      }
    }
  }
  session.turns = session.turns.filter((t) => t.calls.length > 0);
  session.turns.forEach((t, i) => (t.index = i));
  return session;
}

export const codexParser: Parser = {
  id: 'codex',
  name: 'Codex CLI',
  defaultDir: codexDefaultDir,
  async load(dir: string, opts: LoadOptions = {}): Promise<Session[]> {
    const files = await walk(dir, (p) => p.endsWith('.jsonl'));
    const out: Session[] = [];
    for (const f of files) {
      if (opts.since && (await fs.stat(f)).mtimeMs < opts.since) continue;
      const s = await parseCodexFile(f);
      if (s.turns.length) out.push(s);
    }
    return out;
  },
};
