import { promises as fs } from 'node:fs';
import path from 'node:path';
import { forEachCall } from './analyze/report.js';
import { detectWaste, type Finding } from './analyze/waste.js';
import { claudeCodeParser, parseClaudeFile } from './parsers/claude-code.js';
import type { Pricer } from './pricing/index.js';
import { usd } from './render/format.js';
import type { ApiCall, Session } from './types.js';
import { walk } from './util.js';

/**
 * `tokenscope watch`: tail the active Claude Code session and print live alerts.
 *
 * The core (`Watcher`) is pure: give it the freshly parsed session and the current time,
 * and it returns the alert lines that have not been printed yet. The polling loop
 * (`runWatch`) only finds the session file, re-parses it when it changes and prints.
 */

export interface WatchAlert {
  kind: 'expiring' | 'expired' | 'finding' | 'summary' | 'turn';
  text: string;
}

export interface WatcherOptions {
  /** Contexts smaller than this (tokens) never trigger cache alerts. */
  minContextTokens?: number;
  /** Minutes before expiry to print the heads-up. */
  headsUpMin?: number;
  /** Don't alert for caches that expired more than this long ago (ms), e.g. when starting on an old session. */
  staleAfterMs?: number;
}

const MIN = 60_000;
const contextTokens = (c: ApiCall) => c.usage.input + c.usage.cacheRead + c.usage.cacheWrite5m + c.usage.cacheWrite1h;
const fmtTok = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));

/** Stable identity of a finding across re-parses: counts in the title change as a loop grows. */
const findingKey = (f: Finding) => [f.kind, f.cause ?? '', f.agentId ?? '', f.title.replace(/\d[\d,.]*/g, '#'), f.detail.replace(/\d[\d,.]*/g, '#')].join('|');

export class Watcher {
  private sessionId?: string;
  private seen = new Map<string, number>(); // finding key -> count printed
  private cacheAlerted = new Map<string, Set<'expiring' | 'expired'>>(); // last call id -> alerts printed
  private turns = 0;
  readonly o: Required<WatcherOptions>;
  /** Alerts printed so far (for the exit summary). */
  alerts = 0;

  constructor(
    private pricer: Pricer,
    opts: WatcherOptions = {},
  ) {
    this.o = { minContextTokens: 5_000, headsUpMin: 1, staleAfterMs: 2 * 3600_000, ...opts };
  }

