import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Limit, Snapshot, Step, TurnSummary } from '../types'

const PANE = 'usage-meter'
const THRESHOLDS = [80, 95]
const MAX_STEPS = 400
const MAX_TURNS = 100

const latest = atom({ plugin: 'usage-meter', key: 'latest' } as const, null, {
  shape: 'snapshot-1',
})
const steps = atom({ plugin: 'usage-meter', key: 'steps' } as const, [], {
  shape: 'steps-1',
})
const turns = atom({ plugin: 'usage-meter', key: 'turns' } as const, [], {
  shape: 'turns-1',
})
const alerted = atom({ plugin: 'usage-meter', key: 'alerted' } as const, [])
const isBandHidden = atom(
  { plugin: 'usage-meter', key: 'isBandHidden' } as const,
  false,
)
const breakdown = atom({ plugin: 'usage-meter', key: 'breakdown' } as const, null)

const LIMIT_NAMES: Record<string, string> = {
  five_hour: '5h',
  seven_day: '7d',
  spend_limit: 'spend',
}

const limitName = (kind: string) => LIMIT_NAMES[kind] ?? kind

const kTokens = (n: number) =>
  Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`

const signed = (n: number, fmt: (n: number) => string) =>
  `${n >= 0 ? '+' : '-'}${fmt(Math.abs(n))}`

const usd = (n: number) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`

