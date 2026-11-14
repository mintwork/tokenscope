import { promises as fs } from 'node:fs';
import path from 'node:path';
import { home, uniq, vscodeGlobalStorage } from '../paths.js';
import type { ApiCall, Capabilities, Session, SourceId, ToolCall } from '../types.js';
import { FULL_CAPS } from '../types.js';
import { exists, oneLine } from '../util.js';
import { finish, newCall, newSession, newToolCall, newTurn, num, promptText, setCwd, setResult, touch, lastTurn } from './common.js';
import type { LoadOptions, Parser } from './types.js';

/**
 * EXPERIMENTAL - Cline, Roo Code and Kilo Code (legacy) VS Code extensions.
 * Task folders: <VS Code globalStorage>/<extension id>/tasks/<taskId>/
 *   ui_messages.json             [{ts, type:"say"|"ask", say|ask, text, partial?, modelInfo?}]
 *   api_conversation_history.json  Anthropic-style messages (+ ts) with tool_use / tool_result,
 *                                   or XML-mode "[tool for 'x'] Result:" text blocks
 *   task_metadata.json            {model_usage:[{ts, model_id}], files_in_context}
 *   history_item.json (Roo/Kilo)  {workspace, task, ...}
 * Per request: a say:"api_req_started" row whose `text` is JSON
 *   {tokensIn, tokensOut, cacheWrites, cacheReads, cost, apiProtocol?, cancelReason?}
 *   Cline: tokensIn excludes cache (Anthropic style), except the generic OpenAI provider.
 *   Roo / Kilo (current): tokensIn INCLUDES cache reads + writes.
 * Billed-but-folded rows (deleted_api_reqs / api_req_deleted, subagent_usage,
 * condense_context) are kept as extra requests - they were paid for.
 *
 * Cline 4.x ("Cline SDK") also writes ~/.cline/data/sessions/<id>/<id>.messages.json:
 *   {messages:[{role, content, ts, modelInfo:{id}, metrics:{inputTokens (INCLUDES cache),
 *   outputTokens, cacheReadTokens, cacheWriteTokens, cost}}]} + <id>.json manifest {cwd, prompt, model}.
 *
 * Learned from the Cline / Roo / Kilo sources and the ccusage + splitrail
 * adapters (MIT). Not yet validated on real logs.
 */

const CLINE_CAPS: Capabilities = { ...FULL_CAPS };

type Flavor = 'cline' | 'roo' | 'kilo';

const readJson = async (f: string): Promise<any> => {
  try {
    return JSON.parse(await fs.readFile(f, 'utf8'));
  } catch {
    return undefined;
  }
};
const parse = (s: unknown): any => {
  if (typeof s !== 'string') return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

const ENV_CWD = /# Current (?:Working|Workspace) Directory \(([^)]+)\)/;
const ENV_MODEL = /<model>([^<]+)<\/model>/g;
const XML_RESULT = /^\[([\w-]+)(?: for '([^']*)')?\] Result:\n?/;

/** Map the UI / XML tool names onto canonical names our detectors understand. */
const TOOL_ALIAS: Record<string, string> = {
  read_file: 'read_file',
  readFile: 'read_file',
  write_to_file: 'write_to_file',
  replace_in_file: 'replace_in_file',
  apply_diff: 'apply_diff',
  execute_command: 'execute_command',
};

function contentText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b: any) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : '')).join('');
  return '';
}

interface HistTool {
  ts?: number;
  order: number;
  tc: ToolCall;
}

