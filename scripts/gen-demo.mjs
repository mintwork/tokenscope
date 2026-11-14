#!/usr/bin/env node
// Generates SYNTHETIC Claude Code session logs for demos and screenshots.
// Nothing here comes from real sessions. Usage: node scripts/gen-demo.mjs <outDir>
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const out = path.resolve(process.argv[2] ?? '.demo/projects');
rmSync(out, { recursive: true, force: true });

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => Math.floor(lo + rnd() * (hi - lo + 1));

const PROJECTS = [
  { name: 'checkout-service', files: ['src/cart.ts', 'src/payment/stripe.ts', 'src/routes.ts', 'test/cart.test.ts', 'package.json'] },
  { name: 'marketing-site', files: ['app/page.tsx', 'app/layout.tsx', 'components/Hero.tsx', 'tailwind.config.ts'] },
  { name: 'data-pipeline', files: ['etl/load.py', 'etl/transform.py', 'dags/daily.py', 'tests/test_transform.py'] },
  { name: 'mobile-app', files: ['src/screens/Home.tsx', 'src/api/client.ts', 'ios/Podfile', 'android/build.gradle'] },
  { name: 'infra', files: ['main.tf', 'modules/vpc/main.tf', 'k8s/deploy.yaml'] },
];
const TITLES = [
  'Fix flaky checkout test', 'Add Stripe webhook retries', 'Migrate to app router', 'Speed up nightly ETL',
  'Refactor API client', 'Add dark mode', 'Upgrade React Native', 'Terraform VPC peering', 'Investigate memory leak',
  'Write onboarding docs', 'Add rate limiting', 'Port tests to vitest', 'Tune Postgres indexes', 'Hero section redesign',
];
const PROMPTS = [
  'Look at the failing test and fix it', 'Can you explain how this module works?', 'Refactor this to remove the duplication',
  'Add tests for the edge cases', 'Why is this slow?', 'Ship it - open a PR', 'Now update the docs', 'Try a different approach',
];
const MODELS = ['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'];

