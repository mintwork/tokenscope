# Contributing to tokenscope

Thanks for helping. Bug reports, new parsers, pricing updates and new waste detectors are all welcome.

## Ground rules

- **Never commit real session logs** or reports made from them. They contain prompts, source code, file paths and
  sometimes secrets. Tests and demos use synthetic data only (`test/fixtures/`, `scripts/gen-demo.mjs`).
  If you need a real log's *shape*, describe the field names in your PR, not the content.
- Keep **zero runtime dependencies**. Node built-ins only. Dev dependencies are fine.
- Node 22+ and TypeScript `strict`.

## Setup

```bash
npm install
npm test         # vitest
npm run build    # tsc + copy assets into dist/
npm run smoke    # CLI against fixtures
npm run demo     # synthetic demo -> docs/demo-report.html
npm run demo:visuals  # re-render docs/demo.png + docs/demo.gif (Google Chrome + ffmpeg)
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

## Adding a parser (Cursor, Aider, Goose, ...)

1. Create `src/parsers/<agent>.ts` exporting a `Parser`: `id`, `name`, `verified: false`, `caps`, `defaultDirs()` (every candidate location on macOS/Linux/Windows; use the helpers in `src/paths.ts`) and `load(dir, opts)`.
2. Map the logs to `Session → Turn → ApiCall → ToolCall` with the helpers in `parsers/common.ts`. Key points:
   - `Usage.input` is **uncached** input. If the agent reports input including cached tokens (OpenAI, Gemini, Roo, Copilot), subtract them. `Usage.output` includes reasoning/thinking tokens.
   - Set `reportedCost` when the agent records its own cost; it is used when the model isn't in our pricing table.
   - Use `newToolCall()` so file reads/edits are classified (`fileAccess()` in `util.ts`), and `setResult()` when tool output is available.
   - Deduplicate streamed, rewritten, forked or migrated records.
3. **Declare capabilities honestly** (`Capabilities` in `types.ts`): per-request tokens, cache reads/writes, tool calls, tool output, file paths, timestamps. Waste detectors only run when the data they need exists, and the report shows which checks ran per agent. Missing data must never show up as "$0 waste". If you're unsure whether a format records tool calls, pass `toolSeen(s)` to `finish()` so sessions without tool data are reported as unchecked.
4. Add the id to `SourceId` in `types.ts`, register the parser in `src/parsers/index.ts`, and add its project-instructions file to `MEMORY_FILE` in `analyze/waste.ts` (used in tips).
5. Add a **synthetic** fixture under `test/fixtures/<agent>/` that matches the real format as closely as you can verify, plus tests in `test/agents.test.ts`. Cite your sources (agent source files, docs) in the parser's header comment.
6. Mark it `verified: true` only after it has been checked against real logs.

If you adapt logic from another project, check its license and credit it in [NOTICE](NOTICE).

## Updating prices

Edit `src/pricing/pricing.json`, bump `updated`, and update the provider's entry in `sources` (pricing page URL + date).
Omit `cacheRead` / `cacheWrite*` when they follow the default multipliers.

## Adding a waste detector

Detectors live in `src/analyze/waste.ts` and run per *context* (a session or a subagent). Each finding needs a
conservative token estimate and a dollar estimate. Prefer fewer, higher-confidence findings over noise, and add a
fixture-driven test.

## Pull requests

- `npm run typecheck && npm test` must pass.
- Keep PRs focused, and include a screenshot when you change the HTML report.

## Releasing

1. Bump `version` in `package.json`, update `CHANGELOG.md`, add `docs/release-notes-vX.Y.Z.md`,
   commit and push.
2. Create the release; the [release workflow](.github/workflows/release.yml) checks that the tag
   matches `package.json`, runs the typecheck and tests, and publishes to npm with provenance:

   ```bash
   gh release create v0.2.0 --title "tokenscope v0.2.0" --notes-file docs/release-notes-v0.2.0.md
   ```

**npm auth:** the workflow uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers)
(configure `ranjan-mohanty/tokenscope` + `release.yml` on the package's npm settings page), or an
`NPM_TOKEN` repository secret as a fallback. A version already on npm is skipped.
