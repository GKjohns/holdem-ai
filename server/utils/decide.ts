/**
 * One function the route and the self-play harness both call: given a seat's
 * view, ask the seated model which menu option to take. Plain module with
 * relative imports so `bench/selfplay.ts` runs it under bare Node.
 *
 * Models get only what a human in the seat has: own cards, board, chips,
 * positions, the action so far, and the menu (chip amounts + resulting pot).
 * No odds, equity, or hand strength — that's the model's job.
 */
import { generateText, Output, experimental_decide as decideWithModel, Experimental_DecisionRefusalError, InvalidResponseDataError, NoObjectGeneratedError } from 'ai'
import type { Experimental_DecisionModel, LanguageModel } from 'ai'
import { z } from 'zod'
import { buildMenu, raiseToAction } from '../../shared/utils/menu.ts'
import { findModel } from '../../shared/utils/models.ts'
import type { ModelOption, Reasoning } from '../../shared/utils/models.ts'
import type { ActionEvent, Card, Decision, GameFormat, MenuId, MenuOption, PastHand, SeatView } from '../../shared/utils/types.ts'

export interface DecideInput {
  modelId: string
  view: SeatView
  signal?: AbortSignal
  /** Bench-only override of the roster's reasoning effort ('unset' sends none). */
  reasoning?: Reasoning | 'unset'
  /** Test seam: a model instance used in place of the gateway id (the roster entry still picks the path). */
  model?: LanguageModel | Experimental_DecisionModel
  /** Defaults to CALL_TIMEOUT_MS; tests shorten it. */
  timeoutMs?: number
  /**
   * B4 Strategy Lab: a strategy card (style guidance written before any hand is dealt) appended
   * to an LLM's instructions. Never odds or stats about the hand; language models only.
   */
  strategyCard?: string
}

/** A player waiting a minute is worse than a fallback check/fold. */
export const CALL_TIMEOUT_MS = 30_000
/** Wall clock minus awake time above this means the machine slept mid-call (see decide()). */
const SLEEP_SKEW_MS = 5_000
const TABLE_TALK_MAX = 80

const CASH_OPENER = 'You are an AI player seated at a no-limit Texas Hold\'em cash game against other AI players and possibly a human. The blinds never change. Play to win chips.'

const SNG_OPENER = 'You are an AI player seated at a no-limit Texas Hold\'em sit-and-go tournament against other AI players. Everyone started with the same stack, the blinds go up on a fixed schedule, and a player who runs out of chips is out. Players finish in the order they bust; the last player with chips wins. There is no hand limit: play continues until one player has every chip. Only the top places are paid (the payouts are listed with the table details), so what counts is the place you finish in. Each turn tells you the current blind level and how many hands are left at it.'

const RULES = `Rules you know as a player:
- Each player has two private hole cards. Five community cards come out: the flop (3), the turn (1), the river (1). Betting rounds happen preflop, on the flop, on the turn, and on the river.
- Blinds: the small blind and big blind post forced bets before the cards are dealt. Preflop action starts left of the big blind; after the flop it starts with the first active player left of the button.
- No-limit: a raise must be at least the size of the previous bet or raise, and you can always go all-in. If you go all-in for less than a call, you can only win the part of the pot you matched (side pots).
- At showdown the best five-card hand from your two cards plus the board wins. Hand ranks, best to worst: straight flush, four of a kind, full house, flush, straight, three of a kind, two pair, one pair, high card. Ace plays high or low (A-2-3-4-5 is the lowest straight). Suits never break ties.
- Cards are written rank then suit: ranks 2-9, T (ten), J, Q, K, A; suits s (spades), h (hearts), d (diamonds), c (clubs). "Ah" is the ace of hearts. Your own cards and the board are also spelled out in words.

Each turn you see the table details, the earlier hands at this table you remember (the last one to two orbits, up to 11 hands: every action and bet size, everything said, every hand shown at showdown, and who won), your own cards in those hands, then the current hand: your cards, the board, every player's chips (behind, in front of them this street, and in the pot this hand), the pot and any side pots, who still acts after you, the action so far, and a menu of legal options with exact chip amounts. Pick exactly one option id from the menu.

Answer fields:
- reasoning: one or two plain sentences on why you chose this option.
- tableTalk: one short in-character line you say out loud at the table (under 80 characters), or an empty string to stay quiet. Banter is fine; never reveal or hint at your exact cards. Vary it: never repeat a line you've already said this session.
- choice: the option id you take.
- amount: only when choice is raise_to, the total you bet or raise to on this street; otherwise 0.`

/** Cash-game seats (interactive /play and Watch tables, and any view that doesn't state a format). */
export const INSTRUCTIONS = `${CASH_OPENER}

${RULES}`

/** Sit-and-go seats (batch runs and Strategy Lab tables). */
export const SNG_INSTRUCTIONS = `${SNG_OPENER}

${RULES}`

/** The system prompt for a format. v2: a strategy card no longer rides here; it goes in the user turn (promptParts). */
export function instructionsFor(game?: GameFormat['type']): string {
  return game === 'sng' ? SNG_INSTRUCTIONS : INSTRUCTIONS
}

