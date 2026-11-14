# Show HN

> Placeholders: `[MY_WASTE]` and `[MY_SPEND]` are numbers from your own logs (run `npx tokenscope` and copy the
> headline). Keep the "from my own logs" label next to them, or delete the sentence. Don't post until the repo is
> public and the package is on npm.

## Title

Show HN: Tokenscope – find the tokens your AI coding agent wasted (companion to ccusage)

## URL

https://github.com/ranjan-mohanty/tokenscope

## Body

I use ccusage to see what Claude Code costs me. It tells me the total, but not which part of it bought nothing. So I
built tokenscope: it reads the session logs your coding agent already keeps on disk and looks for specific patterns
that cost money without doing work:

- Prompt-cache rebuilds. If you spend 10 minutes reading the agent's answer, the 5-minute cache expires and the next
  message re-writes the whole context at the cache-write price instead of reading it at the cache-read price.
  tokenscope sorts each rebuild by cause (you paused, a slow tool or approval, a prompt-prefix change, a model switch)
  and only suggests the 1-hour TTL when it saves money after its higher write price.
- Loops: the same command, same input, same failure, five times in a row.
- The same file re-read with no edit in between.
- A 60k-token log cat-ed into context, then paid for again on every later request.

Every finding gets a counterfactual dollar estimate ("what this would have cost if X had been done differently",
priced with the same table as the spend) and a one-line fix. The headline counts only the realistic savings. Things
that are probably avoidable but might have been deliberate, like compaction or a model switch, are shown separately.

On my own logs last month it flagged about [MY_WASTE] of [MY_SPEND]. That's one person's usage, not a benchmark.

Other details:

- Zero runtime dependencies, runs locally, no network calls. `npx tokenscope` for the terminal, `--html` for a
  self-contained report with a flame graph of spend, `--json` for scripting, `--redact` for sharing.
- Claude Code is verified on real logs. Codex, Gemini CLI, Qwen Code, OpenCode, Cline, Roo, Kilo, Copilot CLI, Droid
  and Amp are experimental: built from their source and docs, tested on synthetic fixtures. Each parser declares what
  its logs record. If a format has no per-request tokens, the cache check is reported as "not checked" rather than $0.
- Costs are API list-price equivalents, so on a subscription read them as "how much quota went where".

It's not a replacement for ccusage, which covers more agents and has live billing blocks. I run ccusage to track the
bill and tokenscope when the bill surprises me.

I'd especially like (sanitized) sample logs from the experimental agents, and opinions on whether the waste estimates
are too conservative or not conservative enough.