let msg = 0;
function session(proj, dayOffset, opts) {
  const cwd = `/home/dev/${proj.name}`;
  const slug = cwd.replace(/\//g, '-');
  const id = `demo-${String(++msg).padStart(4, '0')}-${proj.name}`;
  const dir = path.join(out, slug);
  mkdirSync(dir, { recursive: true });
  const model = pick(MODELS);
  let t = Date.parse('2026-10-20T09:00:00Z') + dayOffset * 86400e3 + int(0, 8) * 3600e3;
  const lines = [];
  const base = (extra) => ({ cwd, sessionId: id, version: '2.0.0', gitBranch: 'main', userType: 'external', isSidechain: false, timestamp: new Date(t).toISOString(), ...extra });
  // long working sessions start with a big context (instructions, a codebase tour, earlier turns)
  let ctx = opts.ctx0 ? int(opts.ctx0[0], opts.ctx0[1]) : int(14000, 22000);
  let first = true;
  let lastCall = t; // the cache lives 5 minutes from its last use
  const turns = opts.turns;
  const subagents = [];
  for (let turn = 0; turn < turns; turn++) {
    // how long you took to read the answer and reply: usually a minute or two, sometimes 6-30 min
    // (reading a diff, testing by hand, a meeting), and now and then a break of over an hour
    if (turn > 0) t += (opts.breaks?.includes(turn) ? int(70, 180) : rnd() < opts.idleChance ? int(6, 30) : int(1, 4)) * 60e3;
    lines.push(base({ type: 'user', uuid: `u${msg}-${turn}`, message: { role: 'user', content: turn === 0 ? opts.title : pick(PROMPTS) } }));
    const steps = int(opts.steps[0], opts.steps[1]);
    for (let s = 0; s < steps; s++) {
      t += int(4, 40) * 1000;
      const id2 = `msg_${++msg}`;
      const tools = [];
      const r = rnd();
      const file = `${cwd}/${pick(proj.files)}`;
      if (opts.loop && turn === 1 && s >= 2 && s < 6) tools.push({ name: 'Bash', input: { command: 'npm test -- --run cart', description: 'Run tests' }, out: 1800, err: true });
      else if (opts.reread && s % 3 === 0) tools.push({ name: 'Read', input: { file_path: `${cwd}/${proj.files[0]}` }, out: 9000 });
      else if (r < 0.32) tools.push({ name: 'Bash', input: { command: pick(['npm test', 'git status', 'git diff', 'npm run build', 'ls -la src', 'pytest -q']) }, out: int(200, 6000), err: rnd() < 0.08 });
      else if (r < 0.52) tools.push({ name: 'Read', input: { file_path: file }, out: int(1500, 14000) });
      else if (r < 0.66) tools.push({ name: 'Edit', input: { file_path: file, old_string: 'a', new_string: 'b' }, out: 200 });
      else if (r < 0.74) tools.push({ name: 'Grep', input: { pattern: pick(['TODO', 'useEffect', 'retry', 'def load']), path: cwd }, out: int(300, 3000) });
      else if (r < 0.79) tools.push({ name: 'WebFetch', input: { url: pick(['https://docs.stripe.com/webhooks', 'https://react.dev/reference', 'https://registry.terraform.io']), prompt: 'summarize' }, out: int(3000, 9000) });
      else if (r < 0.83 && opts.agents && subagents.length < opts.agents) tools.push({ name: 'Agent', input: { description: pick(['Audit test coverage', 'Research API options', 'Review security of auth flow', 'Map module dependencies']), prompt: 'investigate', subagent_type: 'general-purpose' }, out: 1500, agent: true });
      else if (r < 0.86) tools.push({ name: 'Write', input: { file_path: file, content: 'x' }, out: 100 });
      if (opts.huge && turn === 0 && s === 1) tools.splice(0, 1, { name: 'Bash', input: { command: 'cat logs/server.log' }, out: 240000 });
      // a slow build / test suite the agent waits on in the foreground
      const slow = opts.slowTools?.find((x) => x.turn === turn && x.step === s);
      if (slow) tools.splice(0, tools.length, { name: 'Bash', input: { command: slow.command, description: 'Run it' }, out: int(2000, 5000), min: slow.min });
      // the cache misses when it expired (over 5 min since the last request), or when the prompt
      // prefix changed mid-session (opts.prefixChanges: [turn, step] pairs)
      const prefixChange = opts.prefixChanges?.some(([pt, ps]) => pt === turn && ps === s);
      const cacheMiss = first || t - lastCall > 5 * 60e3 || prefixChange;
      const grow = int(300, 2500);
      const usage = {
        input_tokens: int(1, 8),
        cache_creation_input_tokens: cacheMiss ? ctx : grow,
        cache_read_input_tokens: cacheMiss ? 0 : ctx,
        output_tokens: int(80, 1800),
        cache_creation: { ephemeral_5m_input_tokens: cacheMiss ? ctx : grow, ephemeral_1h_input_tokens: 0 },
      };
      first = false;
      lastCall = t;
      ctx += grow + Math.round(tools.reduce((n, x) => n + x.out, 0) / 4);
      const content = tools.length ? tools.map((x, i) => ({ type: 'tool_use', id: `${id2}_t${i}`, name: x.name, input: x.input })) : [{ type: 'text', text: 'Done.' }];
      lines.push(base({ type: 'assistant', uuid: `a${id2}`, requestId: `req_${id2}`, message: { id: id2, model, role: 'assistant', type: 'message', content, usage } }));
      tools.forEach((x, i) => {
        t += x.min ? x.min * 60e3 : 1000;
        const tuid = `${id2}_t${i}`;
        const entry = base({ type: 'user', uuid: `r${tuid}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tuid, content: (x.err ? 'FAIL cart.test.ts ' : tuid + ' ') + 'x'.repeat(x.out), is_error: !!x.err }] } });
        if (x.agent) {
          const agentId = `a${String(msg).padStart(6, '0')}demo`;
          entry.toolUseResult = { status: 'completed', agentId };
          subagents.push({ agentId, tuid, description: x.input.description, start: t - 900 });
        }
        lines.push(entry);
      });
    }
  }
  lines.push({ type: 'ai-title', aiTitle: opts.title, sessionId: id });
  writeFileSync(path.join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  for (const sa of subagents) {
    const sdir = path.join(dir, id, 'subagents');
    mkdirSync(sdir, { recursive: true });
    let st = sa.start;
    let sctx = int(9000, 14000);
    const sl = [{ type: 'user', isSidechain: true, agentId: sa.agentId, sessionId: id, cwd, timestamp: new Date(st).toISOString(), message: { role: 'user', content: sa.description } }];
    const n = int(6, 22);
    for (let i = 0; i < n; i++) {
      st += int(3, 15) * 1000;
      const mid = `msg_${++msg}`;
      const out = int(1000, 8000);
      sl.push({
        type: 'assistant', isSidechain: true, agentId: sa.agentId, sessionId: id, cwd, timestamp: new Date(st).toISOString(),
        message: { id: mid, model: 'claude-sonnet-5-5', role: 'assistant', content: [{ type: 'tool_use', id: `${mid}_t`, name: pick(['Read', 'Grep', 'Bash']), input: { file_path: `${cwd}/${pick(proj.files)}` } }],
          usage: { input_tokens: 3, cache_creation_input_tokens: i ? 900 : sctx, cache_read_input_tokens: i ? sctx : 0, output_tokens: int(100, 900), cache_creation: { ephemeral_5m_input_tokens: i ? 900 : sctx, ephemeral_1h_input_tokens: 0 } } },
      });
      sl.push({ type: 'user', isSidechain: true, agentId: sa.agentId, sessionId: id, cwd, timestamp: new Date(st + 500).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `${mid}_t`, content: mid + 'y'.repeat(out) }] } });
      sctx += 900 + out / 4;
    }
    writeFileSync(path.join(sdir, `agent-${sa.agentId}.jsonl`), sl.map((l) => JSON.stringify(l)).join('\n') + '\n');
    writeFileSync(path.join(sdir, `agent-${sa.agentId}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: sa.description, toolUseId: sa.tuid }));
  }
}

// A month of mostly interactive work. The two big sessions are long, with large contexts and frequent
// 6-30 min pauses before replying, which is where most real-world cache waste comes from.
const plan = [
  [0, 0, { turns: 6, steps: [8, 24], idleChance: 0.2, agents: 2, title: TITLES[0], loop: true }],
  [0, 2, { turns: 4, steps: [6, 16], idleChance: 0.1, agents: 1, title: TITLES[1] }],
  [1, 3, { turns: 5, steps: [5, 14], idleChance: 0.15, title: TITLES[2], reread: true }],
  [2, 4, { turns: 12, steps: [8, 18], idleChance: 0.65, ctx0: [150000, 180000], agents: 3, title: TITLES[3], huge: true, breaks: [7] }],
  [3, 6, { turns: 3, steps: [5, 12], idleChance: 0.1, title: TITLES[4] }],
  [1, 8, { turns: 3, steps: [4, 10], idleChance: 0.1, title: TITLES[5], prefixChanges: [[1, 2]] }],
  [3, 10, { turns: 6, steps: [8, 20], idleChance: 0.3, agents: 2, title: TITLES[6] }],
  [4, 11, { turns: 3, steps: [4, 10], idleChance: 0.1, title: TITLES[7] }],
  [0, 13, { turns: 10, steps: [8, 18], idleChance: 0.7, ctx0: [130000, 160000], agents: 2, title: TITLES[8], reread: true, breaks: [5],
    slowTools: [{ turn: 2, step: 3, command: 'npm run build', min: 9 }, { turn: 4, step: 2, command: 'npm run test:e2e', min: 12 }, { turn: 7, step: 4, command: 'npm run build', min: 8 }] }],
  [2, 15, { turns: 2, steps: [3, 8], idleChance: 0, title: TITLES[9] }],
  [0, 17, { turns: 4, steps: [6, 18], idleChance: 0.2, agents: 1, title: TITLES[10], loop: true }],
  [2, 19, { turns: 4, steps: [6, 16], idleChance: 0.2, title: TITLES[11] }],
  [4, 21, { turns: 3, steps: [4, 10], idleChance: 0.1, title: TITLES[12] }],
  [1, 23, { turns: 5, steps: [6, 16], idleChance: 0.15, agents: 1, title: TITLES[13] }],
];
for (const [p, day, opts] of plan) session(PROJECTS[p], day, opts);
console.error(`synthetic demo logs written to ${out}`);
