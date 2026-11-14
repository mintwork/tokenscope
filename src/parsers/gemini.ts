import { promises as fs } from 'node:fs';
import path from 'node:path';
import { home, uniq } from '../paths.js';
import type { Capabilities, Session, ToolCall } from '../types.js';
import { FULL_CAPS } from '../types.js';
import { oneLine, parseTime, readJsonl, walk } from '../util.js';
import { finish, newCall, newSession, newToolCall, newTurn, num, promptText, setCwd, setResult, touch, lastTurn } from './common.js';
import type { LoadOptions, Parser } from './types.js';

/**
 * EXPERIMENTAL - Google Gemini CLI chat recordings:
 *   ~/.gemini/tmp/<project-slug-or-hash>/chats/session-<ts>-<id>.jsonl   (current, append-only)
 *   ~/.gemini/tmp/<project>/chats/session-*.json                           (legacy, one object)
 *   ~/.gemini/tmp/<project>/chats/<parentSessionId>/<subagentId>.jsonl     (subagents)
 *   ~/.gemini/tmp/<project>/.project_root  -> absolute project path
 *
 * JSONL lines: a metadata record {sessionId, projectHash, startTime, kind}, message
 * records {id, type:"user"|"gemini"|..., tokens, model, toolCalls}, and `$set` /
 * `$rewindTo` / `$patch` operations. A message is re-appended in full whenever it
 * changes - the last copy of each id wins. Rewinds are ignored on purpose: those
 * requests were still billed.
 *
 * tokens {input (INCLUDES cached), output (EXCLUDES thoughts), cached, thoughts, tool, total}.
 * No cache-write counts. Side calls (compression, loop detection) are not recorded.
 *
 * Learned from gemini-cli's chatRecordingService and the ccusage / splitrail
 * Gemini adapters (MIT). Not yet validated on real logs. Qwen Code (a fork)
 * uses a different, Claude-Code-like transcript - see qwen.ts.
 */

const GEMINI_CAPS: Capabilities = { ...FULL_CAPS, cacheWrites: false };

export function geminiDirs(): string[] {
  const base = process.env.GEMINI_CLI_HOME || home();
  return uniq([path.join(base, '.gemini', 'tmp'), path.join(home(), '.cache', '.gemini', 'tmp')]);
}

interface Rec {
  meta: { sessionId?: string; kind?: string; startTime?: string; summary?: string };
  messages: Map<string, any>;
}

async function readRecording(file: string): Promise<Rec> {
  const rec: Rec = { meta: {}, messages: new Map() };
  if (file.endsWith('.json')) {
    let d: any;
    try {
      d = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      return rec;
    }
    rec.meta = { sessionId: d?.sessionId, kind: d?.kind, startTime: d?.startTime, summary: d?.summary };
    for (const m of Array.isArray(d?.messages) ? d.messages : []) if (m && typeof m.id === 'string') rec.messages.set(m.id, m);
    return rec;
  }
  for await (const e of readJsonl(file)) {
    if (e.$set && typeof e.$set === 'object') {
      if (typeof e.$set.summary === 'string') rec.meta.summary = e.$set.summary;
      if (Array.isArray(e.$set.messages)) for (const m of e.$set.messages) if (m?.id) rec.messages.set(m.id, m);
      continue;
    }
    if (e.$patch && typeof e.$patch === 'object') {
      // final tool output text after history sync
      for (const u of [e.$patch, ...(Array.isArray(e.$patch.updates) ? e.$patch.updates : [])]) {
        const m = u?.id ? rec.messages.get(u.id) : undefined;
        if (!m || !Array.isArray(u.toolCalls)) continue;
        for (const tcu of u.toolCalls) {
          const tc = (m.toolCalls ?? []).find((x: any) => x.id === tcu.id);
          if (tc && tcu.result) tc.result = tcu.result;
        }
      }
      continue;
    }
    if ('$rewindTo' in e) continue;
    if (typeof e.id === 'string') {
      rec.messages.set(e.id, e);
      continue;
    }
    if (typeof e.sessionId === 'string') rec.meta = { ...rec.meta, sessionId: e.sessionId, kind: e.kind, startTime: e.startTime };
  }
  return rec;
}

function toolOutput(result: unknown): { text: unknown; error: boolean } {
  if (!Array.isArray(result)) return { text: result ?? '', error: false };
  let text = '';
  let error = false;
  for (const p of result) {
    const r = (p as any)?.functionResponse?.response;
    if (!r) continue;
    if (r.error !== undefined) {
      error = true;
      text += typeof r.error === 'string' ? r.error : JSON.stringify(r.error);
    }
    if (r.output !== undefined) text += typeof r.output === 'string' ? r.output : JSON.stringify(r.output);
  }
  return { text, error };
}