/** Tool calls + outputs from api_conversation_history.json (native or XML mode). */
function historyTools(history: any[]): { tools: HistTool[]; models: Array<{ ts: number; model: string }>; cwd?: string } {
  const tools: HistTool[] = [];
  const byId = new Map<string, ToolCall>();
  const models: Array<{ ts: number; model: string }> = [];
  let cwd: string | undefined;
  let order = 0;
  for (const m of history) {
    if (!m || typeof m !== 'object') continue;
    const ts = num(m.ts) || undefined;
    if (m.condenseParent || m.truncationParent) {
      /* still part of the billed history - keep it */
    }
    const content = Array.isArray(m.content) ? m.content : [];
    if (m.role === 'assistant') {
      order++;
      for (const b of content)
        if (b?.type === 'tool_use') {
          const tc = newToolCall(String(b.id ?? b.call_id ?? `h${tools.length}`), String(b.name ?? 'tool'), b.input);
          byId.set(tc.id, tc);
          if (b.call_id) byId.set(String(b.call_id), tc);
          tools.push({ ts, order, tc });
        }
    } else if (m.role === 'user') {
      for (const b of content) {
        if (b?.type === 'tool_result') {
          const tc = byId.get(String(b.tool_use_id ?? b.call_id ?? ''));
          if (tc) setResult(tc, contentText(b.content), b.is_error === true);
          continue;
        }
        const text = typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : '';
        if (!cwd) cwd = text.match(ENV_CWD)?.[1];
        for (const mm of text.matchAll(ENV_MODEL)) if (ts) models.push({ ts, model: mm[1].trim() });
        const x = text.match(XML_RESULT);
        if (x) {
          const name = TOOL_ALIAS[x[1]] ?? x[1];
          const input = name === 'execute_command' ? { command: x[2] ?? '' } : { path: x[2] ?? '' };
          const tc = newToolCall(`x${tools.length}`, name, input);
          const out = text.slice(x[0].length);
          setResult(tc, out, /^(Error|The tool execution failed)/.test(out));
          tools.push({ ts: ts ? ts - 1 : undefined, order, tc });
        }
      }
    }
  }
  return { tools, models, cwd };
}

