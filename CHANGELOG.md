# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **`tokenscope diff`** compares two time ranges ("what got more wasteful this week?"): `--from` / `--to` /
  `--until`, defaulting to the last 7 days vs the 7 before, or `--since <when> --compare` for the same-length range
  just before. It lines up spend, the avoidable headline and its share of spend, likely-avoidable waste, cache hit
  rate, waste by pattern, projects that got more or less wasteful, and spend by model. Output is terminal or `--json`.
- **Four new waste detectors**, each with a counterfactual estimate (see "How waste is estimated" in the README).
  For now they run on Claude Code logs only, and other agents list them as not checked:
  - *failed-edit retry storms* (avoidable): 3+ consecutive failed edits of the same file. Permission denials and
    classifier blocks are excluded, and these edits are no longer double-counted as loops;
  - *context bloat before compaction* (likely avoidable): the saving from compacting at 200k tokens (`--compact-at`)
    instead of the auto-compact limit, net of the extra compactions;
  - *unused tool definitions* (likely avoidable): MCP servers whose schemas were sent with every request but never
    called (needs logs that record each request's tool list);
  - *over-thinking on tiny edits* (likely avoidable): 8k+ hidden reasoning tokens for an edit of ≤ 1,000 characters.
- The Claude Code parser now reads compaction events, per-request tool definitions, tool error text (used only for
  classification, and redacted with `--redact`) and visible output sizes.
- **CI mode** for headless agent runs: `--fail-over <usd>` exits 1 when the avoidable waste (the headline) exceeds
  the amount, `--summary [file]` writes a compact JSON summary (totals, waste by pattern, top findings, the
  `--fail-over` result), and `--session <ids>` scopes the report to specific sessions (ids or prefixes). The README
  has a GitHub Actions example.
- `tokenscope watch`: tails the active Claude Code session and prints live alerts, each once: a heads-up about a
  minute before the prompt cache expires, an alert when it has (tokens the next message re-writes and the extra cost
  over a warm cache; 5-minute or 1-hour TTL), and each new waste finding with its fix. Follows you to newer sessions
  unless pinned with `--session`; `-p`, `--dir`, `--interval`; Ctrl-C exits cleanly. Polling only, no dependencies.
- Experimental parsers (built from each agent's source and docs, tested on synthetic fixtures, not yet run on real
  logs): **pi** coding agent (`~/.pi/agent/sessions`), **Goose** (`sessions.db` usage ledger, SQLite, Node 22.13+),
  **Kimi CLI** (`~/.kimi/sessions/*/wire.jsonl`, with subagents) and **Aider** (`.aider.chat.history.md`, spend only:
  no per-request timestamps or tool calls, so no waste check runs). Cursor and Antigravity are not supported: neither
  keeps a per-request log on disk.

### Security

- HTML report: every log-derived value at an `innerHTML` sink is escaped (numbers, ids and class/style
  values too), the footer values are escaped server-side, and the page carries a Content Security
  Policy that only allows its own bundled script (pinned by SHA-256), so injected handlers can't run.
- `--open` no longer goes through `cmd /c start` on Windows (cmd metacharacters in the path could run
  commands). It runs `explorer.exe` / `open` / `xdg-open` with the path as one argument and no shell,
  and only for an existing regular file.
- CI workflow runs with a read-only `GITHUB_TOKEN` (`permissions: contents: read`).
- Model-id normalization strips a trailing `[1m]` without a backtracking regex (CodeQL `js/polynomial-redos`).

## [0.1.1] - 2026-11-14

### Changed

- README badges consolidated into one row; the npm downloads badge is removed until npm reports
  download counts for the new package (it showed "package not found or too new").
- Published from CI with npm trusted publishing (OIDC); no npm token is stored.

## [0.1.0] - 2026-11-14

First public release.

### Added

- **Waste detection** with a counterfactual dollar estimate and a one-line fix for every finding:
  - prompt-cache rebuilds, classified by cause: you paused to read or reply, a slow tool or approval, a mid-session
    prompt-prefix change, a model switch, or a break over an hour (shown but never counted);
  - the net saving of a 1-hour cache TTL per session, and what it would net if turned on everywhere;
  - loops (same call, same input, same result, back to back) and scattered repeated calls;
  - unchanged file re-reads (same file and range, no edit in between);
  - huge tool outputs carried in context by every later request (`--huge` to tune).
- A headline that counts **realistic savings only**; "likely avoidable" waste is shown separately and never added in.
- **Per-agent check coverage**: each parser declares what its logs contain, detectors only run where the data exists,
  and missing data is reported as "not checked", never as $0 waste.
- **Spend breakdown**: cost per session, project, model, day and tool; cost by token type; cache hit rate; how much
  caching saved; subagent cost attributed to the call that spawned it.
- **Reports**: terminal (waste first, then spend), `--json`, and a self-contained `--html` report with a zoomable
  flame graph (project → session → turn → API call → subagent). `--redact` hides prompts, titles, paths and commands.
- **Agents**: Claude Code (verified on real logs), plus experimental parsers for Codex CLI, Gemini CLI, Qwen Code,
  OpenCode, Kilo CLI, Cline, Roo Code, Kilo Code, GitHub Copilot CLI, Factory Droid and Amp, with per-OS default
  locations, `--path <id>=<dir>` overrides, `--source` filtering and `--list-sources`.
- **Pricing table** for Anthropic, OpenAI, Google and Qwen models with source URLs and dates, model-id normalization,
  agent-reported cost as a fallback, and `--pricing` overrides. Unknown models are listed in a warning, never guessed.
- Filters: `--since`, `--until`, `--project`.
- `FORCE_COLOR` forces ANSI colors when stdout is not a TTY; `COLUMNS` sets the width when it is not a terminal.
- Zero runtime dependencies, Node 22+, 100% local: no network requests, no telemetry.

[0.1.1]: https://github.com/mintwork/tokenscope/releases/tag/v0.1.1
[0.1.0]: https://github.com/mintwork/tokenscope/releases/tag/v0.1.0
