import type { DiffReport, DiffRow } from '../analyze/diff.js';
import { dateShort, pct, usd } from './format.js';

export interface DiffTermOptions {
  color: boolean;
  width: number;
  top: number;
}

// eslint-disable-next-line no-control-regex
const vis = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
const padR = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - vis(s)));
const padL = (s: string, n: number) => ' '.repeat(Math.max(0, n - vis(s))) + s;
const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s);

/** "+$1.20" / "-$0.40" / "$0.00" */
const signed = (n: number) => (Math.abs(n) < 0.005 ? '$0.00' : (n > 0 ? '+' : '-') + usd(Math.abs(n)));
const change = (b: number, a: number) => (b > 0.005 ? ` ${a >= b ? '+' : '-'}${Math.round((Math.abs(a - b) / b) * 100)}%` : a > 0.005 ? ' new' : '');

export function renderDiffTerminal(d: DiffReport, o: DiffTermOptions): string {
  const c = (code: string) => (s: string) => (o.color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const bold = c('1');
  const dim = c('2');
  const red = c('38;5;203');
  const green = c('38;5;78');
  const inverse = c('7');
  const W = Math.max(60, Math.min(o.width, 110));
  const labelW = Math.max(20, W - 2 - 3 * 12 - 8);
  const out: string[] = [];
  const line = (s = '') => out.push(s);
  // more waste is bad (red), less is good (green)
  const tint = (n: number, s: string) => (n > 0.005 ? red(s) : n < -0.005 ? green(s) : dim(s));
  const head = (title: string, a = 'before', b = 'after') => {
    line();
    line(`${bold(padR(title, labelW))}${dim(padL(a, 12) + padL(b, 12) + padL('change', 12))}`);
  };
  const row = (label: string, b: string, a: string, delta: string, extra = '') => line(`  ${padR(trunc(label, labelW - 2), labelW - 2)}${padL(b, 12)}${padL(a, 12)}${padL(delta, 12)}${extra}`);

  const B = d.before;
  const A = d.after;
  line();
  line(`${inverse(bold(' tokenscope diff '))}  ${dim(`${dateShort(B.start)} → ${dateShort(B.end)}  vs  ${dateShort(A.start)} → ${dateShort(A.end)}`)}`);

  head('Overview');
  row('spend', usd(B.cost), usd(A.cost), signed(A.cost - B.cost), dim(change(B.cost, A.cost)));
  const dw = A.avoidableCost - B.avoidableCost;
  row('could have been saved', usd(B.avoidableCost), usd(A.avoidableCost), tint(dw, signed(dw)), dim(change(B.avoidableCost, A.avoidableCost)));
  const ds = (A.wasteShare - B.wasteShare) * 100;
  row('  share of spend', pct(B.wasteShare), pct(A.wasteShare), tint(ds / 100, (ds >= 0 ? '+' : '') + ds.toFixed(1) + ' pts'));
  const dl = A.likelyAvoidableCost - B.likelyAvoidableCost;
  row('likely avoidable', usd(B.likelyAvoidableCost), usd(A.likelyAvoidableCost), tint(dl, signed(dl)));
  const dh = (A.cacheHitRate - B.cacheHitRate) * 100;
  row('cache hit rate', pct(B.cacheHitRate), pct(A.cacheHitRate), tint(-dh / 100, (dh >= 0 ? '+' : '') + dh.toFixed(1) + ' pts'));
  row('sessions', String(B.sessions), String(A.sessions), (A.sessions - B.sessions >= 0 ? '+' : '') + (A.sessions - B.sessions));
  row('API calls', B.calls.toLocaleString('en-US'), A.calls.toLocaleString('en-US'), (A.calls - B.calls >= 0 ? '+' : '') + (A.calls - B.calls).toLocaleString('en-US'));

  if (d.byPattern.length) {
    head('Waste by pattern');
    for (const r of d.byPattern.filter((x) => x.before >= 0.005 || x.after >= 0.005).slice(0, o.top))
      row(r.label + (r.certainty === 'likely-avoidable' ? ' (likely)' : ''), `${usd(r.before)} ${dim('×' + r.beforeCount)}`, `${usd(r.after)} ${dim('×' + r.afterCount)}`, tint(r.delta, signed(r.delta)));
    if (d.byPattern.length > o.top) line(dim(`  … ${d.byPattern.length - o.top} more in --json`));
  }

  const projects = (list: DiffRow[], title: string) => {
    if (!list.length) return;
    head(title + ' (avoidable waste)');
    for (const r of list.slice(0, Math.min(5, o.top))) row(r.label, usd(r.before), usd(r.after), tint(r.delta, signed(r.delta)));
  };
  projects(d.byProject.filter((r) => r.delta > 0.005), 'Got more wasteful');
  projects(d.byProject.filter((r) => r.delta < -0.005).reverse(), 'Improved');

  const models = d.byModel.filter((r) => Math.abs(r.delta) > 0.005).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  if (models.length) {
    head('Spend by model');
    for (const r of models.slice(0, o.top)) row(r.label, usd(r.before), usd(r.after), signed(r.delta), dim(change(r.before, r.after)));
  }
  line();
  line(dim(`  waste = estimated avoidable spend in each range (same detectors and prices) · --json for the full diff`));
  line();
  return out.join('\n');
}
