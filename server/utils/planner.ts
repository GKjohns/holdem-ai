/**
 * B4 Strategy Lab's planner calls (Fable): write a generation of strategy cards with pre-registered
 * predictions, reflect on a finished generation, and write the final field notes. Plain module with
 * relative imports so bench/lab.ts runs it under bare Node.
 *
 * Fable reads god-view histories of COMPLETED hands and stats.ts numbers; it never sits, and
 * nothing it reads reaches a seat except the card text, which validateGeneration() (strategy.ts)
 * checks for numbers it must not carry.
 */
import { generateText, Output } from 'ai'
import { z } from 'zod'
import { PLANNER_MODEL } from '../../shared/utils/models.ts'
import { AXES, AXIS_NAMES, exploreQuota } from '../../shared/utils/strategy.ts'
import type { StrategyCard } from '../../shared/utils/strategy.ts'
import { SNG_INSTRUCTIONS } from './decide.ts'

export const PLANNER_TIMEOUT_MS = 300_000
/** Cards (≈ 300 tokens each) + memo + thinking; reasoning tokens count against this. */
export const PLANNER_MAX_OUTPUT = 20_000

const axesSchema = z.object(Object.fromEntries(AXIS_NAMES.map(k => [k, z.enum(AXES[k] as unknown as [string, ...string[]])])) as Record<string, z.ZodEnum>)

export const cardSchema = z.object({
  name: z.string().describe('2–4 words, distinct from every other card'),
  kind: z.enum(['explore', 'exploit']),
  parentIds: z.array(z.string()).describe('explore: []; exploit: 1 parent id (mutation) or 2 (crossover)'),
  changed: z.string().describe('exploit: the single thing changed, one sentence; explore: empty string'),
  axes: axesSchema,
  card: z.string().describe('The card text the player reads, second person, at most 200 words'),
  hypothesis: z.string().describe('One testable sentence: why this should win or lose against this field'),
  predicted: z.object({
    bb100: z.number().describe('This card\'s own bb/100 at its table'),
    rank: z.number().int().describe('Rank among this generation\'s cards, 1 = best, each rank once'),
    vsControl: z.number().describe('Card bb/100 minus the control\'s on the same matches')
  })
})
export type PlannedCard = z.infer<typeof cardSchema>

export const memoSchema = z.object({
  headline: z.string().describe('One sentence: the main thing this generation taught us'),
  confirmed: z.array(z.string()),
  refuted: z.array(z.string()),
  noise: z.array(z.string()),
  surprises: z.array(z.string())
})
export type PlannedMemo = z.infer<typeof memoSchema>

export const fieldNotesSchema = z.object({
  headline: z.string(),
  whatWins: z.string(),
  whatLoses: z.string(),
  priorsWrong: z.string(),
  noise: z.string(),
  nextTests: z.string()
})
export type FieldNotes = z.infer<typeof fieldNotesSchema>

export interface LabBrief {
  baseLabel: string
  /** B3 profile of the base model without a card, as a stats line. */
  baseStyle: string
  /** Field seats beside the card, control and champion, with their table names. */
  field: { name: string, kind: string }[]
  aliases: string[]
  hands: number
  levels: string
  /** B3 context: leaderboard lines and the scouting report's field profiles. */
  priorEvidence: string
  /** One rendered seat prompt, so Fable sees exactly what a seat reads. */
  examplePrompt: string
}

