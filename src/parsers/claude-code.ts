import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ApiCall, Session, ToolCall, Turn, Usage } from '../types.js';
import { FULL_CAPS } from '../types.js';
import { uniq, xdgConfig } from '../paths.js';
import { contentChars, contentHash, fileAccess, oneLine, parseTime, readJsonl, stableStringify, toolTarget, walk } from '../util.js';
import type { LoadOptions, Parser } from './types.js';

/**
 * Claude Code writes one JSONL transcript per session to
 *   ~/.claude/projects/<cwd-slug>/<session-id>.jsonl
 * and subagent transcripts to
 *   ~/.claude/projects/<cwd-slug>/<session-id>/subagents/agent-<id>.jsonl (+ .meta.json)
 *
 * Relevant entry shapes (only the fields we read):
 *   {type:"assistant", message:{id, model, usage:{input_tokens, output_tokens,
 *      cache_read_input_tokens, cache_creation_input_tokens,
 *      cache_creation:{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}}, content:[...]}}
 *   {type:"user", message:{content: string | [{type:"tool_result", tool_use_id, content, is_error}]}}
 *   {type:"ai-title", aiTitle} | {type:"summary", summary}
 *
 * A single API response is streamed into several "assistant" lines (one per
 * content block) that share message.id and repeat the usage - we dedupe on id.
 */

const AGENT_TOOLS = new Set(['Agent', 'Task']);

export function claudeDefaultDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

interface PendingCall {
  call: ApiCall;
  turn: Turn;
}

export interface ParsedFile {
  session: Session;
  /** tool_use id -> ToolCall, so subagents can be attached. */
  toolCalls: Map<string, ToolCall>;
  /** agentId -> tool_use id that spawned it (from toolUseResult). */
  agentSpawns: Map<string, string>;
}

function readUsage(u: any): Usage {
  const cc = u?.cache_creation;
  const write = num(u?.cache_creation_input_tokens);
  let w1h = num(cc?.ephemeral_1h_input_tokens);
  let w5m = num(cc?.ephemeral_5m_input_tokens);
  if (w1h + w5m !== write) {
    // older logs only carry the total - assume 5m TTL (Claude Code's default)
    w5m = Math.max(0, write - w1h);
  }
  return {
    input: num(u?.input_tokens),
    output: num(u?.output_tokens),
    cacheRead: num(u?.cache_read_input_tokens),
    cacheWrite5m: w5m,
    cacheWrite1h: w1h,
    reasoning: num(u?.output_tokens_details?.thinking_tokens),
  };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function promptLabel(content: unknown): string | undefined {
  let text: string | undefined;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some((b) => b?.type === 'tool_result')) return undefined;
    const t = content.find((b) => b?.type === 'text');
    text = t?.text ?? (content.some((b) => b?.type === 'image') ? '[image]' : undefined);
  }
  if (text === undefined) return undefined;
  const cmd = text.match(/<command-name>([^<]+)<\/command-name>/);
  if (cmd) return cmd[1].trim();
  if (text.startsWith('<task-notification')) return '[background task finished]';
  if (text.startsWith('<local-command-stdout') || text.startsWith('<bash-stdout')) return undefined;
  const bash = text.match(/<bash-input>([\s\S]*?)<\/bash-input>/);
  if (bash) return '! ' + oneLine(bash[1], 100);
  return oneLine(text.replace(/<[^>]+>/g, ' '), 120) || '[empty prompt]';
}

export async function parseClaudeFile(file: string, slug: string): Promise<ParsedFile> {
  const session: Session = {
    id: path.basename(file, '.jsonl'),
    source: 'claude-code',
    caps: FULL_CAPS,
    project: slugToName(slug),
    file,
    start: 0,
    end: 0,
    turns: [],
  };
  const calls = new Map<string, PendingCall>();
  const toolCalls = new Map<string, ToolCall>();
  const agentSpawns = new Map<string, string>();
  let turn: Turn | undefined;
  let title: string | undefined;
  let summary: string | undefined;

  const newTurn = (ts: number, prompt: string): Turn => {
    const t: Turn = { index: session.turns.length, timestamp: ts, prompt, calls: [] };
    session.turns.push(t);
    return t;
  };

  for await (const e of readJsonl(file)) {
    const ts = parseTime(e.timestamp);
    if (ts) {
      if (!session.start || ts < session.start) session.start = ts;
      if (ts > session.end) session.end = ts;
    }
    if (typeof e.cwd === 'string' && !session.projectPath) {
      session.projectPath = e.cwd;
      session.project = path.basename(e.cwd) || session.project;
    }
    switch (e.type) {
      case 'ai-title':
        if (typeof e.aiTitle === 'string') title = e.aiTitle;
        break;
      case 'summary':
        if (typeof e.summary === 'string') summary = e.summary;
        break;
      case 'user': {
        const content = e.message?.content;
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b?.type !== 'tool_result') continue;
            const tc = toolCalls.get(b.tool_use_id);
            if (tc) {
              tc.resultChars = contentChars(b.content);
              tc.resultHash = contentHash(b.content ?? '');
              tc.isError = b.is_error === true;
            }
            const agentId = e.toolUseResult?.agentId;
            if (typeof agentId === 'string') agentSpawns.set(agentId, b.tool_use_id);
          }
        }
        if (e.isMeta || e.isCompactSummary) break;
        const label = promptLabel(content);
        if (label !== undefined) turn = newTurn(ts, label);
        break;
      }
      case 'assistant': {
        const m = e.message;
        if (!m || typeof m.id !== 'string' || m.model === '<synthetic>') break;
        let pc = calls.get(m.id);
        if (!pc) {
          if (!turn) turn = newTurn(ts, '(session start)');
          const call: ApiCall = {
            id: m.id,
            timestamp: ts,
            model: String(m.model ?? 'unknown'),
            usage: readUsage(m.usage),
            toolCalls: [],
            cost: 0,
          };
          if (m.usage?.speed === 'fast') call.fast = true;
          pc = { call, turn };
          calls.set(m.id, pc);
          turn.calls.push(call);
        } else {
          // later stream chunks carry the final usage; keep the largest output count
          const u = readUsage(m.usage);
          if (u.output >= pc.call.usage.output) pc.call.usage = u;
        }
        if (Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b?.type !== 'tool_use' || toolCalls.has(b.id)) continue;
            const tc: ToolCall = {
              id: String(b.id),
              name: String(b.name ?? 'unknown'),
              target: toolTarget(b.name, b.input),
              key: String(b.name) + ':' + stableStringify(b.input ?? null),
              resultChars: 0,
              isError: false,
            };
            const fa = fileAccess(tc.name, b.input);
            if (fa) {
              tc.file = fa.file;
              tc.fileOp = fa.op;
            }
            toolCalls.set(tc.id, tc);
            pc.call.toolCalls.push(tc);
          }
        }
        break;
      }
    }
  }
  session.title = title ?? summary;
  session.turns = session.turns.filter((t) => t.calls.length > 0);
  session.turns.forEach((t, i) => (t.index = i));
  return { session, toolCalls, agentSpawns };
}

