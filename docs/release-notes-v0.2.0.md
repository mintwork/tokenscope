# tokenscope v0.2.0

CI mode, four new waste detectors, `diff` and `watch`, four more (experimental) agents, and opt-in
pricing updates. Still zero runtime dependencies, and still local-only by default.

```bash
npx @mintwork/tokenscope@0.2.0
```

## CI mode for headless agent runs

Gate a CI job on the waste of one agent run. `--session <ids>` scopes the report to specific sessions
(ids or prefixes), `--fail-over <usd>` exits 1 when the avoidable waste (the headline; "likely
avoidable" is never counted) exceeds the amount, and `--summary [file]` writes a compact JSON summary.

```bash
npx -y @mintwork/tokenscope --session "$SESSION" --summary tokenscope.json --fail-over 2
```

The README has a full GitHub Actions example.

## Four new waste detectors

Each one comes with a counterfactual dollar estimate and a fix. For now they run on Claude Code logs
only; other agents list them as "not checked".

- **Failed-edit retry storms** (avoidable): 3+ failed edits of the same file in a row. Permission
  denials and safety classifiers don't count.
- **Context bloat before compaction** (likely avoidable): what compacting at 200k tokens
  (`--compact-at`) would have saved, net of the extra compactions.
- **Unused tool definitions** (likely avoidable): MCP servers whose schemas were sent with every
  request but never called.
- **Over-thinking on tiny edits** (likely avoidable): 8k+ hidden reasoning tokens for an edit of
  1,000 characters or less.

## `tokenscope diff`

What got more wasteful this week? Compares spend, the headline waste, cache hit rate, waste by
pattern, projects and models across two time ranges.

```bash
npx @mintwork/tokenscope diff                          # last 7 days vs the 7 before
npx @mintwork/tokenscope diff --from 30d --to 14d
npx @mintwork/tokenscope --since 30d --compare --json  # last 30 days vs the 30 before
```

## `tokenscope watch`

Live alerts for the active Claude Code session: a heads-up about a minute before the prompt cache
expires, an alert (with the cost of re-writing it) once it has, and each new waste finding with its
fix. Polling only, no network.

```bash
npx @mintwork/tokenscope watch
npx @mintwork/tokenscope watch --session 3f2a
```

## Experimental parsers: pi, Goose, Kimi CLI, Aider

Built from each agent's source and docs and tested on synthetic fixtures. Nobody has run them on
real logs yet, so please open an issue with a sanitized sample if the numbers look off.

- **pi** (`~/.pi/agent/sessions`) and **Kimi CLI** (`~/.kimi/sessions`, subagents included; Kimi
  prices are not in the table yet).
- **Goose** (`sessions.db`, SQLite, needs Node 22.13+).
- **Aider** (`.aider.chat.history.md`): spend only. The file has no per-request timestamps or tool
  calls, so no waste check runs.

Cursor and Antigravity are still not supported: neither keeps a per-request log on disk.

## Opt-in pricing updates

`--update-pricing` downloads the pricing table published on `main`, validates it strictly and caches
it. Later runs use it only when it is newer than the built-in table (`--no-pricing-cache` ignores
it). This is the only network request tokenscope can make, and it never happens unless you pass the
flag.

```bash
npx @mintwork/tokenscope --update-pricing
```

## Security hardening

- The HTML report carries a Content Security Policy that only allows its own bundled script, and
  every log-derived value is escaped.
- `--open` no longer goes through a shell (`cmd /c start` on Windows). It runs
  `open` / `xdg-open` / `explorer.exe` with the path as a single argument, and only for an existing
  file.

## Upgrading

No configuration changes. Without the new flags, the default report reads the same logs as 0.1.x,
plus the new agents if their logs exist. Two things will look different:

- Claude Code reports now include the four new detectors, and failed edits are no longer also counted as loops, so the totals can differ from 0.1.x
  for the same logs. The new "likely avoidable" findings are shown next to the headline, never
  added to it.
- In `--json`, findings can have the new kinds `edit-retry`, `context-bloat`, `unused-tools` and
  `overthinking`, and the report has a new `pricingSource` field.

Full details: [Changelog](https://github.com/mintwork/tokenscope/blob/main/CHANGELOG.md)