export function plannerInstructions(b: LabBrief): string {
  const fieldNames = b.field.map(f => `${f.name} (${f.kind})`).join(', ')
  return `You are the research lead of a no-limit Texas Hold'em Strategy Lab. You never play. You write strategy cards for an AI player, pre-register what you expect each to do, and then read the measured results honestly. The lab exists to learn empirically what wins instead of trusting anyone's priors, yours included: test ideas you expect to lose, call noise noise, and say plainly when the data refutes you.

THE PLAYER
A player is ${b.baseLabel} (a fast, cheap language model, reasoning off) plus one strategy card. The card is appended to the model's system instructions, after these standard instructions every seat gets:
<<<
${SNG_INSTRUCTIONS}
>>>
then: "Your strategy card (your coach's plan for how you play at this table; follow it, using only what you can see from your seat):" and the card text. Holding the model fixed means score differences come from the card, not the model.
Without a card, ${b.baseLabel} played like this in an earlier 8-match benchmark: ${b.baseStyle}.

WHAT A SEAT SEES (and nothing else)
Each decision the seat gets: its two cards, the board, every player's chips, the pot, the amount to call, positions, the seating order, this hand's actions with any table talk, its own earlier table-talk lines, and a menu of legal options with exact chip amounts. The menu is fold, check, call, raise_min, raise_half_pot, raise_pot, raise_2x_pot, all_in (only the legal ones appear; a raise size that would exceed the stack becomes all_in). It has NO memory of earlier hands, no notes, no statistics and no odds: it cannot track an opponent across hands. It sees opponents' table names only: ${fieldNames}, and the other ${b.baseLabel} seats under neutral names (${b.aliases.join(', ')}; assigned at random per table, so a name says nothing about who is behind it). An example of exactly what a seat reads for one decision:
<<<
${b.examplePrompt}
>>>

THE TABLE AND THE SCORE
Every card plays at its own 5-seat table: the card, the control (${b.baseLabel} with no card), the current champion card (in generation 0, a second card-less ${b.baseLabel}), ${fieldNames}. Format: sit-and-go, 1,500 chips each, blinds ${b.levels}, doubling every 10 hands, stopped at ${b.hands} hands (survivors placed by chips). Duplicate seeding: a match is the same deck seed played once per seat rotation (5 tournaments), so every player gets every seat's cards and luck largely cancels. Score: bb/100 at the table (each hand's chip change divided by that hand's big blind, per 100 hands). The key number is the lead over the control: card bb/100 minus control bb/100 on the same matches, with a 95% bootstrap CI over matches. Each card gets 2–6 matches, so expect wide intervals (±40–100 bb/100). A difference inside its CI is noise.

PRIOR EVIDENCE (a different, 5-model field: GPT-6 Sol, Claude Haiku 5.5, GPT-6 Luna, GPT-6 Luna Decisions, Jev; 8 matches, 1,913 hands)
${b.priorEvidence}

CARD RULES (checked in code; a card that breaks one is rejected)
- At most 200 words, second person, plain language. Cover style, which hands to play from which position, bet sizing in menu terms, how often to bluff (in words: "rarely", "about one river in three"), how to respond within a hand to what opponents do or say, and a table-talk persona.
- Style and guidance only. No percentages, no HUD statistics (VPIP, PFR, AF, WTSD, W$SD), no bb/100 or win rates, no equity or odds numbers. A seat gets only what a human at the table has, so a card can't hand it numbers from our data.
- Guidance about the named opponents is allowed (a human could know a regular's reputation), but remember the seat can't observe anyone across hands.
- The card is fixed for every hand the player plays.

AXES (every card declares one value per axis; it must match the card text)
${AXIS_NAMES.map(k => `- ${k}: ${AXES[k].join(' | ')}`).join('\n')}

PRE-REGISTRATION (before any hand is dealt)
For every card: a one-sentence testable hypothesis, the card's predicted bb/100 at its table, its predicted lead over the control, and its predicted rank among this generation's cards (1 = best, each rank used once). These are scored against the results later, so make honest point predictions, not hedges.`
}

const cardList = (cards: StrategyCard[]) => cards.map(c => `[${c.id}] "${c.name}" (gen ${c.gen}, ${c.kind}${c.parentIds.length ? ` of ${c.parentIds.join(' × ')}` : ''})
  axes: ${AXIS_NAMES.map(k => `${k}=${c.axes[k]}`).join(', ')}
  hypothesis: ${c.hypothesis}
  card: ${c.card.replace(/\s+/g, ' ').trim()}`).join('\n')

export function gen0Prompt(n: number): string {
  const archetypes = ['a tight nit', 'a maniac', 'a calling station', 'a GTO-ish balanced player', 'an exploit-the-bots specialist (aimed at the named decision models)', 'a trappy slow-player', 'a talkative bluffer', 'an adaptive player who reads each hand\'s action']
  const span = n >= archetypes.length
    ? `Cover all of these archetypes, one card each: ${archetypes.join('; ')}.`
    : `Pick ${n} of these archetypes, as different from each other as possible, and include at least one you expect to lose: ${archetypes.join('; ')}.`
  return `GENERATION 0: write exactly ${n} cards that SPAN the space of styles. This generation maps the terrain; it is not a search for the best card.
${span}
Every pair of cards must differ on at least 2 axes. Do not converge on one idea you believe in: include styles you expect to lose, and say so in their predictions. All ${n} cards are kind "explore" with parentIds [] and changed "".`
}

export interface NextPromptData {
  gen: number
  n: number
  /** Results text for the generation just played (tables, styles, predictions vs results). */
  results: string
  /** Decisive god-view hands per card of the generation just played. */
  hands: string
  pooled: string
  memos: string
  tested: StrategyCard[]
  parentPool: string[]
}

