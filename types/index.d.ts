/** One plan window as the engine last reported it (`five_hour`, `seven_day`, a gateway's `spend_limit`). */
export type CuotaLimit = { kind: string; percentUsed: number; resetsAt?: string }

/** The figures the band and the pane draw from, taken from `session.measure` or `$.session.usage()`. */
export type CuotaReading = {
  at: number
  startedAt: number
  tokens?: number
  window: number
  percent?: number
  limits: CuotaLimit[]
  costUsd?: number
}

/** The model that answered the last main-thread request, and whether it was a fallback. */
export type CuotaModel = { model: string; effort?: string; isFallback: boolean }

/** One row of the context breakdown, as /context groups it. */
export type CuotaCategory = { name: string; tokens: number }

/** What the pane and the band draw from the shared history in `$.store`. */
export type CuotaHistory = {
  /** The five-hour window's percent per 10-minute slot, oldest first, over the last 5 hours. */
  fiveSeries: (number | null)[]
  /** Seven rows (oldest day first) of 24 hourly peaks of the five-hour window. */
  week: (number | null)[][]
  /** The weekday label of each row of `week`. */
  weekDays: string[]
}

/** What the compaction advice learns as the session runs. */
export type CuotaCompact = {
  /** When the main thread last got a response: the prompt cache's clock starts there. */
  lastResponseAt: number
  /** Model requests per main-thread turn, as a running average; 0 until a turn has finished. */
  stepsPerTurn: number
  /** How big a compaction summary comes out: a default until a real compaction measures it. */
  summaryTokens: number
  isSummaryMeasured: boolean
  /** The smallest context seen this session: what compacting cannot remove (system prompt, tools, MCP, memory). */
  baseTokens?: number
  /** Where the engine compacts on its own, from the /context breakdown. */
  autoCompactAt?: number
  isAutoCompact?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    cuota: {
      compact: CuotaCompact | null
      reading: CuotaReading | null
      model: CuotaModel | null
      tick: number
      dismissed: string[]
      toasted: string[]
      breakdown: CuotaCategory[] | null
      history: CuotaHistory | null
      paneOpen: boolean
    }
  }
}
