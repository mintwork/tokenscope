# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `--update-pricing`: opt-in download of the pricing table published on `main`, strictly validated and cached in
  the user cache dir; later runs use it only when it is newer than the built-in table (`--no-pricing-cache` to
  ignore it). The report says which table priced it (`pricingSource` in JSON). This is the only network access
  tokenscope makes, and it never happens by default.

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
