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

- **Actions for you:** manual steps only you can do (a setting, a sign-in, a repo change), tagged `[computer]` or `[phone ok]`. Claude logs each one with a `track_manual_action` tool, which also saves it to your private **action list page** so you can come back to it later from any device and tick it off. Sentences in Claude's replies that look like a manual step it didn't log appear as "maybe" with **track** and **dismiss** buttons.
- **Questions for you:** every question Claude asked. Questions from the question form show as answered (with your answer) or skipped. Questions Claude wrote in its reply stay open, with an "answered" button, until you mark them, and a toast tells you when a reply contains any.
- **Plan:** the task or to-do steps Claude is working through, with a progress bar, ✓ / ▶ / ○ marks and the step running now.
- **Agents:** every subagent and background agent with its status, type, tool-call count, last tool and elapsed time. A toast appears when one finishes or fails.
- **Status line:** `1 action for you · 1 open question · plan 3/7 · 2 agents running`

## ask-with-choices

Adds a short instruction to Claude's system prompt: when it needs a decision or information from you, it should ask through the question form as multiple choice (2-4 options, the recommended one first) rather than leaving questions in its reply. The form always includes an "Other" field for a free-text answer, and Claude falls back to a free-text question only when the answer can't be listed.

## Install

```bash
/plugin install usage-meter --marketplace tiptoptopher/claude-mods
```

```bash
/plugin install work-monitor --marketplace tiptoptopher/claude-mods
```

```bash
/plugin install ask-with-choices --marketplace tiptoptopher/claude-mods
```

Answer `y` to add the marketplace, then pick a scope.

## On by default in every cloud session

Cloud sessions start in a fresh container, so add this to the cloud environment's **Setup script** (the environment menu in the session's title bar, then **Edit**). It needs this repository to be public.

```bash
# Install Claude mods from tiptoptopher/claude-mods for every new session.
# Failures are reported but never stop the session from starting.
if command -v claude >/dev/null 2>&1; then
  claude plugin marketplace add tiptoptopher/claude-mods || echo "claude-mods: marketplace add failed"
  for mod in usage-meter work-monitor ask-with-choices; do
    claude plugin install "$mod@claude-mods" --scope user || echo "claude-mods: install of $mod failed"
  done
fi
```
