import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'usage-meter',
  component: 'Pane',
  requestId: 'usage-meter',
  props: {
    title: 'Usage meter',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const measure = (tokens: number, usd: number, five: number) => ({
  context: { tokens, window: 200_000, percent: Math.round((tokens / 200_000) * 100) },
  rateLimits: [
    { kind: 'five_hour', percentUsed: five },
    { kind: 'seven_day', percentUsed: 12 },
  ],
  cost: { usd },
  changed: ['context', 'cost'] as ('context' | 'cost')[],
})

test('a step is charged to the tool calls that ran before it', async ($, on) => {
  mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('command.register', () => ({ value: { command: 'usage-meter' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => e)
  on('tool.call', () => ({ result: {} }))
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure(measure(20_000, 0.1, 30))
  await $.prompt.submit({ text: 'run the tests' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.session.measure(measure(32_000, 0.15, 31))

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Bash: npm test/ }))?.text).toContain('+12.0k')
    expect(await ui.find({ type: 'Text', text: /#1 \+12\.0k ctx/ })).toBeDefined()
    await ui.unmount()
  }
})

test('crossing 80% raises one toast', async ($, on) => {
  const toasts: string[] = []
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.measure(measure(20_000, 0.1, 81))
  await $.session.measure(measure(21_000, 0.1, 82))
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('5h limit at 81%')
})
