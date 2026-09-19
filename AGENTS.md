# AGENTS.md — System instructions for AI coding agents

## Core operating principle

> **Stop. Check. Act. Learn. Repeat.**
>
> Before every tool call, verify you are not repeating yourself. After every result,
> record what you learned. If you detect a loop or a hallucination, intervene.

## 1. Loop prevention

Before calling a tool, ask yourself:
- "Have I called this same tool with these same arguments in the last N steps?"
- "Am I getting the same result each time?"

**If yes → stop repeating.** Instead:
1. **Re-read** the most recent tool output carefully.
2. **Identify** what actually changed (or what didn't).
3. **Pivot**: try a different function, change your parameters, or decompose the task
   into smaller sub-steps.

### Concrete tactics
- If `grep`/`glob` returns the same result 3 times → broaden the search pattern
  or look in a different directory.
- If `read` → `edit` → `read` → same error → re-read the file fully, check for
  tabs vs spaces, check the exact line numbers, or ask for help.
- If a bash command fails the same way twice → add `set -x` or `--verbose`, or
  try a different approach entirely.

## 2. Hallucination prevention

Every claim in your output must be traceable to a tool result. The agent-guard
module (`agent-guard.js`) tracks this automatically. Respect its feedback.

### Rules
- Never claim a file was written/edited without seeing a success result.
- Never claim a command succeeded without seeing the output.
- Never assume a file exists — `read` it first or use `glob`.
- Verify environment variables, package versions, and file paths against
  actual tool output, not memory.

### Fact-checking checklist
Before stating "X is true":
1. Do I have a tool result that shows X? If not, verify before claiming.
2. If I'm reading a file path from a result, does that path actually exist?
3. If I'm quoting output, did I copy it verbatim?

## 3. Learning from every interaction

Every tool call, result, and decision is logged to `.kilo/agent-guard/`. The
agent-guard module builds a per-session log and a cross-session index of
"what worked" and "what failed."

### How to use the learning log
- Before starting a task, check if similar sessions exist:
  `ls .kilo/agent-guard/` and look for sessions with similar tool patterns.
- If past sessions with the same tools also failed, try a different approach.
- After completing a task, the session log is persisted automatically.

### Context refresh
When context runs low, inject a snapshot of what the agent knows:
```js
import { contextSnapshot } from './agent-guard.js';
console.log(contextSnapshot(guard));
```

## 4. Integration with the x402 server

`agent-guard.js` is a standalone loop/hallucination-tracking utility with its
own tests-adjacent usage (see its exports), but it is **not currently wired
into the running server** — `growth.js`, `agent.js` and `index.js` do not
import it. The loop/cycle detection those modules actually rely on
(`GROWTH_MAX_PER_CYCLE`, the task agent's step budget, backoff on
unresponsive peers) is implemented directly in each module. Treat
`agent-guard.js` as available for a coding agent's own session hygiene (per
sections 1–3 above), not as something already protecting production traffic.
If you wire it into `growth.js`/`agent.js`/`index.js`, update this section to
match and add test coverage under `test/`.

## 5. Debug-aware workflow

When debugging:
1. **Isolate**: reproduce the issue in the smallest possible scope.
2. **Instrument**: add targeted logging or a test to confirm the hypothesis.
3. **Fix**: make the smallest change that addresses the root cause.
4. **Verify**: run the relevant tests and check the output.
5. **Learn**: record the root cause and fix in the agent-guard log.

**Never** make blind changes hoping one of them works. Always have a hypothesis.

## 6. Guard thresholds (configurable via env)

| Variable | Default | Description |
|---|---|---|
| `GUARD_MAX_ITERATIONS` | 80 | Max tool calls before forced checkpoint |
| `GUARD_LOOP_THRESHOLD` | 3 | Identical consecutive calls = loop |
| `GUARD_CYCLE_THRESHOLD` | 2 | Identical call+result pairs = cycle |
| `GUARD_DURABLE` | true (prod) | Persist logs to `.kilo/agent-guard/` |
