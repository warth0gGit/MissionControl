export type ThreadState = 'needs-you' | 'working' | 'idle' | 'done' | 'failed'
export type Thread = {
  id: string
  title: string
  state: ThreadState
  rawState: string
  lastActivity: number
  step?: string
  stepsDone?: number
  stepsTotal?: number
  made: string[]
}
export type Sample = { t: number; pct: number }
export type Limit = { kind: string; pct: number; resetsAt?: number }
export type Board = { threads: Thread[]; fetchedAt: number; error?: string }

declare module 'claude-code' {
  interface PluginState {
    'mission-control': {
      board: Shaped<Board>
      limits: Shaped<Limit[]>
      samples: Shaped<Record<string, Sample[]>>
      view: 'tree' | 'map'
      showTips: boolean
      now: number
      contextPct: number
    }
  }
}
