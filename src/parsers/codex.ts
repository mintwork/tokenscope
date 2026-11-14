import { createReadStream, promises as fs } from 'node:fs';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { ApiCall, Capabilities, Session, ToolCall } from '../types.js';
import { FULL_CAPS } from '../types.js';
import { exists, oneLine, parseTime, walk } from '../util.js';
import { finish, newCall, newSession, newToolCall, newTurn, num, setCwd, setResult, touch, lastTurn } from './common.js';
import type { LoadOptions, Parser } from './types.js';

/**
 * EXPERIMENTAL - OpenAI Codex CLI rollouts:
 *   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local ts>-<thread uuid>.jsonl   (+ archived_sessions/, *.jsonl.zst)
 * Each line is {timestamp, type, payload}:
 *   session_meta   {id, cwd, source, forked_from_id?, ...}
 *   turn_context   {model, cwd, ...}               - latest one gives the model
 *   event_msg      {type:"user_message", message}  - real prompts
 *                  {type:"token_count", info:{total_token_usage, last_token_usage} | null}
 *   response_item  function_call / custom_tool_call / local_shell_call (+ *_output)
 *
 * Token semantics (OpenAI): input_tokens INCLUDES cached_input_tokens (and the newer
 * cache_write_input_tokens); output_tokens INCLUDES reasoning_output_tokens.
 * token_count events can repeat with identical totals; per-request usage is
 * `last_token_usage` when the running total advanced, else the total's delta.
 * Forked / spawned threads replay their parent's lines; replayed usage is
 * de-duplicated across files by (timestamp, totals).
 *
 * Learned from the Codex source (codex-rs protocol / rollout crates) and the
 * ccusage + splitrail Codex adapters (MIT). Not yet validated on real logs.
 */

export const CODEX_CAPS: Capabilities = { ...FULL_CAPS, cacheWrites: false };

export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}
export const codexDefaultDir = (): string => path.join(codexHome(), 'sessions');

const SKIP_PROMPT = /^\s*(<environment_context>|<user_instructions>|# AGENTS\.md instructions for|<recommended_plugins>)/;

/** Server alias `codex-auto-review` resolves to different models over time (per ccusage's table). */
function resolveModel(model: string, ts: number): string {
  if (model !== 'codex-auto-review') return model;
  const d = new Date(ts).toISOString().slice(0, 10);
  if (d >= '2026-07-30') return 'gpt-5.6-luna';
  if (d >= '2026-03-05') return 'gpt-5.4';
  if (d >= '2026-02-05') return 'gpt-5.3-codex';
  if (d >= '2025-12-11') return 'gpt-5.2-codex';
  if (d >= '2025-11-13') return 'gpt-5.1-codex';
  if (d >= '2025-09-15') return 'gpt-5-codex';
  return 'gpt-5';
}

function parseArgs(a: unknown): unknown {
  if (typeof a !== 'string') return a;
  try {
    return JSON.parse(a);
  } catch {
    return a;
  }
}

/** Tool output text + error flag from the several shapes Codex has written. */
function readOutput(raw: unknown): { text: unknown; error: boolean } {
  let out: unknown = raw;
  if (typeof out === 'string' && out.startsWith('{')) {
    const j = parseArgs(out) as any;
    if (j && typeof j === 'object' && 'output' in j) {
      const code = j.metadata?.exit_code;
      return { text: j.output, error: typeof code === 'number' && code !== 0 };
    }
  }
  if (Array.isArray(out)) out = out.map((x: any) => (typeof x?.text === 'string' ? x.text : '')).join('');
  if (out && typeof out === 'object' && 'content' in (out as object)) out = (out as any).content;
  const text = typeof out === 'string' ? out : JSON.stringify(out ?? '');
  const m = text.match(/^(?:Exit code: (\d+)|[\s\S]{0,200}?Process exited with code (\d+))/);
  const code = m ? Number(m[1] ?? m[2]) : 0;
  return { text, error: code !== 0 };
}

let zstdWarned = false;
async function* lines(file: string, notes?: string[]): AsyncGenerator<string> {
  if (file.endsWith('.zst')) {
    const z = zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer };
    if (!z.zstdDecompressSync) {
      if (!zstdWarned) notes?.push(`Codex: skipped compressed *.jsonl.zst rollouts (needs Node 22.15+ for zstd)`);
      zstdWarned = true;
      return;
    }
    let text = '';
    try {
      text = z.zstdDecompressSync(await fs.readFile(file)).toString('utf8');
    } catch {
      return;
    }
    yield* text.split('\n');
    return;
  }
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const l of rl) yield l;
}