/** How a strategy card or persona is introduced to its seat, right before the current hand. */
export const CARD_HEADING = 'Your approach at this table (how you play here; follow it, using only what you can see from your seat):'

const EVAL_QUESTION = 'You are the player described under `me` in this no-limit Texas Hold\'em hand. Which option is the best play, given your hole cards, the board, the chips, how the other players have acted, and what you remember of earlier hands?'
const EVAL_QUESTION_RETRY = 'Which option is the best poker play here?'

const ACTION_WORDS: Record<MenuId, string> = {
  fold: 'fold',
  check: 'check',
  call: 'call',
  raise_min: 'min raise',
  raise_third_pot: 'third-pot',
  raise_half_pot: 'half-pot',
  raise_3q_pot: '3/4-pot',
  raise_pot: 'pot',
  raise_1_5x_pot: '1.5x pot',
  raise_2x_pot: '2x pot',
  raise_to: 'custom raise',
  all_in: 'all-in'
}

class DeadlineError extends Error {
  override name = 'TimeoutError'
}

/**
 * Runs one model call with a hard deadline that covers everything inside it (the SDK's own retry,
 * the refusal re-ask, response parsing). The signal goes to the SDK, and a timer races the promise,
 * so a code path that ignores the signal still can't hold the seat. Caller aborts end it at once.
 */
async function bounded<T>(run: (signal: AbortSignal) => Promise<T>, ms: number, outer?: AbortSignal): Promise<T> {
  const ctrl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onOuter: (() => void) | undefined
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new DeadlineError(`no answer in ${ms} ms`)
      ctrl.abort(err)
      reject(err)
    }, ms)
    onOuter = () => {
      const err = outer?.reason instanceof Error ? outer.reason : new DOMException('Aborted', 'AbortError')
      ctrl.abort(err)
      reject(err)
    }
    if (outer?.aborted) onOuter()
    else outer?.addEventListener('abort', onOuter, { once: true })
  })
  try {
    return await Promise.race([run(ctrl.signal), stop])
  } finally {
    clearTimeout(timer)
    if (onOuter) outer?.removeEventListener('abort', onOuter)
  }
}

const isTimeout = (err: unknown) => err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')

/**
 * Never throws; every path is bounded by `timeoutMs` of awake time.
 *
 * Timers run on the monotonic clock, which stops while a Mac sleeps. A call that straddles a
 * lid-close times out only after wake, with a huge wall-clock latency (the B2 "901 s" Luna fold
 * was a 900 s maintenance sleep, per `pmset -g log`). That isn't the model's fault, so a timeout
 * whose wall time exceeds its awake time is asked once more, also bounded.
 */
export async function decide(input: DecideInput): Promise<Decision> {
  const option = findModel(input.modelId)
  const menu = buildMenu(input.view, { custom: option?.kind === 'llm' })
  const started = Date.now()
  if (!option) return fallbackDecision(menu, input.modelId, started, `Unknown model ${input.modelId}`)
  if (input.strategyCard && option.kind !== 'llm') return fallbackDecision(menu, option.id, started, 'Strategy cards are for language models only')
  const ms = input.timeoutMs ?? CALL_TIMEOUT_MS
  const attempt = () => bounded(signal => option.kind === 'evaluation'
    ? decideWithEvaluation(option, input, menu, signal)
    : decideWithLlm(option, input, menu, signal), ms, input.signal)
  for (let tries = 0; ; tries++) {
    const wall = Date.now()
    const awake = performance.now()
    try {
      const d = await attempt()
      return tries ? { ...d, retriedAfterSleep: true } : d
    } catch (err) {
      const slept = (Date.now() - wall) - (performance.now() - awake) > SLEEP_SKEW_MS
      if (isTimeout(err) && slept && tries === 0 && !input.signal?.aborted) {
        console.warn('[decide] timed out across a system sleep, asking again', option.id)
        continue
      }
      const message = isTimeout(err) ? 'timed out' : (err instanceof Error ? err.message : String(err))
      console.error('[decide] model error', option.id, message.slice(0, 300))
      return fallbackDecision(menu, option.id, started, isTimeout(err) ? 'Timed out' : 'Model error')
    }
  }
}

/** Check when free, else fold. Never throws. */
function fallbackDecision(menu: MenuOption[], model: string, started: number, why: string, requested?: string): Decision {
  const pick = menu.find(o => o.id === 'check') ?? menu.find(o => o.id === 'fold') ?? menu[0]
  const menuId: MenuId = pick?.id ?? 'fold'
  return {
    menuId,
    action: pick?.action ?? { type: 'fold' },
    reasoning: `${why} — auto-${menuId === 'check' ? 'checked' : 'folded'}.`,
    fallback: true,
    ...(requested ? { requested } : {}),
    model,
    latencyMs: Date.now() - started,
    usage: { input: 0, output: 0 }
  }
}

/** Every menu id. The answer schema lists all of them, not just this turn's legal ones (checked after). */
const ALL_MENU_IDS = ['fold', 'check', 'call', 'raise_min', 'raise_third_pot', 'raise_half_pot', 'raise_3q_pot', 'raise_pot', 'raise_1_5x_pot', 'raise_2x_pot', 'raise_to', 'all_in'] as const satisfies readonly MenuId[]