export function buildGeminiSession(rec: Rec, file: string, project?: string): Session | undefined {
  const id = rec.meta.sessionId ?? path.basename(file).replace(/\.jsonl?$/, '');
  const s = newSession('gemini-cli', id, file, GEMINI_CAPS);
  if (project) setCwd(s, project);
  if (rec.meta.summary) s.title = oneLine(rec.meta.summary, 100);
  touch(s, parseTime(rec.meta.startTime));
  for (const m of rec.messages.values()) {
    const ts = parseTime(m.timestamp);
    touch(s, ts);
    if (m.type === 'user') {
      const text = typeof m.displayContent === 'string' ? m.displayContent : promptText(m.content);
      if (text === undefined || /^\s*<session_context>/.test(text)) continue;
      newTurn(s, ts, oneLine(text) || '[empty prompt]');
      if (!s.title) s.title = oneLine(text, 80);
      continue;
    }
    if (m.type !== 'gemini') continue;
    const t = m.tokens;
    const calls: ToolCall[] = [];
    for (const tc of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
      const call = newToolCall(String(tc.id ?? `${m.id}:${calls.length}`), String(tc.name ?? 'tool'), tc.args);
      if (tc.result != null || tc.status === 'error' || tc.status === 'success') {
        const { text, error } = toolOutput(tc.result);
        setResult(call, text, error || tc.status === 'error');
      }
      calls.push(call);
    }
    if (!t && !calls.length) continue;
    const input = num(t?.input);
    const output = num(t?.output);
    const cached = Math.min(input, num(t?.cached));
    const thoughts = num(t?.thoughts);
    const tool = num(t?.tool);
    // input normally includes cached tokens; ccusage only subtracts when the total confirms it
    const includesCached = !t?.total || num(t.total) === input + output + thoughts + tool;
    const call = newCall(String(m.id), ts, String(m.model ?? 'gemini-unknown'), {
      input: (includesCached ? input - cached : input) + tool,
      cacheRead: cached,
      output: output + thoughts,
      reasoning: thoughts,
    });
    call.toolCalls = calls;
    lastTurn(s, ts).calls.push(call);
  }
  return finish(s);
}

async function projectRoot(projectDir: string): Promise<string | undefined> {
  try {
    const p = (await fs.readFile(path.join(projectDir, '.project_root'), 'utf8')).trim();
    return p || undefined;
  } catch {
    return undefined;
  }
}

export const geminiParser: Parser = {
  id: 'gemini-cli',
  name: 'Gemini CLI',
  verified: false,
  caps: GEMINI_CAPS,
  defaultDirs: geminiDirs,
  async load(dir: string, opts: LoadOptions = {}): Promise<Session[]> {
    const files = await walk(dir, (p) => /[\\/]chats[\\/]/.test(p) && (p.endsWith('.jsonl') || (p.endsWith('.json') && path.basename(p).startsWith('session-'))));
    // projects.json maps abs path -> slug (newer builds)
    const slugToPath = new Map<string, string>();
    try {
      const pj = JSON.parse(await fs.readFile(path.join(path.dirname(dir), 'projects.json'), 'utf8'));
      for (const [abs, slug] of Object.entries(pj?.projects ?? {})) slugToPath.set(String(slug), abs);
    } catch {
      /* optional */
    }
    const sessions = new Map<string, { s: Session; jsonl: boolean; parentId?: string }>();
    const roots = new Map<string, string | undefined>();
    for (const f of files) {
      if (opts.since && (await fs.stat(f)).mtimeMs < opts.since) continue;
      const rel = path.relative(dir, f).split(path.sep);
      const projectDir = path.join(dir, rel[0]);
      if (!roots.has(projectDir)) roots.set(projectDir, (await projectRoot(projectDir)) ?? slugToPath.get(rel[0]));
      const rec = await readRecording(f);
      const s = buildGeminiSession(rec, f, roots.get(projectDir));
      if (!s || !s.turns.length) continue;
      if (!s.projectPath) s.project = rel[0].length === 64 ? `gemini-${rel[0].slice(0, 8)}` : rel[0];
      const chatsIdx = rel.indexOf('chats');
      const parentId = rel.length - chatsIdx > 2 ? rel[chatsIdx + 1] : undefined;
      if (parentId || rec.meta.kind === 'subagent') {
        s.isSubagent = true;
        s.agentDescription = s.title;
      }
      const jsonl = f.endsWith('.jsonl');
      const prev = sessions.get(s.id);
      // a legacy .json and its migrated .jsonl can coexist: prefer the .jsonl
      if (!prev || (jsonl && !prev.jsonl)) sessions.set(s.id, { s, jsonl, parentId });
    }
    const out: Session[] = [];
    for (const { s, parentId } of sessions.values()) {
      const parent = parentId ? sessions.get(parentId)?.s : undefined;
      if (parent) {
        let host: ToolCall | undefined;
        for (const t of parent.turns)
          for (const c of t.calls) for (const tc of c.toolCalls) if (tc.name === 'invoke_agent' && !tc.subagent && c.timestamp <= s.start + 60_000) host = tc;
        if (host) {
          host.subagent = s;
          continue;
        }
      }
      out.push(s);
    }
    return out;
  },
};
