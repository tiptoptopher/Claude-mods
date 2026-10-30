export type Limit = { kind: string; percent: number; resetsAt?: string }

export type Snapshot = {
  contextTokens?: number
  contextPercent?: number
  window: number
  usd?: number
  limits: Limit[]
}

// One model response inside a turn: what ran just before it, and what moved.
export type Step = {
  turn: number
  label: string
  contextTokens?: number
  contextDelta: number
  usdDelta: number
}

export type TurnSummary = {
  turn: number
  prompt: string
  steps: number
  contextDelta: number
  usdDelta: number
  seconds: number
  isOpen: boolean
}

export type Category = { name: string; tokens: number }

declare module 'claude-code' {
  interface PluginState {
    'usage-meter': {
      latest: Shaped<Snapshot | null>
      steps: Shaped<Step[]>
      turns: Shaped<TurnSummary[]>
      alerted: string[]
      isBandHidden: boolean
      breakdown: Category[] | null
    }
  }
}
