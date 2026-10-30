import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register, Timer } from 'claude-code'

import type { AgentRow, PlanItem, PlanStatus, Question } from '../types'

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
      description: 'Open the work monitor pane (questions, plan steps and agents)',
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
    const qs = await read($, questions)
    const openQs = qs.filter(isOpenQuestion)
    const closedQs = qs.filter(q => !isOpenQuestion(q)).slice(-5)
    const now = await $.clock.now()
    const width = Math.max(10, Math.min(30, (e.props.bodyColumns ?? 40) - 16))
    const done = items.filter(i => i.status === 'completed').length

    return (
      <Box flexDirection="column" gap={1}>
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
