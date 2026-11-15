import path from 'node:path';
import { appData, home, xdgData } from '../paths.js';
import type { ApiCall, Capabilities, Session, ToolCall } from '../types.js';
import { FULL_CAPS } from '../types.js';
import { exists, oneLine, parseTime } from '../util.js';
import { finish, lastTurn, newCall, newSession, newToolCall, newTurn, num, setCwd, setResult, touch } from './common.js';
import { openSqlite } from './opencode.js';
import type { LoadOptions, Parser } from './types.js';

/**
 * EXPERIMENTAL - Goose (aaif-goose/goose, formerly block/goose).
 *   <data dir>/sessions/sessions.db   (SQLite; needs Node 22.13+ for node:sqlite)
 * where <data dir> is $GOOSE_PATH_ROOT/data, else ~/.local/share/goose (XDG; also used on
 * macOS), ~/Library/Application Support/Block/goose (older macOS builds) or
 * %APPDATA%\Block\goose\data on Windows.
 *
 * Tables read:
 *   sessions      id, name, working_dir, created_at, model_config_json {model_name},
 *                 accumulated_{input,output,cache_read,cache_write}_tokens, accumulated_cost
 *   usage_ledger  one row per model request: created_timestamp (unix s), model,
 *                 input_tokens (INCLUDES cache read + write), output_tokens, cache_read_tokens,
 *                 cache_write_tokens, cost, cost_source ("carried_forward" = pre-ledger totals)
 *   messages      role, content_json [{type:text|toolRequest|toolResponse,...}], created_timestamp
 * Tool requests: {type:"toolRequest", id, toolCall:{status, value:{name, arguments}}};
 * results: {type:"toolResponse", id, toolResult:{status, value:{content[], isError} | [...]}}.
 * Tool calls are attached to the ledger row closest in time (rows don't reference messages).
 * Sessions without ledger rows (older Goose) or with carried-forward totals only have
 * session totals, so per-request checks are switched off for them. The pre-SQLite JSONL
 * session files are not read.
 *
 * Format from Goose's session_manager.rs (schema + migrations), conversation/message.rs,
 * tool_result_serde.rs and provider usage normalization (Apache-2.0, formats only),
 * cross-checked against tokscale's Goose adapter (MIT). Not yet validated against real logs.
 */

const GOOSE_CAPS: Capabilities = { ...FULL_CAPS };

export function gooseDataDirs(): string[] {
  if (process.env.GOOSE_PATH_ROOT) return [path.join(process.env.GOOSE_PATH_ROOT, 'data', 'sessions')];
  if (process.platform === 'win32') return [path.join(appData(), 'Block', 'goose', 'data', 'sessions')];
  const dirs = [path.join(xdgData(), 'goose', 'sessions')];
  if (process.platform === 'darwin') dirs.push(path.join(home(), 'Library', 'Application Support', 'Block', 'goose', 'sessions'));
  return dirs;
}

const parseJson = (v: unknown): any => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
};

/** Goose's text editor is one tool with a `command`; map it to a read or an edit. */
function gooseTool(id: string, name: string, args: any): ToolCall {
  const tc = newToolCall(id, name, args);
  const short = name.split('__').pop() ?? name;
  if (!tc.file && short === 'text_editor' && typeof args?.path === 'string') {
    tc.file = args.path;
    tc.fileOp = args.command === 'view' ? 'read' : 'edit';
  }
  return tc;
}

function resultContent(tr: any): { content: unknown; isError: boolean } {
  if (!tr || tr.status === 'error') return { content: tr?.error ?? '', isError: true };
  const v = tr.value;
  if (Array.isArray(v)) return { content: v, isError: false };
  return { content: v?.content ?? v ?? '', isError: v?.isError === true || v?.is_error === true };
}