/**
 * One answer schema for every turn. v1 built `choice` from the turn's legal ids, but the schema sits
 * ahead of the messages in the provider's prompt, so a different menu (check vs fold) broke the
 * cached prefix on most calls (measured 2026-10-11). An id that isn't on this turn's menu is an
 * illegal choice → fallback, as before.
 */
const LLM_SCHEMA = z.object({
  reasoning: z.string().describe('One or two plain sentences on why.'),
  tableTalk: z.string().describe('One short line said out loud at the table, or an empty string. Never reveal your cards.'),
  choice: z.enum(ALL_MENU_IDS).describe('One option id from this turn\'s menu.'),
  amount: z.number().describe('Only for raise_to: the total you bet or raise to. Otherwise 0.')
})

/** Prompt-token usage with the cache split (v2). `inputTokens` already includes cached tokens. */
export function usageOf(usage: { inputTokens?: number, outputTokens?: number, inputTokenDetails?: { cacheReadTokens?: number, cacheWriteTokens?: number }, outputTokenDetails?: { reasoningTokens?: number } } | undefined): Decision['usage'] {
  const read = usage?.inputTokenDetails?.cacheReadTokens ?? 0
  const write = usage?.inputTokenDetails?.cacheWriteTokens ?? 0
  const thought = usage?.outputTokenDetails?.reasoningTokens ?? 0
  return { input: usage?.inputTokens ?? 0, output: usage?.outputTokens ?? 0, ...(read ? { cacheRead: read } : {}), ...(write ? { cacheWrite: write } : {}), ...(thought ? { reasoning: thought } : {}) }
}

/** Anthropic prompt-cache breakpoint; other providers ignore it. */
const CACHE_HERE = { anthropic: { cacheControl: { type: 'ephemeral' as const } } }

async function decideWithLlm(option: ModelOption, input: DecideInput, menu: MenuOption[], signal: AbortSignal): Promise<Decision> {
  const schema = LLM_SCHEMA
  const reasoning = input.reasoning === 'unset' ? undefined : (input.reasoning ?? option.reasoning)
  const parts = promptParts(input.view, menu, input.strategyCard)
  const started = Date.now()
  let result
  try {
    const r = await generateText({
      model: (input.model as LanguageModel | undefined) ?? option.id,
      instructions: instructionsFor(input.view.game?.type),
      // The shared part (table details + remembered hands) is the same for every seat at the table and
      // only grows within a memory block, so it ends in an explicit cache breakpoint. v1's gateway
      // `caching: 'auto'` put the breakpoint at the very end, so every Anthropic call was a 1.25× write.
      messages: [{
        role: 'user',
        content: [
          // Breakpoints after the table details (so a new memory block reuses system + header) and
          // after the last remembered hand.
          ...parts.shared.map((text, i) => ({ type: 'text' as const, text, ...(i === 0 || i === parts.shared.length - 1 ? { providerOptions: CACHE_HERE } : {}) })),
          { type: 'text' as const, text: parts.seat }
        ]
      }],
      output: Output.object({ schema }),
      // Reasoning models think in output tokens; a low cap starves the JSON. v2: 8000, so a model
      // that thinks longer is never cut off into a fallback.
      // No temperature: the Claude 5 and GPT-6 families reject it.
      maxOutputTokens: 8000,
      abortSignal: signal,
      maxRetries: 1,
      // Prompt caches live per provider; letting the gateway alternate Anthropic backends turned
      // cache reads into fresh writes (measured 2026-10-11), so Claude models prefer Anthropic itself.
      ...(option.vendor === 'Anthropic' ? { providerOptions: { gateway: { order: ['anthropic'] } } } : {}),
      ...(reasoning ? { reasoning } : {})
    })
    // Read inside the try: the structured output is parsed (and can throw) here.
    result = { output: r.output, usage: r.usage, finishReason: r.finishReason }
  } catch (err) {
    // An answer that doesn't parse (e.g. cut off at maxOutputTokens) is logged with its finish reason
    // and usage, so truncation is visible in the run file instead of hiding as a generic model error.
    if (!NoObjectGeneratedError.isInstance(err)) throw err
    const why = err.finishReason === 'length' ? 'Truncated at the output cap' : 'Unparseable answer'
    console.error('[decide] no object', option.id, err.finishReason)
    return { ...fallbackDecision(menu, option.id, started, why), usage: usageOf(err.usage), ...(err.finishReason ? { finishReason: err.finishReason } : {}) }
  }
  const { output, usage, finishReason } = result
  const usageOut = usageOf(usage)
  const chosen = output ? menu.find(o => o.id === output.choice) : undefined
  if (!output || !chosen) {
    return { ...fallbackDecision(menu, option.id, started, 'Illegal choice', output?.choice), usage: usageOut, finishReason }
  }
  let action = chosen.action
  let requested: string | undefined
  if (chosen.id === 'raise_to') {
    const r = raiseToAction(input.view, output.amount)
    action = r.action
    if (r.clamped) requested = `raise_to ${output.amount}`
  }
  const tableTalk = cleanTableTalk(output.tableTalk, input.view)
  return {
    menuId: chosen.id,
    action,
    reasoning: output.reasoning.trim(),
    ...(tableTalk ? { tableTalk } : {}),
    fallback: false,
    ...(requested ? { requested } : {}),
    model: option.id,
    latencyMs: Date.now() - started,
    finishReason,
    ...(output.tableTalk.trim() && !tableTalk ? { tableTalkDropped: true } : {}),
    usage: usageOut
  }
}

