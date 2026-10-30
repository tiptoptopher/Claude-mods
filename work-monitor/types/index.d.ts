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

declare module 'claude-code' {
  interface PluginState {
    'work-monitor': {
      plan: Shaped<PlanItem[]>
      agents: Shaped<AgentRow[]>
      hasOpened: boolean
    }
  }
}
