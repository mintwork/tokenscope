# Contributing to tokenscope

Thanks for helping. Bug reports, new parsers, pricing updates and new waste detectors are all welcome.

## Ground rules

- **Never commit real session logs** or reports made from them. They contain prompts, source code, file paths and
  sometimes secrets. Tests and demos use synthetic data only (`test/fixtures/`, `scripts/gen-demo.mjs`).
  If you need a real log's *shape*, describe the field names in your PR, not the content.
- Keep **zero runtime dependencies**. Node built-ins only. Dev dependencies are fine.
- Node 20+ and TypeScript `strict`.

## Setup

```bash
npm install
npm test         # vitest
npm run build    # tsc + copy assets into dist/
npm run smoke    # CLI against fixtures
npm run demo     # synthetic demo -> docs/demo-report.html
```

## Layout

```
src/
  cli.ts                 argument parsing + orchestration
  types.ts               normalized Session / Turn / ApiCall / ToolCall model
  parsers/               one file per agent; implement the Parser interface
  pricing/pricing.json   the price table (USD per 1M tokens)
  analyze/report.ts      aggregation + flame-graph tree
  analyze/waste.ts       waste detectors
  render/                terminal, JSON, HTML (assets/report.{css,js} are inlined into the HTML)
```

## Adding a parser (Cursor, Aider, Gemini CLI, ...)

1. Create `src/parsers/<agent>.ts` exporting a `Parser` (`id`, `name`, `defaultDir()`, `load(dir)`).
2. Map the agent's logs to `Session → Turn → ApiCall → ToolCall`. Key points:
   - `Usage.input` is **uncached** input. If the provider reports input including cached tokens (OpenAI does), subtract them.
   - Set `ToolCall.file`/`fileOp` for file reads and edits so the re-read detector works (see `fileAccess()` in `util.ts`).
   - Set `resultChars` and `resultHash` when tool output is available.
   - Deduplicate streamed or duplicated responses.
3. Add the id to `SourceId` in `types.ts` and register the parser in `src/parsers/index.ts`.
4. Add a **synthetic** fixture under `test/fixtures/<agent>/` and tests in `test/parsers.test.ts`.

## Updating prices

Edit `src/pricing/pricing.json`, bump `updated`, and cite the source (pricing page URL) in the PR description.
Omit `cacheRead` / `cacheWrite*` when they follow the default multipliers.

## Adding a waste detector

Detectors live in `src/analyze/waste.ts` and run per *context* (a session or a subagent). Each finding needs a
conservative token estimate and a dollar estimate. Prefer fewer, higher-confidence findings over noise, and add a
fixture-driven test.

## Pull requests

- `npm run typecheck && npm test` must pass.
- Keep PRs focused, and include a screenshot when you change the HTML report.