export async function parseTaskFolder(dir: string, source: SourceId, flavor: Flavor, history?: Map<string, any>): Promise<Session | undefined> {
  const ui = await readJson(path.join(dir, 'ui_messages.json'));
  if (!Array.isArray(ui)) return undefined;
  const id = path.basename(dir);
  const s = newSession(source, id, path.join(dir, 'ui_messages.json'), CLINE_CAPS);
  const meta = (await readJson(path.join(dir, 'task_metadata.json'))) ?? {};
  const item = (await readJson(path.join(dir, 'history_item.json'))) ?? history?.get(id);
  const hist = (await readJson(path.join(dir, 'api_conversation_history.json'))) ?? [];
  const ht = historyTools(Array.isArray(hist) ? hist : []);
  setCwd(s, item?.workspace ?? item?.cwdOnTaskInitialization ?? ht.cwd);
  if (typeof item?.task === 'string') s.title = oneLine(item.task, 100);

  const modelUsage: Array<{ ts: number; model: string }> = (Array.isArray(meta.model_usage) ? meta.model_usage : [])
    .map((u: any) => ({ ts: num(u.ts), model: String(u.model_id ?? '') }))
    .filter((u: any) => u.model)
    .concat(ht.models)
    .sort((a: any, b: any) => a.ts - b.ts);
  const fallbackModel = String(item?.modelId ?? item?.apiConfigName ?? modelUsage[modelUsage.length - 1]?.model ?? 'unknown');
  const modelAt = (ts: number, row: any) => {
    if (row?.modelInfo?.modelId) return String(row.modelInfo.modelId);
    let m: string | undefined;
    for (const u of modelUsage) if (u.ts <= ts) m = u.model;
    return m ?? fallbackModel;
  };

  // last version of each row wins (rows are rewritten in place while streaming)
  const rows = new Map<number, any>();
  for (const r of ui) if (r && typeof r.ts === 'number' && !r.partial) rows.set(r.ts, r);
  const ordered = [...rows.values()].sort((a, b) => a.ts - b.ts);
  const reqCalls: ApiCall[] = [];
  let sawWrite = false;
  let first = true;
  let n = 0;

  const usageCall = (row: any, d: any, label: string): ApiCall | undefined => {
    const tin = num(d.tokensIn);
    const out = num(d.tokensOut);
    const cw = num(d.cacheWrites);
    const cr = num(d.cacheReads);
    if (!tin && !out && !cw && !cr && !num(d.cost)) return undefined;
    let input = tin;
    const provider = String(row.modelInfo?.providerId ?? '');
    if (flavor === 'cline') {
      if (provider === 'openai' && tin >= cr) input = tin - cr; // generic OpenAI-compatible provider is inclusive
    } else if (tin >= cr + cw) input = tin - cr - cw; // Roo/Kilo: inclusive (older Anthropic-protocol rows were not)
    if (cw) sawWrite = true;
    const call = newCall(`${id}:${label}${n++}`, row.ts, modelAt(row.ts, row), { input, output: out, cacheRead: cr, cacheWrite5m: cw });
    if (num(d.cost) > 0) call.reportedCost = num(d.cost);
    return call;
  };

  for (const row of ordered) {
    touch(s, row.ts);
    const kind = row.say ?? row.ask;
    if (first && ((flavor === 'cline' && row.say === 'task') || (flavor !== 'cline' && row.say === 'text'))) {
      first = false;
      newTurn(s, row.ts, oneLine(String(row.text ?? '')) || '[task]');
      if (!s.title) s.title = oneLine(String(row.text ?? ''), 100);
      continue;
    }
    first = false;
    if (kind === 'user_feedback' || kind === 'user_feedback_diff') {
      newTurn(s, row.ts, oneLine(String(row.text ?? '')) || '[feedback]');
      continue;
    }
    if (kind === 'api_req_started') {
      const d = parse(row.text);
      const call = d && usageCall(row, d, '');
      if (call) {
        reqCalls.push(call);
        lastTurn(s, row.ts).calls.push(call);
      }
      continue;
    }
    if (kind === 'deleted_api_reqs' || kind === 'api_req_deleted' || kind === 'subagent_usage') {
      const d = parse(row.text);
      const call = d && usageCall(row, d, kind + ':');
      if (call) lastTurn(s, row.ts).calls.push(call);
      continue;
    }
    if (kind === 'condense_context' && num(row.contextCondense?.cost) > 0) {
      const call = newCall(`${id}:condense${n++}`, row.ts, modelAt(row.ts, row));
      call.reportedCost = num(row.contextCondense.cost);
      lastTurn(s, row.ts).calls.push(call);
    }
  }

  // attach history tool calls to the request that produced them
  const tools = ht.tools;
  const useTs = tools.length > 0 && tools.every((t) => t.ts);
  for (const t of tools) {
    let host: ApiCall | undefined;
    if (useTs) {
      for (const c of reqCalls) if (c.timestamp <= t.ts!) host = c;
    } else host = reqCalls[Math.min(reqCalls.length - 1, t.order - 1)];
    (host ?? reqCalls[reqCalls.length - 1])?.toolCalls.push(t.tc);
  }
  s.caps.cacheWrites = sawWrite;
  return finish(s);
}

/* ----------------------------- Cline SDK sessions ----------------------------- */

