# r/ClaudeAI post

> The numbers below are the author's own (measured 2026-11-14 over Oct 17 → Nov 14); keep them labelled as such. Check the subreddit's self-promotion rules and use the flair it asks for (likely "Built with Claude" or "Tool").
> Attach `docs/demo.gif` or link the repo.

## Title

I built a tool that finds where Claude Code wasted tokens: cache rebuilds, loops, re-reads (companion to ccusage)

## Body

ccusage shows what Claude Code cost. I wanted to know which part of that was wasted, so I wrote **tokenscope**. It
reads your local `~/.claude/projects` logs and flags:

- **Cache rebuilds while you were reading.** Reply after more than 5 minutes and the prompt cache has expired, so the
  whole context is written again at the cache-write price. It also catches rebuilds caused by a long tool call
  (`Bash(npm run build) 12 min`), by editing CLAUDE.md or toggling MCP servers mid-session, and by switching models.
- **Loops.** The same command with the same result several times in a row.
- **Unchanged re-reads.** The same file and range read again with nothing edited in between.
- **Huge tool outputs** that every later request has to carry.

Each finding comes with an estimated cost and a concrete fix, e.g. `"promptCacheTtl": "1h"` in
`~/.claude/settings.json`. That one is only suggested when it actually nets a saving, because 1h cache writes cost
more. It never suggests `/clear` to "save" tokens, because rebuilding the context costs about the same.

On my own logs it found roughly $467 out of $1,746 over the last four weeks (27%), mostly cache rebuilds while I was reading or replying. Yours will differ: it depends a lot on how
often you step away mid-session.

```
npx tokenscope               # terminal summary, waste first
npx tokenscope --html --open # report with a flame graph of spend
```

- Runs 100% locally, no network calls, zero dependencies. `--redact` if you want to share a report.
- Prices are API list-price equivalents. On Max it's more "where did my quota go" than dollars.
- Also reads Codex, Gemini CLI, OpenCode, Cline, Roo, Copilot CLI and a few more. Those parsers are experimental, and
  sample logs are very welcome.

Repo: https://github.com/ranjan-mohanty/tokenscope

Happy to answer questions about how the estimates work. The README has the exact counterfactual for each pattern.
