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
import type { Session } from './types.js';
import { exists, parseWhen } from './util.js';

const require = createRequire(import.meta.url);
const VERSION: string = require('../package.json').version;

const HELP = `
tokenscope ${VERSION} - where did my AI coding agent's tokens (and money) go?

Usage
  npx tokenscope [options]

Output
  (default)              pretty terminal summary
  --html [file]          self-contained HTML report with flame graph (default: tokenscope-report.html)
  --json [file]          machine-readable report (stdout when no file given)
  --open                 open the HTML report when done

Filters
  --since <when>         7d, 24h, 2w, or a date (2026-11-01)
  --until <when>         same formats
  -p, --project <text>   only projects whose name/path contains <text>
  --source <id>          claude-code | codex | all (default: all that exist)

Sources
  --dir <path>           Claude Code projects dir (default: ~/.claude/projects, honors CLAUDE_CONFIG_DIR)
  --codex-dir <path>     Codex sessions dir (default: ~/.codex/sessions, honors CODEX_HOME)

Tuning
  --pricing <file>       JSON overrides merged over the built-in pricing table
  --huge <tokens>        tool output size flagged as huge (default 10000)
  --top <n>              rows per section in the terminal (default 8)
  --redact               replace prompts, titles, paths and commands with placeholders
  --no-color             disable ANSI colors (also honors NO_COLOR)
  -h, --help / -v, --version
`;

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
      source: { type: 'string', default: 'all' },
      dir: { type: 'string' },
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
  const dirs: Record<string, string | undefined> = { 'claude-code': values.dir, codex: values['codex-dir'] };
  const wanted = values.source === 'all' ? parsers : parsers.filter((p) => p.id === values.source);
  if (!wanted.length) throw new Error(`Unknown --source "${values.source}" (use claude-code, codex or all)`);

  const t0 = Date.now();
  let sessions: Session[] = [];
  const scanned: string[] = [];
  for (const p of wanted) {
    const dir = dirs[p.id] ?? p.defaultDir();
    if (!(await exists(dir))) {
      if (dirs[p.id]) throw new Error(`${p.name} directory not found: ${dir}`);
      continue;
    }
    scanned.push(`${p.name} (${dir})`);
    sessions.push(...(await p.load(dir, { since })));
  }
  if (!scanned.length) {
    process.stderr.write(
      `No agent logs found. Looked for Claude Code in ${parsers[0].defaultDir()} and Codex in ${parsers[1].defaultDir()}.\nUse --dir / --codex-dir to point at a different location.\n`,
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
    const color = !values['no-color'] && !process.env.NO_COLOR && process.stdout.isTTY === true;
    process.stdout.write(renderTerminal(report, { color, width: process.stdout.columns ?? 100, top: Number(values.top ?? 8) }) + '\n');
    process.stderr.write(`scanned ${report.totals.calls.toLocaleString('en-US')} API calls in ${elapsed}ms\n`);
  }
  return 0;
}

function openFile(file: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', file] : [file];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

// set exitCode instead of calling process.exit() so piped stdout is fully flushed
main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (err) => {
    process.stderr.write(`tokenscope: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