export function nextPrompt(d: NextPromptData): string {
  const q = exploreQuota(d.n, d.gen)
  return `GENERATION ${d.gen - 1} IS DONE. First write the memo on it, then write generation ${d.gen}.

MEMO: what the data confirmed, what it refuted, what is still noise (CI spans 0, or too few matches), and what surprised you. Every bullet must cite a number from the results below (a bb/100, a CI, a stat) or a hand reference like "g1-g1c02 m01-r3 #14". Judge your own predictions against the results; don't defend them.

NEXT GENERATION: exactly ${d.n} cards: exactly ${q.exploit} "exploit" and exactly ${q.explore} "explore" (the quota is enforced in code).
- exploit: a mutation (parentIds = [one id]) or a crossover (parentIds = [two ids]) of the top cards. Parents must come from: ${d.parentPool.join(', ')}. "changed" names the single thing changed in one sentence. A mutation's axes differ from its parent's on at most 1 axis; a crossover takes every axis value from one of its two parents. Make the change the one the evidence points to.
- explore: a new idea unlike anything tested: parentIds [], changed "", and its axes must differ from EVERY tested card on at least 2 axes (and from the other explore cards).
Predictions for every card, as before.

TESTED CARDS SO FAR
${cardList(d.tested)}

POOLED LEADERBOARD (every match each card has played, as candidate or champion; lead = card − control, paired)
${d.pooled}

GENERATION ${d.gen - 1} RESULTS
${d.results}

EARLIER MEMOS
${d.memos || '(none)'}

DECISIVE HANDS OF GENERATION ${d.gen - 1} (god view, completed hands; each seat's private reasoning or option probabilities shown)
${d.hands}`
}

export function fieldNotesPrompt(d: { lastGen: number, tested: StrategyCard[], pooled: string, gens: string, results: string, hands: string, priors: string, heldout: string, memos: string }): string {
  return `THE LAB RUN IS OVER. First write the memo on generation ${d.lastGen} (the last one), as for earlier generations: confirmed, refuted, noise, surprises, each bullet citing a number or a hand reference.

Then write the field notes: the lab's final report for a reader who knows poker but hasn't seen the data. Plain markdown inside each field (short paragraphs or bullets, no headings). Every claim cites a number given below (bb/100 with its CI, a stat, or a count). Uncertainty stated honestly: noise is a finding.
- headline: one or two sentences, the bottom line.
- whatWins: which strategies beat the control, by how much, and whether that survived the held-out test.
- whatLoses: what lost and the most likely mechanism, from the styles and hands.
- priorsWrong: where your pre-registered predictions were most wrong (use the predicted-vs-actual table) and what that says about intuition here.
- noise: what still can't be told apart.
- nextTests: 3–5 concrete experiments to run next, each with what result would change your mind.

CARDS
${cardList(d.tested)}

POOLED LEADERBOARD (training tables)
${d.pooled}

BY GENERATION
${d.gens}

PREDICTED VS ACTUAL (each card at its own generation's table)
${d.priors}

HELD-OUT FINAL (fresh seeds, a different field)
${d.heldout}

MEMOS
${d.memos}

GENERATION ${d.lastGen} RESULTS
${d.results}

DECISIVE HANDS OF GENERATION ${d.lastGen}
${d.hands}`
}

export interface PlannerCall<T> { output: T, usage: { input: number, output: number }, latencyMs: number }

/** One planner call: no temperature, maxRetries 1, a long timeout, gateway caching. */
export async function callPlanner<T>(input: { instructions: string, prompt: string, schema: z.ZodType<T>, signal?: AbortSignal, maxOutputTokens?: number }): Promise<PlannerCall<T>> {
  const started = Date.now()
  const t = AbortSignal.timeout(PLANNER_TIMEOUT_MS)
  const { output, usage } = await generateText({
    model: PLANNER_MODEL.id,
    instructions: input.instructions,
    prompt: input.prompt,
    output: Output.object({ schema: input.schema }),
    maxOutputTokens: input.maxOutputTokens ?? PLANNER_MAX_OUTPUT,
    maxRetries: 1,
    abortSignal: input.signal ? AbortSignal.any([input.signal, t]) : t,
    reasoning: 'medium',
    providerOptions: { gateway: { caching: 'auto' } }
  })
  if (!output) throw new Error('Planner returned no output')
  return { output, usage: { input: usage?.inputTokens ?? 0, output: usage?.outputTokens ?? 0 }, latencyMs: Date.now() - started }
}

export const nextSchema = z.object({ memo: memoSchema, cards: z.array(cardSchema) })
export const gen0Schema = z.object({ cards: z.array(cardSchema) })
export const finalSchema = z.object({ memo: memoSchema, notes: fieldNotesSchema })
