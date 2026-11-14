#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { buildReport, filterByTime } from './analyze/report.js';
import { parsers } from './parsers/index.js';
import { Pricer, loadPricing } from './pricing/index.js';
import { renderHtml } from './render/html.js';
import { renderTerminal } from './render/terminal.js';
import type { Session, SourceId } from './types.js';
import { exists, expandHome, parseWhen } from './util.js';

const require = createRequire(import.meta.url);
const VERSION: string = require('../package.json').version;

const HELP = `
tokenscope ${VERSION} - find the tokens (and money) your AI coding agent wasted

Usage
  npx tokenscope [options]

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
    if ((argv[i] === '--html' || argv[i] === '--json') && (i + 1 >= argv.length || argv[i + 1].startsWith('-'))) out.push('');
  }
  return out;
}

async function main(rawArgv: string[]): Promise<number> {
  const argv = normalizeArgv(rawArgv);
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      html: { type: 'string' },
      json: { type: 'string' },
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
  sessions = filterByTime(sessions, since, until);
  if (!sessions.length) {
    process.stderr.write(`No sessions matched in ${scanned.join(', ')}.\n`);
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
  const htmlFlag = values.html !== undefined;

  if (jsonFlag) {
    const json = JSON.stringify(report, null, 2);
    if (values.json) {
      writeFileSync(values.json, json);
      process.stderr.write(`JSON report written to ${values.json}\n`);
    } else {
      process.stdout.write(json + '\n');
      if (!htmlFlag) return 0;
    }
  }
  if (htmlFlag) {
    const file = values.html || 'tokenscope-report.html';
    writeFileSync(file, renderHtml(report));
    process.stderr.write(`HTML report written to ${path.resolve(file)}\n`);
    if (values.open) openFile(path.resolve(file));
    if (jsonFlag) return 0;
  }
  if (!jsonFlag) {
    const force = process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0' && process.env.FORCE_COLOR !== 'false';
    const color = !values['no-color'] && !process.env.NO_COLOR && (force || process.stdout.isTTY === true);
    process.stdout.write(renderTerminal(report, { color, width: process.stdout.columns ?? (Number(process.env.COLUMNS) || 100), top: Number(values.top ?? 8) }) + '\n');
    process.stderr.write(`scanned ${report.totals.calls.toLocaleString('en-US')} API calls in ${elapsed}ms\n`);
  }
  return 0;
}

function openFile(file: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', file] : [file];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
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