const bar = (percent: number, width: number) => {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const tone = (percent: number) =>
  percent >= 95 ? 'error' : percent >= 80 ? 'warning' : 'success'

const resetIn = (iso: string | undefined, now: number) => {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const h = Math.floor(ms / 3_600_000)
  const m = Math.round((ms % 3_600_000) / 60_000)
  return h >= 24 ? ` resets in ${Math.floor(h / 24)}d ${h % 24}h` : ` resets in ${h}h ${m}m`
}

// A short name for what a tool call did, so a step reads "Bash: npm test".
const describe = (e: { tool: string; agentId?: string }) => {
  const a = e as unknown as Record<string, unknown>
  const hint =
    a.command ?? a.description ?? a.file_path ?? a.pattern ?? a.url ?? a.query ?? a.subject
  const text = typeof hint === 'string' ? (hint.split('\n')[0] ?? '') : ''
  const short = text.length > 40 ? `${text.slice(0, 39)}…` : text
  const base = text.includes('/') && !a.command ? text.split('/').pop() : short
  return `${e.agentId ? '↳ ' : ''}${e.tool}${base ? `: ${base}` : ''}`
}

const summarize = (labels: string[]) =>
  labels.length === 0
    ? 'model reply / reasoning'
    : labels.length <= 3
      ? labels.join(', ')
      : `${labels.slice(0, 3).join(', ')} +${labels.length - 3} more`

const statusText = (s: Snapshot) => {
  const parts = [`ctx ${s.contextPercent ?? 0}%`]
  for (const l of s.limits) parts.push(`${limitName(l.kind)} ${l.percent}%`)
  if (s.usd !== undefined) parts.push(usd(s.usd))
  return parts.join(' · ')
}

export const register: Register = on => {
  // Tool calls since the last model response: the cause of the next delta.
  let pending: string[] = []
  let turnStartedAt = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-meter',
      description: 'Open the usage meter pane (context, limits, cost per prompt and step)',
    })
    const s = await read($, latest)
    if (s) $.ui.status(statusText(s))

    return next(e)
  })

  on('command.run', { command: 'usage-meter' }, async $ => {
    await update($, isBandHidden, () => false)
    await $.ui.open({ id: PANE, title: 'Usage meter' })

    return { text: 'Usage meter opened.' }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.isMeta) return next(e)
    pending = []
    turnStartedAt = await $.clock.now()
    const prompt = (e.text.split('\n')[0] ?? '').slice(0, 80)
    await update($, turns, list => {
      const turn = (list.at(-1)?.turn ?? 0) + 1
      const open: TurnSummary = {
        turn,
        prompt,
        steps: 0,
        contextDelta: 0,
        usdDelta: 0,
        seconds: 0,
        isOpen: true,
      }
      return [...list.map(t => ({ ...t, isOpen: false })), open].slice(-MAX_TURNS)
    })

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', ($, e, next) => {
    pending.push(describe(e))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    const prev = await read($, latest)
    const limits: Limit[] = e.rateLimits.map(l => ({
      kind: l.kind,
      percent: l.percentUsed,
      resetsAt: l.resetsAt,
    }))
    const snap: Snapshot = {
      contextTokens: e.context.tokens,
      contextPercent: e.context.percent,
      window: e.context.window,
      usd: e.cost?.usd,
      limits,
    }
    const contextDelta =
      prev?.contextTokens !== undefined && snap.contextTokens !== undefined
        ? snap.contextTokens - prev.contextTokens
        : 0
    const usdDelta =
      prev?.usd !== undefined && snap.usd !== undefined ? snap.usd - prev.usd : 0
    await update($, latest, () => snap)
    $.ui.status(statusText(snap))

    const isStep = e.changed.includes('context') || e.changed.includes('cost')
    const current = (await read($, turns)).at(-1)
    if (isStep && current?.isOpen) {
      const step: Step = {
        turn: current.turn,
        label: summarize(pending),
        contextTokens: snap.contextTokens,
        contextDelta,
        usdDelta,
      }
      pending = []
      await update($, steps, list => [...list, step].slice(-MAX_STEPS))
      await update($, turns, list =>
        list.map(t =>
          t.turn === current.turn
            ? {
                ...t,
                steps: t.steps + 1,
                contextDelta: t.contextDelta + contextDelta,
                usdDelta: t.usdDelta + usdDelta,
              }
            : t,
        ),
      )
    }

    // Toast once per threshold crossed; forget it once the meter falls back
    // below (a window reset or a compaction).
    const gauges = [
      { key: 'context', name: 'Context', percent: snap.contextPercent ?? 0 },
      ...limits.map(l => ({ key: l.kind, name: `${limitName(l.kind)} limit`, percent: l.percent })),
    ]
    const was = await read($, alerted)
    const now = new Set(was)
    for (const g of gauges) {
      for (const t of THRESHOLDS) {
        const id = `${g.key}:${t}`
        if (g.percent >= t && !now.has(id)) {
          now.add(id)
          $.ui.toast(`${g.name} at ${g.percent}% (passed ${t}%)`, { timeoutMs: 8000 })
        } else if (g.percent < t) {
          now.delete(id)
        }
      }
    }
    if (now.size !== was.length || [...now].some(id => !was.includes(id))) {
      await update($, alerted, () => [...now])
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e)
    const seconds = Math.round(((await $.clock.now()) - turnStartedAt) / 1000)
    await update($, turns, list =>
      list.map(t => (t.isOpen ? { ...t, seconds, isOpen: false } : t)),
    )

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, latest)
    if (e.props.hasSurvey || snap === null || (await read($, isBandHidden))) {
      return next(e)
    }
    const { Box, Button, Text } = $.ui.resolve(e)
    const last = (await read($, turns)).at(-1)
    const ctx = snap.contextPercent ?? 0
    const width = (e.props.bodyColumns ?? 80) < 70 ? 6 : 10

    return (
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        <Text>
          ctx <Text color={tone(ctx)}>{bar(ctx, width)}</Text> {ctx}%
        </Text>
        {snap.limits.map(l => (
          <Text>
            {limitName(l.kind)} <Text color={tone(l.percent)}>{bar(l.percent, width)}</Text>{' '}
            {l.percent}%
          </Text>
        ))}
        {snap.usd !== undefined && <Text>{usd(snap.usd)}</Text>}
        {last && (
          <Text dimColor>
            {last.isOpen ? 'this prompt' : 'last prompt'}: {signed(last.contextDelta, kTokens)} ctx,{' '}
            {signed(last.usdDelta, usd)}, {last.steps} steps
          </Text>
        )}
        <Button key="open" plain label="details" onPress={() => $.ui.open({ id: PANE, title: 'Usage meter' })} />
        <Button key="hide" plain label="hide" onPress={() => update($, isBandHidden, () => true)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const snap = await read($, latest)
    const turnList = await read($, turns)
    const stepList = await read($, steps)
    const cats = await read($, breakdown)
    const now = await $.clock.now()
    const width = Math.max(10, Math.min(30, (e.props.bodyColumns ?? 40) - 24))

    if (snap === null) {
      return <Text dimColor>No usage reading yet: send a prompt.</Text>
    }

    const ctx = snap.contextPercent ?? 0
    const recentTurns = turnList.slice(-8).reverse()
    const shownTurn = turnList.at(-1)?.turn
    const turnSteps = stepList.filter(s => s.turn === shownTurn)
    const costliest = [...stepList]
      .sort((a, b) => b.contextDelta - a.contextDelta)
      .slice(0, 5)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>Now</Text>
          <Text>
            Context <Text color={tone(ctx)}>{bar(ctx, width)}</Text> {ctx}%{' '}
            <Text dimColor>
              {kTokens(snap.contextTokens ?? 0)} / {kTokens(snap.window)}
            </Text>
          </Text>
          {snap.limits.map(l => (
            <Text>
              {limitName(l.kind).padEnd(7)} <Text color={tone(l.percent)}>{bar(l.percent, width)}</Text>{' '}
              {l.percent}%<Text dimColor>{resetIn(l.resetsAt, now)}</Text>
            </Text>
          ))}
          {snap.limits.length === 0 && (
            <Text dimColor>No usage-limit reading (shown on subscription plans).</Text>
          )}
          {snap.usd !== undefined && <Text>Cost    {usd(snap.usd)}</Text>}
        </Box>

        <Box flexDirection="column">
          <Text bold>Steps in prompt {shownTurn ?? '-'}</Text>
          {turnSteps.length === 0 && <Text dimColor>No steps yet.</Text>}
          {turnSteps.slice(-12).map(s => (
            <Text>
              <Text color={s.contextDelta > 10_000 ? 'warning' : 'text'}>
                {signed(s.contextDelta, kTokens).padStart(7)}
              </Text>{' '}
              <Text dimColor>{signed(s.usdDelta, usd).padStart(7)}</Text> {s.label}
            </Text>
          ))}
        </Box>

        <Box flexDirection="column">
          <Text bold>Per prompt</Text>
          {recentTurns.map(t => (
            <Text>
              #{t.turn} {signed(t.contextDelta, kTokens)} ctx, {signed(t.usdDelta, usd)}, {t.steps} steps
              {t.isOpen ? ' (running)' : `, ${t.seconds}s`} <Text dimColor>{t.prompt}</Text>
            </Text>
          ))}
        </Box>

        <Box flexDirection="column">
          <Text bold>Biggest context adds this session</Text>
          {costliest.map(s => (
            <Text>
              {signed(s.contextDelta, kTokens).padStart(7)} <Text dimColor>#{s.turn}</Text> {s.label}
            </Text>
          ))}
        </Box>

        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text bold>What fills the context</Text>
            <Button
              key="breakdown"
              plain
              label={cats ? 'refresh' : 'measure'}
              onPress={async () => {
                const u = await $.session.usage({ breakdown: 'summary' })
                const rows = (u.context.breakdown?.categories ?? [])
                  .filter(c => !c.isDeferred && c.tokens > 0)
                  .map(c => ({ name: c.name, tokens: c.tokens }))
                await update($, breakdown, () => rows)
              }}
            />
          </Box>
          {cats?.map(c => (
            <Text>
              {kTokens(c.tokens).padStart(7)} {c.name}
            </Text>
          ))}
        </Box>
      </Box>
    )
  })
}
