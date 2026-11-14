<div align="center">

# tokenscope

**Your AI coding agent wasted money last month. tokenscope shows exactly where.**

*ccusage tells you what you spent. tokenscope tells you what you wasted.*

`npx tokenscope`

Zero dependencies · runs 100% locally · Claude Code, Codex, Gemini CLI, OpenCode, Cline, Roo, Copilot CLI and more · MIT

![tokenscope HTML report: estimated waste by pattern with fixes, plus a flame graph of token spend](docs/demo.png)

<sub>Screenshot generated from synthetic logs (`npm run demo`). Open <a href="docs/demo-report.html">docs/demo-report.html</a> for the interactive version.</sub>

</div>

---

You know the bill. You don't know which part was **wasted**:

- 264 prompt-cache rebuilds because you came back from lunch to a 500k-token session, each one re-written at cache-*write* price
- the agent running `npm test` five times in a row and getting the same failure back every time
- the same 2,000-line file read 40 times without anyone editing it
- a 60k-token log `cat`-ed into context, then paid for again on every later request

tokenscope reads the session logs your agents already keep on disk, finds these patterns, estimates what each one cost, and tells you how to stop it. Then it shows the full spend as a flame graph, so you can see the rest too.

## Install

```bash
npx tokenscope               # waste first, then spend, in the terminal
npx tokenscope --html --open # interactive report with the flame graph
```

