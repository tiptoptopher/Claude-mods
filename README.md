# claude-mods

Personal Claude Code mods.

## usage-meter

Shows how much of your context window and plan usage limits each prompt, and each step within a response, uses.

- **Band above the prompt:** context, 5-hour and 7-day limit bars, session cost, and the last prompt's change.
- **Status line:** `ctx 42% · 5h 31% · 7d 12% · $1.23`
- **Pane** (`/usage-meter`): current gauges with reset times, the steps of the current prompt (each model response, labeled with the tool calls that ran before it, with its context and cost change), per-prompt totals, the biggest context additions this session, and an on-demand breakdown of what fills the context.
- **Toasts** when context or a usage limit passes 80% and 95%.

Usage limits only appear on subscription plans. Cost appears where the plan reports it.

## work-monitor

Shows one pane (`/work-monitor`, which also opens the first time there's something to watch) with:

- **Plan:** the task or to-do steps Claude is working through, with a progress bar, ✓ / ▶ / ○ marks and the step running now.
- **Agents:** every subagent and background agent with its status, type, tool-call count, last tool and elapsed time. A toast appears when one finishes or fails.
- **Status line:** `plan 3/7 · 2 agents running`

## Install

```bash
/plugin install usage-meter --marketplace tiptoptopher/claude-mods
```

```bash
/plugin install work-monitor --marketplace tiptoptopher/claude-mods
```

Answer `y` to add the marketplace, then pick a scope.