/**
 * Decision models answer one choice question over the menu. They get the same
 * table information as the LLMs, as JSON, and return a probability per option;
 * their "reasoning" is the chosen option's text plus the ranked spread.
 */
async function decideWithEvaluation(option: ModelOption, input: DecideInput, menu: MenuOption[], signal: AbortSignal): Promise<Decision> {
  const criteria = Object.fromEntries(menu.map(o => [o.id, o.describe])) as Record<MenuId, string>
  const state = tableState(input.view)
  // One signal and one deadline (bounded() in decide) cover both the first ask and the reworded retry.
  const ask = (instructions: string) => decideWithModel({
    model: (input.model as Experimental_DecisionModel | undefined) ?? option.id,
    state,
    questions: { action: { type: 'choice', instructions, criteria } },
    abortSignal: signal,
    maxRetries: 1
  })
  /**
   * The SDK rejects an answer whose `choice` isn't its own top probability. That answer is still
   * the model's: keep its choice (as the app always has) and flag it, rather than folding.
   * The rejected response carries no usage, so those calls are logged at 0 tokens (≈ $0.00005 each).
   */
  type Answer = { choice: string, probabilities?: Record<string, number> }
  const askKeepingOffTop = async (instructions: string): Promise<{ answer: Answer, usage: { input: number, output: number }, choiceNotTop?: true }> => {
    try {
      const r = await ask(instructions)
      return { answer: r.answers.action, usage: { input: r.usage.inputTokens ?? 0, output: r.usage.outputTokens ?? 0 } }
    } catch (err) {
      const data = InvalidResponseDataError.isInstance(err) && /highest-probability/.test(err.message)
        ? (err.data as { action?: { type?: string } & Answer } | undefined)?.action
        : undefined
      if (data?.type !== 'choice' || typeof data.choice !== 'string') throw err
      return { answer: { choice: data.choice, probabilities: data.probabilities }, usage: { input: 0, output: 0 }, choiceNotTop: true }
    }
  }
  const started = Date.now()
  let result: Awaited<ReturnType<typeof askKeepingOffTop>>
  let retried = false
  try {
    result = await askKeepingOffTop(EVAL_QUESTION)
  } catch (err) {
    // Luna Decisions occasionally refuses a phrasing outright (deterministically, per state);
    // a plainer rewording of the same question gets an answer.
    if (!Experimental_DecisionRefusalError.isInstance(err)) throw err
    console.warn('[decide] refusal, retrying reworded', option.id)
    retried = true
    result = await askKeepingOffTop(EVAL_QUESTION_RETRY)
  }
  const { answer, usage } = result
  const offTop = result.choiceNotTop ? { choiceNotTop: true as const } : {}
  const chosen = menu.find(o => o.id === answer.choice)
  if (!chosen) return { ...fallbackDecision(menu, option.id, started, 'Illegal choice', answer.choice), usage, ...(retried ? { retried } : {}), ...offTop }
  const raw: Record<string, number> = answer.probabilities ?? {}
  const probabilities = Object.fromEntries(menu.map(o => [o.id, raw[o.id] ?? 0])) as Partial<Record<MenuId, number>>
  const ranked = menu
    .map(o => ({ id: o.id, p: probabilities[o.id] ?? 0 }))
    .sort((a, b) => b.p - a.p)
    .filter((x, i) => i < 3 && x.p >= 0.01)
    .map(x => `${ACTION_WORDS[x.id]} ${Math.round(x.p * 100)}%`)
  return {
    menuId: chosen.id,
    action: chosen.action,
    reasoning: ranked.length ? `${chosen.describe} — ${ranked.join(', ')}` : chosen.describe,
    probabilities,
    fallback: false,
    ...(retried ? { retried } : {}),
    ...offTop,
    model: option.id,
    latencyMs: Date.now() - started,
    usage
  }
}

// ── what the seat sees, as words (LLMs) or JSON (decision models) ──────────

function nameOf(view: SeatView, seatId: string): string {
  if (seatId === view.me.id) return `${view.me.name} (you)`
  return displayName(view.opponents.find(o => o.id === seatId)?.name ?? seatId)
}

/** The human's seat is literally named "You"; a model would read that as itself. */
function displayName(name: string): string {
  return name === 'You' ? 'Human player' : name
}

/** "Human player (button), GPT-6 Sol (small blind), Jev (you, big blind)". */
function seatingWords(view: SeatView): string {
  const pos = new Map(view.opponents.map(o => [o.id, o.position]))
  pos.set(view.me.id, view.position)
  return (view.seatOrder ?? []).map((id) => {
    if (id === view.me.id) return `${view.me.name} (you, ${view.position})`
    const o = view.opponents.find(x => x.id === id)
    return `${displayName(o?.name ?? id)} (${pos.get(id) ?? 'seated'})`
  }).join(', ')
}

function positionWords(position: string): string {
  if (position === 'button') return 'on the button'
  if (position === 'small blind' || position === 'big blind' || position === 'cutoff') return `in the ${position}`
  return `in ${position} position`
}

