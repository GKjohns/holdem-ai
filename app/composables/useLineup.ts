export type TableMode = 'play' | 'watch'

export interface Lineup {
  /** Play: you + 1–5 AIs. Watch: 2–6 AIs, nobody human. */
  mode: TableMode
  /** AI model ids, clockwise (Play: from the seat left of the human). */
  seats: string[]
  stack: number
  smallBlind: number
  bigBlind: number
}

/** The table picked on the setup screen. Lives in memory only: refresh = new session. */
export function useLineup() {
  return useState<Lineup | null>('lineup', () => null)
}

/** Default session spend cap, USD. */
export const DEFAULT_COST_CAP = 2

/** Hand #, blinds and session spend for the app header while a table is open, and a "leave" signal back to the page. */
export function useTableHeader() {
  const meta = useState<{ handNo: number, smallBlind: number, bigBlind: number, costUsd: number, capped: boolean } | null>('table-header', () => null)
  const leaveRequests = useState('table-leave', () => 0)
  /** Session spend cap in USD (default $2); kept across tables until refresh. */
  const costCap = useState('table-cost-cap', () => DEFAULT_COST_CAP)
  return { meta, leaveRequests, costCap }
}
