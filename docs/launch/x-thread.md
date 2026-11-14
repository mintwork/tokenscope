# X / Twitter thread

> Tweet 4 uses the author's own numbers (measured 2026-11-14, Oct 17 → Nov 14). Keep the "my own logs" label. Attach `docs/demo.gif` to tweet 1 and `docs/demo.png` to tweet 5. Each tweet is under 280 characters.

**1/**
ccusage tells you what your AI coding agent cost.

tokenscope tells you what it wasted: cache rebuilds, loops, re-reads, giant tool outputs. Each one gets a $ estimate and a fix.

npx @mintwork/tokenscope

[demo.gif]

**2/**
The biggest one is the prompt cache. Step away for 10 minutes to read the agent's answer and the 5-min cache expires, so your next message re-writes the whole context at the write price.

tokenscope finds each rebuild and says why it happened.

**3/**
The cause matters because the fix is different:
- you paused → 1h cache TTL (only if it nets a saving)
- slow tool → run it in the background
- edited CLAUDE.md mid-session → don't
- break over an hour → nothing to fix, so it's not counted

**4/**
My own logs: ≈$467 of $1,746 (27%) over 4 weeks was avoidable, mostly via a 1-hour cache TTL. One person, not a benchmark.

It also catches `npm test` run 5× for the same failure, and files re-read with nothing edited.

**5/**
--html writes one self-contained file with a flame graph of spend, down to single API calls and subagents.

Local only, zero deps, no network calls. Claude Code is verified on real logs; Codex, Gemini CLI, OpenCode, Cline, Roo, Copilot CLI and more are experimental.

[demo.png]

**6/**
It's MIT-licensed and meant to run alongside ccusage, not replace it.

Sample logs from the experimental agents would help a lot.

github.com/mintwork/tokenscope 