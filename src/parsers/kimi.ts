import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { home } from '../paths.js';
import type { ApiCall, Capabilities, Session, ToolCall } from '../types.js';
import { FULL_CAPS } from '../types.js';
import { oneLine, readJsonl, walk } from '../util.js';
import { finish, lastTurn, newCall, newSession, newToolCall, newTurn, num, promptText, setCwd, setResult, touch } from './common.js';
import type { LoadOptions, Parser } from './types.js';

/**
 * EXPERIMENTAL - Kimi CLI (MoonshotAI/kimi-cli, Python).
 *   ~/.kimi/sessions/<md5(work dir)>/<session-id>/wire.jsonl            ($KIMI_SHARE_DIR)
 *   ~/.kimi/sessions/<md5(work dir)>/<session-id>/subagents/<agent-id>/wire.jsonl
 *   ~/.kimi/kimi.json   {work_dirs:[{path, kaos}]}  maps the md5 folder back to the work dir
 *   ~/.kimi/config.toml default_model + [models.<name>] model = "<provider model id>"
 *
 * wire.jsonl: a {type:"metadata", protocol_version} header, then records
 * {timestamp (unix seconds, float), message:{type, payload}}:
 *   TurnBegin {user_input}          a user prompt
 *   StepBegin {n}                   one model request per step
 *   ToolCall {id, function:{name, arguments (JSON string)}}
 *   ToolResult {tool_call_id, return_value:{is_error, output, message}}
 *   StatusUpdate {token_usage:{input_other (uncached), output, input_cache_read,
 *                 input_cache_creation}, message_id, context_tokens}
 *   SubagentEvent {parent_tool_call_id, agent_id, event}  (mirrored; the subagent's own
 *                 wire.jsonl is read instead, so these are ignored for usage)
 * The wire records no model id, so every request is attributed to the configured default
 * model. StatusUpdates for the same message_id are de-duplicated (largest wins).
 * Tools: ReadFile{path}, StrReplaceFile{path,edit}, WriteFile{path}, Shell{command}, Agent.
 *
 * Format from kimi-cli's wire/types.py, wire/file.py, session.py, metadata.py, config.py,
 * subagents/store.py and kosong's TokenUsage / ToolCall / ToolResult (Apache-2.0, formats only),
 * cross-checked against tokscale's Kimi adapter (MIT). Not yet validated against real logs.
 * Kimi Code (~/.kimi-code, a different wire format) is not read yet.
 */

const KIMI_CAPS: Capabilities = { ...FULL_CAPS };

export function kimiShareDir(): string {
  return process.env.KIMI_SHARE_DIR || path.join(home(), '.kimi');
}

/** The configured default model's provider id, from config.toml (or legacy config.json). */
export function kimiModelFromConfig(text: string): string | undefined {
  if (text.trim().startsWith('{')) {
    try {
      const j = JSON.parse(text);
      const name = j.default_model;
      return (name && j.models?.[name]?.model) || name || j.model || undefined;
    } catch {
      return undefined;
    }
  }
  const def = text.match(/^\s*default_model\s*=\s*["']([^"']+)["']/m)?.[1];
  if (!def) return undefined;
  const esc = def.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sec = text.match(new RegExp(`^\\s*\\[models\\.(?:"${esc}"|'${esc}'|${esc})\\]\\s*$([\\s\\S]*?)(?=^\\s*\\[|$(?![\\s\\S]))`, 'm'));
  return sec?.[1].match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1] ?? def;
}

async function readText(f: string): Promise<string | undefined> {
  try {
    return await fs.readFile(f, 'utf8');
  } catch {
    return undefined;
  }
}

function parseArgs(a: unknown): unknown {
  if (typeof a !== 'string') return a ?? null;
  try {
    return JSON.parse(a);
  } catch {
    return a;
  }
}

