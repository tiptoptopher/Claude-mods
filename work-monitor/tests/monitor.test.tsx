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
