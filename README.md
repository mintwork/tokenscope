<div align="center">

# tokenscope

**Your AI coding agent wasted money last month. tokenscope shows exactly where.**

*ccusage tells you what you spent. tokenscope tells you what you wasted.*

`npx @mintwork/tokenscope`

Zero dependencies · runs 100% locally · Claude Code, Codex, Gemini CLI, OpenCode, Cline, Roo, Copilot CLI and more · MIT

[![CI](https://github.com/mintwork/tokenscope/actions/workflows/ci.yml/badge.svg)](https://github.com/mintwork/tokenscope/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@mintwork/tokenscope?color=cb3837&logo=npm&label=npm)](https://www.npmjs.com/package/@mintwork/tokenscope) [![npm provenance](https://img.shields.io/badge/provenance-signed-7EE2B8?labelColor=0D1714&logo=sigstore&logoColor=white)](https://www.npmjs.com/package/@mintwork/tokenscope#provenance) [![Node 22+](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=nodedotjs&logoColor=white)](package.json) [![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![zero runtime dependencies](https://img.shields.io/badge/runtime%20deps-0-7EE2B8?labelColor=0D1714)](package.json) [![GitHub stars](https://img.shields.io/github/stars/mintwork/tokenscope?style=social)](https://github.com/mintwork/tokenscope/stargazers)

![npx @mintwork/tokenscope in a terminal: estimated waste first, with a fix for each finding, then spend by project, model, session and tool](docs/demo.gif)

<sub>Recorded from the real CLI on synthetic logs (`npm run demo:gif`).</sub>

</div>

---

You know the bill. You don't know which part was **wasted**:

- your prompt cache expiring every time you spend 10 minutes reading the agent's answer, so a 500k-token context is re-written at cache-*write* price instead of read at cache-*read* price
- the agent running `npm test` five times in a row and getting the same failure back every time
- the same 2,000-line file read 40 times without anyone editing it
- a 60k-token log `cat`-ed into context, then paid for again on every later request

tokenscope reads the session logs your agents already keep on disk, finds these patterns, estimates what each one cost, and tells you how to stop it. Then it shows the full spend as a flame graph, so you can see the rest too.

## Install

```bash
npx @mintwork/tokenscope               # waste first, then spend, in the terminal
npx @mintwork/tokenscope --html --open # interactive report with the flame graph
```

Needs Node 22+ (22.13+ to read the SQLite databases of OpenCode and Goose). No configuration, no API keys, no network calls (the one exception is the opt-in `--update-pricing`). Your logs never leave your machine.

## What it finds

Every finding comes with an estimated dollar cost and a one-line fix.

| Pattern | What it means | Fix it suggests | Counted in headline? |
|---|---|---|---|
| **Cache rebuilds while you read/reply** | A gap of 5-60 min after the agent's answer (you were reading or thinking) outlived the 5-minute cache TTL, so the whole context was re-written. | Turn on the 1-hour cache TTL (Claude Code: `"promptCacheTtl": "1h"` in `~/.claude/settings.json`). Only suggested when it nets a saving. **Never** `/clear`, which would lose the context and cost about the same to rebuild. | ✅ net saving of the 1h TTL |
| **Cache rebuilds while the agent waited on a tool** | A tool call (or your approval) took 5-60 min and the cache expired. tokenscope names the tool and command, e.g. `Bash(npm run build) 12 min`. | Run long commands in the background (Claude Code: `run_in_background`, `/tasks`), or use the 1-hour TTL. | ✅ net saving of the 1h TTL |
| **Loops** | The same tool called with the same input **and the same result**, several times in a row. | Interrupt early. Add a rule to `CLAUDE.md` / `AGENTS.md`: "if a command fails the same way twice, stop and ask". | ✅ |
| **Repeated calls** | Identical call, identical answer, scattered through a session. | Tell the agent to reuse earlier results, or note slow-changing facts in the instructions file. | ✅ |
| **Unchanged re-reads** | The same file (same range) read again with no edit in between. | Put the key facts in `CLAUDE.md` / `AGENTS.md`, or read a line range. | ✅ |
| **Mid-session prompt changes / model switches** | The cache was rebuilt with no idle gap: instructions or tools changed, compaction ran, or the model switched. | Don't edit instructions or toggle MCP servers mid-session; stick to one model. | ➖ shown separately as *likely avoidable* |
| **Huge tool outputs** | A single tool result above 10k tokens (configurable), carried by every later request. | `head`, `grep`, `--limit`; "never cat logs or lockfiles". | ➖ shown separately as *likely avoidable* |
| **Failed-edit retry storms** | Three or more edits of the same file failing in a row (text to replace not found, not unique, file not read). | Re-read the exact lines before retrying; "if an edit fails twice, re-read the file". | ✅ |
| **Context bloat before compaction** | The context grew far past 200k tokens (e.g. to the 1M limit) before compaction shrank it to a fraction. | `/compact` when a task is done, `/clear` before an unrelated one, or auto-compact earlier. | ➖ shown separately as *likely avoidable* |
| **Unused tool definitions** | An MCP server's tool schemas sent with every request of a session that never called any of them. | Disable the server for this project, or load its tools on demand (tool search). | ➖ shown separately as *likely avoidable* |
| **Over-thinking on tiny edits** | A request whose only output was a small edit, but that billed 8k+ hidden reasoning tokens. | Lower effort or a thinking budget for small, well-specified edits. | ➖ shown separately as *likely avoidable* |
| **Rebuilds after breaks over an hour** | No cache lives that long. | None needed. A fresh session helps only if you're starting an unrelated task. | ❌ not waste, shown for context |

**Plus the spend side:** cost per session, project, model, day and tool, cache hit rate, how much caching saved you, and a **flame graph** (project → session → turn → API call → subagent) you can click to zoom.

### The HTML report

`npx @mintwork/tokenscope --html --open` writes one self-contained file: waste by pattern with fixes, which checks ran per agent, and a zoomable flame graph of spend. It loads nothing from the network, and its Content Security Policy only lets its own bundled script run.

![tokenscope HTML report: estimated waste by pattern with fixes, plus a flame graph of token spend](docs/demo.png)

<sub>Screenshot generated from synthetic logs (`npm run demo:png`). Open the <a href="https://mintwork.github.io/tokenscope/demo-report.html">interactive demo report</a>.</sub>

## How waste is estimated

Every number is a **counterfactual**: what the same work would have cost if one specific thing had been done differently, priced with the same table as your spend. tokenscope never counts the full cost of a request as waste; it counts only the difference.

- **Cache rebuilds (5-60 min gaps):** the counterfactual is *this whole session on a 1-hour cache TTL*. In that world:
  - each rebuild after a 5-60 min gap becomes a cache read of the context it carried over (new content is still written);
  - but **every** cache write in the session pays the 1h price (2× base input instead of 1.25×).

  The finding is `actual cache cost − counterfactual cache cost`, computed per session (each subagent separately). If the premium outweighs the savings, there is no finding and no recommendation. The terminal also shows what the setting would net if you turned it on for *every* session, including those that would only pay the premium.
- **Gaps over an hour** are beyond any TTL. They're listed as unavoidable and never added to waste.
- **Rebuilds with no gap** (prompt prefix changed, model switched): the tokens carried over from the previous request × (write price − read price). These are only *likely* avoidable, because compaction or a deliberate model switch may have been worth it, so they're kept out of the headline.
- **Loops:** the cost of the repeated round trips after the first (their share of each request).
- **Repeats, unchanged re-reads, huge outputs:** the avoidable tokens (output size ÷ 4) × the price of adding them to the context once, plus the cache reads every later request in that context paid to carry them. Re-reads only count when the file wasn't edited in between and the same range was read.
- **Failed-edit retry storms** (avoidable): 3+ consecutive failed edits of one file, where the error says the edit itself failed (text not found or not unique, stale or unread file). Permission denials, hooks and safety classifiers don't count, and a successful edit ends the run. The counterfactual is a good recovery after the first failure (re-read the lines, then edit), which still costs one round trip, so the first two attempts are free and each later one counts as its share of its request. Failed edits are not also counted as loops or repeats.
- **Context bloat before compaction** (likely avoidable): only for compactions that started above 1.5 × 200k tokens (`--compact-at`) and ended below half of it. The counterfactual compacts each time the context passes 200k, to the size the real compaction reached, then lets it grow by the same steps as the real session. The finding is the cache reads saved on the smaller context (at each size's own pricing tier) **minus** the cost of every extra compaction: reading the context once, writing a summary as large as the post-compaction context at output price, and re-caching it. If that isn't positive, there's no finding. It is only *likely* avoidable because earlier compaction can drop context the agent still needed.
- **Unused tool definitions** (likely avoidable): MCP servers (`mcp__<server>__*`) whose tools were sent with requests but never called anywhere in the session, subagents included. Deferred tools (tool search) and built-in tools are never counted. Each request is charged the schema tokens (JSON size ÷ 4) at the price that request paid for its prompt prefix: a cache read when the prefix was cached, otherwise a cache write or fresh input. Needs logs that record each request's tool list (Claude Code 2.1.3xx and later).
- **Over-thinking on tiny edits** (likely avoidable): requests whose only output was edits totalling ≤ 1,000 characters, with hidden reasoning (output tokens − visible text and tool input ÷ 4) of 8k tokens or more. Only the reasoning above a 2k-token allowance counts, at output price; a one-line fix can still be the result of hard thinking.

The headline (**"could have been saved"**) is the sum of the ✅ rows only. The likely-avoidable amount is shown next to it, never added in. Each detector only runs on agents whose logs contain the data it needs; anything else is reported as *not checked*, never as $0.

## tokenscope vs ccusage

[ccusage](https://github.com/ccusage/ccusage) is great, and you should probably keep using it. The two tools answer different questions:

| | ccusage | tokenscope |
|---|---|---|
| Question it answers | *How much did I spend?* | *What did I waste, and how do I stop?* |
| Daily / monthly / session spend | ✅ excellent | ✅ |
| Agents supported | ~19 | 16 (see below) |
| Live status line, billing blocks | ✅ | ❌ |
| Waste detection (cache rebuilds, loops, re-reads, giant outputs, failed edits, context bloat, ...) | ❌ | ✅ with counterfactual $ estimates and fixes |
| What got more wasteful between two periods | ❌ | ✅ `tokenscope diff` |
| Live waste alerts during a session | ❌ | ✅ `tokenscope watch` (Claude Code) |
| Fail a CI job when an agent run wastes too much | ❌ | ✅ `--fail-over` |
| Why a cache miss happened (you paused / long tool / prefix change / model switch) | ❌ | ✅ |
| Flame graph down to individual tool calls | ❌ | ✅ |
| Subagent cost attributed to the call that spawned it | ❌ | ✅ |
| Says which checks it could run per agent | n/a | ✅ never reports $0 waste for missing data |

Use ccusage to track the bill. Run tokenscope when the bill surprises you.

## Supported agents

Each parser declares what its log format contains. A waste check only runs when the data it needs is there, and the report lists, per agent, which checks ran and what the logs were missing.

| Agent | Status | Cache rebuilds | Loops / repeats | Re-reads | Huge outputs | Default location |
|---|---|---|---|---|---|---|
| Claude Code | ✅ **verified on real logs** | ✅ | ✅ | ✅ | ✅ | `~/.claude/projects` |
| Codex CLI | 🧪 experimental (format from docs/source) | ✅ | ✅ | ◐ shell reads only | ✅ | `~/.codex/sessions`, `archived_sessions` |
| Gemini CLI | 🧪 experimental | ✅ | ✅ | ✅ | ✅ | `~/.gemini/tmp/*/chats` |
| Qwen Code | 🧪 experimental | ✅ | ✅ | ✅ | ✅ | `~/.qwen/projects` |
| OpenCode | 🧪 experimental | ✅ | ✅ | ✅ | ✅ | `~/.local/share/opencode` (SQLite needs Node 22.13+) |
| Kilo CLI | 🧪 experimental | ✅ | ✅ | ✅ | ✅ | `~/.local/share/kilo` |
| Cline | 🧪 experimental | ✅ | ✅ | ✅ | ✅ | VS Code globalStorage, `~/.cline/data` |
| Roo Code | 🧪 experimental | ✅ | ✅ | ✅ | ✅ | VS Code globalStorage |
| Kilo Code (extension, ≤ v5) | 🧪 experimental | ✅ | ✅ | ✅ | ✅ | VS Code globalStorage |
| GitHub Copilot CLI | 🧪 experimental | ❌ no per-request tokens on disk | ✅ | ✅ | ✅ | `~/.copilot/session-state` |
| Factory Droid | 🧪 experimental | ❌ session totals only | ◐ if transcript has tool blocks | ◐ | ◐ | `~/.factory/sessions` |
| Amp | 🧪 experimental | ✅ | ◐ tool-block shape unverified | ◐ | ◐ | `~/.local/share/amp/threads` |
| pi (coding agent) | 🧪 experimental | ✅ | ✅ | ✅ | ✅ | `~/.pi/agent/sessions` |
| Goose | 🧪 experimental | ✅ (◐ older sessions have totals only) | ✅ | ✅ | ✅ | `~/.local/share/goose/sessions/sessions.db` (SQLite, Node 22.13+) |
| Kimi CLI | 🧪 experimental | ✅ | ✅ | ✅ | ✅ | `~/.kimi/sessions` (model taken from `config.toml`; Kimi prices not in the table yet) |
| Aider | 🧪 experimental | ❌ no per-request timestamps; spend only | ❌ no tool calls | ❌ | ❌ | `.aider.chat.history.md` in the current directory |

Failed-edit retries, context bloat, unused tool definitions and over-thinking currently run on Claude Code logs only. Other agents list them as *not checked* until their log fields are verified.

*Experimental* means the parser was built from the agent's source code and docs, cross-checked against other open-source parsers, and tested on synthetic fixtures, but nobody has run it on a real user's logs yet. **If you use one of these agents, please run `npx @mintwork/tokenscope --source <agent>` and [open an issue](.github/ISSUE_TEMPLATE/sample-logs.yml) with a sanitized sample** if the numbers look off. That's how a parser becomes *verified*.

Not supported: **Cursor** keeps usage on its servers (no local per-request log to read without network calls), and **Antigravity** has no plain session log on disk (its usage comes from the running app). Kimi Code (`~/.kimi-code`, a newer format) is not read yet.

VS Code-family locations are checked for Code, Code - Insiders, Cursor, Windsurf, VSCodium, Positron, Antigravity, Trae and Kiro on macOS, Linux (including `~/.vscode-server`) and Windows. Run `npx @mintwork/tokenscope --list-sources` to see what was found where.

## Usage

```text
tokenscope [options]
tokenscope diff [--from 14d] [--to 7d] [options]
tokenscope watch [options]   live alerts for the active Claude Code session (see below)

Output
  (default)              terminal summary: waste first, then spend
  --html [file]          self-contained HTML report (default: tokenscope-report.html)
  --json [file]          machine-readable report (stdout when no file given)
  --open                 open the HTML report when done

Filters
  --since <when>         7d, 24h, 2w, or a date (2026-11-01)
  --until <when>         same formats
  -p, --project <text>   only projects whose name/path contains <text>
  --source <ids>         comma-separated agent ids, or "all" (default: every agent found)

Compare two time ranges
  diff                   compare [--from, --to) with [--to, --until or now] (default: the last 7 days vs the 7 before)
  --from <when> / --to <when>
  --compare              with --since: compare that range with the one of equal length just before it

CI / headless runs
  --session <ids>        only these sessions (comma-separated ids or id prefixes)
  --fail-over <usd>      exit 1 when the avoidable waste (the headline) exceeds <usd>
  --summary [file]       compact JSON summary for CI (stdout when no file given)

Sources
  --path <id>=<dir>      read agent <id> from <dir> (repeatable)
  --dir <dir>            shorthand for --path claude-code=<dir>
  --codex-dir <dir>      shorthand for --path codex=<dir>
  --list-sources         show every supported agent, where it looks, and what it found

Tuning
  --pricing <file>       JSON overrides merged over the built-in pricing table
  --update-pricing       download the latest published pricing table and cache it (opt-in network)
  --no-pricing-cache     ignore the cached table, use the built-in one
  --huge <tokens>        tool output size flagged as huge (default 10000)
  --compact-at <tokens>  context size the context-bloat estimate compacts at (default 200000)
  --top <n>              rows per terminal section (default 8)
  --redact               hide prompts, titles, paths and commands
  --no-color             disable ANSI colors (also honors NO_COLOR; FORCE_COLOR forces them on)
```

```bash
npx @mintwork/tokenscope --since 7d                         # last week
npx @mintwork/tokenscope --source codex,gemini-cli          # just these agents
npx @mintwork/tokenscope --path opencode=~/backup/opencode  # read from somewhere else
npx @mintwork/tokenscope -p checkout --html report.html     # one project, as HTML
npx @mintwork/tokenscope --json | jq '.totals.avoidableCost' # the headline number, for scripts
npx @mintwork/tokenscope --redact --html share.html         # safe to post in Slack
npx @mintwork/tokenscope diff                               # what got more wasteful this week?
npx @mintwork/tokenscope --since 30d --compare --json       # last 30 days vs the 30 before, as JSON
```

`diff` builds a full report for each range, with the same detectors and prices, and lines them up: spend, the headline waste and its share of spend, likely-avoidable waste, cache hit rate, waste by pattern (cache rebuilds split by cause), the projects that got more or less wasteful, and spend by model. `--json` gives the same diff as data. Sessions that span the boundary are split at it.

Agent ids: `claude-code`, `codex`, `gemini-cli`, `qwen-code`, `opencode`, `kilo-cli`, `cline`, `roo-code`, `kilo-code`, `copilot-cli`, `droid`, `amp`, `pi`, `goose`, `kimi`, `aider`. Usual env overrides are honored (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, `QWEN_HOME`, `XDG_DATA_HOME`, `CLINE_DATA_DIR`, `COPILOT_HOME`, `DROID_SESSIONS_DIR`, `AMP_DATA_DIR`, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `GOOSE_PATH_ROOT`, `KIMI_SHARE_DIR`, `AIDER_CHAT_HISTORY_FILE`). Aider has no central log store: point `--path aider=<repo or history file>` at your repos.

### CI mode for headless agent runs

Run tokenscope after an agent runs in CI to gate on waste. Scope the check to the current run with `--session <id>` (Claude Code's `claude -p --output-format json` prints the `session_id`) or `--since <ISO time>` captured before the run. `--fail-over <usd>` exits 1 when the headline (avoidable waste only; *likely avoidable* is never counted) exceeds the amount, and `--summary` writes a small JSON document (totals, waste by pattern, top findings with fixes, and the `failOver` result) instead of the full report.

```yaml
# .github/workflows/agent.yml (excerpt)
      - name: Run the agent headless
        id: agent
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          claude -p "Fix the failing tests" --output-format json > agent.json
          echo "session=$(jq -r .session_id agent.json)" >> "$GITHUB_OUTPUT"
      - name: Waste check
        if: always()
        env:
          SESSION: ${{ steps.agent.outputs.session }}
        run: npx -y @mintwork/tokenscope --session "$SESSION" --summary tokenscope.json --html tokenscope.html --fail-over 2
      - name: Job summary
        if: always()
        run: |
          jq -r '"### tokenscope: ≈ $\(.avoidableCost) avoidable of $\(.cost)\n" +
            (.topFindings | map("- **\(.kind)** $\(.cost): \(.title)") | join("\n"))' tokenscope.json >> "$GITHUB_STEP_SUMMARY"
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: tokenscope
          path: tokenscope.*
```

Exit codes: `0` ok; `1` when the avoidable waste is over the threshold, on errors, or when no session matched the filters.


### Live alerts: `tokenscope watch`

```bash
npx @mintwork/tokenscope watch                    # the newest Claude Code session; follows you to new ones
npx @mintwork/tokenscope watch --session 3f2a     # pin one session (id or prefix)
npx @mintwork/tokenscope watch -p checkout        # newest session in a matching project
```

```text
14:02:11 cache expires in ~1 min: ~180k tokens are cached; replying after that re-writes them (~$0.90)
14:03:12 cache likely expired (5-minute TTL, idle 5 min): the next message re-writes ~180k tokens (~$0.90) instead of reading them from cache
14:09:40 Bash called 3× in a row, same input & same result - ≈$0.42
  ↳ Interrupt as soon as the same result comes back twice, ...
```

It polls the session log every 2 seconds (`--interval <seconds>`; no dependencies, no network), re-reads it when it changes, and prints each alert once: a heads-up about a minute before the prompt cache expires (5 minutes, or 1 hour when the session writes 1h cache), an alert when it has expired (the tokens the next message re-writes, priced as cache write minus cache read for that model), and every new waste finding with its fix. Findings already in the session when you start are summarized in one line. Ctrl-C exits. Claude Code only for now.

## How costs are computed

For each API request: `input × in + output × out + cache_read × read + cache_write_5m × 1.25·in + cache_write_1h × 2·in`, using the rates in [`src/pricing/pricing.json`](src/pricing/pricing.json) (Anthropic, OpenAI, Google and Qwen models, each provider with its source URL and date). It handles each agent's token semantics: OpenAI-style input includes cached tokens, Gemini output excludes thoughts, Roo's `tokensIn` includes cache. Model ids are normalized (Bedrock/Vertex prefixes, `-v1:0`, dates, `[1m]`, Copilot's `claude-sonnet-4.5`) and matched exactly or by longest prefix.

- If a model isn't in the table but the agent recorded its own cost (OpenCode, Cline, Roo), that cost is used and labelled.
- Otherwise the model is counted as $0 **and listed in a warning**. Prices are never guessed.
- Costs are **API list-price equivalents**. Subscriptions (Claude Max, ChatGPT plans, Copilot premium requests, Gemini/Qwen free tiers) bill differently.

To update prices, edit `pricing.json` (PRs welcome) or pass your own file:

```bash
npx @mintwork/tokenscope --pricing my-prices.json   # { "models": { "my-model": { "input": 1, "output": 5 } } }
```

Prices change faster than releases, so you can also pull the table published on `main` without upgrading:

```bash
npx @mintwork/tokenscope --update-pricing           # fetch, validate and cache it, then exit
npx @mintwork/tokenscope --update-pricing --since 7d  # update, then run as usual
```

This downloads [`src/pricing/pricing.json`](src/pricing/pricing.json) from `raw.githubusercontent.com/mintwork/tokenscope/main`, checks it strictly (dates, multipliers, every price a sane non-negative number, size limit) and caches it in `~/.cache/tokenscope/pricing.json` (`$XDG_CACHE_HOME`, `%LOCALAPPDATA%\tokenscope` on Windows, or `$TOKENSCOPE_CACHE_DIR`). A failed or invalid download keeps the previous cache. Later runs use the cached table only when it is newer than the built-in one, and say so; `--no-pricing-cache` ignores it and `--pricing` still merges on top. `TOKENSCOPE_PRICING_URL` points it at a mirror. **It never fetches unless you pass `--update-pricing`.**

## Privacy

tokenscope only reads files on your machine and writes the report you ask for. It makes no network requests and sends no telemetry. The only exception is `--update-pricing`, which you must ask for: it downloads the public pricing table (no data is sent) and is never run by default. HTML reports include prompt snippets and file paths unless you pass `--redact`. The test suite uses synthetic fixtures only.

## Roadmap

- [ ] Verify the experimental parsers on real logs (please send sanitized samples)
- [ ] Run the four newer detectors on other agents once their log fields are verified (Claude Code only today)
- [ ] `tokenscope watch` for agents other than Claude Code
- [ ] More agents: Kimi Code (`~/.kimi-code`); Cursor and Antigravity only if they start keeping per-request logs on disk

Shipped in 0.2.0:

- [x] More agents (experimental): pi, Goose, Kimi CLI, Aider
- [x] `tokenscope watch`: live waste alerts for the current session ("cache expired: this message will cost $4")
- [x] CI mode for headless agent runs (`--fail-over`, `--summary`, `--session`)
- [x] More detectors: failed-edit retry storms, context bloat before compaction, unused tool definitions, over-thinking on tiny edits
- [x] Diff two time ranges (`tokenscope diff`, `--compare`)
- [x] Opt-in pricing updates from a published feed (`--update-pricing`)

## Development

```bash
npm install
npm test          # builds, then vitest on synthetic fixtures
npm run smoke     # run the CLI against the fixtures
npm run demo      # generate synthetic logs + docs/demo-report.html
npm run demo:visuals  # re-render docs/demo.png and docs/demo.gif (needs Google Chrome + ffmpeg)
```

See [CONTRIBUTING.md](CONTRIBUTING.md). **Never commit real session logs.** They contain your prompts, code and secrets.

Parsers for agents other than Claude Code were written from each agent's source and cross-checked against [ccusage](https://github.com/ccusage/ccusage), [better-ccusage](https://github.com/cobra91/better-ccusage), [splitrail](https://github.com/Piebald-AI/splitrail) and [tokscale](https://github.com/junhoyeo/tokscale) (all MIT). Thank you to their authors. See [NOTICE](NOTICE).

## License

MIT
