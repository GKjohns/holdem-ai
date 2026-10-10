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

/** Hand # + blinds for the app header while a table is open, and a "leave" signal back to the page. */
export function useTableHeader() {
  const meta = useState<{ handNo: number, smallBlind: number, bigBlind: number } | null>('table-header', () => null)
  const leaveRequests = useState('table-leave', () => 0)
  return { meta, leaveRequests }
}
