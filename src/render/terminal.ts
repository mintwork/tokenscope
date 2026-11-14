import type { Report, SessionSummary } from '../analyze/report.js';
import type { Severity } from '../analyze/waste.js';
import { dateShort, pct, tok, usd } from './format.js';

export interface TermOptions {
  color: boolean;
  width: number;
  top: number;
}

type Paint = (s: string) => string;

function palette(on: boolean) {
  const c = (code: string): Paint => (on ? (s) => `\x1b[${code}m${s}\x1b[0m` : (s) => s);
  return {
    bold: c('1'),
    dim: c('2'),
    blue: c('38;5;75'),
    orange: c('38;5;209'),
    aqua: c('38;5;43'),
    yellow: c('38;5;214'),
    violet: c('38;5;141'),
    red: c('38;5;203'),
    green: c('38;5;78'),
    inverse: c('7'),
  };
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const vis = (s: string) => s.replace(ANSI, '').length;
const padR = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - vis(s)));
const padL = (s: string, n: number) => ' '.repeat(Math.max(0, n - vis(s))) + s;
const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s);

function wrap(text: string, width: number, maxLines = 3): string[] {
  const out: string[] = [];
  let cur = '';
  for (const w of text.split(/\s+/)) {
    if (cur && (cur + ' ' + w).length > width) {
      out.push(cur);
      cur = w;
    } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) out.push(cur);
  if (out.length > maxLines) {
    out.length = maxLines;
    out[maxLines - 1] = trunc(out[maxLines - 1] + ' …', width);
  }
  return out;
}

function bar(frac: number, width: number): string {
  const blocks = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
  const total = Math.max(0, Math.min(1, frac)) * width;
  const full = Math.floor(total);
  const rest = blocks[Math.round((total - full) * 7)] ?? '';
  return '█'.repeat(full) + rest;
}

