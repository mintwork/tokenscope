import { copyFileSync, mkdtempSync, promises as fs, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { xdgData } from '../paths.js';
import type { Capabilities, Session, SourceId, ToolCall } from '../types.js';
import { exists, oneLine, walk } from '../util.js';
import { finish, newCall, newSession, newToolCall, newTurn, num, setCwd, setResult, touch, lastTurn } from './common.js';
import type { LoadOptions, Parser } from './types.js';

/**
 * EXPERIMENTAL - OpenCode (and its fork Kilo CLI). Three storage generations
 * can coexist in one data dir (`${XDG_DATA_HOME:-~/.local/share}/opencode`):
 *   G0  storage/{session,message,part}/... JSON files (oldest)
 *   G1  opencode.db tables session / message / part, JSON in a `data` column
 *   G2  opencode.db tables session_v2 / session_message / session_part (newest)
 * Migrations keep message ids and leave older copies in place, so messages are
 * de-duplicated by id with G2 > G1 > G0 precedence.
 *
 * Assistant usage: tokens {input (excludes cache), output, reasoning (separate),
 * cache:{read, write}} and a precomputed `cost` (USD), used when the model is
 * not in our pricing table. SQLite needs Node >= 22.13 (built-in node:sqlite);
 * on older Node only the JSON storage is read and a note is printed.
 *
 * Format learned from OpenCode's source (schema + migrations) and the ccusage /
 * splitrail OpenCode adapters (MIT). Not yet validated against real data.
 */

const OPENCODE_CAPS: Capabilities = {
  perRequestTokens: true,
  cacheReads: true,
  cacheWrites: true, // narrowed per session: OpenAI-style providers never report writes
  toolCalls: true,
  toolOutputs: true,
  filePaths: true,
  timestamps: true,
};

interface RawSession {
  id: string;
  title?: string;
  directory?: string;
  parentId?: string;
  created: number;
  forkOf?: string;
}
interface RawTokens {
  input: number;
  output: number;
  reasoning: number;
  read: number;
  write: number;
}
interface RawMessage {
  id: string;
  sessionId: string;
  role: string;
  time: number;
  model?: string;
  provider?: string;
  tokens?: RawTokens;
  cost?: number;
  cwd?: string;
  gen: 0 | 1 | 2;
}
interface RawPart {
  messageId: string;
  type: string;
  text?: string;
  synthetic?: boolean;
  tool?: { callId: string; name: string; input: unknown; output: unknown; error: boolean; status?: string };
  stepTokens?: RawTokens;
  stepCost?: number;
}

const ms = (v: unknown): number => {
  const n = num(v);
  if (!n) return 0;
  return n < 1e11 ? n * 1000 : n; // some builds stored seconds
};

function readTokens(t: any): RawTokens | undefined {
  if (!t || typeof t !== 'object') return undefined;
  const cache = typeof t.cache === 'object' && t.cache ? t.cache : {};
  return { input: num(t.input), output: num(t.output), reasoning: num(t.reasoning), read: num(cache.read), write: num(cache.write) };
}

const parseJson = (s: unknown): any => {
  if (typeof s !== 'string') return s;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

/** v1/v0 part JSON -> RawPart */
function v1Part(messageId: string, d: any): RawPart | undefined {
  if (!d || typeof d !== 'object') return undefined;
  const p: RawPart = { messageId, type: String(d.type ?? '') };
  if (d.type === 'text') {
    p.text = typeof d.text === 'string' ? d.text : undefined;
    p.synthetic = d.synthetic === true || d.ignored === true;
  } else if (d.type === 'tool') {
    const st = d.state ?? {};
    p.tool = {
      callId: String(d.callID ?? d.id ?? ''),
      name: String(d.tool ?? 'tool'),
      input: st.input,
      output: st.output ?? st.error ?? '',
      error: st.status === 'error',
      status: st.status,
    };
  } else if (d.type === 'step-finish') {
    p.stepTokens = readTokens(d.tokens);
    p.stepCost = num(d.cost);
  }
  return p;
}

/** v2 part JSON -> RawPart */
function v2Part(messageId: string, d: any): RawPart | undefined {
  if (!d || typeof d !== 'object') return undefined;
  if (d.type !== 'tool') return v1Part(messageId, d);
  const st = d.state ?? {};
  return {
    messageId,
    type: 'tool',
    tool: {
      callId: String(d.id ?? ''),
      name: String(d.name ?? 'tool'),
      input: st.input,
      output: st.content ?? st.error ?? '',
      error: st.status === 'error',
      status: st.status,
    },
  };
}

interface Store {
  sessions: Map<string, RawSession>;
  messages: Map<string, RawMessage>;
  parts: Map<string, RawPart[]>; // by message id
}

function putMessage(store: Store, m: RawMessage, parts: RawPart[]): void {
  const prev = store.messages.get(m.id);
  if (prev && prev.gen >= m.gen) return;
  store.messages.set(m.id, m);
  // a migrated G2 row may keep its parts only in the older generation
  if (parts.length || !store.parts.has(m.id)) store.parts.set(m.id, parts);
}

/* ------------------------------ SQLite (G1/G2) ------------------------------ */

export type Db = { prepare(sql: string): { all(...a: unknown[]): any[] }; close(): void };

/** Open a SQLite file read-only with the built-in node:sqlite (Node 22.13+); shared with other SQLite-backed parsers. */
export async function openSqlite(file: string, notes?: string[], agent = 'OpenCode', fallback = 'only legacy JSON storage was read'): Promise<{ db: Db; cleanup: () => void } | undefined> {
  let mod: any;
  const origEmit = process.emitWarning;
  try {
    // node:sqlite prints an ExperimentalWarning on some Node versions - keep the CLI output clean
    process.emitWarning = ((w: unknown, ...rest: unknown[]) => {
      if (String((w as Error)?.message ?? w).includes('SQLite')) return;
      return (origEmit as any).call(process, w, ...rest);
    }) as typeof process.emitWarning;
    const modName = 'node:sqlite'; // indirection keeps the import lazy, so Node < 22.13 (no node:sqlite) can still load this module
    mod = await import(modName);
  } catch {
    notes?.push(`${agent}: found ${path.basename(file)} but reading SQLite needs Node 22.13+ (you have ${process.version}); ${fallback}.`);
    return undefined;
  } finally {
    process.emitWarning = origEmit;
  }
  const open = (f: string): Db => new mod.DatabaseSync(f, { readOnly: true }) as Db;
  try {
    const db = open(file);
    db.prepare('SELECT 1').all();
    return { db, cleanup: () => db.close() };
  } catch {
    // read-only dir or locked: read a private copy (db + wal + shm together)
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'tokenscope-oc-'));
    try {
      for (const ext of ['', '-wal', '-shm']) if (await exists(file + ext)) copyFileSync(file + ext, path.join(tmp, path.basename(file) + ext));
      const db = open(path.join(tmp, path.basename(file)));
      return { db, cleanup: () => (db.close(), rmSync(tmp, { recursive: true, force: true })) };
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      notes?.push(`${agent}: could not open ${file}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }
}

export async function readSqlite(file: string, store: Store, notes?: string[]): Promise<boolean> {
  const h = await openSqlite(file, notes);
  if (!h) return false;
  const { db } = h;
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => String(r.name)));
    const q = (sql: string) => {
      try {
        return db.prepare(sql).all();
      } catch {
        return [];
      }
    };

    if (tables.has('session') && tables.has('message') && tables.has('part')) {
      // G1
      for (const r of q('SELECT id, parent_id, directory, title, time_created FROM session'))
        if (!store.sessions.has(r.id)) store.sessions.set(r.id, { id: r.id, parentId: r.parent_id ?? undefined, directory: r.directory || undefined, title: r.title || undefined, created: ms(r.time_created) });
      const parts = new Map<string, RawPart[]>();
      for (const r of q('SELECT message_id, data FROM part ORDER BY time_created, id')) {
        const p = v1Part(r.message_id, parseJson(r.data));
        if (p) (parts.get(r.message_id) ?? parts.set(r.message_id, []).get(r.message_id)!).push(p);
      }
      for (const r of q('SELECT id, session_id, time_created, data FROM message ORDER BY time_created, id')) {
        const d = parseJson(r.data);
        if (!d) continue;
        putMessage(store, v1Message(r.id, r.session_id, d, ms(d.time?.created) || ms(r.time_created), 1), parts.get(r.id) ?? []);
      }
    }

    if (tables.has('session_v2') && tables.has('session_message')) {
      // G2
      for (const r of q('SELECT id, parent_id, directory, title, time_created, fork_session_id FROM session_v2'))
        store.sessions.set(r.id, {
          id: r.id,
          parentId: r.parent_id ?? undefined,
          directory: r.directory || undefined,
          title: r.title || store.sessions.get(r.id)?.title,
          created: ms(r.time_created),
          forkOf: r.fork_session_id ?? undefined,
        });
      const parts = new Map<string, RawPart[]>();
      if (tables.has('session_part'))
        for (const r of q('SELECT message_id, data FROM session_part ORDER BY message_id, ordinal')) {
          const p = v2Part(r.message_id, parseJson(r.data));
          if (p) (parts.get(r.message_id) ?? parts.set(r.message_id, []).get(r.message_id)!).push(p);
        }
      for (const r of q("SELECT id, session_id, type, time_created, data FROM session_message WHERE type IN ('user','assistant','compaction') ORDER BY session_id, seq")) {
        const d = parseJson(r.data) ?? {};
        const sess = store.sessions.get(r.session_id);
        const created = ms(d.time?.created) || ms(r.time_created);
        if (sess?.forkOf && created && created < sess.created) continue; // history copied into a fork
        const role = r.type === 'user' ? 'user' : 'assistant';
        const m: RawMessage = {
          id: r.id,
          sessionId: r.session_id,
          role,
          time: created,
          model: d.model?.id,
          provider: d.model?.providerID,
          tokens: readTokens(d.tokens),
          cost: typeof d.cost === 'number' ? d.cost : undefined,
          gen: 2,
        };
        const ps = [...(parts.get(r.id) ?? [])];
        if (Array.isArray(d.content)) for (const c of d.content) { const p = v2Part(r.id, c); if (p) ps.push(p); }
        if (role === 'user' && typeof d.text === 'string') ps.unshift({ messageId: r.id, type: 'text', text: d.text });
        putMessage(store, m, ps);
      }
    }
    return true;
  } finally {
    h.cleanup();
  }
}

function v1Message(id: string, sessionId: string, d: any, time: number, gen: 0 | 1): RawMessage {
  return {
    id,
    sessionId,
    role: String(d.role ?? ''),
    time,
    model: d.modelID ?? d.model?.modelID ?? d.model?.id,
    provider: d.providerID ?? d.model?.providerID,
    tokens: readTokens(d.tokens),
    cost: typeof d.cost === 'number' ? d.cost : undefined,
    cwd: d.path?.cwd,
    gen,
  };
}

/* ------------------------------ JSON storage (G0) ------------------------------ */

async function readJsonStorage(storage: string, store: Store): Promise<void> {
  const read = async (f: string) => parseJson(await fs.readFile(f, 'utf8').catch(() => ''));
  for (const f of await walk(path.join(storage, 'session'), (p) => p.endsWith('.json'))) {
    const d = await read(f);
    if (!d?.id || store.sessions.has(d.id)) continue;
    store.sessions.set(d.id, { id: d.id, parentId: d.parentID, directory: d.directory || undefined, title: d.title, created: ms(d.time?.created) });
  }
  const partFiles = await walk(path.join(storage, 'part'), (p) => p.endsWith('.json'));
  const parts = new Map<string, RawPart[]>();
  for (const f of partFiles) {
    const d = await read(f);
    const mid = d?.messageID ?? path.basename(path.dirname(f));
    const p = v1Part(mid, d);
    if (p) (parts.get(mid) ?? parts.set(mid, []).get(mid)!).push(p);
  }
  for (const f of await walk(path.join(storage, 'message'), (p) => p.endsWith('.json'))) {
    const id = path.basename(f, '.json');
    if (store.messages.has(id)) continue; // already loaded from the database
    const d = await read(f);
    if (!d) continue;
    putMessage(store, v1Message(d.id ?? id, d.sessionID ?? path.basename(path.dirname(f)), d, ms(d.time?.created), 0), parts.get(d.id ?? id) ?? []);
  }
}

/* ------------------------------ build sessions ------------------------------ */

const AGENT_TOOLS = new Set(['task', 'subagent']);

export function buildOpenCodeSessions(store: Store, source: SourceId, file: string): Session[] {
  const bySession = new Map<string, RawMessage[]>();
  for (const m of store.messages.values()) (bySession.get(m.sessionId) ?? bySession.set(m.sessionId, []).get(m.sessionId)!).push(m);
  const built = new Map<string, Session>();
  const agentCalls: Array<{ tc: ToolCall; input: any; ts: number; sessionId: string }> = [];

  for (const [sid, msgs] of bySession) {
    const info = store.sessions.get(sid);
    const s = newSession(source, sid, file, OPENCODE_CAPS);
    s.title = info?.title ? oneLine(info.title, 100) : undefined;
    setCwd(s, info?.directory);
    let sawWrite = false;
    msgs.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    for (const m of msgs) {
      touch(s, m.time);
      const parts = store.parts.get(m.id) ?? [];
      if (m.role === 'user') {
        const text = parts.filter((p) => p.type === 'text' && !p.synthetic && p.text).map((p) => p.text).join(' ');
        newTurn(s, m.time, oneLine(text) || '[prompt]');
        continue;
      }
      if (m.role !== 'assistant') continue;
      setCwd(s, m.cwd);
      let t = m.tokens;
      let cost = m.cost;
      const zero = !t || t.input + t.output + t.reasoning + t.read + t.write === 0;
      if (zero) {
        // fall back to step-finish parts (never add both)
        const steps = parts.filter((p) => p.stepTokens);
        if (steps.length) {
          t = steps.reduce<RawTokens>((a, p) => ({ input: a.input + p.stepTokens!.input, output: a.output + p.stepTokens!.output, reasoning: a.reasoning + p.stepTokens!.reasoning, read: a.read + p.stepTokens!.read, write: a.write + p.stepTokens!.write }), { input: 0, output: 0, reasoning: 0, read: 0, write: 0 });
          if (!cost) cost = steps.reduce((a, p) => a + (p.stepCost ?? 0), 0);
        }
      }
      if (t?.write) sawWrite = true;
      const model = m.model ? String(m.model) : 'unknown';
      const call = newCall(m.id, m.time, model, {
        input: t?.input ?? 0,
        output: (t?.output ?? 0) + (t?.reasoning ?? 0),
        reasoning: t?.reasoning ?? 0,
        cacheRead: t?.read ?? 0,
        cacheWrite5m: t?.write ?? 0,
      });
      if (cost && cost > 0) call.reportedCost = cost;
      for (const p of parts) {
        if (!p.tool) continue;
        let input = p.tool.input;
        if (typeof input === 'string') input = parseJson(input) ?? input;
        const tc = newToolCall(p.tool.callId || `${m.id}:${call.toolCalls.length}`, p.tool.name, input);
        if (p.tool.status === 'completed' || p.tool.status === 'error') setResult(tc, p.tool.output, p.tool.error);
        call.toolCalls.push(tc);
        if (AGENT_TOOLS.has(p.tool.name)) agentCalls.push({ tc, input, ts: m.time, sessionId: sid });
      }
      lastTurn(s, m.time).calls.push(call);
    }
    s.caps.cacheWrites = sawWrite;
    finish(s);
    if (s.turns.length) built.set(sid, s);
  }

  // attach child sessions (parentID) to the task/subagent call that spawned them
  const roots: Session[] = [];
  for (const s of built.values()) {
    const parentId = store.sessions.get(s.id)?.parentId;
    if (!parentId || !built.has(parentId)) {
      roots.push(s);
      continue;
    }
    s.isSubagent = true;
    s.agentDescription = s.title;
    const cands = agentCalls.filter((a) => a.sessionId === parentId && !a.tc.subagent);
    const host =
      cands.find((a) => a.input?.sessionID === s.id || a.input?.session_id === s.id) ??
      cands.filter((a) => a.ts <= s.start).pop() ??
      cands[0];
    if (host) host.tc.subagent = s;
    else roots.push(s);
  }
  return roots;
}

function makeParser(id: SourceId, name: string, dirName: string, dbPrefix: string, envVar: string): Parser {
  return {
    id,
    name,
    verified: false,
    caps: OPENCODE_CAPS,
    defaultDirs: () => [process.env[envVar] || path.join(xdgData(), dirName)],
    async load(dir: string, opts: LoadOptions = {}): Promise<Session[]> {
      const store: Store = { sessions: new Map(), messages: new Map(), parts: new Map() };
      let entries: string[] = [];
      try {
        entries = await fs.readdir(dir);
      } catch {
        return [];
      }
      const dbRe = new RegExp(`^${dbPrefix}(-[\\w.]+)?\\.db$`);
      const dbs = entries.filter((e) => dbRe.test(e)).sort((a, b) => (a === `${dbPrefix}.db` ? -1 : b === `${dbPrefix}.db` ? 1 : a.localeCompare(b)));
      for (const db of dbs) {
        const f = path.join(dir, db);
        if (opts.since && (await fs.stat(f)).mtimeMs < opts.since) continue;
        await readSqlite(f, store, opts.notes);
      }
      const storage = path.join(dir, 'storage');
      if (await exists(storage)) await readJsonStorage(storage, store);
      return buildOpenCodeSessions(store, id, dbs[0] ? path.join(dir, dbs[0]) : storage);
    },
  };
}

export const openCodeParser = makeParser('opencode', 'OpenCode', 'opencode', 'opencode', 'OPENCODE_DATA_DIR');
export const kiloCliParser = makeParser('kilo-cli', 'Kilo CLI', 'kilo', 'kilo', 'KILO_DATA_DIR');
