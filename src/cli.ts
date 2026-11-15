#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildReport, filterByTime } from './analyze/report.js';
import { exceeds, summarize } from './analyze/summary.js';
import { openFile } from './open.js';
import { parsers } from './parsers/index.js';
import { Pricer, loadPricing } from './pricing/index.js';
import { renderHtml } from './render/html.js';
import { usd } from './render/format.js';
import { renderTerminal } from './render/terminal.js';
import { runWatch } from './watch.js';
import type { Session, SourceId } from './types.js';
import { exists, expandHome, parseWhen } from './util.js';

const require = createRequire(import.meta.url);
const VERSION: string = require('../package.json').version;

const HELP = `
tokenscope ${VERSION} - find the tokens (and money) your AI coding agent wasted

Usage
  npx @mintwork/tokenscope [options]
  npx @mintwork/tokenscope watch [--session <id>] [-p <text>] [--dir <dir>]
                         live alerts for the active Claude Code session (cache about to
                         expire, new loops/re-reads/huge outputs); Ctrl-C to stop

Output
  (default)              terminal summary: waste first, then spend
  --html [file]          self-contained HTML report with flame graph (default: tokenscope-report.html)
  --json [file]          machine-readable report (stdout when no file given)
  --open                 open the HTML report when done

Filters
  --since <when>         7d, 24h, 2w, or a date (2026-11-01)
  --until <when>         same formats
  -p, --project <text>   only projects whose name/path contains <text>
  --source <ids>         comma-separated agent ids, or "all" (default: every agent found)
                         ${'${SOURCES}'}

CI / headless runs
  --session <ids>        only these sessions (comma-separated ids or id prefixes)
  --fail-over <usd>      exit 1 when the avoidable waste (the headline) exceeds <usd>
  --summary [file]       compact JSON summary for CI (stdout when no file given)

Sources
  --path <id>=<dir>      read agent <id> from <dir> (repeatable), e.g. --path gemini-cli=~/backup/gemini
  --dir <dir>            shorthand for --path claude-code=<dir>
  --codex-dir <dir>      shorthand for --path codex=<dir>
  --list-sources         show every supported agent, where it looks, and what it found

Tuning
  --pricing <file>       JSON overrides merged over the built-in pricing table
  --huge <tokens>        tool output size flagged as huge (default 10000)
  --top <n>              rows per section in the terminal (default 8)
  --redact               replace prompts, titles, paths and commands with placeholders
  --no-color             disable ANSI colors (also honors NO_COLOR; FORCE_COLOR forces them on)
  -h, --help / -v, --version
`.replace('${SOURCES}', parsers.map((p) => p.id).join(', '));

/** Allow `--html` / `--json` without a value by injecting an empty one. */
function normalizeArgv(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    out.push(argv[i]);
    if ((argv[i] === '--html' || argv[i] === '--json' || argv[i] === '--summary') && (i + 1 >= argv.length || argv[i + 1].startsWith('-'))) out.push('');
  }
  return out;
}

const WATCH_HELP = `
tokenscope watch - live waste alerts for the active Claude Code session

Usage
  npx @mintwork/tokenscope watch [options]

Tails the most recently active session log (switching when a newer session starts) and prints:
  - a heads-up ~1 min before the prompt cache expires, and when it has expired, with the
    tokens the next message will re-write and what that costs over a warm cache
  - each new waste finding (loops, repeats, unchanged re-reads, huge outputs, cache rebuilds)

Options
  --session <id>         watch this session (id or prefix) instead of the newest one
  -p, --project <text>   only sessions whose project name/path contains <text>
  --dir <dir>            Claude Code projects dir (also --path claude-code=<dir>)
  --pricing <file>       JSON overrides merged over the built-in pricing table
  --interval <seconds>   how often to check the log (default 2)
  --no-color             disable ANSI colors (also honors NO_COLOR)
`;