export async function parseClineSdkSession(dir: string): Promise<Session | undefined> {
  const id = path.basename(dir);
  const doc = await readJson(path.join(dir, `${id}.messages.json`));
  const messages: any[] = Array.isArray(doc) ? doc : Array.isArray(doc?.messages) ? doc.messages : [];
  if (!messages.length) return undefined;
  const manifest = (await readJson(path.join(dir, `${id}.json`))) ?? {};
  const s = newSession('cline', id, path.join(dir, `${id}.messages.json`), CLINE_CAPS);
  setCwd(s, manifest.cwd ?? manifest.workspace_root);
  const title = manifest.metadata?.title ?? manifest.prompt;
  if (typeof title === 'string') s.title = oneLine(title, 100);
  const byId = new Map<string, ToolCall>();
  let sawWrite = false;
  let n = 0;
  for (const m of messages) {
    const ts = num(m.ts) || s.end;
    touch(s, ts);
    const content = Array.isArray(m.content) ? m.content : [];
    if (m.role === 'user') {
      for (const b of content)
        if (b?.type === 'tool_result') {
          const tc = byId.get(String(b.tool_use_id ?? ''));
          if (tc) setResult(tc, contentText(b.content), b.is_error === true);
        }
      const text = promptText(m.content);
      if (text !== undefined) newTurn(s, ts, oneLine(text) || '[prompt]');
      continue;
    }
    if (m.role !== 'assistant') continue;
    const mt = m.metrics ?? {};
    const cr = num(mt.cacheReadTokens);
    const cw = num(mt.cacheWriteTokens);
    if (cw) sawWrite = true;
    const call = newCall(String(m.id ?? `${id}:${n++}`), ts, String(m.modelInfo?.id ?? manifest.model ?? 'unknown'), {
      input: Math.max(0, num(mt.inputTokens) - cr - cw),
      output: num(mt.outputTokens),
      cacheRead: cr,
      cacheWrite5m: cw,
    });
    if (num(mt.cost) > 0) call.reportedCost = num(mt.cost);
    for (const b of content)
      if (b?.type === 'tool_use') {
        const tc = newToolCall(String(b.id ?? b.call_id ?? `t${n++}`), String(b.name ?? 'tool'), b.input);
        byId.set(tc.id, tc);
        call.toolCalls.push(tc);
      }
    lastTurn(s, ts).calls.push(call);
  }
  s.caps.cacheWrites = sawWrite;
  return finish(s);
}

/* ----------------------------------- parsers ----------------------------------- */

function makeParser(id: SourceId, name: string, flavor: Flavor, extId: string, extraDirs: () => string[]): Parser {
  return {
    id,
    name,
    verified: false,
    caps: CLINE_CAPS,
    defaultDirs: () =>
      uniq([
        ...extraDirs(),
        ...vscodeGlobalStorage(extId),
        path.join(home(), '.vscode-server', 'data', 'User', 'globalStorage', extId),
        path.join(home(), '.vscode-server-insiders', 'data', 'User', 'globalStorage', extId),
      ]),
    async load(dir: string, opts: LoadOptions = {}): Promise<Session[]> {
      const out: Session[] = [];
      // Cline keeps its task list (with cwd) in state/taskHistory.json
      const historyList = await readJson(path.join(dir, 'state', 'taskHistory.json'));
      const history = new Map<string, any>();
      if (Array.isArray(historyList)) for (const h of historyList) if (h?.id) history.set(String(h.id), h);
      const tasks = path.join(dir, 'tasks');
      if (await exists(tasks)) {
        for (const e of await fs.readdir(tasks, { withFileTypes: true })) {
          if (!e.isDirectory()) continue; // e.g. Roo's tasks/_index.json
          const d = path.join(tasks, e.name);
          if (opts.since) {
            const st = await fs.stat(path.join(d, 'ui_messages.json')).catch(() => undefined);
            if (!st || st.mtimeMs < opts.since) continue;
          }
          const s = await parseTaskFolder(d, id, flavor, history);
          if (s && s.turns.length) out.push(s);
        }
      }
      const sdk = path.join(dir, 'sessions');
      if (flavor === 'cline' && (await exists(sdk))) {
        for (const e of await fs.readdir(sdk, { withFileTypes: true })) {
          if (!e.isDirectory()) continue;
          const s = await parseClineSdkSession(path.join(sdk, e.name));
          if (s && s.turns.length && (!opts.since || s.end >= opts.since)) out.push(s);
        }
      }
      return out;
    },
  };
}

export const clineParser = makeParser('cline', 'Cline', 'cline', 'saoudrizwan.claude-dev', () => [
  process.env.CLINE_DATA_DIR || path.join(process.env.CLINE_DIR || path.join(home(), '.cline'), 'data'),
]);
export const rooParser = makeParser('roo-code', 'Roo Code', 'roo', 'rooveterinaryinc.roo-cline', () => []);
export const kiloCodeParser = makeParser('kilo-code', 'Kilo Code', 'kilo', 'kilocode.kilo-code', () => []);
