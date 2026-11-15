import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Capabilities, Session } from '../types.js';
import { oneLine } from '../util.js';
import { finish, lastTurn, newCall, newSession, newTurn, setCwd, touch } from './common.js';
import type { LoadOptions, Parser } from './types.js';

/**
 * EXPERIMENTAL - Aider (Aider-AI/aider). Aider has no central log store: it appends a
 * Markdown chat history to `.aider.chat.history.md` in each repo (or $AIDER_CHAT_HISTORY_FILE /
 * --chat-history-file). We read the file in the current directory, or wherever --path points
 * (a file, or a directory searched two levels deep).
 *
 *   # aider chat started at 2026-11-02 10:00:00          one session per block
 *   > Main model: claude-sonnet-4-5 with diff edit format  (or "> Model: ...")
 *   #### <user prompt>
 *   > Tokens: 12k sent, 2.1k cache write, 8.3k cache hit, 1.2k received. Cost: $0.05 message, $0.12 session.
 *
 * Each "Tokens:" line is one model request. "sent" is litellm's prompt_tokens plus the cache
 * write; whether prompt_tokens already contains cache hits/writes depends on the litellm
 * version, so the uncached input is derived conservatively. Aider rounds the counts (1.2k, 12k), so
 * token-based prices are approximate; the per-message cost it printed is kept as the
 * fallback when the model isn't in our pricing table. There are no per-request timestamps
 * (only the session start), no tool calls (Aider edits through text blocks), and no tool
 * output, so no waste detector can run: the logs give spend only.
 *
 * Format from aider's coders/base_coder.py (calculate_and_show_tokens_and_cost,
 * get_announcements), io.py (append_chat_history, user_input) and utils.format_tokens
 * (Apache-2.0, formats only). Not yet validated against real logs.
 */

const AIDER_CAPS: Capabilities = {
  perRequestTokens: true,
  cacheReads: true,
  cacheWrites: true,
  toolCalls: false,
  toolOutputs: false,
  filePaths: false,
  timestamps: false,
};

export const HISTORY_FILE = '.aider.chat.history.md';

/** "12k" -> 12000, "2.1k" -> 2100, "950" -> 950 */
export function aiderTokens(s: string): number {
  const m = s.trim().match(/^([\d.,]+)\s*([kKmM]?)$/);
  if (!m) return 0;
  const n = Number(m[1].replace(/,/g, ''));
  return Math.round(n * (m[2].toLowerCase() === 'k' ? 1e3 : m[2].toLowerCase() === 'm' ? 1e6 : 1));
}

export function parseAiderHistory(text: string, file: string): Session[] {
  const out: Session[] = [];
  let s: Session | undefined;
  let model = 'unknown';
  let start = 0;
  let n = 0;
  let pending: { sent: number; write: number; hit: number; out: number } | undefined;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const started = line.match(/^# aider chat started at (.+?)\s*$/);
    if (started) {
      if (s) out.push(finish(s));
      start = Date.parse(started[1].replace(' ', 'T')) || 0;
      s = newSession('aider', `${path.basename(path.dirname(file))}@${started[1]}`, file, AIDER_CAPS);
      setCwd(s, path.dirname(path.resolve(file)));
      touch(s, start);
      model = 'unknown';
      n = 0;
      continue;
    }
    if (!s) continue;
    const mm = line.match(/^> (?:Main model|Model): (\S+)/);
    if (mm) {
      model = mm[1];
      continue;
    }
    const prompt = line.match(/^#### (.*)$/);
    if (prompt) {
      newTurn(s, start + n, oneLine(prompt[1]) || '[empty prompt]');
      if (!s.title) s.title = oneLine(prompt[1], 80);
      continue;
    }
    const tok = line.match(/^> Tokens: (.+)$/);
    if (tok) {
      const part = (re: RegExp) => aiderTokens(tok[1].match(re)?.[1] ?? '0');
      pending = {
        sent: part(/([\d.,]+[kKmM]?) sent/),
        write: part(/([\d.,]+[kKmM]?) cache write/),
        hit: part(/([\d.,]+[kKmM]?) cache hit/),
        out: part(/([\d.,]+[kKmM]?) received/),
      };
      // the cost is on the same line, or on the next one when both cache fields are shown
      const costLine = /Cost:/.test(line) ? line : /^> Cost:/.test(lines[i + 1] ?? '') ? lines[++i] : '';
      const cost = costLine.match(/Cost: \$([\d.]+) message/);
      const p = pending;
      // aider adds the cache write to litellm's prompt_tokens; recent litellm already counts
      // cache writes and hits in prompt_tokens, older versions don't. Take out what fits.
      const base = p.sent - p.write;
      const uncached = base >= p.write + p.hit ? base - p.write - p.hit : Math.max(0, base - p.hit);
      const call = newCall(`${s.id}#${n}`, start + n, model, {
        input: uncached,
        cacheWrite5m: p.write,
        cacheRead: p.hit,
        output: p.out,
      });
      if (cost) call.reportedCost = Number(cost[1]);
      lastTurn(s, start + n).calls.push(call);
      n++;
      pending = undefined;
    }
  }
  if (s) out.push(finish(s));
  return out.filter((x) => x.turns.length);
}

async function findHistories(dir: string, depth = 2): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === HISTORY_FILE) out.push(p);
    else if (e.isDirectory() && depth > 0 && !e.name.startsWith('.') && e.name !== 'node_modules') out.push(...(await findHistories(p, depth - 1)));
  }
  return out;
}

export const aiderParser: Parser = {
  id: 'aider',
  name: 'Aider',
  verified: false,
  caps: AIDER_CAPS,
  defaultDirs: () => {
    const env = process.env.AIDER_CHAT_HISTORY_FILE;
    if (env) return [env];
    // no central store: only the current directory's history file
    return [path.join(process.cwd(), HISTORY_FILE)];
  },
  async load(dir: string, opts: LoadOptions = {}): Promise<Session[]> {
    const st = await fs.stat(dir);
    const files = st.isFile() ? [dir] : await findHistories(dir);
    const out: Session[] = [];
    for (const f of files) {
      if (opts.since && (await fs.stat(f)).mtimeMs < opts.since) continue;
      out.push(...parseAiderHistory(await fs.readFile(f, 'utf8'), f));
    }
    return out;
  },
};