export interface CodexParseResult {
  session: Session;
  parentThreadId?: string;
  /** usage event keys, for cross-file replay de-duplication */
  usageKeys: Map<ApiCall, string>;
}

export async function parseCodexFile(file: string, notes?: string[]): Promise<CodexParseResult | undefined> {
  const s = newSession('codex', path.basename(file).replace(/\.jsonl(\.zst)?$/, '').replace(/^rollout-/, ''), file, CODEX_CAPS);
  let model = '';
  let modelFromContext = false;
  const byCallId = new Map<string, ToolCall>();
  let pending: ToolCall[] = [];
  let prevTotal: any;
  let n = 0;
  let parentThreadId: string | undefined;
  let sawWrapper = false;
  let sawCacheWrite = false;
  const usageKeys = new Map<ApiCall, string>();
  let sawUserMessageEvent = false;
  const fallbackPrompts: Array<{ ts: number; text: string }> = [];

  for await (const line of lines(file, notes)) {
    if (!line || line.charCodeAt(0) !== 123) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e.payload || typeof e.type !== 'string') continue; // pre-wrapper rollouts carry no usage
    sawWrapper = true;
    const ts = parseTime(e.timestamp);
    touch(s, ts);
    const p = e.payload;
    switch (e.type) {
      case 'session_meta':
        if (typeof p.id === 'string') s.id = p.id;
        setCwd(s, p.cwd);
        parentThreadId = p.source?.subagent?.thread_spawn?.parent_thread_id ?? undefined;
        if (p.source?.subagent) {
          s.isSubagent = true;
          s.agentDescription = p.agent_nickname ?? p.agent_role ?? (typeof p.source.subagent === 'string' ? p.source.subagent : 'subagent');
        }
        break;
      case 'turn_context':
        if (typeof p.model === 'string') {
          model = p.model;
          modelFromContext = true;
        }
        if (typeof p.cwd === 'string') {
          s.projectPath = undefined;
          setCwd(s, p.cwd);
        }
        break;
      case 'response_item': {
        const t = p.type;
        if (t === 'function_call' || t === 'custom_tool_call' || t === 'local_shell_call') {
          const input = t === 'local_shell_call' ? p.action : t === 'custom_tool_call' ? p.input : parseArgs(p.arguments);
          const name = String(p.name ?? (t === 'local_shell_call' ? 'local_shell' : 'tool'));
          const tc = newToolCall(String(p.call_id ?? p.id ?? `call-${n++}`), name, input);
          byCallId.set(tc.id, tc);
          pending.push(tc);
        } else if (t === 'function_call_output' || t === 'custom_tool_call_output' || t === 'local_shell_call_output') {
          const tc = byCallId.get(String(p.call_id));
          if (tc) {
            const { text, error } = readOutput(p.output);
            setResult(tc, text, error);
          }
        } else if (t === 'message' && p.role === 'user' && Array.isArray(p.content)) {
          const text = p.content.find((c: any) => typeof c?.text === 'string')?.text;
          if (text && !SKIP_PROMPT.test(text)) fallbackPrompts.push({ ts, text });
        }
        break;
      }
      case 'event_msg': {
        if (p.type === 'user_message') {
          sawUserMessageEvent = true;
          newTurn(s, ts, oneLine(String(p.message ?? '')) || '[empty prompt]');
        } else if (p.type === 'token_count') {
          const info = p.info;
          if (!info) break;
          const total = info.total_token_usage;
          const last = info.last_token_usage;
          const same = (a: any, b: any) =>
            a && b && ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'].every((k) => num(a[k]) === num(b[k]));
          const advanced = !total || !prevTotal || !same(total, prevTotal);
          let u: any;
          if (advanced && last) u = last;
          else if (advanced && total && prevTotal) {
            u = {};
            for (const k of ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'])
              u[k] = Math.max(0, num(total[k]) - num(prevTotal[k]));
          } else if (advanced && total) u = total;
          if (total) prevTotal = total;
          if (!u) break;
          const input = num(u.input_tokens ?? u.prompt_tokens);
          const cached = Math.min(input, num(u.cached_input_tokens ?? u.cached_tokens));
          const write = Math.min(input - cached, num(u.cache_write_input_tokens));
          const output = num(u.output_tokens ?? u.completion_tokens);
          const reasoning = num(u.reasoning_output_tokens ?? u.reasoning_tokens);
          if (!input && !output && !cached && !reasoning) break; // context-window fill events etc.
          if (write) sawCacheWrite = true;
          const call = newCall(`${s.id}:${n++}`, ts, resolveModel(model || 'gpt-5', ts), {
            input: input - cached - write,
            output,
            reasoning,
            cacheRead: cached,
            cacheWrite5m: write,
          });
          call.toolCalls = pending;
          pending = [];
          usageKeys.set(call, `${e.timestamp}|${num(total?.total_tokens)}|${input}|${output}`);
          lastTurn(s, ts).calls.push(call);
        }
        break;
      }
    }
  }
  if (!sawWrapper) return undefined;
  if (!modelFromContext) notes?.push(`Codex: no model recorded in ${path.basename(file)}; assumed gpt-5 pricing`);
  if (!sawUserMessageEvent && fallbackPrompts.length && s.turns[0]) s.turns[0].prompt = oneLine(fallbackPrompts[0].text);
  s.caps.cacheWrites = sawCacheWrite;
  finish(s);
  return { session: s, parentThreadId, usageKeys };
}