Needs Node 20+ (22.13+ to read OpenCode's SQLite database). No configuration, no API keys, no network calls. Your logs never leave your machine.

## What it finds

Every finding comes with an estimated dollar cost and a one-line fix.

| Pattern | What it means | Typical fix | Certainty |
|---|---|---|---|
| **Cache rebuilds** | The whole context was re-sent at cache-write (or full input) price instead of cache-read price. tokenscope says why: an idle gap longer than the cache TTL, a model switch, or a changed prompt prefix. | `/clear` or start a fresh session after breaks longer than 5 min, or use a 1-hour cache TTL. Don't edit `CLAUDE.md` or toggle MCP servers mid-session. | *likely avoidable* |
| **Loops** | The same tool called with the same input **and the same result**, several times in a row. | Interrupt early. Add a rule to `CLAUDE.md` / `AGENTS.md`: "if a command fails the same way twice, stop and ask". | avoidable |
| **Repeated calls** | Identical call, identical answer, scattered through a session. | Tell the agent to reuse earlier results, or note slow-changing facts in the project instructions file. | avoidable |
| **Unchanged re-reads** | The same file (same range) read again with no edit in between. | Put the key facts about the file in `CLAUDE.md` / `AGENTS.md`, or read a line range. | avoidable |
| **Huge tool outputs** | A single tool result above 10k tokens (configurable), carried by every later request. | `head`, `grep`, `--limit`. Add "never cat logs or lockfiles" to the instructions file. | *likely avoidable* |

**These are estimates, and the report says so.** Avoidable tokens are priced at what it cost to add them to the context once, plus the cache reads every later request paid to carry them. Some waste is arguable: you may have *wanted* that coffee break. That's why cache rebuilds after breaks and huge outputs are labelled **likely avoidable**, and kept separate from clear-cut repeats.

Then the spend side: cost per session, project, model, day and tool, cache hit rate, how much caching saved you, and a **flame graph** (project → session → turn → API call → subagent) you can click to zoom.

## tokenscope vs ccusage

[ccusage](https://github.com/ccusage/ccusage) is great, and you should probably keep using it. The two tools answer different questions:

| | ccusage | tokenscope |
|---|---|---|
| Question it answers | *How much did I spend?* | *What did I waste, and how do I stop?* |
| Daily / monthly / session spend | ✅ excellent | ✅ |
| Agents supported | ~19 | 12 (see below) |
| Live status line, billing blocks | ✅ | ❌ |
| Waste detection (cache rebuilds, loops, re-reads, giant outputs) | ❌ | ✅ with $ estimates and fixes |
| Why a cache miss happened (idle gap / model switch / prefix change) | ❌ | ✅ |
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

*Experimental* means the parser was built from the agent's source code and docs, cross-checked against other open-source parsers, and tested on synthetic fixtures, but nobody has run it on a real user's logs yet. **If you use one of these agents, please run `npx tokenscope --source <agent>` and [open an issue](.github/ISSUE_TEMPLATE/sample-logs.yml) with a sanitized sample** if the numbers look off. That's how a parser becomes *verified*.

VS Code-family locations are checked for Code, Code - Insiders, Cursor, Windsurf, VSCodium, Positron, Antigravity, Trae and Kiro on macOS, Linux (including `~/.vscode-server`) and Windows. Run `npx tokenscope --list-sources` to see what was found where.

## Usage

```text
tokenscope [options]

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

Sources
  --path <id>=<dir>      read agent <id> from <dir> (repeatable)
  --dir <dir>            shorthand for --path claude-code=<dir>
  --codex-dir <dir>      shorthand for --path codex=<dir>
  --list-sources         show every supported agent, where it looks, and what it found

Tuning
  --pricing <file>       JSON overrides merged over the built-in pricing table
  --huge <tokens>        tool output size flagged as huge (default 10000)
  --top <n>              rows per terminal section (default 8)
  --redact               hide prompts, titles, paths and commands
  --no-color             disable ANSI colors (also honors NO_COLOR)
```

```bash
npx tokenscope --since 7d                         # last week
npx tokenscope --source codex,gemini-cli          # just these agents
npx tokenscope --path opencode=~/backup/opencode  # read from somewhere else
npx tokenscope -p checkout --html report.html     # one project, as HTML
npx tokenscope --json | jq '.totals.wasteCost'    # pipe the number into anything
npx tokenscope --redact --html share.html         # safe to post in Slack
```

Agent ids: `claude-code`, `codex`, `gemini-cli`, `qwen-code`, `opencode`, `kilo-cli`, `cline`, `roo-code`, `kilo-code`, `copilot-cli`, `droid`, `amp`. Usual env overrides are honored (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, `QWEN_HOME`, `XDG_DATA_HOME`, `CLINE_DATA_DIR`, `COPILOT_HOME`, `DROID_SESSIONS_DIR`, `AMP_DATA_DIR`).

## How costs are computed

For each API request: `input × in + output × out + cache_read × read + cache_write_5m × 1.25·in + cache_write_1h × 2·in`, using the rates in [`src/pricing/pricing.json`](src/pricing/pricing.json) (Anthropic, OpenAI, Google and Qwen models, each provider with its source URL and date). It handles each agent's token semantics: OpenAI-style input includes cached tokens, Gemini output excludes thoughts, Roo's `tokensIn` includes cache. Model ids are normalized (Bedrock/Vertex prefixes, `-v1:0`, dates, `[1m]`, Copilot's `claude-sonnet-4.5`) and matched exactly or by longest prefix.

- If a model isn't in the table but the agent recorded its own cost (OpenCode, Cline, Roo), that cost is used and labelled.
- Otherwise the model is counted as $0 **and listed in a warning**. Prices are never guessed.
- Costs are **API list-price equivalents**. Subscriptions (Claude Max, ChatGPT plans, Copilot premium requests, Gemini/Qwen free tiers) bill differently.

To update prices, edit `pricing.json` (PRs welcome) or pass your own file:

```bash
npx tokenscope --pricing my-prices.json   # { "models": { "my-model": { "input": 1, "output": 5 } } }
```

## Privacy

tokenscope only reads files on your machine and writes the report you ask for. It makes no network requests and sends no telemetry. HTML reports include prompt snippets and file paths unless you pass `--redact`. The test suite uses synthetic fixtures only.

## Roadmap

- [ ] Verify the experimental parsers on real logs (please send sanitized samples)
- [ ] More agents: Cursor, Aider, Goose, Antigravity, pi-agent, Kimi
- [ ] `tokenscope watch`: live waste alerts for the current session ("cache expired: this message will cost $4")
- [ ] CI mode for headless agent runs (`--fail-over 20` dollars of waste)
- [ ] More detectors: context bloat before compaction, unused tool definitions, over-thinking on trivial turns, failed-edit retry storms
- [ ] Diff two time ranges ("what got more wasteful this week?")
- [ ] Opt-in pricing updates from a published feed

## Development

```bash
npm install
npm test          # builds, then vitest on synthetic fixtures
npm run smoke     # run the CLI against the fixtures
npm run demo      # generate synthetic logs + docs/demo-report.html
```

See [CONTRIBUTING.md](CONTRIBUTING.md). **Never commit real session logs.** They contain your prompts, code and secrets.

Parsers for agents other than Claude Code were written from each agent's source and cross-checked against [ccusage](https://github.com/ccusage/ccusage), [better-ccusage](https://github.com/cobra91/better-ccusage) and [splitrail](https://github.com/Piebald-AI/splitrail) (all MIT). Thank you to their authors. See [NOTICE](NOTICE).

## License

MIT
