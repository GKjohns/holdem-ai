/**
 * The Booth: per-hand narration and the end-of-session scouting report. Shared types plus the
 * pieces both sides need (stat wording, markdown, cost). Pure (relative imports, no Nuxt) so
 * tests and bench scripts load it under bare Node. The narrator only interprets numbers that
 * stats.ts computed; it never computes them, and it never sits at the table.
 */
import { costUsd } from './pricing.ts'
import type { SeatStats } from './stats.ts'
import type { ActionEvent, Card, Decision, HandResult, Street } from './types.ts'

export const NARRATOR_MODEL = 'anthropic/claude-sonnet-5.5'

export interface NarrateSeat { id: string, name: string, modelId: string | null }

/** A completed hand, god view. Same shape as the client's HandRecord and the JSONL `hand` line. */
export interface NarrateHand {
  handNo: number
  board: Card[]
  /** Index into the seats array. */
  button: number
  pots: HandResult['pots']
  shown: HandResult['shown']
  deltas: Record<string, number>
  stacksAfter: Record<string, number>
  holes: Record<string, Card[]>
  log: ActionEvent[]
  actionLabels: string[]
  blindsNote: string
  decisions: { seatId: string, street: Street, logIndex: number, decision: Decision }[]
}

interface Billed { model: string, latencyMs: number, usage: { input: number, output: number } }

export interface Narration extends Billed {
  handNo: number
  headline: string
  playByPlay: string
  keyMoment: { seatId: string, street: string, why: string }
}

export interface SeatScout {
  seatId: string
  styleLabel: string
  /** 2–4 claims, each citing a stat or a hand number. */
  tendencies: string[]
  signatureHand: { handNo: number, why: string }
  howToBeat: string
  voice: string
}

export interface ScoutingReport extends Billed {
  /** Finished hands the report covers. */
  hands: number
  overview: string
  seats: SeatScout[]
  /** stats.ts output the narrator was handed, so the page and the markdown show the same numbers. */
  stats: SeatStats[]
}

const pctText = (v: number | null, n: number, d: number) => v === null ? '— (0 hands)' : `${Math.round(v)}% (${n}/${d})`

/** The stat wording the narrator is told to cite, e.g. "VPIP 42% (5/12)". */
export function statsLine(s: SeatStats): string {
  const c = s.counts
  // From the counts, not s.af: JSON turns Infinity into null.
  const af = c.calls
    ? `${(c.bets / c.calls).toFixed(1)} (${c.bets} bets/raises, ${c.calls} calls)`
    : c.bets ? `∞ (${c.bets} bets/raises, 0 calls)` : '— (no postflop bets or calls)'
  return [
    `hands ${s.hands}`,
    `VPIP ${pctText(s.vpip, c.vpip, s.hands)}`,
    `PFR ${pctText(s.pfr, c.pfr, s.hands)}`,
    `AF ${af}`,
    `WTSD ${pctText(s.wtsd, c.showdowns, c.sawFlop)}`,
    `W$SD ${pctText(s.wsd, c.wonAtShowdown, c.showdowns)}`,
    `avg decision ${s.avgMs === null ? '—' : `${s.avgMs} ms`}`
  ].join(' · ')
}

/** Gateway cost of narrator calls (pricing.ts × usage). */
export function narratorCost(items: Iterable<Billed | null | undefined>): number {
  let total = 0
  for (const x of items) if (x) total += costUsd(x.model, x.usage)
  return total
}

export function scoutingMarkdown(report: ScoutingReport, nameOf: (seatId: string) => string, title = 'Scouting report'): string {
  const out = [`# ${title}`, '', `${report.hands} ${report.hands === 1 ? 'hand' : 'hands'} · narrator ${report.model}`, '', report.overview, '']
  for (const s of report.seats) {
    const st = report.stats.find(x => x.seatId === s.seatId)
    out.push(`## ${nameOf(s.seatId)}: ${s.styleLabel}`, '')
    if (st) out.push(`*${statsLine(st)}*`, '')
    out.push(...s.tendencies.map(t => `- ${t}`), '')
    out.push(`**Signature hand #${s.signatureHand.handNo}:** ${s.signatureHand.why}`, '')
    out.push(`**How to beat it:** ${s.howToBeat}`, '')
    out.push(`**Table talk:** ${s.voice}`, '')
  }
  return `${out.join('\n').trimEnd()}\n`
}

/** Claims with no number or hand reference in them; the prompt says there should be none. */
export function uncitedClaims(report: Pick<ScoutingReport, 'seats'>): string[] {
  return report.seats.flatMap(s => s.tendencies).filter(t => !/[\d∞]/.test(t))
}
