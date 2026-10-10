/**
 * The Booth's model calls: one narration per completed hand, and a scouting report at the end
 * of a session. Plain module with relative imports so tests and bench scripts run it under bare
 * Node. The narrator gets the god view (every hole card, every model's reasoning or
 * probabilities), but only of completed hands; the client never asks before a hand is over.
 */
import { generateText, Output } from 'ai'
import { z } from 'zod'
import { findModel } from '../../shared/utils/models.ts'
import { NARRATOR_MODEL, statsLine } from '../../shared/utils/narration.ts'
import type { NarrateHand, NarrateSeat, Narration, ScoutingReport } from '../../shared/utils/narration.ts'
import { rankHand } from '../../shared/utils/handRank.ts'
import { seatStats } from '../../shared/utils/stats.ts'
import type { Decision, MenuId } from '../../shared/utils/types.ts'

export const NARRATE_TIMEOUT_MS = 45_000
export const SCOUT_TIMEOUT_MS = 60_000
const STREETS = ['preflop', 'flop', 'turn', 'river', 'showdown'] as const

export const NARRATE_INSTRUCTIONS = `You are the Booth: the commentator for a no-limit Texas Hold'em table where AI models play each other (sometimes with one human). You get the god view of one COMPLETED hand: every hole card, every action, each model's private reasoning (language models) or option probabilities (decision models, which answer with a probability per option and no prose), and the result.

Write:
- headline: at most 10 words, names at least one seat, says what happened.
- playByPlay: 2 to 4 sentences for a viewer. What each key player held, what they did, and whether their own reasoning or probabilities matched the cards. Use chip amounts and cards from the history.
- keyMoment: the one decision that decided the hand (seatId from the seat list, street, and why in one sentence).

Only state facts in the history. Hand names come from the "best five" given per seat (computed by the game engine; a folded seat's is what it would have had); never work out a hand yourself. Don't invent reads, tells, odds or numbers. Call seats by name. Write cards plainly ("A♥ K♣" or "ace-king"). Lively, but no hype words.`

export const SCOUT_INSTRUCTIONS = `You are the Booth writing an end-of-session scouting report on each AI model at a no-limit Texas Hold'em table. You get per-seat stats computed from the action log (you never compute stats yourself), a one-line summary of every hand, the full god-view history of each seat's notable hands, and each seat's table talk.

For every seat in the seat list, write:
- styleLabel: a short label such as "loose-passive caller" or "tight-aggressive", justified by the stats.
- tendencies: 2 to 4 claims. EVERY claim must cite a stat exactly as written in the stats block (e.g. "VPIP 42%", "AF 1.5", "W$SD 50%") or a hand number written as "#7". A claim without a stat or a hand number is not allowed.
- signatureHand: the hand number that best shows the style, and why in one sentence.
- howToBeat: one or two sentences, citing a stat or a hand number.
- voice: one line on its table talk (quote a line if it has any; say it stayed silent if it has none). Decision models never talk.

Also write overview: two sentences on the table as a whole, citing numbers.

Samples are small: say so when a stat rests on few hands (the counts in parentheses are numerator/denominator). Never invent numbers or hands.`

const SUIT: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' }
const pretty = (cards: string[]) => cards.map(c => `${c[0] === 'T' ? '10' : c[0]}${SUIT[c[1]!] ?? c[1]}`).join(' ')
const clip = (s: string, n: number) => s.length > n ? `${s.slice(0, n - 1)}…` : s

const ACTION_WORDS: Record<MenuId, string> = {
  fold: 'fold', check: 'check', call: 'call', raise_min: 'min raise', raise_half_pot: 'half-pot',
  raise_pot: 'pot', raise_2x_pot: '2x pot', all_in: 'all-in'
}

function kindWords(modelId: string | null): string {
  if (!modelId) return 'human'
  const m = findModel(modelId)
  if (!m) return modelId
  return `${m.vendor} ${m.kind === 'evaluation' ? 'decision model' : 'language model'}`
}

function decisionWords(d: Decision, reasoningMax: number): string {
  if (d.fallback) return `(fallback: ${clip(d.reasoning, 120)})`
  if (d.probabilities) {
    const ranked = Object.entries(d.probabilities)
      .filter(([, p]) => (p ?? 0) >= 0.01)
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
      .slice(0, 4)
      .map(([id, p]) => `${ACTION_WORDS[id as MenuId] ?? id} ${Math.round((p ?? 0) * 100)}%`)
    return `probabilities: ${ranked.join(', ') || 'none returned'}`
  }
  return `reasoning: ${clip(d.reasoning, reasoningMax)}`
}

