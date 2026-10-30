import type { Register } from 'claude-code'

const SECTION = {
  id: 'ask-with-choices:style',
  scope: 'session',
  text: [
    '# Asking the user questions',
    'The user prefers to answer questions in the question form, not in prose. Whenever you need a decision or information from the user, ask with the AskUserQuestion tool instead of writing the question inline in your reply:',
    '- Make each question multiple choice with 2-4 clear options, putting a recommended option first and labeling it "(Recommended)". The form always adds an "Other" field for a free-text answer, so do not add one yourself.',
    '- Use a free-text question only when the answer cannot reasonably be listed as options (a name, a URL, a description).',
    '- Group related questions into one call (up to 4).',
    '- Do not end a reply with open questions in prose. If a question is optional or can wait, say what you will assume instead.',
  ].join('\n'),
} as const

export const register: Register = on => {
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes('AskUserQuestion')) return composed

    return { sections: [...composed.sections, SECTION] }
  })
}
