import { promises as fs } from 'node:fs';
import path from 'node:path';
import { home } from '../paths.js';
import type { Capabilities, Session } from '../types.js';
import { oneLine, parseTime, readJsonl, walk } from '../util.js';
import { envDirs, finish, newCall, newSession, newToolCall, newTurn, num, promptText, setCwd, setResult, toolSeen, touch, lastTurn } from './common.js';
import { slugToName } from './claude-code.js';
import type { LoadOptions, Parser } from './types.js';

/**
 * EXPERIMENTAL - Factory Droid CLI.
 *   ~/.factory/sessions[/<cwd-slug>]/<sessionId>.settings.json   (token totals)
 *   ~/.factory/sessions[/<cwd-slug>]/<sessionId>.jsonl           (transcript)
 *
 * Token usage is only recorded as cumulative per-session totals in
 * `settings.json` -> tokenUsage {inputTokens, outputTokens, cacheCreationTokens,
 * cacheReadTokens, thinkingTokens}, so per-request detectors (cache rebuilds)
 * can't run. The transcript is read defensively for Anthropic-style
 * tool_use / tool_result blocks; tool-based detectors run only when found.
 *
 * Format learned from the ccusage and better-ccusage Droid adapters (MIT) and
 * Factory's docs; not yet validated against real logs.
 */

const DROID_CAPS: Capabilities = {
  perRequestTokens: false,
  cacheReads: true,
  cacheWrites: true,
  toolCalls: true,
  toolOutputs: true,
  filePaths: true,
  timestamps: false,
};

/** "custom:Claude-Opus-4.5-Thinking-[Anthropic]-0" -> "claude-opus-4-5-thinking-0" */
export function normalizeDroidModel(m: string): string {
  return m
    .replace(/^custom:/i, '')
    .replace(/\[[^\]]*\]/g, '')
    .toLowerCase()
    .replace(/[\s.\-_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function modelFromProvider(provider: unknown): string {
  const p = String(provider ?? '').toLowerCase();
  if (p.includes('anthropic')) return 'claude-unknown';
  if (p.includes('openai')) return 'gpt-unknown';
  if (p.includes('google') || p.includes('gemini') || p.includes('vertex')) return 'gemini-unknown';
  return 'unknown';
}

export async function parseDroidSession(settingsFile: string): Promise<Session | undefined> {
  let settings: any;
  try {
    settings = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  } catch {
    return undefined;
  }
  const id = path.basename(settingsFile).replace(/\.settings\.json$/, '');
  const transcript = settingsFile.replace(/\.settings\.json$/, '.jsonl');
  const s = newSession('droid', id, transcript, DROID_CAPS);
  const slug = path.basename(path.dirname(settingsFile));
  if (slug.startsWith('-')) s.project = slugToName(slug);

  const u = settings?.tokenUsage ?? {};
  const usage = {
    input: num(u.inputTokens),
    output: num(u.outputTokens) + num(u.thinkingTokens),
    cacheRead: num(u.cacheReadTokens),
    cacheWrite5m: num(u.cacheCreationTokens),
    reasoning: num(u.thinkingTokens),
  };
  const known = usage.input + usage.output + usage.cacheRead + usage.cacheWrite5m;
  if (!known && num(u.totalTokens)) usage.output = num(u.totalTokens);
  if (!usage.input && !usage.output && !usage.cacheRead && !usage.cacheWrite5m) return undefined;

  let model = typeof settings?.model === 'string' ? normalizeDroidModel(settings.model) : '';
  let ts = parseTime(settings?.providerLockTimestamp);
  if (!ts) ts = (await fs.stat(settingsFile)).mtimeMs;
  touch(s, ts);

  // transcript: title, cwd, prompts and tool calls (no per-request usage)
  const byId = new Map<string, ReturnType<typeof newToolCall>>();
  let n = 0;
  let scanned = 0;
  try {
    for await (const e of readJsonl(transcript)) {
      scanned++;
      const ets = parseTime(e.timestamp) || ts;
      if (e.type === 'session_start') {
        if (typeof e.title === 'string') s.title = oneLine(e.title, 100);
        else if (typeof e.sessionTitle === 'string') s.title = oneLine(e.sessionTitle, 100);
        setCwd(s, e.cwd);
        continue;
      }
      const m = e.message ?? e;
      const role = m?.role;
      const content = m?.content;
      if (!model && scanned < 500) {
        const hit = JSON.stringify(content ?? '').match(/Model:\s*([^"\\[]+)/);
        if (hit) model = normalizeDroidModel(hit[1]);
      }
      if (role === 'user') {
        if (Array.isArray(content))
          for (const b of content) {
            const tid = b?.tool_use_id ?? b?.toolUseId ?? b?.toolUseID;
            if (b?.type === 'tool_result' && byId.has(tid)) setResult(byId.get(tid)!, b.content, b.is_error === true);
          }
        const text = promptText(content);
        if (text !== undefined && !/^\s*<system-reminder>/.test(text)) newTurn(s, ets, oneLine(text) || '[empty prompt]');
      } else if (role === 'assistant' && Array.isArray(content)) {
        const call = newCall(`${id}:${n++}`, ets, model || 'unknown');
        for (const b of content)
          if (b?.type === 'tool_use') {
            const tc = newToolCall(String(b.id ?? `t${n}`), String(b.name ?? 'tool'), b.input);
            byId.set(tc.id, tc);
            call.toolCalls.push(tc);
          }
        lastTurn(s, ets).calls.push(call);
      }
    }
  } catch {
    /* transcript missing or unreadable: totals only */
  }
  if (!model) model = modelFromProvider(settings?.providerLock);
  for (const t of s.turns) for (const c of t.calls) c.model = model;

  // all tokens live on one synthetic "session total" request at the end
  const total = newCall(`${id}:total`, s.end || ts, model, usage);
  lastTurn(s, ts).calls.push(total);
  return finish(s, toolSeen(s));
}

export const droidParser: Parser = {
  id: 'droid',
  name: 'Factory Droid',
  verified: false,
  caps: DROID_CAPS,
  defaultDirs: () => envDirs('DROID_SESSIONS_DIR') ?? [path.join(home(), '.factory', 'sessions')],
  async load(dir: string, opts: LoadOptions = {}): Promise<Session[]> {
    const files = await walk(dir, (p) => p.endsWith('.settings.json'));
    const byId = new Map<string, Session>();
    for (const f of files) {
      if (opts.since && (await fs.stat(f)).mtimeMs < opts.since) continue;
      const s = await parseDroidSession(f);
      if (!s) continue;
      // the same session can exist in several places (archives): keep the latest snapshot
      const prev = byId.get(s.id);
      if (!prev || s.end >= prev.end) byId.set(s.id, s);
    }
    return [...byId.values()];
  },
};
