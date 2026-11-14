import { promises as fs } from 'node:fs';
import path from 'node:path';
import { home } from '../paths.js';
import type { Capabilities, Session, ToolCall } from '../types.js';
import { oneLine, parseTime, readJsonl } from '../util.js';
import { finish, newCall, newSession, newToolCall, newTurn, num, setCwd, setResult, touch, lastTurn } from './common.js';
import type { LoadOptions, Parser } from './types.js';

/**
 * EXPERIMENTAL - GitHub Copilot CLI: ${COPILOT_HOME:-~/.copilot}/session-state/<sessionId>/events.jsonl
 * Events {type, id, parentId, timestamp, data}. Per-request token usage is NOT
 * persisted (assistant.usage is ephemeral); tokens only appear as per-model totals
 * in `session.shutdown` data.modelMetrics[model].usage {inputTokens (INCLUDES cache),
 * outputTokens, cacheReadTokens, cacheWriteTokens}. Newer builds (with
 * session.usage_checkpoint) write cumulative totals per shutdown; older builds
 * per process run - we pick per the heuristic ccusage/splitrail disagree on.
 * Tool calls: assistant.message toolRequests[] + tool.execution_complete {success, result.content}.
 * Copilot bills premium requests, not tokens: costs are API-price equivalents.
 *
 * Learned from the copilot-sdk session-event schema and the ccusage / splitrail
 * Copilot adapters (MIT). Not yet validated on real logs.
 */

const COPILOT_CAPS: Capabilities = {
  perRequestTokens: false,
  cacheReads: true,
  cacheWrites: true,
  toolCalls: true,
  toolOutputs: true,
  filePaths: true,
  timestamps: false,
};

type Usage4 = { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number };

export async function parseCopilotSession(file: string): Promise<Session | undefined> {
  const id = path.basename(path.dirname(file));
  const s = newSession('copilot-cli', id, file, COPILOT_CAPS);
  const tools = new Map<string, ToolCall>();
  let model = 'unknown';
  let n = 0;
  const shutdowns: Array<Record<string, Usage4>> = [];
  let hasCheckpoint = false;
  for await (const e of readJsonl(file)) {
    if (e.checkpoint === true) continue; // replayed after log rotation
    const ts = parseTime(e.timestamp);
    touch(s, ts);
    const d = e.data ?? {};
    switch (e.type) {
      case 'session.start':
      case 'session.resume':
        if (typeof d.sessionId === 'string') s.id = d.sessionId;
        if (d.context?.cwd) {
          s.projectPath = undefined;
          setCwd(s, d.context.cwd);
        }
        if (typeof d.selectedModel === 'string') model = d.selectedModel;
        break;
      case 'session.model_change':
        if (typeof d.newModel === 'string') model = d.newModel;
        break;
      case 'user.message': {
        const src = String(d.source ?? '');
        if (d.isAutopilotContinuation || src.startsWith('skill-') || src.startsWith('agent-')) break;
        const text = String(d.content ?? '');
        newTurn(s, ts, oneLine(text) || '[prompt]');
        if (!s.title) s.title = oneLine(text, 80);
        break;
      }
      case 'assistant.message': {
        if (typeof d.model === 'string') model = d.model;
        const reqs = Array.isArray(d.toolRequests) ? d.toolRequests : [];
        // no per-request tokens: the call only carries tool calls (usage lands on the session total)
        const call = newCall(`${s.id}:${n++}`, ts, model);
        for (const r of reqs) {
          let args = r.arguments;
          if (typeof args === 'string') {
            try {
              args = JSON.parse(args);
            } catch {
              /* keep string */
            }
          }
          const tc = newToolCall(String(r.toolCallId ?? `t${n}`), String(r.name ?? r.toolName ?? 'tool'), args);
          tools.set(tc.id, tc);
          call.toolCalls.push(tc);
        }
        if (call.toolCalls.length) lastTurn(s, ts).calls.push(call);
        break;
      }
      case 'tool.execution_complete': {
        const tc = tools.get(String(d.toolCallId));
        if (!tc) break;
        const text = d.result?.detailedContent ?? d.result?.content ?? d.error?.message ?? '';
        const exit = d.shellExecution?.exitCode;
        setResult(tc, text, d.success === false || (typeof exit === 'number' && exit !== 0));
        if (!tc.file && Array.isArray(d.fileEdits) && d.fileEdits[0]?.path) {
          tc.file = String(d.fileEdits[0].path);
          tc.fileOp = 'edit';
        }
        break;
      }
      case 'session.usage_checkpoint':
        hasCheckpoint = true;
        break;
      case 'session.shutdown': {
        const mm = d.modelMetrics ?? {};
        const snap: Record<string, Usage4> = {};
        for (const [m, v] of Object.entries<any>(mm)) {
          const u = v?.usage ?? {};
          snap[m] = { input: num(u.inputTokens), output: num(u.outputTokens), cacheRead: num(u.cacheReadTokens), cacheWrite: num(u.cacheWriteTokens), reasoning: num(u.reasoningTokens) };
        }
        shutdowns.push(snap);
        break;
      }
    }
  }
  // newer builds: totals are cumulative (take the last); older: per process run (sum)
  const totals: Record<string, Usage4> = {};
  const cumulative = hasCheckpoint && shutdowns.every((x, i) => i === 0 || Object.entries(x).every(([m, u]) => !shutdowns[i - 1][m] || u.input >= shutdowns[i - 1][m].input));
  for (const snap of cumulative && shutdowns.length ? [shutdowns[shutdowns.length - 1]] : shutdowns)
    for (const [m, u] of Object.entries(snap)) {
      const t = (totals[m] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
      t.input += u.input;
      t.output += u.output;
      t.cacheRead += u.cacheRead;
      t.cacheWrite += u.cacheWrite;
      t.reasoning += u.reasoning;
    }
  for (const [m, u] of Object.entries(totals)) {
    if (!u.input && !u.output) continue;
    lastTurn(s, s.end).calls.push(
      newCall(`${s.id}:total:${m}`, s.end, m, {
        input: Math.max(0, u.input - u.cacheRead - u.cacheWrite),
        output: u.output,
        cacheRead: u.cacheRead,
        cacheWrite5m: u.cacheWrite,
        reasoning: u.reasoning,
      }),
    );
  }
  return finish(s);
}

export const copilotParser: Parser = {
  id: 'copilot-cli',
  name: 'Copilot CLI',
  verified: false,
  caps: COPILOT_CAPS,
  defaultDirs: () => [path.join(process.env.COPILOT_HOME || path.join(home(), '.copilot'), 'session-state')],
  async load(dir: string, opts: LoadOptions = {}): Promise<Session[]> {
    const out: Session[] = [];
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const f = path.join(dir, e.name, 'events.jsonl');
      const st = await fs.stat(f).catch(() => undefined);
      if (!st || (opts.since && st.mtimeMs < opts.since)) continue;
      const s = await parseCopilotSession(f);
      if (s && s.turns.length) out.push(s);
    }
    return out;
  },
};