async function watchMain(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      session: { type: 'string' },
      project: { type: 'string', short: 'p' },
      dir: { type: 'string' },
      path: { type: 'string', multiple: true },
      pricing: { type: 'string' },
      interval: { type: 'string' },
      'no-color': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(WATCH_HELP);
    return 0;
  }
  const dirs: string[] = [];
  for (const spec of values.path ?? []) {
    const eq = spec.indexOf('=');
    if (eq < 1 || spec.slice(0, eq) !== 'claude-code') throw new Error(`watch supports Claude Code only: use --path claude-code=<dir> (got "${spec}")`);
    dirs.push(expandHome(spec.slice(eq + 1)));
  }
  if (values.dir) dirs.push(expandHome(values.dir));
  const parser = parsers.find((p) => p.id === 'claude-code')!;
  const candidates = dirs.length ? dirs : parser.defaultDirs();
  const found: string[] = [];
  for (const d of candidates) if (await exists(d)) found.push(d);
  if (!found.length) {
    process.stderr.write(`tokenscope watch: Claude Code directory not found (checked ${candidates.join(', ')}). Use --dir <dir>.\n`);
    return 1;
  }
  const interval = values.interval ? Number(values.interval) : 2;
  if (!(interval > 0)) throw new Error(`--interval expects seconds > 0, got "${values.interval}"`);
  const force = process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0' && process.env.FORCE_COLOR !== 'false';
  return runWatch({
    dirs: found,
    pricer: new Pricer(loadPricing(values.pricing)),
    session: values.session,
    project: values.project,
    intervalMs: interval * 1000,
    color: !values['no-color'] && !process.env.NO_COLOR && (force || process.stdout.isTTY === true),
  });
}

