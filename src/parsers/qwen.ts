import { promises as fs } from 'node:fs';
import path from 'node:path';
import { home } from '../paths.js';
import type { Capabilities, Session, ToolCall } from '../types.js';
import { FULL_CAPS } from '../types.js';
import { oneLine, parseTime, readJsonl, walk } from '../util.js';
import { finish, newCall, newSession, newToolCall, newTurn, num, setCwd, setResult, touch, lastTurn } from './common.js';
import { slugToName } from './claude-code.js';
import type { LoadOptions, Parser } from './types.js';

/**
 * EXPERIMENTAL - Qwen Code transcripts (a Gemini CLI fork with a Claude-Code-like log):
 *   ~/.qwen/projects/<sanitized-cwd>/chats/<sessionId>.jsonl
 *   ~/.qwen/projects/<sanitized-cwd>/subagents/<sessionId>/agent-<id>.jsonl
 * Records {uuid, parentUuid, sessionId, timestamp, type:"user"|"assistant"|"tool_result"|"system", cwd, ...}.
 * assistant.usageMetadata {promptTokenCount (INCLUDES cached), candidatesTokenCount,
 * cachedContentTokenCount, thoughtsTokenCount, totalTokenCount}. On OpenAI-compatible
 * backends candidates already include thoughts; we infer which from totalTokenCount.
 * `/branch` copies records with the same uuid into a new file - de-duplicated by uuid.
 * `system/ui_telemetry` api_response events duplicate assistant usage and are ignored.
 *
 * Learned from qwen-code's chatRecordingService and the ccusage / splitrail Qwen
 * adapters (MIT). Not yet validated on real logs. Costs for Qwen OAuth (free tier)
 * are API-price equivalents.
 */

const QWEN_CAPS: Capabilities = { ...FULL_CAPS, cacheWrites: false };

export function qwenDir(): string {
  return path.join(process.env.QWEN_RUNTIME_DIR || process.env.QWEN_HOME || path.join(home(), '.qwen'), 'projects');
}

/** Map Qwen OAuth aliases to a priced model. */
const ALIASES: Record<string, string> = { 'coder-model': 'qwen3-coder-plus', 'vision-model': 'qwen3-vl-plus' };

export async function parseQwenFile(file: string, seen: Set<string>): Promise<Session | undefined> {
  const s = newSession('qwen-code', path.basename(file, '.jsonl'), file, QWEN_CAPS);
  const byCall = new Map<string, ToolCall>();
  let model = '';
  for await (const e of readJsonl(file)) {
    if (typeof e.uuid === 'string') {
      if (seen.has(e.uuid)) continue; // copied by /branch or replayed
      seen.add(e.uuid);
    }
    const ts = parseTime(e.timestamp);
    touch(s, ts);
    setCwd(s, e.cwd);
    if (typeof e.sessionId === 'string' && !s.isSubagent) s.id = e.sessionId;
    const parts: any[] = Array.isArray(e.message?.parts) ? e.message.parts : [];
    switch (e.type) {
      case 'system':
        if (e.subtype === 'custom_title' && typeof e.systemPayload?.customTitle === 'string') s.title = oneLine(e.systemPayload.customTitle, 100);
        if (e.subtype === 'session_model' && typeof e.systemPayload?.modelId === 'string') model = e.systemPayload.modelId;
        break;
      case 'user': {
        if (e.provenance && e.provenance !== 'real_user') break;
        if (parts.some((p) => p?.functionResponse)) break;
        const text = parts.filter((p) => typeof p?.text === 'string' && !p.thought).map((p) => p.text).join(' ');
        if (/^\s*<session_context>/.test(text)) break;
        newTurn(s, ts, oneLine(text) || '[empty prompt]');
        if (!s.title) s.title = oneLine(text, 80);
        break;
      }
      case 'assistant': {
        const u = e.usageMetadata;
        const tools: ToolCall[] = [];
        for (const p of parts)
          if (p?.functionCall) {
            const tc = newToolCall(String(p.functionCall.id ?? `${e.uuid}:${tools.length}`), String(p.functionCall.name ?? 'tool'), p.functionCall.args);
            byCall.set(tc.id, tc);
            tools.push(tc);
          }
        if (!u && !tools.length) break;
        const prompt = num(u?.promptTokenCount);
        const cand = num(u?.candidatesTokenCount);
        const cached = Math.min(prompt, num(u?.cachedContentTokenCount));
        const thoughts = num(u?.thoughtsTokenCount);
        const total = num(u?.totalTokenCount);
        // Gemini-native: total = prompt + candidates + thoughts. OpenAI-compatible: thoughts already in candidates.
        const thoughtsSeparate = thoughts > 0 && total > 0 && Math.abs(total - (prompt + cand + thoughts)) < Math.abs(total - (prompt + cand));
        let output = cand + (thoughtsSeparate ? thoughts : 0);
        if (!prompt && !cand && total) output = total;
        const m = String(e.model ?? model ?? 'unknown') || 'unknown';
        const call = newCall(String(e.uuid ?? `${s.id}:${tools.length}`), ts, ALIASES[m] ?? m, {
          input: prompt - cached,
          cacheRead: cached,
          output,
          reasoning: thoughts,
        });
        call.toolCalls = tools;
        lastTurn(s, ts).calls.push(call);
        break;
      }
      case 'tool_result':
        for (const p of parts) {
          const fr = p?.functionResponse;
          const tc = fr ? byCall.get(String(fr.id ?? e.toolCallResult?.callId)) : undefined;
          if (!tc) continue;
          const r = fr.response ?? {};
          const status = e.toolCallResult?.status;
          setResult(tc, r.output ?? r.error ?? '', r.error !== undefined || status === 'error');
        }
        break;
    }
  }
  return finish(s);
}

export const qwenParser: Parser = {
  id: 'qwen-code',
  name: 'Qwen Code',
  verified: false,
  caps: QWEN_CAPS,
  defaultDirs: () => [qwenDir()],
  async load(dir: string, opts: LoadOptions = {}): Promise<Session[]> {
    const files = await walk(dir, (p) => p.endsWith('.jsonl') && /[\\/](chats|subagents)[\\/]/.test(p));
    // parse originals before /branch copies: oldest first
    const stats = await Promise.all(files.map(async (f) => ({ f, st: await fs.stat(f) })));
    stats.sort((a, b) => a.st.birthtimeMs - b.st.birthtimeMs || a.f.localeCompare(b.f));
    const seen = new Set<string>();
    const mains = new Map<string, Session>();
    const subs: Array<{ s: Session; parent: string }> = [];
    for (const { f, st } of stats) {
      if (opts.since && st.mtimeMs < opts.since) continue;
      const rel = path.relative(dir, f).split(path.sep);
      const isSub = rel.includes('subagents');
      const s = await parseQwenFile(f, seen);
      if (!s || !s.turns.length) continue;
      if (!s.projectPath) s.project = slugToName(rel[0]);
      if (isSub) {
        s.isSubagent = true;
        s.id = path.basename(f, '.jsonl');
        s.agentDescription = s.title;
        subs.push({ s, parent: rel[rel.indexOf('subagents') + 1] });
      } else mains.set(s.id, s);
    }
    for (const { s, parent } of subs) {
      const p = mains.get(parent);
      let host: ToolCall | undefined;
      if (p) for (const t of p.turns) for (const c of t.calls) for (const tc of c.toolCalls) if ((tc.name === 'agent' || tc.name === 'task') && !tc.subagent && c.timestamp <= s.start + 60_000) host = tc;
      if (host) host.subagent = s;
      else mains.set(s.id, s);
    }
    return [...mains.values()];
  },
};
