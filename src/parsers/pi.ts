import { promises as fs } from 'node:fs';
import path from 'node:path';
import { home } from '../paths.js';
import type { Capabilities, Session, ToolCall, Usage } from '../types.js';
import { FULL_CAPS } from '../types.js';
import { oneLine, parseTime, readJsonl, walk } from '../util.js';
import { finish, lastTurn, newCall, newSession, newToolCall, newTurn, num, promptText, setCwd, setResult, touch } from './common.js';
import type { LoadOptions, Parser } from './types.js';

/**
 * EXPERIMENTAL - pi coding agent (`pi`, earendil-works/pi, formerly badlogic/pi-mono).
 *   ~/.pi/agent/sessions/--<cwd-slug>--/<timestamp>_<session-id>.jsonl
 * ($PI_CODING_AGENT_SESSION_DIR, or $PI_CODING_AGENT_DIR/sessions)
 *
 * First line is a header {type:"session", version, id, timestamp, cwd, parentSession?}.
 * Entries form a tree (id/parentId) so branches live in the same file; every
 * assistant entry is a request that was made, so all of them are counted.
 *   {type:"message", message:{role:"user", content}}
 *   {type:"message", message:{role:"assistant", content:[text|thinking|toolCall{id,name,arguments}],
 *      provider, model, usage:{input (uncached), output (incl. reasoning), cacheRead, cacheWrite,
 *      cacheWrite1h? (subset of cacheWrite), reasoning?, cost:{total}}, timestamp(ms)}}
 *   {type:"message", message:{role:"toolResult", toolCallId, toolName, content, isError}}
 *   {type:"usage", kind, model, usage}           usage outside the conversation (e.g. cache warming)
 *   {type:"compaction"|"branch_summary", usage?} summary generation usage
 *   {type:"session_info", name}                  user-set session name
 * Built-in tools: read{path,offset,limit}, edit{path,edits[]}, write{path,content}, bash{command}.
 * `/fork` and `/clone` copy history into a new file; copies are de-duplicated by entry id +
 * message timestamp (oldest file first).
 *
 * Format from pi's docs/session-format.md, docs/message-types.md and packages/ai usage
 * normalization (MIT). Not yet validated against real logs.
 */

const PI_CAPS: Capabilities = { ...FULL_CAPS };

export function piSessionDirs(): string[] {
  if (process.env.PI_CODING_AGENT_SESSION_DIR) return [process.env.PI_CODING_AGENT_SESSION_DIR];
  return [path.join(process.env.PI_CODING_AGENT_DIR || path.join(home(), '.pi', 'agent'), 'sessions')];
}

function readUsage(u: any): { usage: Partial<Usage>; cost?: number } {
  const write = num(u?.cacheWrite);
  const w1h = Math.min(write, num(u?.cacheWrite1h));
  const total = u?.cost && typeof u.cost === 'object' ? u.cost.total : undefined;
  return {
    usage: { input: num(u?.input), output: num(u?.output), cacheRead: num(u?.cacheRead), cacheWrite5m: write - w1h, cacheWrite1h: w1h, reasoning: num(u?.reasoning) },
    cost: typeof total === 'number' && Number.isFinite(total) ? total : undefined,
  };
}

const modelOf = (o: any): string => String(o?.responseModel || o?.model || o?.modelId || 'unknown');

export async function parsePiFile(file: string, seen: Set<string>): Promise<Session | undefined> {
  const base = path.basename(file, '.jsonl');
  const s = newSession('pi', base.replace(/^[^_]*_/, ''), file, PI_CAPS);
  const byCall = new Map<string, ToolCall>();
  let n = 0;
  const addCall = (key: string, ts: number, model: string, u: any, tools: ToolCall[] = []) => {
    const { usage, cost } = readUsage(u);
    if (!tools.length && !usage.input && !usage.output && !usage.cacheRead && !usage.cacheWrite5m && !usage.cacheWrite1h) return;
    const call = newCall(key, ts, model, usage);
    if (cost !== undefined) call.reportedCost = cost;
    call.toolCalls = tools;
    lastTurn(s, ts).calls.push(call);
  };
  for await (const e of readJsonl(file)) {
    const ts = parseTime(e.message?.timestamp) || parseTime(e.timestamp);
    touch(s, ts);
    if (e.type === 'session') {
      if (typeof e.id === 'string') s.id = e.id;
      setCwd(s, e.cwd);
      continue;
    }
    if (e.type === 'session_info' && typeof e.name === 'string' && e.name) {
      s.title = oneLine(e.name, 100);
      continue;
    }
    // forked / cloned sessions copy entries: count each request once
    const key = `${e.id ?? n++}:${e.message?.timestamp ?? e.timestamp ?? ''}`;
    if (e.type === 'usage' || ((e.type === 'compaction' || e.type === 'branch_summary') && e.usage)) {
      if (seen.has(key)) continue;
      seen.add(key);
      addCall(`${s.id}:${key}`, ts, modelOf(e), e.usage);
      continue;
    }
    if (e.type !== 'message' || !e.message) continue;
    const m = e.message;
    if (m.role === 'user') {
      const text = promptText(m.content);
      if (text !== undefined) {
        newTurn(s, ts, oneLine(text) || '[empty prompt]');
        if (!s.title) s.title = oneLine(text, 80);
      }
    } else if (m.role === 'assistant') {
      if (seen.has(key)) continue;
      seen.add(key);
      const tools: ToolCall[] = [];
      if (Array.isArray(m.content))
        for (const b of m.content)
          if (b?.type === 'toolCall') {
            const tc = newToolCall(String(b.id ?? `${key}:${tools.length}`), String(b.name ?? 'tool'), b.arguments);
            byCall.set(tc.id, tc);
            tools.push(tc);
          }
      addCall(`${s.id}:${key}`, ts, modelOf(m), m.usage, tools);
    } else if (m.role === 'toolResult') {
      const tc = byCall.get(String(m.toolCallId));
      if (tc) setResult(tc, m.content ?? '', m.isError === true);
      // a tool that ran its own model calls (nested usage) is billed too
      if (m.usage && !seen.has(key)) {
        seen.add(key);
        addCall(`${s.id}:${key}`, ts, `pi-tool:${m.toolName ?? 'tool'}`, m.usage); // model not recorded; priced from usage.cost
      }
    }
  }
  return finish(s);
}

export const piParser: Parser = {
  id: 'pi',
  name: 'pi agent',
  verified: false,
  caps: PI_CAPS,
  defaultDirs: piSessionDirs,
  async load(dir: string, opts: LoadOptions = {}): Promise<Session[]> {
    const files = await walk(dir, (p) => p.endsWith('.jsonl'));
    // file names start with the creation timestamp: originals sort before their forks
    const named = files.map((f) => ({ f, name: path.basename(f) })).sort((a, b) => a.name.localeCompare(b.name));
    const seen = new Set<string>();
    const out: Session[] = [];
    for (const { f } of named) {
      if (opts.since && (await fs.stat(f)).mtimeMs < opts.since) continue;
      const s = await parsePiFile(f, seen);
      if (s?.turns.length) out.push(s);
    }
    return out;
  },
};