/** One completed hand as text, god view. */
export function renderHand(hand: NarrateHand, seats: NarrateSeat[], opts: { reasoningMax?: number } = {}): string {
  const reasoningMax = opts.reasoningMax ?? 400
  const name = (id: string) => seats.find(s => s.id === id)?.name ?? id
  const lines = [`Hand #${hand.handNo}. Button: ${seats[hand.button]?.name ?? '?'}. Blinds: ${hand.blindsNote || 'none noted'}.`, '', 'Seats:']
  for (const s of seats) {
    const hole = hand.holes[s.id] ?? []
    if (!hole.length) {
      lines.push(`- ${s.id} ${s.name}: sat out (busted)`)
      continue
    }
    const delta = hand.deltas[s.id] ?? 0
    // The engine's hand ranking, so the Booth never misreads a board. The narrator isn't seated;
    // seated models still get no hand strength.
    const made = hand.board.length >= 3 ? `; best five with the full board: ${rankHand([...hole, ...hand.board]).name}` : ''
    lines.push(`- ${s.id} ${s.name} (${kindWords(s.modelId)}): holds ${pretty(hole)}${made}; ${delta > 0 ? `+${delta}` : delta} this hand, ${hand.stacksAfter[s.id] ?? '?'} after`)
  }
  const byIndex = new Map(hand.decisions.map(d => [d.logIndex, d.decision]))
  const boardAt: Record<string, string[]> = { flop: hand.board.slice(0, 3), turn: hand.board.slice(3, 4), river: hand.board.slice(4, 5) }
  let street = ''
  lines.push('', 'Action:')
  hand.log.forEach((e, i) => {
    if (e.street !== street) {
      street = e.street
      const cards = boardAt[street]
      lines.push(`${street[0]!.toUpperCase()}${street.slice(1)}${cards?.length ? ` (${pretty(cards)})` : ''}:`)
    }
    const talk = e.tableTalk ? ` and says "${e.tableTalk}"` : ''
    lines.push(`- ${name(e.seatId)} ${hand.actionLabels[i] ?? e.action.type}${talk}`)
    const d = byIndex.get(i)
    if (d) lines.push(`    ${decisionWords(d, reasoningMax)}`)
  })
  if (hand.board.length) lines.push('', `Final board: ${pretty(hand.board)}`)
  lines.push('', 'Result:')
  hand.pots.forEach((p, i) => {
    const label = hand.pots.length > 1 ? (i === 0 ? 'Main pot' : `Side pot ${i}`) : 'Pot'
    lines.push(`- ${label} ${p.amount}: ${p.winners.map(name).join(' & ')} (${p.handName})`)
  })
  for (const [id, sh] of Object.entries(hand.shown)) lines.push(`- ${name(id)} showed ${pretty(sh.cards)}: ${sh.handName}`)
  return lines.join('\n')
}

/** One line per hand for the scouting report: winners and swings. */
export function handLine(hand: NarrateHand, seats: NarrateSeat[]): string {
  const name = (id: string) => seats.find(s => s.id === id)?.name ?? id
  const won = hand.pots.map(p => `${p.winners.map(name).join(' & ')} won ${p.amount} (${p.handName})`).join('; ')
  const swings = Object.entries(hand.deltas).filter(([, d]) => d).map(([id, d]) => `${name(id)} ${d > 0 ? '+' : ''}${d}`).join(', ')
  return `#${hand.handNo}: ${won}. ${swings}${Object.keys(hand.shown).length ? ' · showdown' : ''}`
}

/** The hands that say most about a seat: its showdowns first, then its biggest swings. */
export function notableHands(seatId: string, hands: NarrateHand[], n = 4): number[] {
  return hands
    .filter(h => h.holes[seatId]?.length)
    .map(h => ({ handNo: h.handNo, score: Math.abs(h.deltas[seatId] ?? 0) + (h.shown[seatId] ? 1e6 : 0) }))
    .sort((a, b) => b.score - a.score || a.handNo - b.handNo)
    .slice(0, n)
    .map(x => x.handNo)
    .sort((a, b) => a - b)
}

function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, t]) : t
}

function narratorModel(modelId?: string): string {
  const m = findModel(modelId)
  return m && m.kind === 'llm' ? m.id : NARRATOR_MODEL
}

/** Every call: no temperature, maxRetries 1, a timeout, reasoning 'low', gateway caching. */
function callOptions(signal: AbortSignal) {
  return {
    maxOutputTokens: 4000,
    maxRetries: 1,
    abortSignal: signal,
    reasoning: 'low' as const,
    providerOptions: { gateway: { caching: 'auto' as const } }
  }
}