/**
 * Blinds aren't log events; on the preflop street what a seat has in front of
 * it beyond its logged actions is its blind — the dealer would announce it.
 */
function blindPosted(view: SeatView, seatId: string, committed: number): number {
  if (view.street !== 'preflop') return 0
  const acted = view.log.filter(e => e.seatId === seatId && e.street === 'preflop').reduce((n, e) => n + e.added, 0)
  return Math.max(0, committed - acted)
}

function blindWords(view: SeatView, amount: number): string {
  if (!amount) return ''
  if (amount === view.bigBlind) return `posted the big blind (${amount})`
  if (amount === view.bigBlind / 2) return `posted the small blind (${amount})`
  return `posted a blind of ${amount} (all-in)`
}

function eventWords(e: ActionEvent, facingBet: boolean): string {
  const verb = facingBet ? 'raises to' : 'bets'
  switch (e.action.type) {
    case 'fold': return 'folds'
    case 'check': return 'checks'
    case 'call': return `calls ${e.added}`
    case 'raise': return `${verb} ${e.raiseTo ?? e.action.to}`
    // An all-in with no raiseTo was only a (short) call.
    case 'all_in': return e.raiseTo ? `${verb} ${e.raiseTo}, all-in` : `calls ${e.added}, all-in`
  }
}

/** "preflop: X raises to 60, says "…"" lines for a log; `name` maps seat ids to how they're called. */
function logLines(log: ActionEvent[], name: (id: string) => string): string[] {
  return log.map((e, i) => {
    // Preflop the blinds are the opening bet.
    const facingBet = e.street === 'preflop'
      || log.slice(0, i).some(p => p.street === e.street && p.raiseTo !== undefined)
    const talk = e.tableTalk ? ` — says "${e.tableTalk}"` : ''
    return `${e.street}: ${name(e.seatId)} ${eventWords(e, facingBet)}${talk}`
  })
}

function actionLines(view: SeatView): string[] {
  return logLines(view.log, id => nameOf(view, id))
}

