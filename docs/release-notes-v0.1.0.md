# tokenscope v0.1.0

**ccusage tells you what you spent. tokenscope tells you what you wasted.**

tokenscope reads the session logs your AI coding agents already keep on disk, finds the patterns that burn tokens for
nothing, estimates what each one cost, and tells you how to stop it. Then it shows the rest of your spend as a flame
graph. It runs locally, has zero dependencies and makes no network calls.

![npx tokenscope on synthetic logs](https://raw.githubusercontent.com/ranjan-mohanty/tokenscope/v0.1.0/docs/demo.gif)

## Highlights

- **Waste first.** The headline answers "how much could I have saved?", counting only realistic savings. Everything else
  (likely-avoidable rebuilds, huge outputs, breaks over an hour) is shown next to it and never added in.
- **Why your cache missed.** Every prompt-cache rebuild is classified: you paused to read, a tool or approval ran
  long (named, e.g. `Bash(npm run build) 12 min`), the prompt prefix changed, or the model switched. The 1-hour TTL is
  only suggested when it nets a saving after its higher write price.
- **Loops, repeats, re-reads and giant outputs**, each with a counterfactual dollar estimate and a one-line fix.
- **Honest coverage.** Each parser declares what its log format records. A check only runs where the data exists, and
  the report says which checks ran per agent. Missing data never shows up as $0 waste.
- **Three outputs:** a terminal summary, `--json` for scripting, and a single self-contained `--html` file with a
  zoomable flame graph down to individual API calls and subagents. `--redact` makes it safe to share.
- **12 agents:** Claude Code (verified on real logs), plus experimental parsers for Codex CLI, Gemini CLI, Qwen Code,
  OpenCode, Kilo CLI, Cline, Roo Code, Kilo Code, GitHub Copilot CLI, Factory Droid and Amp.

## Install

```bash
npx tokenscope               # waste first, then spend, in the terminal
npx tokenscope --html --open # interactive report with the flame graph
```

Needs Node 22+ (22.13+ to read OpenCode's SQLite database). No configuration, no API keys.

## Notes

- Costs are API list-price equivalents. Subscriptions (Claude Max, ChatGPT plans, Copilot) bill differently.
- Waste figures are estimates; [How waste is estimated](https://github.com/ranjan-mohanty/tokenscope#how-waste-is-estimated)
  explains every counterfactual.
- The experimental parsers were built from each agent's source and docs and tested on synthetic fixtures. If you use one,
  please run `npx tokenscope --source <agent>` and
  [send a sanitized sample](https://github.com/ranjan-mohanty/tokenscope/issues/new?template=sample-logs.yml) if the
  numbers look off.

Full changelog: [CHANGELOG.md](https://github.com/ranjan-mohanty/tokenscope/blob/v0.1.0/CHANGELOG.md)