async function readTitles(home: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const f = path.join(home, 'session_index.jsonl');
  if (!(await exists(f))) return titles;
  for (const l of (await fs.readFile(f, 'utf8')).split('\n')) {
    try {
      const j = JSON.parse(l);
      if (typeof j.id === 'string' && typeof j.thread_name === 'string') titles.set(j.id, j.thread_name);
    } catch {
      /* ignore */
    }
  }
  return titles;
}

export const codexParser: Parser = {
  id: 'codex',
  name: 'Codex CLI',
  verified: false,
  caps: CODEX_CAPS,
  defaultDirs: () => [codexDefaultDir(), path.join(codexHome(), 'archived_sessions')],
  async load(dir: string, opts: LoadOptions = {}): Promise<Session[]> {
    const files = await walk(dir, (p) => /\.jsonl(\.zst)?$/.test(p) && path.basename(p).startsWith('rollout-'));
    // a plain .jsonl wins over its .zst twin
    const plain = new Set(files.filter((f) => f.endsWith('.jsonl')));
    const parsed: CodexParseResult[] = [];
    for (const f of files) {
      if (f.endsWith('.zst') && plain.has(f.slice(0, -4))) continue;
      if (opts.since && (await fs.stat(f)).mtimeMs < opts.since) continue;
      const r = await parseCodexFile(f, opts.notes);
      if (r && r.session.turns.length) parsed.push(r);
    }
    const titles = await readTitles(path.dirname(dir));
    // replayed parent history: drop usage events already seen in an earlier thread
    parsed.sort((a, b) => a.session.start - b.session.start);
    const seen = new Set<string>();
    for (const r of parsed) {
      for (const t of r.session.turns)
        t.calls = t.calls.filter((c) => {
          const k = r.usageKeys.get(c);
          if (!k) return true;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      r.session.turns = r.session.turns.filter((t) => t.calls.length);
      const title = titles.get(r.session.id);
      if (title) r.session.title = oneLine(title, 100);
    }
    // attach spawned subagent threads to the parent's spawn_agent call
    const byId = new Map(parsed.map((r) => [r.session.id, r.session]));
    const out: Session[] = [];
    for (const r of parsed) {
      if (!r.session.turns.length) continue;
      const parent = r.parentThreadId ? byId.get(r.parentThreadId) : undefined;
      if (parent) {
        let host: ToolCall | undefined;
        for (const t of parent.turns)
          for (const c of t.calls)
            for (const tc of c.toolCalls) if (tc.name === 'spawn_agent' && !tc.subagent && c.timestamp <= r.session.start + 60_000) host = tc;
        if (host) {
          host.subagent = r.session;
          continue;
        }
      }
      out.push(r.session);
    }
    return out;
  },
};
