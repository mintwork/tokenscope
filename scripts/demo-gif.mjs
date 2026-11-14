#!/usr/bin/env node
// Renders docs/demo.gif: an animated terminal recording of `npx @mintwork/tokenscope` on SYNTHETIC logs.
//
// How it works:
//   1. scripts/gen-demo.mjs writes synthetic Claude Code logs into a throwaway HOME (never your real logs).
//   2. The real CLI (dist/cli.js) runs with that HOME and FORCE_COLOR=1; its ANSI output is captured.
//   3. The output is rendered into a styled terminal page, the command is "typed" and the output revealed
//      line by line. Playwright (Google Chrome) screenshots each frame.
//   4. ffmpeg builds the GIF with palettegen/paletteuse.
//
// Usage: npm run demo:gif   (needs Google Chrome and ffmpeg; set FFMPEG=/path/to/ffmpeg if it's not on PATH)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outGif = path.resolve(process.argv[2] ?? path.join(root, 'docs/demo.gif'));
const ffmpeg = process.env.FFMPEG ?? (existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
const cli = path.join(root, 'dist/cli.js');
if (!existsSync(cli)) throw new Error('dist/cli.js not found - run `npm run build` first');

const WIDTH = 1200;
const ROWS = 30; // visible terminal rows
const FONT = 18; // px; 100 columns of Menlo at 18px fit in 1200px
const LINE = 1.38;
const COMMAND = 'npx @mintwork/tokenscope';

const work = mkdtempSync(path.join(tmpdir(), 'tokenscope-gif-'));
try {
  // 1-2. Synthetic logs in an isolated HOME, then the real CLI. env is built from scratch so no
  // CLAUDE_CONFIG_DIR / CODEX_HOME / XDG_* from the caller can point it at real logs.
  const home = path.join(work, 'home');
  run(process.execPath, [path.join(root, 'scripts/gen-demo.mjs'), path.join(home, '.claude/projects')]);
  const res = spawnSync(process.execPath, [cli], {
    env: { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, FORCE_COLOR: '1', COLUMNS: '100', TZ: 'UTC', LANG: 'en_US.UTF-8' },
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`tokenscope failed:\n${res.stderr}`);
  const lines = (res.stdout.replace(/\n+$/, '') + '\n' + res.stderr.replace(/\n+$/, '')).split('\n');
  // The real run takes ~50ms; replace the timing so the GIF doesn't change on every rebuild.
  const html = lines.map((l) => ansiToHtml(l.replace(/ in \d+ms$/, ' in 48ms')));

  // 3. Frames.
  const frames = []; // { file, ms }
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: 200 }, deviceScaleFactor: 1 });
  await page.setContent(pageHtml(html));
  await page.evaluate(() => document.fonts.ready);
  const height = await page.evaluate(() => document.querySelector('.win').getBoundingClientRect().height);
  await page.setViewportSize({ width: WIDTH, height: Math.ceil(height) });

  let n = 0;
  const shot = async (state, ms) => {
    await page.evaluate((s) => window.setFrame(s), state);
    const file = path.join(work, `f${String(n++).padStart(4, '0')}.png`);
    await page.screenshot({ path: file });
    frames.push({ file, ms });
  };

  // Blinking cursor on an empty prompt.
  for (let i = 0; i < 2; i++) {
    await shot({ typed: 0, shown: 0, cursor: true }, 450);
    await shot({ typed: 0, shown: 0, cursor: false }, 350);
  }
  // Type the command.
  for (let i = 1; i <= COMMAND.length; i++) await shot({ typed: i, shown: 0, cursor: true }, i === 3 ? 160 : 75);
  await shot({ typed: COMMAND.length, shown: 0, cursor: true }, 450);
  // First screen (headline + top waste), a line at a time, then hold so it can be read.
  // (as many lines as fit without scrolling, so the headline stays on screen)
  const firstScreen = await page.evaluate((n) => {
    for (let i = 1; i <= n; i++) if (window.setFrame({ typed: 0, shown: i })) return i - 1;
    return n;
  }, html.length);
  for (let i = 1; i <= firstScreen; i++) await shot({ typed: COMMAND.length, shown: i, cursor: false }, 55);
  frames[frames.length - 1].ms = 6800;
  // The rest scrolls past, then hold on the spend summary at the bottom.
  for (let i = firstScreen + 1; i <= html.length; i += 3) await shot({ typed: COMMAND.length, shown: Math.min(i + 2, html.length), cursor: false }, 60);
  for (let i = 0; i < 3; i++) {
    await shot({ typed: COMMAND.length, shown: html.length, cursor: true, prompt: true }, 500);
    await shot({ typed: COMMAND.length, shown: html.length, cursor: false, prompt: true }, 400);
  }
  await browser.close();

  // 4. GIF. Each PNG is shown for its own duration via the concat demuxer.
  const list = path.join(work, 'frames.txt');
  writeFileSync(list, 'ffconcat version 1.0\n' + frames.map((f) => `file '${f.file}'\nduration ${(f.ms / 1000).toFixed(3)}\n`).join('') + `file '${frames.at(-1).file}'\n`);
  const palette = path.join(work, 'palette.png');
  run(ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vf', 'palettegen=max_colors=128:stats_mode=full', palette]);
  run(ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-i', palette,
    '-lavfi', '[0:v][1:v]paletteuse=dither=none:diff_mode=rectangle', '-fps_mode', 'vfr', '-loop', '0', outGif]);
  const total = frames.reduce((s, f) => s + f.ms, 0) / 1000;
  console.log(`wrote ${path.relative(process.cwd(), outGif)}: ${frames.length} frames, ${total.toFixed(1)}s, ${(statSync(outGif).size / 1024 / 1024).toFixed(2)} MB`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} exited with ${r.status}`);
}

// ---------------------------------------------------------------------------------------------
// ANSI SGR -> HTML. Supports what the terminal renderer emits: reset, bold, dim, inverse, 256-color fg.

function xterm256(n) {
  const base = ['#1e2127', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf',
    '#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff'];
  if (n < 16) return base[n];
  if (n < 232) {
    const v = [0, 95, 135, 175, 215, 255];
    const i = n - 16;
    return `rgb(${v[Math.floor(i / 36)]},${v[Math.floor(i / 6) % 6]},${v[i % 6]})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