export async function narrateHand(input: { hand: NarrateHand, seats: NarrateSeat[], modelId?: string, signal?: AbortSignal }): Promise<Narration> {
  const model = narratorModel(input.modelId)
  const ids = input.seats.map(s => s.id) as [string, ...string[]]
  const schema = z.object({
    headline: z.string().describe('At most 10 words.'),
    playByPlay: z.string().describe('2 to 4 sentences.'),
    keyMoment: z.object({ seatId: z.enum(ids), street: z.enum(STREETS), why: z.string() })
  })
  const seatList = input.seats.map(s => `${s.id} = ${s.name}`).join(', ')
  const started = Date.now()
  const { output, usage } = await generateText({
    model,
    instructions: NARRATE_INSTRUCTIONS,
    prompt: `Seat ids: ${seatList}\n\n${renderHand(input.hand, input.seats)}`,
    output: Output.object({ schema }),
    ...callOptions(withTimeout(NARRATE_TIMEOUT_MS, input.signal))
  })
  if (!output) throw new Error('Narrator returned no output')
  return {
    handNo: input.hand.handNo,
    headline: output.headline.trim(),
    playByPlay: output.playByPlay.trim(),
    keyMoment: output.keyMoment,
    model,
    latencyMs: Date.now() - started,
    usage: { input: usage?.inputTokens ?? 0, output: usage?.outputTokens ?? 0 }
  }
}

export function renderScoutingPrompt(seats: NarrateSeat[], hands: NarrateHand[], headlines: Record<number, string> = {}): { prompt: string, stats: ReturnType<typeof seatStats> } {
  const ais = seats.filter(s => s.modelId)
  const stats = seatStats(
    seats.map(s => s.id),
    hands,
    hands.flatMap(h => h.decisions)
  )
  const name = (id: string) => seats.find(s => s.id === id)?.name ?? id
  const lines = [`Seats to scout (seatId = name): ${ais.map(s => `${s.id} = ${s.name} (${kindWords(s.modelId)})`).join(', ')}`]
  const human = seats.find(s => !s.modelId)
  if (human) lines.push(`Also at the table, not to be scouted: ${human.name} (human).`)
  lines.push('', `Stats over ${hands.length} finished hands (from stats.ts; percentages with numerator/denominator):`)
  for (const st of stats) lines.push(`- ${name(st.seatId)}: ${statsLine(st)}`)
  lines.push('', 'Every hand:')
  for (const h of hands) lines.push(`- ${handLine(h, seats)}${headlines[h.handNo] ? ` · Booth: "${headlines[h.handNo]}"` : ''}`)
  const notable = new Map<number, string[]>()
  for (const s of ais) for (const n of notableHands(s.id, hands)) notable.set(n, [...(notable.get(n) ?? []), s.name])
  lines.push('', 'Notable hands per seat:')
  for (const s of ais) lines.push(`- ${s.name}: ${notableHands(s.id, hands).map(n => `#${n}`).join(', ') || 'none'}`)
  for (const h of hands.filter(x => notable.has(x.handNo))) lines.push('', '---', renderHand(h, seats, { reasoningMax: 250 }))
  lines.push('', 'Table talk by seat:')
  for (const s of ais) {
    const talk = [...new Set(hands.flatMap(h => h.log.filter(e => e.seatId === s.id && e.tableTalk).map(e => `#${h.handNo} "${e.tableTalk}"`)))].slice(-8)
    lines.push(`- ${s.name}: ${talk.join(' · ') || '(silent)'}`)
  }
  return { prompt: lines.join('\n'), stats }
}

export async function scoutingReport(input: { seats: NarrateSeat[], hands: NarrateHand[], headlines?: Record<number, string>, modelId?: string, signal?: AbortSignal }): Promise<ScoutingReport> {
  const model = narratorModel(input.modelId)
  const ais = input.seats.filter(s => s.modelId)
  const ids = ais.map(s => s.id) as [string, ...string[]]
  const schema = z.object({
    overview: z.string(),
    seats: z.array(z.object({
      seatId: z.enum(ids),
      styleLabel: z.string(),
      tendencies: z.array(z.string()),
      signatureHand: z.object({ handNo: z.number().int(), why: z.string() }),
      howToBeat: z.string(),
      voice: z.string()
    }))
  })
  const { prompt, stats } = renderScoutingPrompt(input.seats, input.hands, input.headlines)
  const started = Date.now()
  const { output, usage } = await generateText({
    model,
    instructions: SCOUT_INSTRUCTIONS,
    prompt,
    output: Output.object({ schema }),
    ...callOptions(withTimeout(SCOUT_TIMEOUT_MS, input.signal))
  })
  if (!output) throw new Error('Narrator returned no report')
  const order = new Map(ids.map((id, i) => [id, i]))
  return {
    hands: input.hands.length,
    overview: output.overview.trim(),
    seats: output.seats.slice().sort((a, b) => (order.get(a.seatId) ?? 0) - (order.get(b.seatId) ?? 0)),
    stats: stats.filter(s => order.has(s.seatId)),
    model,
    latencyMs: Date.now() - started,
    usage: { input: usage?.inputTokens ?? 0, output: usage?.outputTokens ?? 0 }
  }
}
