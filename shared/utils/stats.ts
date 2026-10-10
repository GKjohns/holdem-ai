/**
 * Per-seat session stats from finished hands and decision logs. Pure (relative imports, no Nuxt)
 * so tests and bench scripts run it under bare Node. These numbers go to the UI, the narrator and
 * the planner only, never into a seated model's prompt.
 *
 * Definitions (standard HUD conventions):
 * - VPIP: hands where the seat put chips in preflop by choice (call, raise or all-in; blinds don't count).
 * - PFR: hands with a preflop raise.
 * - AF: postflop (bets + raises) / calls.
 * - WTSD: hands that reached showdown, out of hands where the seat saw the flop.
 * - W$SD: showdowns where the seat won at least one pot.
 */
import { costUsd } from './pricing.ts'
import type { ActionEvent, Card, Decision, HandResult } from './types.ts'

export interface StatsHand {
  handNo: number
  board: Card[]
  log: ActionEvent[]
  /** Hole cards per seat; an empty array means the seat sat out (busted). */
  holes: Record<string, Card[]>
  shown: HandResult['shown']
  pots: HandResult['pots']
}
export interface StatsDecision { seatId: string, decision: Decision }

export interface SeatStats {
  seatId: string
  hands: number
  /** Percentages 0–100, or null when the denominator is 0. */
  vpip: number | null
  pfr: number | null
  /** null with no postflop calls or aggression; Infinity when aggressive but never called. */
  af: number | null
  wtsd: number | null
  wsd: number | null
  /** Raw counts behind the rates, for the narrator and tests. */
  counts: { vpip: number, pfr: number, bets: number, calls: number, sawFlop: number, showdowns: number, wonAtShowdown: number }
  decisions: number
  avgMs: number | null
  costUsd: number
}

const pct = (n: number, d: number) => d ? (n / d) * 100 : null

export function seatStats(seatIds: string[], hands: StatsHand[], decisions: StatsDecision[]): SeatStats[] {
  return seatIds.map((id) => {
    const c = { vpip: 0, pfr: 0, bets: 0, calls: 0, sawFlop: 0, showdowns: 0, wonAtShowdown: 0 }
    let dealt = 0
    for (const h of hands) {
      if (!h.holes[id]?.length) continue
      dealt++
      const mine = h.log.filter(e => e.seatId === id)
      const pre = mine.filter(e => e.street === 'preflop')
      if (pre.some(e => e.added > 0)) c.vpip++
      if (pre.some(e => e.raiseTo !== undefined)) c.pfr++
      for (const e of mine) {
        if (e.street === 'preflop' || e.added === 0) continue
        if (e.raiseTo !== undefined) c.bets++
        else c.calls++
      }
      const foldedPre = pre.some(e => e.action.type === 'fold')
      if (h.board.length >= 3 && !foldedPre) {
        c.sawFlop++
        if (h.shown[id]) {
          c.showdowns++
          if (h.pots.some(p => p.winners.includes(id))) c.wonAtShowdown++
        }
      }
    }
    const mine = decisions.filter(d => d.seatId === id).map(d => d.decision)
    return {
      seatId: id,
      hands: dealt,
      vpip: pct(c.vpip, dealt),
      pfr: pct(c.pfr, dealt),
      af: c.calls ? c.bets / c.calls : c.bets ? Infinity : null,
      wtsd: pct(c.showdowns, c.sawFlop),
      wsd: pct(c.wonAtShowdown, c.showdowns),
      counts: c,
      decisions: mine.length,
      avgMs: mine.length ? Math.round(mine.reduce((a, d) => a + d.latencyMs, 0) / mine.length) : null,
      costUsd: mine.reduce((a, d) => a + costUsd(d.model, d.usage), 0)
    }
  })
}

/** Gateway cost of every decision so far (pricing.ts × usage). */
export function sessionCost(decisions: { decision: Decision }[]): number {
  return decisions.reduce((a, d) => a + costUsd(d.decision.model, d.decision.usage), 0)
}
