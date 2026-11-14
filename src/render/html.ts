import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Report } from '../analyze/report.js';
import { usd } from './format.js';

const asset = (name: string) => readFileSync(new URL(`./assets/${name}`, import.meta.url), 'utf8');

/** For the few values interpolated into the HTML on the server side (title, footer). */
function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * Defense in depth: the report only runs its own bundled script (pinned by hash) and loads nothing.
 * Even if some log-derived string were ever rendered unescaped, inline handlers such as
 * `onerror=` and injected `<script>` tags would not run.
 */
function csp(script: string): string {
  const hash = createHash('sha256').update(script, 'utf8').digest('base64');
  return `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'`;
}

/** Serialize for embedding inside <script>: compact numbers, no `</script>` breakouts. */
function embed(r: Report): string {
  const json = JSON.stringify(r, (k, v) => {
    if (typeof v === 'number' && !Number.isInteger(v)) return Math.round(v * 1e6) / 1e6;
    if (k === 'file' && typeof v === 'string') return undefined; // full paths of transcript files stay out of the report
    return v;
  });
  return json.replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#3987e5"/><rect x="5" y="7" width="22" height="4" rx="2" fill="#fff"/><rect x="5" y="13" width="14" height="4" rx="2" fill="#fff" opacity=".85"/><rect x="20" y="13" width="7" height="4" rx="2" fill="#fff" opacity=".6"/><rect x="5" y="19" width="8" height="4" rx="2" fill="#fff" opacity=".7"/><rect x="14" y="19" width="4" height="4" rx="2" fill="#fff" opacity=".5"/><rect x="5" y="25" width="4" height="2" rx="1" fill="#fff" opacity=".5"/></svg>`;

export function renderHtml(r: Report): string {
  const script = asset('report.js');
  const title = `tokenscope · ≈${usd(r.totals.avoidableCost)} could have been saved of ${usd(r.totals.cost)}`;
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp(script)}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${asset('report.css')}</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div class="logo">${LOGO}<span>tokenscope</span></div>
    <div class="meta" id="meta"></div>
    <div class="spacer"></div>
    <button id="theme" title="Toggle light/dark">◐ Theme</button>
  </header>

  <section class="kpis" id="kpis"></section>

  <section class="card">
    <div class="hd"><h2>Where the waste is</h2><span class="hint">estimated avoidable spend by pattern, with how to avoid it</span></div>
    <div id="waste-overview"></div>
  </section>

  <section class="card" id="flame-card">
    <div class="hd">
      <h2>Token spend flame graph</h2>
      <span class="hint">project → session → turn → API call → subagent · width = share of spend · click to zoom, Esc to zoom out</span>
      <div class="spacer"></div>
      <div class="seg" id="metric"><button data-m="v" aria-pressed="true">$ cost</button><button data-m="t" aria-pressed="false">tokens</button></div>
    </div>
    <div class="crumbs" id="crumbs"></div>
    <div id="flame"></div>
    <div class="legend" id="flame-legend" style="margin-top:12px"></div>
  </section>

  <div class="grid2 row">
    <section class="card">
      <div class="hd"><h2>Spend by project &amp; session</h2><span class="hint">area = cost · click a tile to open it</span></div>
      <div id="treemap"></div>
      <div class="legend" id="treemap-legend" style="margin-top:10px"></div>
    </section>
    <section class="card">
      <div class="hd"><h2>Daily spend</h2></div>
      <div id="daily"></div>
      <div class="hd" style="margin:16px 0 0"><h2>Where the money went</h2><span class="hint">by token type</span></div>
      <div id="mix"></div>
    </section>
  </div>

  <section class="card">
    <div class="hd"><h2>All waste findings</h2><span class="hint">estimates · click a row to see the session in the flame graph</span><div class="spacer"></div><div class="filters" id="waste-filters"></div></div>
    <div class="scroll" id="findings"></div>
  </section>

  <section class="card">
    <div class="hd"><h2>Sessions</h2><span class="hint">click a header to sort, a row to open it in the flame graph</span></div>
    <div class="scroll" id="sessions"></div>
  </section>

  <div class="grid2 row">
    <section class="card"><div class="hd"><h2>Models</h2></div><div id="models"></div></section>
    <section class="card"><div class="hd"><h2>Tools</h2><span class="hint">*cost of the API requests that issued the call</span></div><div id="tools"></div></section>
  </div>

  <footer>
    Generated by <a href="https://github.com/mintwork/tokenscope">tokenscope</a> v${escapeHtml(r.version)} · pricing table updated ${escapeHtml(r.pricingUpdated ?? 'n/a')} ·
    everything was computed locally - this file contains no data that left your machine.
  </footer>
</div>
<div class="tip" id="tip"></div>
<script id="ts-data" type="application/json">${embed(r)}</script>
<script>${script}</script>
</body>
</html>
`;
}