async function main(rawArgv: string[]): Promise<number> {
  if (rawArgv[0] === 'watch') return watchMain(rawArgv.slice(1));
  const argv = normalizeArgv(rawArgv);
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      html: { type: 'string' },
      json: { type: 'string' },
      summary: { type: 'string' },
      session: { type: 'string' },
      'fail-over': { type: 'string' },
      open: { type: 'boolean' },
      since: { type: 'string' },
      until: { type: 'string' },
      project: { type: 'string', short: 'p' },
      source: { type: 'string' },
      dir: { type: 'string' },
      path: { type: 'string', multiple: true },
      'list-sources': { type: 'boolean' },
      'codex-dir': { type: 'string' },
      pricing: { type: 'string' },
      huge: { type: 'string' },
      top: { type: 'string' },
      redact: { type: 'boolean' },
      'no-color': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(VERSION + '\n');
    return 0;
  }

  const since = parseWhen(values.since);
  let failOver: number | undefined;
  if (values['fail-over'] !== undefined) {
    failOver = Number(values['fail-over'].replace(/^\$/, ''));
    if (!values['fail-over'].trim() || !Number.isFinite(failOver) || failOver < 0) throw new Error(`--fail-over expects a dollar amount like 5 or 0.5, got "${values['fail-over']}"`);
  }
  const until = parseWhen(values.until);

  const overrides = new Map<SourceId, string[]>();
  const addPath = (id: string, dir: string) => {
    if (!parsers.some((p) => p.id === id)) throw new Error(`Unknown agent "${id}" in --path (known: ${parsers.map((p) => p.id).join(', ')})`);
    const list = overrides.get(id as SourceId) ?? [];
    list.push(expandHome(dir));
    overrides.set(id as SourceId, list);
  };
  for (const spec of values.path ?? []) {
    const eq = spec.indexOf('=');
    if (eq < 1) throw new Error(`--path expects <agent>=<dir>, got "${spec}"`);
    addPath(spec.slice(0, eq), spec.slice(eq + 1));
  }
  if (values.dir) addPath('claude-code', values.dir);
  if (values['codex-dir']) addPath('codex', values['codex-dir']);

  let wanted = parsers;
  if (values.source && values.source !== 'all') {
    const ids = values.source.split(',').map((x) => x.trim()).filter(Boolean);
    const bad = ids.filter((id) => !parsers.some((p) => p.id === id));
    if (bad.length) throw new Error(`Unknown --source ${bad.join(', ')} (known: ${parsers.map((p) => p.id).join(', ')})`);
    wanted = parsers.filter((p) => ids.includes(p.id));
  } else if (overrides.size && !values.source) {
    // explicit paths given without --source: only read those agents
    wanted = parsers.filter((p) => overrides.has(p.id));
  }

  if (values['list-sources']) {
    for (const p of parsers) {
      const dirs = overrides.get(p.id) ?? p.defaultDirs();
      const found: string[] = [];
      for (const d of dirs) if (await exists(d)) found.push(d);
      process.stdout.write(
        `${found.length ? '●' : '○'} ${p.id.padEnd(12)} ${p.name.padEnd(16)} ${p.verified ? 'verified on real logs' : 'experimental (format from docs/source)'}\n` +
          (found.length
            ? found.map((d) => `     found    ${d}`).join('\n') + '\n'
            : `     not found (checked ${dirs.length} location${dirs.length > 1 ? 's' : ''}, e.g. ${dirs[0]})\n`),
      );
    }
    return 0;
  }

  const t0 = Date.now();
  let sessions: Session[] = [];
  const scanned: string[] = [];
  const notes: string[] = [];
  for (const p of wanted) {
    const explicit = overrides.get(p.id);
    for (const dir of explicit ?? p.defaultDirs()) {
      if (!(await exists(dir))) {
        if (explicit) throw new Error(`${p.name} directory not found: ${dir}`);
        continue;
      }
      scanned.push(`${p.name} (${dir})`);
      try {
        sessions.push(...(await p.load(dir, { since, notes })));
      } catch (err) {
        notes.push(`${p.name}: could not read ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  for (const n of notes) process.stderr.write(`tokenscope: ${n}\n`);
  // the same session can be reachable from two candidate dirs
  const seen = new Set<string>();
  sessions = sessions.filter((s) => {
    const k = s.source + '\0' + s.id;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!scanned.length) {
    process.stderr.write(
      `No agent logs found. Supported: ${parsers.map((p) => p.name).join(', ')}.\nRun \`tokenscope --list-sources\` to see where each agent is looked for, and --path <agent>=<dir> to point somewhere else.\n`,
    );
    return 1;
  }
  if (values.project) {
    const q = values.project.toLowerCase();
    sessions = sessions.filter((s) => s.project.toLowerCase().includes(q) || (s.projectPath ?? '').toLowerCase().includes(q));
  }
  if (values.session) {
    const ids = values.session.split(',').map((x) => x.trim()).filter(Boolean);
    sessions = sessions.filter((s) => ids.some((id) => s.id === id || s.id.startsWith(id)));
  }
  sessions = filterByTime(sessions, since, until);
  if (!sessions.length) {
    process.stderr.write(`No sessions matched${values.session ? ` --session ${values.session}` : ''} in ${scanned.join(', ')}.\n`);
    return 1;
  }

  const pricer = new Pricer(loadPricing(values.pricing));
  const report = buildReport(sessions, pricer, {
    redact: values.redact,
    version: VERSION,
    sourceInfo: Object.fromEntries(parsers.map((p) => [p.id, { name: p.name, verified: p.verified }])),
    waste: values.huge ? { hugeOutputTokens: Number(values.huge) } : undefined,
  });
  const elapsed = Date.now() - t0;

  const jsonFlag = values.json !== undefined;
  const summaryFlag = values.summary !== undefined;
  const htmlFlag = values.html !== undefined;

  if (jsonFlag) {
    const json = JSON.stringify(report, null, 2);
    if (values.json) {
      writeFileSync(values.json, json);
      process.stderr.write(`JSON report written to ${values.json}\n`);
    } else process.stdout.write(json + '\n');
  }
  if (summaryFlag) {
    const json = JSON.stringify(summarize(report, { failOver }), null, 2);
    if (values.summary) {
      writeFileSync(values.summary, json);
      process.stderr.write(`JSON summary written to ${values.summary}\n`);
    } else process.stdout.write(json + '\n');
  }
  if (htmlFlag) {
    const file = values.html || 'tokenscope-report.html';
    writeFileSync(file, renderHtml(report));
    process.stderr.write(`HTML report written to ${path.resolve(file)}\n`);
    if (values.open && !openFile(file)) process.stderr.write(`tokenscope: --open: ${path.resolve(file)} is not a file\n`);
  }
  // terminal report unless a JSON document goes to stdout (or --json was asked for)
  if (!jsonFlag && !(summaryFlag && !values.summary)) {
    const force = process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0' && process.env.FORCE_COLOR !== 'false';
    const color = !values['no-color'] && !process.env.NO_COLOR && (force || process.stdout.isTTY === true);
    process.stdout.write(renderTerminal(report, { color, width: process.stdout.columns ?? (Number(process.env.COLUMNS) || 100), top: Number(values.top ?? 8) }) + '\n');
    process.stderr.write(`scanned ${report.totals.calls.toLocaleString('en-US')} API calls in ${elapsed}ms\n`);
  }
  if (failOver !== undefined) {
    const msg = `avoidable waste ${usd(report.totals.avoidableCost)} ${exceeds(report, failOver) ? 'exceeds' : 'is within'} --fail-over ${usd(failOver)}`;
    process.stderr.write(`tokenscope: ${msg}\n`);
    if (exceeds(report, failOver)) return 1;
  }
  return 0;
}

// `tokenscope | head` closes the pipe early - that's fine
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

// set exitCode instead of calling process.exit() so piped stdout is fully flushed
main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (err) => {
    process.stderr.write(`tokenscope: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
