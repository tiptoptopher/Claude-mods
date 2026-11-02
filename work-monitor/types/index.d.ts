export type PlanStatus = 'pending' | 'in_progress' | 'completed'

export type PlanItem = {
  id: string
  subject: string
  status: PlanStatus
  activeForm?: string
}

export type AgentRow = {
  id: string
  description: string
  type: string
  status: string
  parentId?: string
  calls: number
  lastTool?: string
  startedAt: number
  endedAt?: number
}

// A question Claude asked: through the question form (`form`) or in prose
// (`inline`). `waiting` is on screen in the form; `open` and `unanswered`
// (skipped in the form) still need a reply; `answered`, `done` (marked by
// hand) and `dismissed` are closed.
export type Question = {
  id: string
  text: string
  kind: 'form' | 'inline'
  status: 'waiting' | 'answered' | 'unanswered' | 'open' | 'done' | 'dismissed'
  answer?: string
  at: number
}

// Something only the person can do. `tracked` is on the action list page;
// `suggested` was spotted in a reply and waits for the person to track or
// dismiss it; `failed` could not be written to the page.
export type ManualAction = {
  id: string
  title: string
  device: 'computer' | 'phone'
  details?: string
  unblocks?: string
  status: 'tracked' | 'suggested' | 'dismissed' | 'failed'
}

declare module 'claude-code' {
  interface PluginState {
    'work-monitor': {
      plan: Shaped<PlanItem[]>
      agents: Shaped<AgentRow[]>
      questions: Shaped<Question[]>
      actions: Shaped<ManualAction[]>
      isAnsweredShown: boolean
      hasOpened: boolean
    }
  }
}