export function renderTerminal(r: Report, o: TermOptions): string {
  const p = palette(o.color);
  const W = Math.max(60, Math.min(o.width, 110));
  const out: string[] = [];
  const line = (s = '') => out.push(s);
  const h = (title: string, right = '') => {
    line();
    line(p.bold(title) + (right ? '  ' + p.dim(right) : ''));
  };

  const t = r.totals;
  const srcName = r.coverage.map((c) => c.name).join(' + ') || r.sources.join(' + ');
  line();
  line(`${p.inverse(p.bold(' tokenscope '))}  ${p.dim(`${srcName} · ${dateShort(r.range.start)} → ${dateShort(r.range.end)}`)}`);
  line();

  // ===== WASTE FIRST =====
  const sevPaint: Record<Severity, Paint> = { high: p.red, medium: p.yellow, low: p.dim };
  const kinds: Record<string, string> = { loop: 'LOOP', repeat: 'REPEAT', reread: 'RE-READ', 'huge-output': 'HUGE OUT', 'cache-miss': 'CACHE' };
  const anyChecked = t.uncheckedSessions < t.sessions;
  if (!anyChecked) {
    line(p.yellow(`Waste could not be estimated: these logs don't record the data the detectors need (see "Waste checks" below).`));
  } else if (r.findings.length) {
    const share = t.cost ? ` of ${usd(t.cost)} spent (${pct(t.avoidableCost / t.cost, 1)})` : '';
    line(`${p.bold(p.orange(`≈ ${usd(t.avoidableCost)}`))} ${p.bold('could have been saved')}${p.dim(share)}`);
    line(p.dim(`  realistic savings only: repeated work + the net gain of a 1-hour cache TTL · estimates`));
    if (t.likelyAvoidableCost >= 0.01) line(p.dim(`  + up to ${usd(t.likelyAvoidableCost)} more, likely avoidable (mid-session prompt changes, model switches, huge outputs)`));
  } else {
    line(p.green(`No waste patterns found in ${usd(t.cost)} of spend. Nice.`));
  }
  const ttlSaved = r.findings.filter((f) => f.cause === 'pause' || f.cause === 'tool-wait').reduce((n, f) => n + f.cost, 0);
  // long notes wrap at the terminal width, continuation lines indented
  const note = (text: string) => wrap(text, W - 4, 4).forEach((l, i) => line(p.dim(`  ${i ? '  ' : ''}${l}`)));
  if (ttlSaved > 0)
    note(`1-hour cache TTL: ${usd(ttlSaved)} net in the sessions that would gain; turned on everywhere it nets ${t.ttlGlobalNet >= 0 ? usd(t.ttlGlobalNet) : '-' + usd(-t.ttlGlobalNet)} (the 1h write premium applies to every session)`);
  if (t.unavoidableRebuilds)
    note(`not counted: ${t.unavoidableRebuilds} cache rebuild${t.unavoidableRebuilds > 1 ? 's' : ''} after breaks over an hour (${usd(t.unavoidableRebuildCost)}) - no cache lives that long; a fresh session helps only if you start an unrelated task`);
  if (anyChecked && t.partiallyCheckedSessions)
    note(`${t.partiallyCheckedSessions} of ${t.sessions} sessions could only be partly checked (missing data, see below) - real waste may be higher.`);

  if (r.findings.length) {
    const counts = new Map<string, { n: number; cost: number }>();
    for (const f of r.findings) {
      const c = counts.get(f.kind) ?? { n: 0, cost: 0 };
      c.n++;
      c.cost += f.cost;
      counts.set(f.kind, c);
    }
    line();
    line(
      '  ' +
        [...counts.entries()]
          .sort((a, b) => b[1].cost - a[1].cost)
          .map(([k, c]) => `${p.bold(kinds[k] ?? k)} ${c.n} ${p.dim(usd(c.cost))}`)
          .join(p.dim('  ·  ')),
    );
    h('Top waste', 'est. cost');
    for (const f of r.findings.slice(0, o.top)) {
      const tag = sevPaint[f.severity](padR('● ' + (kinds[f.kind] ?? f.kind), 10));
      const likely = f.certainty === 'likely-avoidable' ? p.dim(' (likely)') : '';
      line(`  ${tag} ${padL(usd(f.cost), 9)}${likely}  ${trunc(f.title, W - 26 - (likely ? 9 : 0))}`);
      line(p.dim(`  ${' '.repeat(21)}${trunc(f.project + ' · ' + f.detail, W - 23)}`));
      wrap(f.tip, W - 25).forEach((l, i) => line(`  ${' '.repeat(21)}${i ? '  ' : p.aqua('↳ ')}${l}`));
    }
    if (r.findings.length > o.top) line(p.dim(`  … ${r.findings.length - o.top} more findings in --html / --json`));
  }

  // which detectors could run, per agent
  h('Waste checks', 'per agent - a detector only runs when the logs contain the data it needs');
  const short: Record<string, string> = { 'cache-miss': 'cache', loop: 'loops', repeat: 'repeats', reread: 're-reads', 'huge-output': 'huge outputs' };
  for (const c of r.coverage) {
    const marks = c.detectors
      .map((d) => (d.status === 'yes' ? p.green('✓ ') : d.status === 'partial' ? p.yellow('◐ ') : p.red('✗ ')) + short[d.kind])
      .join('  ');
    line(`  ${padR(trunc(c.name, 16), 16)} ${marks}${c.verified ? '' : p.dim('  [experimental parser]')}`);
    const missing = [...new Set(c.detectors.filter((d) => d.status !== 'yes').flatMap((d) => d.missing))];
    const allNo = c.detectors.filter((d) => d.status !== 'yes').every((d) => d.status === 'no');
    if (missing.length) line(p.dim(`  ${' '.repeat(17)}${allNo ? "logs don't record" : "some sessions' logs don't record"}: ${missing.join(', ')}`));
  }

  // ===== THEN SPEND =====
  h('Spend');
  const kpi = (label: string, value: string) => `${p.dim(label)} ${p.bold(value)}`;
  const kpis = [
    kpi('total', p.green(usd(t.cost))),
    kpi('tokens', tok(t.tokens)),
    kpi('sessions', String(t.sessions) + (t.subagents ? p.dim(` +${t.subagents} subagents`) : '')),
    kpi('API calls', t.calls.toLocaleString('en-US')),
    kpi('cache hit', pct(t.cacheHitRate)),
  ];
  const wide = '  ' + kpis.join(p.dim('  │  '));
  line(vis(wide) <= W ? wide : '  ' + kpis.join(p.dim(' │ ')));
  if (t.costWithoutCache > t.cost)
    line(p.dim(`  prompt caching saved you ${usd(t.costWithoutCache - t.cost)} (would have been ${usd(t.costWithoutCache)})`));

  // --- spend by token type ---
  h('Where the money went', 'by token type');
  const types: Array<[string, number, number, Paint]> = [
    ['input', r.costByType.input, t.usage.input, p.blue],
    ['cache write', r.costByType.cacheWrite, t.usage.cacheWrite5m + t.usage.cacheWrite1h, p.orange],
    ['cache read', r.costByType.cacheRead, t.usage.cacheRead, p.aqua],
    ['output', r.costByType.output, t.usage.output, p.violet],
  ];
  const typeMax = Math.max(...types.map((x) => x[1]), 1e-9);
  const barW = Math.max(10, W - 50);
  for (const [name, c, n, paint] of types) {
    line(`  ${padR(name, 12)} ${padR(paint(bar(c / typeMax, barW)), barW)} ${padL(usd(c), 10)} ${padL(pct(t.cost ? c / t.cost : 0, 0), 4)} ${p.dim(padL(tok(n), 7) + ' tok')}`);
  }

  // --- by project ---
  if (r.byProject.length) {
    h('By project');
    const max = r.byProject[0].cost || 1e-9;
    const nameW = Math.min(24, Math.max(...r.byProject.slice(0, o.top).map((b) => b.name.length)));
    const bw = Math.max(10, W - nameW - 36);
    for (const b of r.byProject.slice(0, o.top))
      line(`  ${padR(trunc(b.name, nameW), nameW)} ${padR(p.blue(bar(b.cost / max, bw)), bw)} ${padL(usd(b.cost), 10)}  ${p.dim(`${b.sessions ?? 0} sess`)}`);
    if (r.byProject.length > o.top) line(p.dim(`  … ${r.byProject.length - o.top} more`));
  }

  // --- by model ---
  if (r.byModel.length) {
    h('By model');
    for (const b of r.byModel.slice(0, o.top))
      line(`  ${padR(trunc(b.name, 28), 28)} ${padL(usd(b.cost), 10)}  ${p.dim(`${padL(b.calls.toLocaleString('en-US'), 7)} calls · ${tok(b.usage.output)} out`)}`);
  }

  // --- top sessions ---
  if (r.sessions.length) {
    h('Most expensive sessions');
    // fixed columns take 53 chars; leave room for the "  $0.74 in 3 subagents" suffix so rows fit the width
    const subLabel = (s: SessionSummary) => (s.subagentCost > 0 ? `  ${usd(s.subagentCost)} in ${s.subagents} subagent${s.subagents === 1 ? '' : 's'}` : '');
    const subW = Math.max(0, ...r.sessions.slice(0, o.top).map((s) => subLabel(s).length));
    const titleW = Math.max(16, W - 53 - subW);
    line(p.dim(`  ${padL('cost', 10)}  ${padR('date', 7)} ${padR('project', 16)} ${padR('session', titleW)} ${padL('calls', 6)} ${padL('cache', 6)}`));
    for (const s of r.sessions.slice(0, o.top)) {
      const label = s.title ?? s.id.slice(0, 8);
      line(
        `  ${padL(p.bold(usd(s.cost)), 10)}  ${padR(dateShort(s.start), 7)} ${padR(trunc(s.project, 16), 16)} ${padR(trunc(label, titleW), titleW)} ${padL(String(s.calls), 6)} ${padL(pct(s.cacheHitRate, 0), 6)}` +
          (s.subagentCost > 0 ? p.dim(subLabel(s)) : ''),
      );
    }
  }

  // --- tools ---
  if (r.byTool.length) {
    h('Tools', 'cost = API requests that issued the call');
    line(p.dim(`  ${padR('tool', 22)} ${padL('calls', 7)} ${padL('errors', 7)} ${padL('output', 9)} ${padL('cost', 10)}`));
    for (const x of r.byTool.slice(0, o.top))
      line(`  ${padR(trunc(x.name, 22), 22)} ${padL(x.calls.toLocaleString('en-US'), 7)} ${padL(x.errors ? p.red(String(x.errors)) : p.dim('0'), 7)} ${padL(tok(x.resultTokens), 9)} ${padL(usd(x.cost), 10)}`);
  }

  if (r.reportedModels.length) {
    line();
    line(p.dim(`ℹ Priced from the agent's own recorded cost (not in our table): ${r.reportedModels.join(', ')}`));
  }
  if (r.unknownModels.length) {
    line();
    line(p.yellow(`⚠ No pricing for: ${r.unknownModels.join(', ')} - their spend is NOT included (counted as $0). Add them to pricing.json or pass --pricing.`));
  }
  if (r.pricingSource === 'feed') {
    line();
    line(p.dim(`ℹ Prices from the published table of ${r.pricingUpdated} (cached by --update-pricing; --no-pricing-cache to use the built-in one)`));
  }
  line();
  line(p.dim(`→ ${p.bold('tokenscope --html')} for the interactive flame graph · ${p.bold('--json')} for raw data · ${p.bold('--help')} for filters`));
  line();
  return out.join('\n');
}
