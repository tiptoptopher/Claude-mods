import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register, Timer } from 'claude-code'

import type { AgentRow, ManualAction, PlanItem, PlanStatus, Question } from '../types'

const PANE = 'work-monitor'
const ENDED = ['completed', 'failed', 'killed']

const plan = atom({ plugin: 'work-monitor', key: 'plan' } as const, [], {
  shape: 'plan-1',
})
const agents = atom({ plugin: 'work-monitor', key: 'agents' } as const, [], {
  shape: 'agents-1',
})
const questions = atom({ plugin: 'work-monitor', key: 'questions' } as const, [], {
  shape: 'questions-1',
})
const actions = atom({ plugin: 'work-monitor', key: 'actions' } as const, [], {
  shape: 'actions-1',
})
const hasOpened = atom({ plugin: 'work-monitor', key: 'hasOpened' } as const, false)

const MARK: Record<PlanStatus, string> = {
  completed: '✓',
  in_progress: '▶',
  pending: '○',
}

const agentTone = (status: string) =>
  status === 'failed' || status === 'killed'
    ? 'error'
    : status === 'completed'
      ? 'success'
      : status === 'running'
        ? 'claude'
        : 'subtle'

const elapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

const bar = (done: number, total: number, width: number) => {
  const filled = total === 0 ? 0 : Math.round((done / total) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const isOpenQuestion = (q: Question) => q.status === 'open' || q.status === 'waiting'

// Questions asked in prose rather than through the question form: sentences
// ending in "?" outside code, quotes and tables.
const inlineQuestions = (answer: string) => {
  const found: string[] = []
  let isInFence = false
  for (const raw of answer.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('```')) {
      isInFence = !isInFence
      continue
    }
    if (isInFence || line.startsWith('>') || line.startsWith('|')) continue
    const plain = line
      .replace(/https?:\/\/\S+/g, '')
      .replace(/`[^`]*`/g, '')
      .replace(/[*_#]/g, '')
      .replace(/^[-\d.)\s]+/, '')
    for (const m of plain.matchAll(/[^.!?]*\?/g)) {
      const q = m[0].trim()
      if (q.length >= 12 && q.length <= 300) found.push(q)
    }
  }
  return found.slice(0, 8)
}

// The private action list page that keeps manual actions across sessions
// and devices. Only its owner can open it.
const ACTION_LIST_URL = 'https://claude.ai/artifact/5ozUugfu6bWgKWfaaTiRt9'
const TRACK_TOOL = 'track_manual_action'

const PROMPT_SECTION = {
  id: 'work-monitor:manual-actions',
  scope: 'session',
  text: [
    '# Manual actions for the user',
    `Whenever you hand the user something only they can do (change a setting, sign in or authorize a connector, create or change visibility of a repo, paste a script into environment settings, approve something, buy or install something), call the mcp__work-monitor__${TRACK_TOOL} tool once per action, in the same turn you ask for it. These are often roadblocks the user comes back to later, possibly from their phone, so:`,
    '- Give a short imperative title and the exact steps (where to click, what to paste).',
    '- Set device to "computer" when it needs a desktop or laptop (terminal commands, pasting long scripts, desktop-only settings, local files) and "phone" when it can be done from the Claude or GitHub mobile app or a mobile browser.',
    '- Say what it unblocks.',
    'Do not log actions you can do yourself, and do not log questions: ask those with the question form.',
  ].join('\n'),
} as const

const slug = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'action'

// Write one action to the action list page; false when the page could not
// be reached (the caller keeps it in the pane as `failed`).
const saveAction = async ($: EngineInterface, action: ManualAction, source?: string, sessionUrl?: string) => {
  const now = new Date((await $.clock.now())).toISOString()
  const ran = await $.tool.call({
    tool: 'ArtifactData',
    action: 'set',
    url: ACTION_LIST_URL,
    collection: 'actions',
    doc_id: action.id,
    data: {
      title: action.title,
      details: action.details ?? '',
      unblocks: action.unblocks ?? '',
      device: action.device,
      status: 'open',
      source: source ?? 'Claude Code',
      ...(sessionUrl ? { sessionUrl } : {}),
      createdAt: now,
    },
  } as never).catch(() => ({ deny: 'unreachable' }))

  return !('deny' in ran && ran.deny !== undefined) && !('isError' in ran && ran.isError)
}

// Sentences in a reply that hand the person something to do themselves.
const ACTION_HINT =
  /\b(you('ll| will)? need to|you'll have to|you have to|you need to|only you can|I can't do this|on your (computer|phone)|in (the )?(environment )?settings|(go|open|click|add|create|paste|sign in|enable|switch|make) (it |the |a |your )?\S+ (on|in|at|under) )/i
const COMPUTER_HINT = /\b(computer|desktop|laptop|terminal|command line|paste|setup script|local|pc)\b/i

const suggestedActions = (answer: string) => {
  const found: string[] = []
  let isInFence = false
  for (const raw of answer.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('```')) {
      isInFence = !isInFence
      continue
    }
    if (isInFence || line.startsWith('>') || line.startsWith('|')) continue
    const plain = line.replace(/`[^`]*`/g, m => m.slice(1, -1)).replace(/[*_#]/g, '').replace(/^[-\d.)\s]+/, '')
    for (const m of plain.matchAll(/[^.!?]*[.!?]?/g)) {
      const sentence = m[0].trim()
      if (sentence.length >= 15 && sentence.length <= 240 && !sentence.endsWith('?') && ACTION_HINT.test(sentence)) {
        found.push(sentence)
      }
    }
  }
  return found.slice(0, 5)
}

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Work monitor' })

// Open the pane by itself the first time there is something to watch.
const openOnce = async ($: EngineInterface) => {
  if (await read($, hasOpened)) return
  await update($, hasOpened, () => true)
  void openPane($)
}

const statusLine = async ($: EngineInterface) => {
  const items = await read($, plan)
  const rows = await read($, agents)
  const parts: string[] = []
  if (items.length > 0) {
    const done = items.filter(i => i.status === 'completed').length
    parts.push(`plan ${done}/${items.length}`)
  }
  const todo = (await read($, actions)).filter(a => a.status === 'tracked' || a.status === 'failed').length
  if (todo > 0) parts.unshift(`${todo} action${todo === 1 ? '' : 's'} for you`)
  const open = (await read($, questions)).filter(isOpenQuestion).length
  if (open > 0) parts.unshift(`${open} open question${open === 1 ? '' : 's'}`)
  const live = rows.filter(r => !ENDED.includes(r.status)).length
  if (live > 0) parts.push(`${live} agent${live === 1 ? '' : 's'} running`)
  $.ui.status(parts.length > 0 ? parts.join(' · ') : undefined)
}

// Merge the engine's agent list into the rows, keeping what only this mod
// counts (tool calls, timing) and announcing each agent that ends.
const refresh = async ($: EngineInterface) => {
  const list: AgentInfo[] = await $.agent.list()
  const now = await $.clock.now()
  const before = await read($, agents)
  const ended: AgentRow[] = []
  const rows = list.map(info => {
    const old = before.find(r => r.id === info.id)
    const isEnded = ENDED.includes(info.status)
    const row: AgentRow = {
      id: info.id,
      description: info.description || info.name || info.type,
      type: info.type,
      status: info.status,
      parentId: info.parentId,
      calls: old?.calls ?? 0,
      lastTool: old?.lastTool,
      startedAt: old?.startedAt ?? now,
      endedAt: isEnded ? (old?.endedAt ?? now) : undefined,
    }
    if (isEnded && old && !ENDED.includes(old.status)) ended.push(row)
    return row
  })
  await update($, agents, () => rows)
  for (const row of ended) {
    $.ui.toast(`Agent ${row.status}: ${row.description}`)
  }
  if (rows.length > 0) await openOnce($)
  await statusLine($)
}

export const register: Register = on => {
  let timer: Timer | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'work-monitor',
      description: 'Open the work monitor pane (actions, questions, plan steps and agents)',
    })
    await $.tool.register({
      name: TRACK_TOOL,
      description:
        'Log a manual action the user must take themselves (a setting, sign-in, repo change, approval) to their action list, which they open on any device. Call once per action, in the turn you ask for it.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short imperative title, e.g. "Make claude-mods public on GitHub"' },
          steps: { type: 'string', description: 'Exact steps: where to go, what to click or paste' },
          device: {
            type: 'string',
            enum: ['computer', 'phone'],
            description: '"computer" if it needs a desktop or laptop; "phone" if it can be done from a phone',
          },
          unblocks: { type: 'string', description: 'What this unblocks once done' },
          source: { type: 'string', description: 'Project or repository it belongs to' },
          sessionUrl: { type: 'string', description: 'Link back to this session, when known' },
        },
        required: ['title', 'device'],
      },
      isDeferred: false,
    })
    timer?.cancel()
    // Agents run between this session's own events: look again every 3s
    // while any is still going.
    timer = $.clock.every(3000, () => {
      void read($, agents).then(rows => {
        if (rows.some(r => !ENDED.includes(r.status))) void refresh($)
      })
    })
    await statusLine($)

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return { sections: [...composed.sections, PROMPT_SECTION] }
  })

  on('tool.call', { tool: 'mcp__work-monitor__track_manual_action' }, async ($, e) => {
    const input = e as unknown as {
      title?: string
      steps?: string
      device?: string
      unblocks?: string
      source?: string
      sessionUrl?: string
    }
    const title = (input.title ?? '').trim()
    if (!title) return { deny: 'title is required' }
    const action: ManualAction = {
      id: `${slug(title)}-${Math.round((await $.clock.now()) / 1000)}`,
      title,
      device: input.device === 'phone' ? 'phone' : 'computer',
      details: input.steps,
      unblocks: input.unblocks,
      status: 'tracked',
    }
    const isSaved = await saveAction($, action, input.source, input.sessionUrl)
    await update($, actions, list => [...list, { ...action, status: isSaved ? ('tracked' as const) : ('failed' as const) }].slice(-100))
    await statusLine($)
    await openOnce($)

    return {
      result: {
        isSaved,
        text: isSaved
          ? `Logged to the user's action list (${ACTION_LIST_URL}).`
          : `Could not reach the action list page; it is shown in the work monitor pane only. Tell the user to add it at ${ACTION_LIST_URL}.`,
      },
    } as never
  })
    .catch(() => ({ deny: 'The action could not be logged; tell the user in your reply instead.' }))

  on('command.run', { command: 'work-monitor' }, async $ => {
    await openPane($)

    return { text: 'Work monitor opened.' }
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId) {
      const id = e.agentId
      const tool = e.tool
      await update($, agents, rows =>
        rows.map(r => (r.id === id ? { ...r, calls: r.calls + 1, lastTool: tool } : r)),
      )
    }
    if (e.tool === 'AskUserQuestion' && !e.agentId) {
      const at = await $.clock.now()
      const asked: Question[] = e.questions.map((q, i) => ({
        id: `form-${at}-${i}`,
        text: q.question,
        kind: 'form',
        status: 'waiting',
        at,
      }))
      await update($, questions, list => [...list, ...asked].slice(-100))
      await statusLine($)
      const ran = await next(e)
      const answers = (ran.result as { answers?: Record<string, string> } | undefined)?.answers ?? {}
      await update($, questions, list =>
        list.map(q => {
          if (!asked.some(a => a.id === q.id)) return q
          const answer = answers[q.text]
          return answer
            ? { ...q, status: 'answered', answer }
            : { ...q, status: 'unanswered' }
        }),
      )
      await statusLine($)

      return ran
    }

    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const result = ran.result as Record<string, unknown> | undefined

    if (e.tool === 'TodoWrite') {
      const items: PlanItem[] = e.todos.map((t, i) => ({
        id: `todo-${i}`,
        subject: t.content,
        status: t.status,
        activeForm: t.activeForm,
      }))
      await update($, plan, () => items)
      await openOnce($)
    } else if (e.tool === 'TaskCreate') {
      const task = result?.task as { id?: string } | undefined
      const id = task?.id ?? `task-${Date.now()}`
      const item: PlanItem = {
        id,
        subject: e.subject,
        status: 'pending',
        activeForm: e.activeForm,
      }
      await update($, plan, items => [...items.filter(i => i.id !== id), item])
      await openOnce($)
    } else if (e.tool === 'TaskUpdate') {
      const { taskId, status, subject, activeForm } = e
      await update($, plan, items =>
        status === 'deleted'
          ? items.filter(i => i.id !== taskId)
          : items.map(i =>
              i.id === taskId
                ? {
                    ...i,
                    status: status ?? i.status,
                    subject: subject ?? i.subject,
                    activeForm: activeForm ?? i.activeForm,
                  }
                : i,
            ),
      )
    } else if (e.tool === 'Agent') {
      await refresh($)
    }
    if (['TodoWrite', 'TaskCreate', 'TaskUpdate'].includes(e.tool)) await statusLine($)

    return ran
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    await refresh($)

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    await refresh($)
    const spotted = e.agentId ? [] : suggestedActions(e.answer)
    if (spotted.length > 0) {
      const at = await $.clock.now()
      const known = await read($, actions)
      const fresh = spotted.filter(text => !known.some(a => a.title === text))
      if (fresh.length > 0) {
        await update($, actions, list =>
          [
            ...list,
            ...fresh.map((text, i): ManualAction => ({
              id: `${slug(text)}-${Math.round(at / 1000)}-${i}`,
              title: text,
              device: COMPUTER_HINT.test(text) ? 'computer' : 'phone',
              status: 'suggested',
            })),
          ].slice(-100),
        )
        await openOnce($)
      }
    }
    const asked = e.agentId ? [] : inlineQuestions(e.answer)
    if (asked.length > 0) {
      const at = await $.clock.now()
      await update($, questions, list =>
        [
          ...list,
          ...asked.map((text, i): Question => ({
            id: `inline-${at}-${i}`,
            text,
            kind: 'inline',
            status: 'open',
            at,
          })),
        ].slice(-100),
      )
      $.ui.toast(
        `Claude asked ${asked.length} question${asked.length === 1 ? '' : 's'} in its reply: see Work monitor`,
        { timeoutMs: 8000 },
      )
      await statusLine($)
      await openOnce($)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const items = await read($, plan)
    const rows = await read($, agents)
    const acts = await read($, actions)
    const tracked = acts.filter(a => a.status === 'tracked' || a.status === 'failed')
    const suggested = acts.filter(a => a.status === 'suggested')
    const qs = await read($, questions)
    const openQs = qs.filter(isOpenQuestion)
    const closedQs = qs.filter(q => !isOpenQuestion(q)).slice(-5)
    const now = await $.clock.now()
    const width = Math.max(10, Math.min(30, (e.props.bodyColumns ?? 40) - 16))
    const done = items.filter(i => i.status === 'completed').length

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>Actions for you</Text>
          {tracked.length === 0 && suggested.length === 0 && (
            <Text dimColor>No manual actions this session.</Text>
          )}
          {tracked.map(a => (
            <Text color={a.status === 'failed' ? 'error' : 'text'}>
              <Text color={a.device === 'computer' ? 'warning' : 'success'}>
                {a.device === 'computer' ? '[computer]' : '[phone ok]'}
              </Text>{' '}
              {a.title}
              {a.status === 'failed' ? ' (not saved to the list)' : ''}
            </Text>
          ))}
          {suggested.map(a => (
            <Box flexDirection="row" gap={1}>
              <Text dimColor>maybe: {a.title}</Text>
              <Button
                key={`track-${a.id}`}
                plain
                label="track"
                onPress={async () => {
                  const isSaved = await saveAction($, a)
                  await update($, actions, list =>
                    list.map(one => (one.id === a.id ? { ...one, status: isSaved ? ('tracked' as const) : ('failed' as const) } : one)),
                  )
                  await statusLine($)
                }}
              />
              <Button
                key={`dismiss-${a.id}`}
                plain
                label="dismiss"
                onPress={() =>
                  update($, actions, list =>
                    list.map(one => (one.id === a.id ? { ...one, status: 'dismissed' } : one)),
                  )
                }
              />
            </Box>
          ))}
          <Text dimColor>All open actions: {ACTION_LIST_URL}</Text>
        </Box>

        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text bold>Questions for you</Text>
            {closedQs.length > 0 && (
              <Button
                key="clear-questions"
                plain
                label="clear answered"
                onPress={async () => {
                  await update($, questions, list => list.filter(isOpenQuestion))
                  await statusLine($)
                }}
              />
            )}
          </Box>
          {qs.length === 0 && <Text dimColor>No questions yet.</Text>}
          {openQs.map(q => (
            <Box flexDirection="row" gap={1}>
              <Text color="warning">
                {q.kind === 'form' ? '? form' : '? inline'} {q.text}
              </Text>
              {q.kind === 'inline' && (
                <Button
                  key={`done-${q.id}`}
                  plain
                  label="answered"
                  onPress={async () => {
                    await update($, questions, list =>
                      list.map(one => (one.id === q.id ? { ...one, status: 'done' } : one)),
                    )
                    await statusLine($)
                  }}
                />
              )}
            </Box>
          ))}
          {closedQs.map(q => (
            <Text dimColor>
              {q.status === 'unanswered' ? '– skipped' : '✓'} {q.text}
              {q.answer ? ` → ${q.answer}` : ''}
            </Text>
          ))}
        </Box>

        <Box flexDirection="column">
          <Text bold>Plan</Text>
          {items.length === 0 ? (
            <Text dimColor>No plan steps yet.</Text>
          ) : (
            <Text>
              <Text color="success">{bar(done, items.length, width)}</Text> {done}/{items.length} done
            </Text>
          )}
          {items.map(i => (
            <Text
              color={i.status === 'in_progress' ? 'claude' : 'text'}
              dimColor={i.status === 'completed'}
              bold={i.status === 'in_progress'}
            >
              {MARK[i.status]} {i.status === 'in_progress' && i.activeForm ? i.activeForm : i.subject}
            </Text>
          ))}
        </Box>

        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text bold>Agents</Text>
            {rows.some(r => ENDED.includes(r.status)) && (
              <Button
                key="clear"
                plain
                label="clear finished"
                onPress={() => update($, agents, list => list.filter(r => !ENDED.includes(r.status)))}
              />
            )}
          </Box>
          {rows.length === 0 && <Text dimColor>No agents yet.</Text>}
          {rows.map(r => (
            <Text>
              <Text color={agentTone(r.status)}>{r.status.padEnd(9)}</Text>
              {r.parentId ? '↳ ' : ''}
              {r.description} <Text dimColor>
                ({r.type}, {r.calls} calls{r.lastTool ? `, last ${r.lastTool}` : ''},{' '}
                {elapsed((r.endedAt ?? now) - r.startedAt)})
              </Text>
            </Text>
          ))}
        </Box>
      </Box>
    )
  })
}
