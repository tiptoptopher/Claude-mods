import { expect, test } from 'claude-code/testing'

const COMPOSE = {
  model: 'm',
  promptModel: 'm',
  surfaces: ['desktop'],
  outputStyle: null,
  traits: [],
} as const

test('the preference joins the system prompt where the question form exists', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))

  const withForm = await $.prompt.compose({ ...COMPOSE, tools: ['AskUserQuestion', 'Bash'] })
  expect(withForm.sections.at(-1)?.id).toBe('ask-with-choices:style')

  const without = await $.prompt.compose({ ...COMPOSE, tools: ['Bash'] })
  expect(without.sections).toHaveLength(1)
})