  /** Returns alerts not printed before. Call after every re-parse and periodically (for time-based alerts). */
  check(session: Session, now: number): WatchAlert[] {
    const out: WatchAlert[] = [];
    const first = this.sessionId !== session.id;
    if (first) {
      this.sessionId = session.id;
      this.seen.clear();
      this.cacheAlerted.clear();
      this.turns = session.turns.length;
    }
    forEachCall(session, (c) => this.pricer.price(c));

    // --- waste findings: on the first look, summarize what is already there; afterwards print each new one
    const findings = detectWaste([session], this.pricer);
    if (first) {
      for (const f of findings) this.seen.set(findingKey(f), f.count);
      const avoidable = findings.filter((f) => f.certainty === 'avoidable').reduce((n, f) => n + f.cost, 0);
      out.push({
        kind: 'summary',
        text: findings.length
          ? `${findings.length} waste finding${findings.length > 1 ? 's' : ''} so far in this session (≈${usd(avoidable)} avoidable); new ones are shown as they happen`
          : 'no waste patterns so far in this session',
      });
    } else {
      for (const f of findings) {
        const k = findingKey(f);
        const prev = this.seen.get(k);
        if (prev !== undefined && f.count <= prev) continue;
        this.seen.set(k, f.count);
        const likely = f.certainty === 'likely-avoidable' ? ' (likely avoidable)' : '';
        out.push({ kind: 'finding', text: `${prev !== undefined ? 'still ' : ''}${f.title} - ≈${usd(f.cost)}${likely}\n  ↳ ${f.tip}` });
      }
    }

    // --- running spend when a new turn starts (the previous one is done)
    if (!first && session.turns.length > this.turns) {
      this.turns = session.turns.length;
      let cost = 0;
      let calls = 0;
      forEachCall(session, (c) => {
        cost += c.cost;
        calls++;
      });
      out.push({ kind: 'turn', text: `turn ${session.turns.length} started · session so far ${usd(cost)} in ${calls} API calls` });
    }

    // --- cache expiry for the main conversation (the next message goes there)
    const calls = session.turns.flatMap((t) => t.calls).sort((a, b) => a.timestamp - b.timestamp);
    const last = calls[calls.length - 1];
    if (last && last.timestamp) {
      const tokens = contextTokens(last);
      // a pure cache read doesn't say which TTL is in use; the latest write does
      const lastWrite = [...calls].reverse().find((c) => c.usage.cacheWrite5m + c.usage.cacheWrite1h > 0);
      const oneHour = !!lastWrite && lastWrite.usage.cacheWrite1h > lastWrite.usage.cacheWrite5m;
      const ttlMs = (oneHour ? 60 : 5) * MIN;
      const age = now - last.timestamp;
      const cached = last.usage.cacheRead + last.usage.cacheWrite5m + last.usage.cacheWrite1h > 0;
      if (cached && tokens >= this.o.minContextTokens && age < ttlMs + this.o.staleAfterMs) {
        const done = this.cacheAlerted.get(last.id) ?? new Set();
        this.cacheAlerted.set(last.id, done);
        const r = this.pricer.rates(last.model, tokens, last.fast);
        const extra = r ? (tokens * ((oneHour ? r.cacheWrite1h : r.cacheWrite5m) - r.cacheRead)) / 1e6 : undefined;
        const price = extra !== undefined ? ` (~${usd(extra)})` : '';
        const ttl = oneHour ? '1-hour' : '5-minute';
        if (age >= ttlMs) {
          if (!done.has('expired')) {
            done.add('expired');
            done.add('expiring');
            out.push({
              kind: 'expired',
              text: `cache likely expired (${ttl} TTL, idle ${Math.round(age / MIN)} min): the next message re-writes ~${fmtTok(tokens)} tokens${price} instead of reading them from cache`,
            });
          }
        } else if (age >= ttlMs - this.o.headsUpMin * MIN && !done.has('expiring')) {
          done.add('expiring');
          const left = Math.max(1, Math.round((ttlMs - age) / MIN));
          out.push({
            kind: 'expiring',
            text: `cache expires in ~${left} min: ~${fmtTok(tokens)} tokens are cached; replying after that re-writes them${price}`,
          });
        }
      }
    }
    this.alerts += out.filter((a) => a.kind !== 'summary' && a.kind !== 'turn').length;
    return out;
  }
}

export interface WatchTarget {
  file: string;
  mtimeMs: number;
}