function ansiToHtml(line) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let st = { bold: false, dim: false, inv: false, fg: null };
  let out = '';
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  const emit = (text) => {
    if (!text) return;
    const css = [];
    if (st.bold) css.push('font-weight:700');
    if (st.dim) css.push('opacity:.55');
    if (st.inv) css.push(`background:${st.fg ?? 'var(--fg)'};color:var(--bg)`);
    else if (st.fg) css.push(`color:${st.fg}`);
    out += css.length ? `<span style="${css.join(';')}">${esc(text)}</span>` : esc(text);
  };
  for (let m; (m = re.exec(line)); ) {
    emit(line.slice(last, m.index));
    last = re.lastIndex;
    const codes = (m[1] || '0').split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) st = { bold: false, dim: false, inv: false, fg: null };
      else if (c === 1) st.bold = true;
      else if (c === 2) st.dim = true;
      else if (c === 7) st.inv = true;
      else if (c === 22) st.bold = st.dim = false;
      else if (c === 27) st.inv = false;
      else if (c === 39) st.fg = null;
      else if (c >= 30 && c <= 37) st.fg = xterm256(c - 30);
      else if (c >= 90 && c <= 97) st.fg = xterm256(c - 90 + 8);
      else if (c === 38 && codes[i + 1] === 5) { st.fg = xterm256(codes[i + 2]); i += 2; }
    }
  }
  emit(line.slice(last));
  return out;
}

function pageHtml(lines) {
  const prompt = '<span class="p1">~/dev</span> <span class="p2">❯</span> ';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  :root { --bg: #0f1419; --fg: #d5dae0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: var(--bg); }
  .win { width: ${WIDTH}px; background: var(--bg); overflow: hidden; }
  .bar { height: 40px; background: #1b2128; border-bottom: 1px solid #262e37; display: flex; align-items: center; padding: 0 16px; position: relative; }
  .dot { width: 13px; height: 13px; border-radius: 50%; margin-right: 8px; }
  .title { position: absolute; left: 0; right: 0; text-align: center; color: #8a949e; font: 500 14px -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }
  .screen { padding: 14px 22px 18px; height: ${Math.ceil(ROWS * FONT * LINE) + 32}px; overflow: hidden; }
  .lines { font: ${FONT}px/${LINE} Menlo, "DejaVu Sans Mono", monospace; color: var(--fg); white-space: pre-wrap; word-break: break-all; font-variant-ligatures: none; }
  .l { min-height: ${FONT * LINE}px; }
  .p1 { color: #6cb6ff; font-weight: 700; } .p2 { color: #5fd787; font-weight: 700; }
  .cur { display: inline-block; width: .6em; height: 1.15em; vertical-align: -.2em; background: #d5dae0; }
  .cur.off { background: transparent; }
  </style></head><body><div class="win">
  <div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="title">tokenscope — synthetic demo logs</span></div>
  <div class="screen"><div class="lines" id="lines"></div></div></div>
  <script>
  const OUT = ${JSON.stringify(lines)};
  const CMD = ${JSON.stringify(COMMAND)};
  const PROMPT = ${JSON.stringify(prompt)};
  window.setFrame = ({ typed, shown, cursor, prompt }) => {
    const cur = '<span class="cur' + (cursor ? '' : ' off') + '"></span>';
    let h = '<div class="l">' + PROMPT + CMD.slice(0, typed) + (prompt ? '' : cur) + '</div>';
    for (let i = 0; i < shown; i++) h += '<div class="l">' + OUT[i] + '</div>';
    if (prompt) h += '<div class="l"></div><div class="l">' + PROMPT + cur + '</div>';
    const el = document.getElementById('lines');
    el.innerHTML = h;
    const scr = el.parentElement;
    scr.scrollTop = scr.scrollHeight;
    return scr.scrollHeight > scr.clientHeight; // true when the content no longer fits
  };
  </script></body></html>`;
}