export async function parseKimiWire(file: string, id: string, model: string, spawns?: Map<string, ToolCall>): Promise<Session> {
  const s = newSession('kimi', id, file, KIMI_CAPS);
  const byCall = new Map<string, ToolCall>();
  const byMsg = new Map<string, ApiCall>();
  let step: { call?: ApiCall; tools: ToolCall[]; ts: number } | undefined;
  let n = 0;
  const callFor = (ts: number): ApiCall => {
    if (!step) step = { tools: [], ts };
    if (!step.call) {
      step.call = newCall(`${id}:${n++}`, step.ts || ts, model);
      lastTurn(s, step.ts || ts).calls.push(step.call);
    }
    return step.call;
  };
  for await (const e of readJsonl(file)) {
    const m = e.message;
    if (!m || typeof m.type !== 'string') continue;
    const ts = typeof e.timestamp === 'number' && e.timestamp > 0 ? Math.round(e.timestamp * 1000) : 0;
    touch(s, ts);
    const p = m.payload ?? {};
    switch (m.type) {
      case 'TurnBegin': {
        step = undefined;
        const text = typeof p.user_input === 'string' ? p.user_input : promptText(p.user_input);
        newTurn(s, ts, oneLine(text ?? '') || '[empty prompt]');
        if (!s.title && text) s.title = oneLine(text, 80);
        break;
      }
      case 'StepBegin':
        step = { tools: [], ts };
        break;
      case 'ToolCall': {
        const tc = newToolCall(String(p.id ?? `${id}:t${byCall.size}`), String(p.function?.name ?? 'tool'), parseArgs(p.function?.arguments));
        byCall.set(tc.id, tc);
        callFor(ts).toolCalls.push(tc);
        break;
      }
      case 'ToolResult': {
        const tc = byCall.get(String(p.tool_call_id));
        const rv = p.return_value ?? {};
        if (tc) setResult(tc, rv.output ?? rv.message ?? '', rv.is_error === true);
        break;
      }
      case 'SubagentEvent': {
        const host = byCall.get(String(p.parent_tool_call_id ?? p.task_tool_call_id));
        if (host && typeof p.agent_id === 'string') spawns?.set(p.agent_id, host);
        break;
      }
      case 'StatusUpdate': {
        const u = p.token_usage;
        if (!u) break;
        const usage = { input: num(u.input_other), output: num(u.output), cacheRead: num(u.input_cache_read), cacheWrite5m: num(u.input_cache_creation) };
        const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite5m;
        if (!total) break;
        const key = typeof p.message_id === 'string' ? p.message_id : undefined;
        const prev = key ? byMsg.get(key) : undefined;
        if (prev) {
          const pt = prev.usage.input + prev.usage.output + prev.usage.cacheRead + prev.usage.cacheWrite5m;
          if (total > pt) Object.assign(prev.usage, usage);
          break;
        }
        const call = callFor(ts);
        if (call.usage.input + call.usage.output + call.usage.cacheRead + call.usage.cacheWrite5m > 0) {
          // a second usage report inside one step without a message id: a separate request
          step = { tools: [], ts };
          const c2 = callFor(ts);
          Object.assign(c2.usage, usage);
          if (key) byMsg.set(key, c2);
          break;
        }
        Object.assign(call.usage, usage);
        if (key) byMsg.set(key, call);
        break;
      }
    }
  }
  return finish(s);
}

export const kimiParser: Parser = {
  id: 'kimi',
  name: 'Kimi CLI',
  verified: false,
  caps: KIMI_CAPS,
  defaultDirs: () => [path.join(kimiShareDir(), 'sessions')],
  async load(dir: string, opts: LoadOptions = {}): Promise<Session[]> {
    const share = path.dirname(dir);
    const config = (await readText(path.join(share, 'config.toml'))) ?? (await readText(path.join(share, 'config.json')));
    const model = (config && kimiModelFromConfig(config)) || 'kimi-unknown';
    const workDirs = new Map<string, string>();
    try {
      const meta = JSON.parse((await readText(path.join(share, 'kimi.json'))) ?? '{}');
      for (const wd of meta.work_dirs ?? []) {
        if (typeof wd?.path !== 'string') continue;
        const h = createHash('md5').update(wd.path, 'utf8').digest('hex');
        workDirs.set(!wd.kaos || wd.kaos === 'local' ? h : `${wd.kaos}_${h}`, wd.path);
      }
    } catch {
      /* no metadata: project falls back to the folder name */
    }
    const files = await walk(dir, (p) => path.basename(p) === 'wire.jsonl');
    const mains = new Map<string, Session>();
    const spawns = new Map<string, ToolCall>();
    const subs: Array<{ s: Session; parent: string; agentId: string }> = [];
    for (const f of files) {
      if (opts.since && (await fs.stat(f)).mtimeMs < opts.since) continue;
      const rel = path.relative(dir, f).split(path.sep);
      const isSub = rel.includes('subagents');
      const sessionId = rel[1] ?? path.basename(path.dirname(f));
      const agentId = isSub ? rel[rel.indexOf('subagents') + 1] : '';
      const s = await parseKimiWire(f, isSub ? `agent-${agentId}` : sessionId, model, spawns);
      if (!s.turns.length) continue;
      const cwd = workDirs.get(rel[0]);
      if (cwd) setCwd(s, cwd);
      else s.project = rel[0]?.slice(0, 8) ?? 'kimi';
      if (isSub) {
        s.isSubagent = true;
        s.agentDescription = s.title;
        subs.push({ s, parent: sessionId, agentId });
      } else mains.set(sessionId, s);
    }
    for (const { s, parent, agentId } of subs) {
      const p = mains.get(parent);
      let host = spawns.get(agentId);
      if (host?.subagent) host = undefined;
      if (!host && p)
        for (const t of p.turns)
          for (const c of t.calls)
            for (const tc of c.toolCalls) if (/^(Agent|Task)$/.test(tc.name) && !tc.subagent && c.timestamp <= s.start + 60_000) host = tc;
      if (host) host.subagent = s;
      else mains.set(s.id, s);
    }
    return [...mains.values()];
  },
};