/** Top-level Claude Code session files under `dirs`, newest first. */
export async function listSessionFiles(dirs: string[]): Promise<WatchTarget[]> {
  const out: WatchTarget[] = [];
  for (const dir of dirs) {
    const files = await walk(dir, (p) => p.endsWith('.jsonl') && !p.split(/[\\/]/).includes('subagents'));
    for (const file of files) {
      try {
        out.push({ file, mtimeMs: (await fs.stat(file)).mtimeMs });
      } catch {
        /* removed while scanning */
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Pick the session to watch: pinned by id prefix, else the newest matching the project filter. */
export async function pickSession(dirs: string[], opts: { session?: string; project?: string }): Promise<string | undefined> {
  const q = opts.project?.toLowerCase();
  for (const t of await listSessionFiles(dirs)) {
    const id = path.basename(t.file, '.jsonl');
    if (opts.session && !id.startsWith(opts.session)) continue;
    if (q) {
      const { session } = await parseClaudeFile(t.file, path.basename(path.dirname(t.file)));
      if (!session.project.toLowerCase().includes(q) && !(session.projectPath ?? '').toLowerCase().includes(q)) continue;
    }
    return t.file;
  }
  return undefined;
}

/** Parse one session file, with its subagents attached (via the regular parser on its project folder). */
export async function loadSession(file: string): Promise<Session | undefined> {
  const id = path.basename(file, '.jsonl');
  const { session } = await parseClaudeFile(file, path.basename(path.dirname(file)));
  if (!session.turns.length) return undefined;
  // only files touched since this session started can belong to it
  const all = await claudeCodeParser.load(path.dirname(file), { since: session.start - 1000 });
  return all.find((s) => s.id === id && !s.isSubagent) ?? session;
}

export interface RunWatchOptions {
  dirs: string[];
  pricer: Pricer;
  session?: string;
  project?: string;
  intervalMs?: number;
  color?: boolean;
  out?: (s: string) => void;
  /** Resolves when watching should stop (defaults to SIGINT/SIGTERM). */
  stop?: Promise<void>;
}

/** Poll the newest session (or a pinned one), print alerts until stopped. Returns the exit code. */
export async function runWatch(o: RunWatchOptions): Promise<number> {
  const write = o.out ?? ((s: string) => void process.stdout.write(s + '\n'));
  const c = (code: string) => (s: string) => (o.color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const dim = c('2');
  const paint: Record<WatchAlert['kind'], (s: string) => string> = { expired: c('38;5;203'), expiring: c('38;5;214'), finding: c('38;5;209'), summary: dim, turn: dim };
  const stamp = () => {
    const d = new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  };
  const watcher = new Watcher(o.pricer);
  const interval = o.intervalMs ?? 2000;
  const started = Date.now();

  let file = await pickSession(o.dirs, o);
  if (!file) {
    process.stderr.write(`tokenscope watch: no Claude Code session found${o.session ? ` matching "${o.session}"` : ''} in ${o.dirs.join(', ')}\n`);
    return 1;
  }
  let mtime = -1;
  let size = -1;
  let session: Session | undefined;
  let lastScan = 0;
  let busy = false;

  const emit = (alerts: WatchAlert[]) => {
    // a.kind is a closed union and paint has a color for each kind.
    // nosemgrep
    for (const a of alerts) write(`${dim(stamp())} ${paint[a.kind](a.text)}`);
  };
  const announce = (s: Session) =>
    write(`${c('1')('tokenscope watch')} ${dim(`· ${s.project} · ${s.title ?? s.id} · Ctrl-C to stop`)}`);

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      // a newer session file appears when you start a new conversation
      if (!o.session && Date.now() - lastScan >= Math.max(interval * 5, 5000)) {
        lastScan = Date.now();
        const newest = await pickSession(o.dirs, o);
        if (newest && newest !== file) {
          file = newest;
          mtime = size = -1;
          session = undefined;
        }
      }
      let st;
      try {
        st = await fs.stat(file!);
      } catch {
        return; // file rotated away; the next scan picks another one
      }
      if (st.mtimeMs !== mtime || st.size !== size) {
        mtime = st.mtimeMs;
        size = st.size;
        const fresh = await loadSession(file!);
        if (fresh) {
          if (!session || session.id !== fresh.id) announce(fresh);
          session = fresh;
        }
      }
      if (session) emit(watcher.check(session, Date.now()));
    } finally {
      busy = false;
    }
  };

  await tick();
  if (!session) write(dim(`waiting for API calls in ${file}`));

  const stop =
    o.stop ??
    new Promise<void>((resolve) => {
      const done = () => resolve();
      process.once('SIGINT', done);
      process.once('SIGTERM', done);
    });
  const timer = setInterval(() => void tick().catch((err) => process.stderr.write(`tokenscope watch: ${err instanceof Error ? err.message : String(err)}\n`)), interval);
  await stop;
  clearInterval(timer);
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  let cost = 0;
  if (session) forEachCall(session, (x) => (cost += x.cost));
  write(dim(`\nstopped after ${Math.max(1, Math.round((Date.now() - started) / MIN))} min · ${watcher.alerts} alert${watcher.alerts === 1 ? '' : 's'} · session spend ${usd(cost)}`));
  return 0;
}
