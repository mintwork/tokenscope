import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { home, xdgData, uniq } from '../paths.js';
import type { ApiCall, Capabilities, Session } from '../types.js';
import { oneLine, parseTime, walk } from '../util.js';
import { envDirs, finish, lastTurn, newCall, newSession, newToolCall, newTurn, num, promptText, setCwd, setResult, toolSeen, touch } from './common.js';
import type { LoadOptions, Parser } from './types.js';

/**
 * EXPERIMENTAL - Amp (ampcode.com) threads: one JSON document per thread,
 *   ~/.local/share/amp/threads/T-<uuid>.json   (AMP_DATA_DIR overrides the data dir)
 *
 * Usage, newest schema first:
 *   messages[].usage {model, timestamp, inputTokens, outputTokens,
 *                     cacheCreationInputTokens, cacheReadInputTokens, credits}
 *   legacy: usageLedger.events[] {timestamp, model, tokens:{input,output}, toMessageId}
 *           (cache tokens come from the assistant message with messageId == toMessageId)
 * The ledger wins when present (never count both). `inputTokens` excludes cache.
 * Amp also bills in "credits", which we don't convert to USD.
 *
 * Usage fields learned from the ccusage Amp adapter (MIT). Tool-call blocks
 * (tool_use / tool_result with `toolUseID` + `run.status`) are parsed
 * defensively; not yet validated against real threads.
 */

const AMP_CAPS: Capabilities = {
  perRequestTokens: true,
  cacheReads: true,
  cacheWrites: true,
  toolCalls: true,
  toolOutputs: true,
  filePaths: true,
  timestamps: true,
};

export function parseAmpThread(doc: any, file: string): Session | undefined {
  if (!doc || typeof doc.id !== 'string') return undefined;
  const s = newSession('amp', doc.id, file, AMP_CAPS);
  if (typeof doc.title === 'string') s.title = oneLine(doc.title, 100);
  const tree = doc.env?.initial?.trees?.[0];
  if (typeof tree?.uri === 'string' && tree.uri.startsWith('file:')) {
    try {
      setCwd(s, fileURLToPath(tree.uri));
    } catch {
      /* ignore */
    }
  }
  if (!s.projectPath && typeof tree?.displayName === 'string') s.project = tree.displayName;
  const created = parseTime(doc.created);
  touch(s, created);

  const messages: any[] = Array.isArray(doc.messages) ? doc.messages : [];
  const ledger: any[] | undefined = Array.isArray(doc.usageLedger?.events) ? doc.usageLedger.events : undefined;
  const msgById = new Map<string, any>();
  for (const m of messages) if (m && m.messageId !== undefined) msgById.set(String(m.messageId), m);
  const callByMsg = new Map<string, ApiCall>();
  const tools = new Map<string, ReturnType<typeof newToolCall>>();
  let n = 0;
  let lastTs = created;

  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const ts = parseTime(m.usage?.timestamp) || parseTime(m.meta?.sentAt) || parseTime(m.timestamp) || lastTs;
    lastTs = ts;
    touch(s, ts);
    const content = m.content;
    if (m.role === 'user') {
      if (Array.isArray(content))
        for (const b of content) {
          if (b?.type !== 'tool_result') continue;
          const tc = tools.get(String(b.toolUseID ?? b.tool_use_id ?? ''));
          if (!tc) continue;
          const run = b.run ?? {};
          const status = String(run.status ?? '');
          setResult(tc, run.result ?? run.error ?? b.content ?? '', status === 'error' || b.is_error === true);
        }
      const text = promptText(content);
      if (text !== undefined) newTurn(s, ts, oneLine(text) || '[empty prompt]');
    } else if (m.role === 'assistant') {
      const u = m.usage;
      // in ledger mode usage comes from the ledger events; still create the call to hold tool calls
      const call = newCall(`${s.id}:${m.messageId ?? n}`, ts, String(u?.model ?? 'unknown'));
      n++;
      if (!ledger && u) {
        call.usage.input = num(u.inputTokens);
        call.usage.output = num(u.outputTokens);
        call.usage.cacheRead = num(u.cacheReadInputTokens);
        call.usage.cacheWrite5m = num(u.cacheCreationInputTokens);
        if (!call.usage.input && !call.usage.output && num(u.totalTokens)) call.usage.output = num(u.totalTokens);
      }
      if (Array.isArray(content))
        for (const b of content)
          if (b?.type === 'tool_use') {
            const tc = newToolCall(String(b.id ?? `t${n}`), String(b.name ?? 'tool'), b.input);
            tools.set(tc.id, tc);
            call.toolCalls.push(tc);
          }
      if (m.messageId !== undefined) callByMsg.set(String(m.messageId), call);
      lastTurn(s, ts).calls.push(call);
    }
  }

  if (ledger) {
    for (const ev of ledger) {
      const ts = parseTime(ev?.timestamp);
      if (!ts || typeof ev?.model !== 'string' || !ev.tokens) continue;
      const key = ev.toMessageId !== undefined ? String(ev.toMessageId) : undefined;
      const msg = key ? msgById.get(key) : undefined;
      let call = key ? callByMsg.get(key) : undefined;
      if (!call) {
        call = newCall(`${s.id}:ev:${ev.id ?? n++}`, ts, ev.model);
        lastTurn(s, ts).calls.push(call);
      }
      call.model = ev.model;
      call.timestamp = ts;
      call.usage.input += num(ev.tokens.input);
      call.usage.output += num(ev.tokens.output);
      call.usage.cacheRead += num(msg?.usage?.cacheReadInputTokens);
      call.usage.cacheWrite5m += num(msg?.usage?.cacheCreationInputTokens);
      touch(s, ts);
    }
  }
  // drop assistant messages that carried neither tokens nor tools
  for (const t of s.turns)
    t.calls = t.calls.filter((c) => c.toolCalls.length || c.usage.input || c.usage.output || c.usage.cacheRead || c.usage.cacheWrite5m);
  return finish(s, toolSeen(s));
}

export const ampParser: Parser = {
  id: 'amp',
  name: 'Amp',
  verified: false,
  caps: AMP_CAPS,
  defaultDirs: () =>
    (envDirs('AMP_DATA_DIR') ?? uniq([path.join(xdgData(), 'amp'), path.join(home(), '.local', 'share', 'amp')])).map((d) =>
      path.basename(d) === 'threads' ? d : path.join(d, 'threads'),
    ),
  async load(dir: string, opts: LoadOptions = {}): Promise<Session[]> {
    const files = await walk(dir, (p) => p.endsWith('.json'));
    const out: Session[] = [];
    for (const f of files) {
      if (opts.since && (await fs.stat(f)).mtimeMs < opts.since) continue;
      let doc: unknown;
      try {
        doc = JSON.parse(await fs.readFile(f, 'utf8'));
      } catch {
        continue; // half-written while Amp is running
      }
      const s = parseAmpThread(doc, f);
      if (s && s.turns.length) out.push(s);
    }
    return out;
  },
};