export async function readGooseDb(file: string, notes?: string[]): Promise<Session[]> {
  const h = await openSqlite(file, notes, 'Goose', 'Goose sessions were skipped');
  if (!h) return [];
  const { db } = h;
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => String(r.name)));
    if (!tables.has('sessions')) return [];
    const rows = db.prepare('SELECT * FROM sessions').all();
    const ledger = new Map<string, any[]>();
    if (tables.has('usage_ledger'))
      for (const r of db.prepare('SELECT * FROM usage_ledger ORDER BY created_timestamp, id').all()) {
        const l = ledger.get(String(r.session_id)) ?? [];
        l.push(r);
        ledger.set(String(r.session_id), l);
      }
    const messages = new Map<string, any[]>();
    if (tables.has('messages'))
      for (const r of db.prepare('SELECT session_id, role, content_json, created_timestamp FROM messages ORDER BY created_timestamp, id').all()) {
        const l = messages.get(String(r.session_id)) ?? [];
        l.push(r);
        messages.set(String(r.session_id), l);
      }

    const out: Session[] = [];
    for (const row of rows) {
      const id = String(row.id);
      const s = newSession('goose', id, file, GOOSE_CAPS);
      setCwd(s, row.working_dir);
      if (typeof row.name === 'string' && row.name) s.title = oneLine(row.name, 100);
      const created = parseTime(typeof row.created_at === 'string' && !/[zZ+]/.test(row.created_at) ? row.created_at.replace(' ', 'T') + 'Z' : row.created_at);
      const fallbackModel = String(parseJson(row.model_config_json)?.model_name ?? 'unknown');
      const msgs = messages.get(id) ?? [];
      const led = ledger.get(id) ?? [];
      const calls: ApiCall[] = [];
      let totalsOnly = !led.length;
      for (const r of led) {
        const ts = num(r.created_timestamp) * 1000 || created;
        const cr = num(r.cache_read_tokens);
        const cw = num(r.cache_write_tokens);
        const inp = num(r.input_tokens);
        const c = newCall(`${id}:l${r.id}`, ts, String(r.model ?? fallbackModel) || fallbackModel, {
          input: inp >= cr + cw ? inp - cr - cw : inp, // input includes cached tokens
          output: num(r.output_tokens),
          cacheRead: cr,
          cacheWrite5m: cw,
        });
        if (typeof r.cost === 'number' && Number.isFinite(r.cost)) c.reportedCost = r.cost;
        if (r.cost_source === 'carried_forward') totalsOnly = true;
        calls.push(c);
      }
      if (!led.length) {
        // older Goose: only cumulative session totals
        const cr = num(row.accumulated_cache_read_tokens);
        const cw = num(row.accumulated_cache_write_tokens);
        const inp = num(row.accumulated_input_tokens);
        const c = newCall(`${id}:total`, created, fallbackModel, {
          input: inp >= cr + cw ? inp - cr - cw : inp,
          output: num(row.accumulated_output_tokens),
          cacheRead: cr,
          cacheWrite5m: cw,
        });
        if (typeof row.accumulated_cost === 'number') c.reportedCost = row.accumulated_cost;
        if (c.usage.input || c.usage.output || c.usage.cacheRead || c.usage.cacheWrite5m) calls.push(c);
      }
      if (!calls.length) continue;

      // replay messages into turns; attach tool requests to the nearest unclaimed request
      const byTool = new Map<string, ToolCall>();
      const claimed = new Set<ApiCall>();
      let ci = 0;
      const nearest = (ts: number): ApiCall | undefined => {
        let best: ApiCall | undefined;
        for (const c of calls) {
          if (claimed.has(c) || c.id.endsWith(':total')) continue;
          if (Math.abs(c.timestamp - ts) <= 5_000 && (!best || Math.abs(c.timestamp - ts) < Math.abs(best.timestamp - ts))) best = c;
        }
        return best;
      };
      const placed = new Set<ApiCall>();
      const place = (c: ApiCall) => {
        if (placed.has(c)) return;
        placed.add(c);
        lastTurn(s, c.timestamp).calls.push(c);
      };
      for (const m of msgs) {
        const ts = num(m.created_timestamp) * 1000;
        // requests that happened before this message belong to the turn so far
        const cut = m.role === 'user' ? ts : ts - 5_000;
        while (ci < led.length && calls[ci].timestamp <= cut) place(calls[ci++]);
        const content = parseJson(m.content_json);
        if (!Array.isArray(content)) continue;
        if (m.role === 'user') {
          for (const b of content)
            if (b?.type === 'toolResponse') {
              const tc = byTool.get(String(b.id));
              if (tc) {
                const r = resultContent(b.toolResult);
                setResult(tc, r.content, r.isError);
              }
            }
          if (content.some((b: any) => b?.type === 'toolResponse')) continue;
          const text = content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join(' ');
          if (text) {
            newTurn(s, ts, oneLine(text));
            if (!s.title) s.title = oneLine(text, 80);
          }
        } else if (m.role === 'assistant') {
          const reqs = content.filter((b: any) => b?.type === 'toolRequest');
          if (!reqs.length) continue;
          let host = totalsOnly ? undefined : nearest(ts);
          if (!host) {
            host = newCall(`${id}:m${ts}:${byTool.size}`, ts, calls[0].model);
            calls.push(host);
          }
          claimed.add(host);
          for (const b of reqs) {
            const v = b.toolCall?.value ?? {};
            const tc = gooseTool(String(b.id ?? `${id}:${byTool.size}`), String(v.name ?? 'tool'), v.arguments ?? null);
            if (b.toolCall?.status === 'error') tc.isError = true;
            byTool.set(tc.id, tc);
            host.toolCalls.push(tc);
          }
          place(host);
        }
      }
      for (const c of calls) place(c);
      for (const t of s.turns) t.calls.sort((a, b) => a.timestamp - b.timestamp);
      for (const c of calls) touch(s, c.timestamp);
      touch(s, created);
      // OpenAI-style providers report cached input but never cache writes
      if (!calls.some((c) => c.usage.cacheWrite5m > 0) && calls.some((c) => c.usage.cacheRead > 0)) s.caps.cacheWrites = false;
      if (totalsOnly) {
        s.caps.perRequestTokens = false;
        s.caps.timestamps = false;
      }
      out.push(finish(s));
    }
    return out.filter((x) => x.turns.length);
  } finally {
    h.cleanup();
  }
}

export const gooseParser: Parser = {
  id: 'goose',
  name: 'Goose',
  verified: false,
  caps: GOOSE_CAPS,
  defaultDirs: gooseDataDirs,
  async load(dir: string, opts: LoadOptions = {}): Promise<Session[]> {
    const file = dir.endsWith('.db') ? dir : path.join(dir, 'sessions.db');
    if (!(await exists(file))) return [];
    const sessions = await readGooseDb(file, opts.notes);
    return opts.since ? sessions.filter((s) => s.end >= opts.since!) : sessions;
  },
};
