import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'work-monitor',
  component: 'Pane',
  requestId: 'work-monitor',
  props: {
    title: 'Work monitor',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('plan steps and agents show in one pane', async ($, on) => {
  mock.clock(on)
  let nextId = 0
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({
    value: [{ id: 'a1', description: 'scan repo', type: 'Explore', status: 'running' }],
  }))
  on('tool.call', (_, e) =>
    e.tool === 'TaskCreate'
      ? ({ result: { task: { id: String(++nextId), subject: e.subject } } } as never)
      : ({ result: {} } as never),
  )

  await $.tool.call({ tool: 'TaskCreate', subject: 'Write tests', description: 'd' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Ship it', description: 'd' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'Agent', description: 'scan repo', prompt: 'p' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/x', agentId: 'a1' } as never)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /✓ Write tests/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /○ Ship it/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /scan repo/ }))?.text).toContain('1 calls, last Read')
    await ui.unmount()
  }
})

test('form questions resolve and inline questions stay open', async ($, on) => {
  mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [] }))
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  on('tool.call', () => ({ result: { answers: { 'Which license?': 'MIT' } } }) as never)

  await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [
      { question: 'Which license?', header: 'License', multiSelect: false, options: [] },
      { question: 'Public or private?', header: 'Visibility', multiSelect: false, options: [] },
    ],
  } as never)
  await $.turn.complete({
    answer: 'Done.\n```\nif (x?) {}\n```\nShould I push it now? See https://x.y/?a=1',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /✓ Which license\? → MIT/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /skipped Public or private\?/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\? inline Should I push it now\?/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /if \(x/ })).toBeUndefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const done = await ui.find({ type: 'Button', text: /^answered$/ })
  await ui.press({ key: done?.key ?? '' })
  expect(await ui.find({ type: 'Text', text: /✓ Should I push it now\?/ })).toBeDefined()
  await ui.unmount()
})

test('a tracked action is written to the action list page', async ($, on) => {
  mock.clock(on)
  const writes: Record<string, unknown>[] = []
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [] }))
  on('tool.call', (_, e) => {
    if (e.tool === 'ArtifactData') writes.push(e as never)
    return { result: {} } as never
  })

  const ran = await $.tool.call({
    tool: 'mcp__work-monitor__track_manual_action',
    title: 'Make claude-mods public',
    device: 'phone',
    steps: 'Settings, Change visibility',
  } as never)

  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatchObject({ action: 'set', collection: 'actions', data: { device: 'phone', status: 'open' } })
  expect((ran.result as { isSaved: boolean }).isSaved).toBe(true)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /\[phone ok\] Make claude-mods public/ })).toBeDefined()
  await ui.unmount()
})

test('a reply that hands over a manual step is offered for tracking', async ($, on) => {
  mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [] }))
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)

  await $.turn.complete({
    answer: 'Pushed.\n\nYou will need to paste the setup script into the environment settings on your computer.',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /maybe: You will need to paste the setup script/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /^track$/ })).toBeDefined()
  await ui.unmount()
})