/** "-Users-me-code-my-app" -> "my-app" (best effort; the cwd field is preferred). */
export function slugToName(slug: string): string {
  const parts = slug.split('-').filter(Boolean);
  return parts.slice(-1)[0] ?? slug;
}

async function readMeta(file: string): Promise<any> {
  try {
    return JSON.parse(await fs.readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

/** Drop API calls already seen in an earlier session (resumed / forked sessions copy history). */
export function dedupeAcrossSessions(sessions: Session[]): void {
  const seen = new Set<string>();
  const visit = (s: Session) => {
    for (const t of s.turns) {
      t.calls = t.calls.filter((c) => {
        if (seen.has(c.id)) return false;
        seen.add(c.id);
        return true;
      });
      for (const c of t.calls) for (const tc of c.toolCalls) if (tc.subagent) visit(tc.subagent);
    }
    s.turns = s.turns.filter((t) => t.calls.length > 0);
  };
  [...sessions].sort((a, b) => a.start - b.start).forEach(visit);
}

export const claudeCodeParser: Parser = {
  id: 'claude-code',
  name: 'Claude Code',
  verified: true,
  caps: FULL_CAPS,
  defaultDirs: () => {
    const dirs = [claudeDefaultDir()];
    // newer installs may also use the XDG config dir
    if (!process.env.CLAUDE_CONFIG_DIR) dirs.push(path.join(xdgConfig(), 'claude', 'projects'));
    return uniq(dirs);
  },
  async load(dir: string, opts: LoadOptions = {}): Promise<Session[]> {
    const files = await walk(dir, (p) => p.endsWith('.jsonl'));
    const sessions: Session[] = [];
    const bySessionDir = new Map<string, ParsedFile>();
    const subFiles: string[] = [];

    for (const f of files) {
      if (opts.since) {
        const st = await fs.stat(f);
        if (st.mtimeMs < opts.since) continue;
      }
      const rel = path.relative(dir, f).split(path.sep);
      if (rel.includes('subagents')) {
        subFiles.push(f);
        continue;
      }
      // <slug>/<id>.jsonl, or <id>.jsonl when pointed directly at a project folder
      const slug = rel.length >= 2 ? rel[rel.length - 2] : path.basename(dir);
      const parsed = await parseClaudeFile(f, slug);
      if (parsed.session.turns.length === 0) continue;
      sessions.push(parsed.session);
      bySessionDir.set(path.join(path.dirname(f), path.basename(f, '.jsonl')), parsed);
    }

    // Attach subagents to the tool call that spawned them.
    for (const f of subFiles) {
      const parentDir = path.dirname(path.dirname(f)); // .../<session-id>
      const parent = bySessionDir.get(parentDir);
      const slug = path.basename(path.dirname(parentDir));
      const parsed = await parseClaudeFile(f, slug);
      const sub = parsed.session;
      if (sub.turns.length === 0) continue;
      const meta = await readMeta(f);
      const agentId = path.basename(f, '.jsonl').replace(/^agent-/, '');
      sub.id = 'agent-' + agentId;
      sub.isSubagent = true;
      sub.agentDescription = typeof meta?.description === 'string' ? meta.description : undefined;
      sub.agentType = typeof meta?.agentType === 'string' ? meta.agentType : undefined;
      if (parent) sub.project = parent.session.project;

      const toolUseId: string | undefined = meta?.toolUseId ?? parent?.agentSpawns.get(agentId);
      let host = toolUseId ? parent?.toolCalls.get(toolUseId) : undefined;
      if (!host && parent) host = attachByTime(parent.session, sub);
      if (host && !host.subagent) host.subagent = sub;
      else sessions.push(sub); // orphan subagent: report it as its own session
    }

    dedupeAcrossSessions(sessions);
    return sessions.filter((s) => s.turns.length > 0);
  },
};

/** Fallback: attach to the latest unclaimed Agent tool call that started before the subagent. */
function attachByTime(parent: Session, sub: Session): ToolCall | undefined {
  let best: ToolCall | undefined;
  for (const t of parent.turns)
    for (const c of t.calls) {
      if (c.timestamp > sub.start) return best;
      for (const tc of c.toolCalls) if (AGENT_TOOLS.has(tc.name) && !tc.subagent) best = tc;
    }
  return best;
}
