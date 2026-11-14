import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { claudeCodeParser } from '../src/parsers/claude-code.js';
import { codexParser } from '../src/parsers/codex.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE = path.join(here, 'fixtures/claude/projects');
const CODEX = path.join(here, 'fixtures/codex/sessions/2026/11');

describe('claude-code parser', async () => {
  const sessions = await claudeCodeParser.load(CLAUDE);
  const alpha = sessions.find((s) => s.id === 'sess-alpha')!;
  const beta = sessions.find((s) => s.id === 'sess-beta')!;

  it('finds both sessions and no orphan subagents', () => {
    expect(sessions.map((s) => s.id).sort()).toEqual(['sess-alpha', 'sess-beta']);
  });

  it('reads project, title and turns', () => {
    expect(alpha.project).toBe('acme-api');
    expect(alpha.projectPath).toBe('/Users/demo/acme-api');
    expect(alpha.title).toBe('Add API rate limiting');
    expect(alpha.turns.map((t) => t.prompt)).toEqual(['Add rate limiting to the API', 'Now add tests for the limiter']);
    expect(beta.title).toBe('Review web app');
    expect(beta.turns[0].prompt).toBe('/review');
  });

  it('dedupes streamed chunks and keeps the final usage', () => {
    const calls = alpha.turns.flatMap((t) => t.calls);
    expect(calls).toHaveLength(8);
    expect(calls[0].usage).toMatchObject({ input: 10, cacheWrite5m: 20000, output: 350 });
    expect(calls[0].toolCalls[0]).toMatchObject({ name: 'Read', file: '/Users/demo/acme-api/src/server.ts', fileOp: 'read', resultChars: 4000 });
  });

  it('skips <synthetic> error messages', () => {
    expect(alpha.turns.flatMap((t) => t.calls).some((c) => c.model === '<synthetic>')).toBe(false);
  });

  it('records tool errors', () => {
    const bash = alpha.turns.flatMap((t) => t.calls).flatMap((c) => c.toolCalls).filter((t) => t.name === 'Bash');
    expect(bash).toHaveLength(3);
    expect(bash.every((b) => b.isError)).toBe(true);
  });

  it('attaches subagents to the Agent tool call that spawned them', () => {
    const agent = alpha.turns.flatMap((t) => t.calls).flatMap((c) => c.toolCalls).find((t) => t.name === 'Agent')!;
    expect(agent.subagent).toBeDefined();
    expect(agent.subagent!.isSubagent).toBe(true);
    expect(agent.subagent!.agentDescription).toBe('Audit middleware');
    expect(agent.subagent!.turns.flatMap((t) => t.calls)).toHaveLength(2);
  });

  it('drops API calls duplicated from an earlier session (resume/fork)', () => {
    const ids = beta.turns.flatMap((t) => t.calls).map((c) => c.id);
    expect(ids).toEqual(['b_1', 'b_2', 'b_3']);
  });

  it('tolerates truncated trailing lines', () => {
    expect(alpha.turns.length).toBe(2);
  });
});

describe('codex parser (experimental)', async () => {
  const [s] = await codexParser.load(CODEX);

  it('reads the session meta and model', () => {
    expect(s.id).toBe('cdx-0001');
    expect(s.project).toBe('ml-pipeline');
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0].prompt).toBe('Why is the training job slow?');
  });

  it('turns token_count events into API calls, skipping duplicates', () => {
    const calls = s.turns[0].calls;
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.model === 'gpt-5-codex')).toBe(true);
    // OpenAI input includes cached tokens
    expect(calls[1].usage).toMatchObject({ input: 2500, cacheRead: 12000, output: 150, reasoning: 50 });
  });

  it('attributes function calls to the request that issued them', () => {
    const [a, b, c] = s.turns[0].calls;
    expect(a.toolCalls.map((t) => t.target)).toEqual(['cat train.py']);
    expect(a.toolCalls[0]).toMatchObject({ file: 'train.py', fileOp: 'read', resultChars: 2000, isError: false });
    expect(b.toolCalls[0].isError).toBe(true);
    expect(c.toolCalls).toHaveLength(0);
  });
});