const RANK_NAMES: Record<string, string> = { 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', T: 'ten', J: 'jack', Q: 'queen', K: 'king', A: 'ace' }
const SUIT_NAMES: Record<string, string> = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' }

/** "Kh Kd (king of hearts, king of diamonds)": the cards spelled out, never named as a hand. */
export function cardsInWords(cards: Card[]): string {
  if (!cards.length) return ''
  return `${cards.join(' ')} (${cards.map(c => `${RANK_NAMES[c[0]!]} of ${SUIT_NAMES[c[1]!]}`).join(', ')})`
}

/** What the floor announces about the format and blinds; a view without `game` keeps the pre-B5 wording. */
function formatWords(view: SeatView): string {
  const g = view.game
  if (!g) return `Big blind ${view.bigBlind}.`
  if (g.type === 'cash') return `Cash game, big blind ${view.bigBlind}.`
  const head = `Sit-and-go tournament, blind level ${g.level}, big blind ${view.bigBlind}.`
  if (!g.next) return `${head} This is the top level; the blinds stay here.`
  const next = `${g.next.smallBlind}/${g.next.bigBlind}`
  if (g.handsLeftAtLevel === 0) return `${head} This is the last hand at this level; the blinds go up to ${next} next hand.`
  return `${head} ${g.handsLeftAtLevel} more hand${g.handsLeftAtLevel === 1 ? '' : 's'} at this level after this one, then the blinds go up to ${next}.`
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`

/** The structure sheet, the same for the whole table and the whole tournament. */
function tableWords(view: SeatView): string {
  const g = view.game
  if (g?.type === 'sng' && g.entrants) {
    const lines = [`Table: a sit-and-go for ${g.entrants} players, ${g.startingStack} chips each. The blinds double every ${g.handsPerLevel ?? 10} hands. No hand limit: it plays until one player has every chip.`]
    if (g.payouts?.length) {
      const paid = g.payouts.map((p, i) => `${ordinal(i + 1)} ${p}%`).join(', ')
      const several = g.entrants > g.payouts.length + 1
      const unpaid = g.entrants > g.payouts.length ? `; ${ordinal(g.payouts.length + 1)}${several ? `–${ordinal(g.entrants)} get` : ' gets'} nothing` : ''
      lines.push(`Payouts: ${paid} of the prize pool${unpaid}.`)
    }
    return lines.join('\n')
  }
  if (g?.type === 'sng') return 'Table: a sit-and-go tournament.'
  return g?.type === 'cash' ? 'Table: a cash game; the blinds never change.' : 'Table: no-limit Texas Hold\'em.'
}

const MEMORY_HEADING = 'Earlier hands you remember at this table (the last one to two orbits, up to 11 hands: every action and bet, everything said, every hand shown at showdown, who won):'

/** One street's actions for the memory log; silent folds in a row read as one clause ("A, B and C fold"). */
function compactActions(evs: ActionEvent[], log: ActionEvent[], name: (id: string) => string): string[] {
  const out: string[] = []
  let folds: string[] = []
  const flush = () => {
    if (folds.length) out.push(folds.length === 1 ? `${folds[0]} folds` : `${folds.slice(0, -1).join(', ')} and ${folds.at(-1)} fold`)
    folds = []
  }
  for (const e of evs) {
    if (e.action.type === 'fold' && !e.tableTalk) {
      folds.push(name(e.seatId))
      continue
    }
    flush()
    const i = log.indexOf(e)
    const facingBet = e.street === 'preflop' || log.slice(0, i).some(p => p.street === e.street && p.raiseTo !== undefined)
    out.push(`${name(e.seatId)} ${eventWords(e, facingBet)}${e.tableTalk ? ` — says "${e.tableTalk}"` : ''}`)
  }
  flush()
  return out
}

/**
 * One remembered hand, the same text for every seat (no "you"), so the shared prompt prefix is
 * identical across seats. Cards shown at showdown are listed; hands are never named.
 */
export function pastHandText(h: PastHand): string {
  const name = (id: string) => displayName(h.players.find(p => p.id === id)?.name ?? id)
  const n = h.players.length
  const sb = n === 2 ? h.players[0] : h.players[1]
  const bb = n === 2 ? h.players[1] : h.players[2]
  const seatsWords = n === 2
    ? `button and small blind ${name(h.players[0]!.id)}, big blind ${name(h.players[1]!.id)}`
    : `button ${name(h.players[0]!.id)}, small blind ${sb ? name(sb.id) : '—'}, big blind ${bb ? name(bb.id) : '—'}`
  const lines = [`Hand #${h.handNo} (blinds ${h.smallBlind}/${h.bigBlind}; ${seatsWords})`]
  const boardAt: Record<string, number> = { preflop: 0, flop: 3, turn: 4, river: 5 }
  let dealt = 0
  for (const street of ['preflop', 'flop', 'turn', 'river'] as const) {
    const evs = h.log.filter(e => e.street === street)
    if (!evs.length) continue
    const cards = street === 'preflop' ? '' : ` ${h.board.slice(0, boardAt[street]).slice(street === 'flop' ? 0 : boardAt[street]! - 1).join(' ')}`
    dealt = boardAt[street]!
    lines.push(`- ${street}${cards}: ${compactActions(evs, h.log, name).join('; ')}`)
  }
  if (h.board.length > dealt) lines.push(`- the board ran out: ${h.board.join(' ')}`)
  const shown = Object.entries(h.shown)
  if (shown.length) lines.push(`- showdown: ${shown.map(([id, c]) => `${name(id)} showed ${c.join(' ')}`).join('; ')}`)
  // Side pots that went to the same winners read as one pot.
  const pots = h.pots.reduce<{ amount: number, winners: string[] }[]>((acc, p) => {
    const last = acc.at(-1)
    if (last && last.winners.join() === p.winners.join()) last.amount += p.amount
    else acc.push({ amount: p.amount, winners: p.winners.slice() })
    return acc
  }, [])
  const potWords = pots.map((p, i) => {
    const who = p.winners.map(name)
    const which = pots.length === 1 ? 'the pot' : i === 0 ? 'the main pot' : 'a side pot'
    return who.length > 1 ? `${who.join(' and ')} split ${which} (${p.amount})` : `${who[0]} won ${which} (${p.amount})`
  })
  lines.push(`- ${potWords.join('; ')}${shown.length ? '' : ', no showdown'}.`)
  if (h.busted.length) lines.push(`- ${h.busted.map(name).join(' and ')} ran out of chips.`)
  return lines.join('\n')
}

/** The players knocked out so far, and how many are left (v2). */
function fieldWords(view: SeatView): string | null {
  const g = view.game
  const out = view.eliminated ?? []
  if (!(g?.type === 'sng' && g.entrants)) return null
  const left = view.opponents.length + 1
  const gone = out.length ? ` Out so far: ${out.map(e => `${displayName(e.name)} (${ordinal(e.place)}, hand ${e.handNo})`).join(', ')}.` : ''
  return `Players left: ${left} of ${g.entrants}.${gone}`
}

function chipsWords(view: SeatView, stack: number, committed: number, inPot: number | undefined, mine: boolean): string {
  const front = mine ? `${committed} in front of you this street` : `${committed} in front this street`
  return `${stack} behind, ${front}${inPot !== undefined ? `, ${inPot} in the pot this hand` : ''}`
}

function potWords(view: SeatView): string {
  const base = `Pot: ${view.pot} (every chip put in this hand, including this street).`
  const pots = view.pots ?? []
  if (pots.length < 2) return base
  const names = (ids: string[]) => ids.map(id => nameOf(view, id)).join(', ')
  return `${base} Split as: ${pots.map((p, i) => `${i === 0 ? 'main pot' : `side pot ${i}`} ${p.amount} (${names(p.eligible)})`).join('; ')}.`
}

/**
 * The prompt in two parts: `shared` (table details, then one part per remembered hand) is the same
 * for every seat at the table, so it can be cached as a prefix; `seat` is this seat's own view.
 */
export function promptParts(view: SeatView, menu: MenuOption[], strategyCard?: string): { shared: string[], seat: string } {
  const history = view.history ?? []
  const shared = [history.length ? `${tableWords(view)}\n\n${MEMORY_HEADING}` : tableWords(view), ...history.map(pastHandText)]
  const { me } = view
  const lines: string[] = []
  if (view.myCards?.length) lines.push(`Your own cards in those hands: ${view.myCards.map(m => `#${m.handNo} ${m.cards.join(' ')}`).join('; ')}.`, '')
  const card = strategyCard?.trim()
  if (card) lines.push(CARD_HEADING, card, '')
  const others = view.opponents.map(o => displayName(o.name)).join(', ')
  lines.push(`Hand #${view.handNo}, ${view.street}. ${formatWords(view)}`)
  const field = fieldWords(view)
  if (field) lines.push(field)
  lines.push(`You are ${me.name}, ${positionWords(view.position)}, playing against ${others}.`)
  lines.push('', `Your cards: ${cardsInWords(view.hole)}`)
  lines.push(`Board: ${view.board.length ? cardsInWords(view.board) : '(no community cards yet)'}`)
  lines.push('', potWords(view))
  const myBlind = blindWords(view, blindPosted(view, me.id, me.committed))
  lines.push(`You: ${chipsWords(view, me.stack, me.committed, me.inPot, true)}${myBlind ? `; you ${myBlind}` : ''}. To call: ${view.toCall}.`)
  const seating = seatingWords(view)
  if (seating) lines.push('', `Seating, clockwise from the button: ${seating}.`)
  lines.push('', 'Other players:')
  for (const o of view.opponents) {
    const status = o.folded ? 'folded' : o.allIn ? 'all-in' : 'in the hand'
    const blind = blindWords(view, blindPosted(view, o.id, o.committed))
    const where = o.position ? ` (${o.position})` : ''
    lines.push(`- ${displayName(o.name)}${where}: ${chipsWords(view, o.stack, o.committed, o.inPot, false)}, ${status}${blind ? `; ${blind}` : ''}`)
  }
  if (view.actingAfter) {
    lines.push('', view.actingAfter.length
      ? `Still to act after you this round: ${view.actingAfter.map(id => nameOf(view, id)).join(', ')}.`
      : view.canRaise ? 'Nobody acts after you this round unless you bet or raise.' : 'Nobody acts after you this round.')
  }
  const log = actionLines(view)
  lines.push('', 'Action so far this hand (after the blinds):', ...(log.length ? log.map(l => `- ${l}`) : ['- none yet']))
  const prior = view.priorTableTalk?.filter(Boolean) ?? []
  if (prior.length) lines.push('', 'Table talk you already said this session (say something new or stay quiet):', ...prior.map(t => `- "${t}"`))
  lines.push('', 'Your options (pick one id):', ...menu.map(o => `- ${o.id} — ${o.describe}`))
  return { shared, seat: lines.join('\n') }
}

/** The whole prompt as one string (logs, estimates, tests). A view with no v2 fields renders as before plus the table line. */
export function renderPrompt(view: SeatView, menu: MenuOption[], strategyCard?: string): string {
  const p = promptParts(view, menu, strategyCard)
  return [...p.shared, p.seat].join('\n\n')
}

export function tableState(view: SeatView) {
  const g = view.game
  const name = (id: string) => id === view.me.id ? `${view.me.name} (me)` : displayName(view.opponents.find(o => o.id === id)?.name ?? id)
  return {
    game: g?.type === 'sng' ? 'No-limit Texas Hold\'em sit-and-go tournament' : 'No-limit Texas Hold\'em cash game',
    ...(g?.type === 'sng'
      ? {
          blind_level: g.level,
          hands_left_at_level_after_this_one: g.handsLeftAtLevel,
          next_level_blinds: g.next ? `${g.next.smallBlind}/${g.next.bigBlind}` : 'none (top level)',
          ...(g.entrants
            ? {
                table: tableWords(view),
                players_left: view.opponents.length + 1,
                eliminated: (view.eliminated ?? []).map(e => `${displayName(e.name)}: ${ordinal(e.place)}, hand ${e.handNo}`)
              }
            : {})
        }
      : {}),
    ...(view.history?.length ? { earlier_hands: view.history.map(pastHandText) } : {}),
    ...(view.myCards?.length ? { my_cards_in_earlier_hands: view.myCards.map(m => `#${m.handNo} ${m.cards.join(' ')}`) } : {}),
    hand_number: view.handNo,
    street: view.street,
    me: {
      name: view.me.name,
      position: view.position,
      hole_cards: view.hole,
      stack_behind: view.me.stack,
      in_front_this_street: view.me.committed,
      ...(view.me.inPot !== undefined ? { in_pot_this_hand: view.me.inPot } : {}),
      blind_posted: blindPosted(view, view.me.id, view.me.committed)
    },
    board: view.board,
    pot: view.pot,
    ...((view.pots?.length ?? 0) > 1 ? { pots: view.pots!.map(p => ({ amount: p.amount, eligible: p.eligible.map(name) })) } : {}),
    to_call: view.toCall,
    big_blind: view.bigBlind,
    seating_clockwise_from_button: (view.seatOrder ?? []).map(name),
    ...(view.actingAfter ? { acting_after_me: view.actingAfter.map(name) } : {}),
    opponents: view.opponents.map(o => ({
      name: displayName(o.name),
      position: o.position,
      stack_behind: o.stack,
      in_front_this_street: o.committed,
      ...(o.inPot !== undefined ? { in_pot_this_hand: o.inPot } : {}),
      status: o.folded ? 'folded' : o.allIn ? 'all-in' : 'in the hand',
      blind_posted: blindPosted(view, o.id, o.committed)
    })),
    action_so_far: actionLines(view)
  }
}

// ── table talk hygiene ─────────────────────────────────────────────────────

/** Words a player uses for each rank. Counting words (2–T) only in plural or card phrases; see below. */
const RANK_WORDS: Record<string, { plain: string[], counting?: string }> = {
  A: { plain: ['aces?', 'rockets', 'bullets'] },
  K: { plain: ['kings?', 'cowboys'] },
  Q: { plain: ['queens?', 'ladies'] },
  J: { plain: ['jacks?', 'hooks'] },
  T: { plain: ['tens'], counting: 'ten' },
  9: { plain: ['nines'], counting: 'nine' },
  8: { plain: ['eights'], counting: 'eight' },
  7: { plain: ['sevens'], counting: 'seven' },
  6: { plain: ['sixes'], counting: 'six' },
  5: { plain: ['fives'], counting: 'five' },
  4: { plain: ['fours'], counting: 'four' },
  3: { plain: ['threes', 'treys?'], counting: 'three' },
  2: { plain: ['twos', 'deuces?', 'ducks'], counting: 'two' }
}
const SINGULAR: Record<string, string> = { ace: 'A', king: 'K', queen: 'Q', jack: 'J', ten: 'T', nine: '9', eight: '8', seven: '7', six: '6', five: '5', four: '4', three: '3', trey: '3', two: '2', deuce: '2' }
const HAND_WORD = Object.keys(SINGULAR).join('|')
const HAND_WORDS = new RegExp(`\\b(${HAND_WORD})-(${HAND_WORD})\\b`, 'gi')
const rankOfWord = (w: string) => SINGULAR[w.toLowerCase()]!
const SUIT_WORDS: Record<string, string> = { h: 'hearts?', s: 'spades?', d: 'diamonds?', c: 'clubs?' }

function rankPattern(rank: string): RegExp {
  const w = RANK_WORDS[rank]!
  const alts = [...w.plain]
  // "ten", "four" alone are usually counting ("four-bet", "two pair"); only card phrases count.
  if (w.counting) alts.push(`(?:pocket|set of|trip|pair of) ${w.counting}s?`, `${w.counting}[- ]high`)
  // Digit plurals: "pocket 9s", "10s full". (Letter shorthand like "AK" is matched case-sensitively below.)
  if (w.counting) alts.push(`${rank === 'T' ? '10' : rank}'?s`)
  return new RegExp(`\\b(?:${alts.join('|')})\\b`, 'i')
}

/**
 * True when a line names the speaker's own hole cards: a card code ("Kh"), a hole rank in words
 * ("Kings again", "pocket jacks", "set of fours", "AK") that isn't on the board, or a suit it holds
 * in a flush/draw phrase ("heart flush") unless the board alone shows that flush. A rank or suit
 * that's on the board is public, so naming it is fine.
 */
export function namesOwnCards(text: string, hole: Card[], board: Card[]): boolean {
  if (hole.some(c => new RegExp(`\\b${c}\\b`).test(text))) return true
  const boardRanks = new Set(board.map(c => c[0]))
  const hidden = [...new Set(hole.map(c => c[0]!))].filter(r => !boardRanks.has(r))
  if (hidden.some(r => rankPattern(r).test(text))) return true
  // Two-rank shorthand like "AK", "KQs", "JJ", "99", "A-K": case-sensitive, and a pure-digit pair
  // only when it's a pocket pair ("99"), so chip counts like "45" pass.
  for (const m of text.matchAll(/\b([2-9TJQKA])-?([2-9TJQKA])[so]?\b/g)) {
    const [a, b] = [m[1]!, m[2]!]
    if (/^\d$/.test(a) && /^\d$/.test(b) && a !== b) continue
    if (hidden.includes(a) || hidden.includes(b)) return true
  }
  // Hyphenated hands in words: "nine-seven", "ten-four suited", "king-trey".
  for (const m of text.matchAll(HAND_WORDS)) {
    if ([m[1]!, m[2]!].some(w => hidden.includes(rankOfWord(w)))) return true
  }
  for (const suit of new Set(hole.map(c => c[1]!))) {
    if (board.filter(c => c[1] === suit).length >= 5) continue
    const word = SUIT_WORDS[suit]!
    if (new RegExp(`\\b${word}\\b[^.!?]{0,20}\\b(?:flush|draw|suited)\\b|\\b(?:flush|draw|suited)\\b[^.!?]{0,12}\\b${word}\\b`, 'i').test(text)) return true
  }
  return false
}

/** Trim to 80 chars and drop any line that names the speaker's own hole cards (codes or words). */
export function cleanTableTalk(text: string, view: Pick<SeatView, 'hole' | 'board'>): string | undefined {
  const t = text.trim().replace(/\s+/g, ' ')
  if (!t) return undefined
  if (namesOwnCards(t, view.hole, view.board)) return undefined
  return t.length > TABLE_TALK_MAX ? `${t.slice(0, TABLE_TALK_MAX - 1).trimEnd()}…` : t
}
