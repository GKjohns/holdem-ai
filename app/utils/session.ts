/**
 * Session numbers for the summary modal and the Chips tab. Pure (relative imports, no Nuxt)
 * so tests/session.test.ts runs it under bare Node.
 */
import { costUsd } from '../../shared/utils/pricing.ts'
import type { Decision, HandResult } from '../../shared/utils/types.ts'

export interface SessionSeat { id: string, name: string, modelId: string | null, stack: number }
export interface SessionHand { handNo: number, pots: HandResult['pots'], stacksAfter: Record<string, number> }
export interface SessionDecision { seatId: string, decision: Decision }

export interface SummaryRow {
  id: string
  name: string
  modelId: string | null
  stack: number
  net: number
  handsWon: number
  decisions: number
  /** null for the human (their think time isn't measured). */
  avgMs: number | null
  costUsd: number | null
}

export function summaryRows(
  seats: SessionSeat[],
  start: Record<string, number>,
  hands: SessionHand[],
  decisions: SessionDecision[]
): SummaryRow[] {
  return seats.map((s) => {
    const mine = decisions.filter(d => d.seatId === s.id).map(d => d.decision)
    const isAi = s.modelId !== null
    return {
      id: s.id,
      name: s.name,
      modelId: s.modelId,
      stack: s.stack,
      net: s.stack - (start[s.id] ?? 0),
      handsWon: hands.filter(h => h.pots.some(p => p.winners.includes(s.id))).length,
      decisions: mine.length,
      avgMs: isAi && mine.length ? Math.round(mine.reduce((a, d) => a + d.latencyMs, 0) / mine.length) : null,
      costUsd: isAi ? mine.reduce((a, d) => a + costUsd(d.model, d.usage), 0) : null
    }
  }).sort((a, b) => b.net - a.net || b.handsWon - a.handsWon)
}

/** Stack per seat after each hand, starting with hand 0 = starting stacks. */
export function stackSeries(seatIds: string[], start: Record<string, number>, hands: SessionHand[]): { handNo: number, stacks: Record<string, number> }[] {
  const pick = (src: Record<string, number>) => Object.fromEntries(seatIds.map(id => [id, src[id] ?? 0]))
  return [{ handNo: 0, stacks: pick(start) }, ...hands.map(h => ({ handNo: h.handNo, stacks: pick(h.stacksAfter) }))]
}

/** "Main pot" / "Side pot" / "Side pot 2" — only when a hand has more than one pot. */
export function potLabel(index: number, count: number): string | null {
  if (count < 2) return null
  if (index === 0) return 'Main pot'
  return count === 2 ? 'Side pot' : `Side pot ${index}`
}

/** "Jev wins 340 with two pair, aces and sevens" / "You & Jev split 200 with …". */
export function potSentence(p: HandResult['pots'][number], nameOf: (id: string) => string): string {
  const who = p.winners.map(nameOf).join(' & ')
  const verb = p.winners.length > 1 ? 'split' : p.winners[0] === 'you' ? 'win' : 'wins'
  const how = p.handName === 'Uncontested' ? '' : ` with ${p.handName.charAt(0).toLowerCase()}${p.handName.slice(1)}`
  return `${who} ${verb} ${p.amount.toLocaleString()}${how}`
}
