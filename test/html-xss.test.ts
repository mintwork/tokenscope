/**
 * The HTML report renders strings taken from agent logs (project names, prompts, tool names, file
 * paths). A crafted log must not be able to inject markup or break out of the embedded JSON.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildReport } from '../src/analyze/report.js';
import { claudeCodeParser } from '../src/parsers/claude-code.js';
import { Pricer } from '../src/pricing/index.js';
import { renderHtml } from '../src/render/html.js';

const PROJECT = `"><img src=x onerror="window.__xss=1">`;
const TITLE = `</script><script>window.__xss=2</script><!--`;
const TOOL = `<img src=x onerror=window.__xss=3>`;
const FILE = `/repo/'"><svg onload=window.__xss=4>.ts`;
const PROMPT = `<!--<script>window.__xss=5</script>--> ]]> \u2028 \u2029`;
const PAYLOADS = [PROJECT, TITLE, TOOL, FILE, PROMPT];

const tmp = mkdtempSync(path.join(os.tmpdir(), 'tokenscope-xss-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function hostileLog(): string {
  const base = { cwd: `/work/${PROJECT}`, sessionId: 'sess-xss', version: '9.9.9', userType: 'external' };
  const lines: object[] = [
    { ...base, type: 'ai-title', aiTitle: TITLE },
    { ...base, type: 'user', uuid: 'p-1', timestamp: '2026-11-03T09:00:00.000Z', message: { role: 'user', content: PROMPT } },
  ];
  // Repeated identical calls of a hostile-named tool, and re-reads of a hostile path: both produce
  // waste findings whose title/detail/tip quote the log strings.
  for (let i = 0; i < 4; i++) {
    for (const [name, input] of [[TOOL, { file_path: FILE }], ['Read', { file_path: FILE }]] as const) {
      const id = `${name === 'Read' ? 'r' : 't'}${i}`;
      lines.push({
        ...base, type: 'assistant', uuid: `a-${id}`, requestId: `req-${id}`, timestamp: `2026-11-03T09:0${i}:0${name === 'Read' ? 5 : 1}.000Z`,
        message: {
          model: 'claude-sonnet-4-5', id: `msg-${id}`, type: 'message', role: 'assistant', stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: `tu-${id}`, name, input }],
          usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000, output_tokens: 50 },
        },
      });
      lines.push({
        ...base, type: 'user', uuid: `u-${id}`, timestamp: `2026-11-03T09:0${i}:0${name === 'Read' ? 6 : 2}.000Z`,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-${id}`, content: `same output ${PROMPT}`.repeat(50) }] },
      });
    }
  }
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

async function hostileReport() {
  const dir = path.join(tmp, 'projects', '-work-hostile');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'sess-xss.jsonl'), hostileLog());
  const report = buildReport(await claudeCodeParser.load(path.join(tmp, 'projects')), new Pricer(), { version: '<b>v</b>' });
  return { report, html: renderHtml(report) };
}

const DATA = /<script id="ts-data" type="application\/json">([\s\S]*?)<\/script>/;

describe('HTML report with hostile log content', async () => {
  const { report, html } = await hostileReport();
  const blob = JSON.stringify(report);

  it('actually carries the payloads into the report data', () => {
    for (const p of [PROJECT, TITLE, TOOL]) expect(blob).toContain(JSON.stringify(p).slice(1, -1));
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.byTool.map((t) => t.name)).toContain(TOOL);
  });

  it('embeds the data so it cannot close the <script> or open a comment', () => {
    const json = html.match(DATA)![1]!;
    expect(json).not.toContain('<'); // covers </script>, <!--, <script
    expect(json).not.toMatch(/[\u2028\u2029]/);
    const parsed = JSON.parse(json);
    expect(parsed.byTool.map((t: { name: string }) => t.name)).toContain(TOOL);
    expect(parsed.sessions[0].title).toBe(TITLE);
  });

  it('has no markup from the payloads anywhere in the HTML source', () => {
    expect(html.match(/<script\b/g)).toHaveLength(2); // the JSON data block and the bundled client
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    // Outside the JSON block (where `<` is \u003c), not even the attribute text of a payload appears.
    const page = html.replace(DATA, '');
    for (const bad of ['<img', '<b>v</b>', '<!--<script', 'onerror', 'onload', '__xss']) expect(page).not.toContain(bad);
    expect(html).toContain('v&lt;b&gt;v&lt;/b&gt;'); // server-side footer value is escaped
  });

  it('pins the bundled script with a CSP hash and allows nothing else', () => {
    const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)![1]!;
    expect(csp).toMatch(/default-src 'none'/);
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'(;|$)/);
    expect(csp).not.toMatch(/unsafe-inline'[^;]*script|script-src[^;]*unsafe/);
    // The hash must match the script as the browser sees it: LF line endings (HTML parsing turns CRLF into LF).
    const start = html.lastIndexOf('<script>') + '<script>'.length;
    const client = html.slice(start, html.indexOf('</script>', start));
    expect(client).not.toContain('\r');
    expect(csp).toContain(`'sha256-${createHash('sha256').update(client).digest('base64')}'`);
  });

  it('renders the payloads as text in a real browser (Chrome)', async (ctx) => {
    let chromium: typeof import('playwright-core').chromium;
    let browser: import('playwright-core').Browser;
    try {
      ({ chromium } = await import('playwright-core'));
      browser = await chromium.launch({ channel: 'chrome' });
    } catch (e) {
      console.warn(`[browser check skipped] ${(e as Error).message.split('\n')[0]}`);
      return ctx.skip();
    }
    try {
      const file = path.join(tmp, 'report.html');
      writeFileSync(file, html);
      const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
      const errors: string[] = [];
      const dialogs: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      page.on('dialog', (d) => (dialogs.push(d.message()), d.dismiss()));
      await page.goto(pathToFileURL(file).href);
      expect(errors).toEqual([]); // e.g. a CSP hash mismatch would block the client here
      await page.waitForSelector('#flame .n', { timeout: 5000 });
      // Exercise every sink: hover each flame/treemap/daily element (tooltips), switch filters and sort.
      for (const sel of ['#flame .n', '#treemap .tm', '#daily .hit']) {
        for (const h of await page.$$(sel)) await h.dispatchEvent('mousemove', { clientX: 10, clientY: 10, bubbles: true });
      }
      // Buttons and headers are re-rendered on click, so look each one up again.
      for (const sel of ['#waste-filters button', '#sessions th']) {
        const n = (await page.$$(sel)).length;
        for (let i = 0; i < n; i++) await page.locator(sel).nth(i).click();
      }
      await page.click('#flame .n');
      await page.click('#metric button[data-m="t"]');
      const state = await page.evaluate(() => ({
        xss: (window as unknown as { __xss?: number }).__xss ?? null,
        injected: [...document.querySelectorAll('img, [onerror], [onload], script:not(#ts-data)')].map((e) => e.outerHTML.slice(0, 80)),
        scripts: document.scripts.length,
        text: document.body.textContent ?? '',
        tip: document.getElementById('tip')!.textContent ?? '',
        kpis: document.querySelectorAll('#kpis .kpi').length,
      }));
      expect(errors).toEqual([]); // the client ran (CSP hash matches) and nothing broke
      expect(dialogs).toEqual([]);
      expect(state.xss).toBeNull();
      expect(state.injected).toHaveLength(1); // only the bundled client script
      expect(state.injected[0]!.startsWith('<script>')).toBe(true);
      expect(state.scripts).toBe(2);
      expect(state.kpis).toBeGreaterThan(0);
      expect(state.text).toContain(TOOL); // shown literally, as text
      expect(state.text).toContain(path.basename(`/work/${PROJECT}`));
    } finally {
      await browser.close();
    }
  }, 60_000);
});
