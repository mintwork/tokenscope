#!/usr/bin/env node
// Screenshots the SYNTHETIC demo HTML report (docs/demo-report.html, from `npm run demo`) into docs/demo.png.
// Usage: npm run demo:png   (needs Google Chrome)
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const report = path.join(root, 'docs/demo-report.html');
const out = path.resolve(process.argv[2] ?? path.join(root, 'docs/demo.png'));
if (!existsSync(report)) throw new Error('docs/demo-report.html not found - run `npm run demo` first');

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1400, height: 1300 }, deviceScaleFactor: 2, colorScheme: 'dark' });
await page.goto(pathToFileURL(report).href);
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300); // let the flame graph lay out
// KPIs, waste by pattern, per-agent checks and the top of the flame graph
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1400, height: 1300 } });
await browser.close();
console.log(`wrote ${path.relative(process.cwd(), out)}: ${(statSync(out).size / 1024).toFixed(0)} KB`);
