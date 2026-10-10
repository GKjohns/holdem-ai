/**
 * One function the route and the self-play harness both call: given a seat's
 * view, ask the seated model which menu option to take. Plain module with
 * relative imports so `bench/selfplay.ts` runs it under bare Node.
 *
 * Models get only what a human in the seat has: own cards, board, chips,
 * positions, the action so far, and the menu (chip amounts + resulting pot).
 * No odds, equity, or hand strength — that's the model's job.
 */
import { generateText, Output, experimental_decide as decideWithModel, Experimental_DecisionRefusalError } from 'ai'
import { z } from 'zod'
import { buildMenu } from '../../shared/utils/menu.ts'
import { findModel } from '../../shared/utils/models.ts'
import type { ModelOption, Reasoning } from '../../shared/utils/models.ts'
import type { ActionEvent, Decision, MenuId, MenuOption, SeatView } from '../../shared/utils/types.ts'

export interface DecideInput {
  modelId: string
  view: SeatView
  signal?: AbortSignal
  /** Bench-only override of the roster's reasoning effort ('unset' sends none). */
  reasoning?: Reasoning | 'unset'
}

/** A player waiting a minute is worse than a fallback check/fold. */
export const CALL_TIMEOUT_MS = 30_000
const TABLE_TALK_MAX = 80

export const INSTRUCTIONS = `You are an AI player seated at a no-limit Texas Hold'em cash game against other AI players and possibly a human. Play to win chips.

Rules you know as a player:
- Each player has two private hole cards. Five community cards come out: the flop (3), the turn (1), the river (1). Betting rounds happen preflop, on the flop, on the turn, and on the river.
- Blinds: the small blind and big blind post forced bets before the cards are dealt. Preflop action starts left of the big blind; after the flop it starts with the first active player left of the button.
- No-limit: a raise must be at least the size of the previous bet or raise, and you can always go all-in. If you go all-in for less than a call, you can only win the part of the pot you matched (side pots).
- At showdown the best five-card hand from your two cards plus the board wins. Hand ranks, best to worst: straight flush, four of a kind, full house, flush, straight, three of a kind, two pair, one pair, high card. Ace plays high or low (A-2-3-4-5 is the lowest straight). Suits never break ties.
- Cards are written rank then suit: ranks 2-9, T (ten), J, Q, K, A; suits s (spades), h (hearts), d (diamonds), c (clubs). "Ah" is the ace of hearts.

Each turn you see your cards, the board, every player's chips, the action so far this hand, and a menu of legal options with exact chip amounts. Pick exactly one option id from the menu.

Answer fields:
- reasoning: one or two plain sentences on why you chose this option.
- tableTalk: one short in-character line you say out loud at the table (under 80 characters), or an empty string to stay quiet. Banter is fine; never reveal or hint at your exact cards.
- choice: the option id you take.`

const EVAL_QUESTION = 'You are the player described under `me` in this no-limit Texas Hold\'em hand. Which option is the best play, given your hole cards, the board, the chips, and how the other players have acted?'
const EVAL_QUESTION_RETRY = 'Which option is the best poker play here?'

const ACTION_WORDS: Record<MenuId, string> = {
  fold: 'fold',
  check: 'check',
  call: 'call',
  raise_min: 'min raise',
  raise_half_pot: 'half-pot',
  raise_pot: 'pot',
  raise_2x_pot: '2x pot',
  all_in: 'all-in'
}

function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

export async function decide(input: DecideInput): Promise<Decision> {
  const option = findModel(input.modelId)
  const menu = buildMenu(input.view)
  const started = Date.now()
  if (!option) return fallbackDecision(menu, input.modelId, started, `Unknown model ${input.modelId}`)
  try {
    return option.kind === 'evaluation'
      ? await decideWithEvaluation(option, input, menu)
      : await decideWithLlm(option, input, menu)
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    const message = timedOut ? 'timed out' : (err instanceof Error ? err.message : String(err))
    console.error('[decide] model error', option.id, message.slice(0, 300))
    return fallbackDecision(menu, option.id, started, timedOut ? 'Timed out' : 'Model error')
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

async function decideWithLlm(option: ModelOption, input: DecideInput, menu: MenuOption[]): Promise<Decision> {
  const ids = menu.map(o => o.id) as [MenuId, ...MenuId[]]
  const schema = z.object({
    reasoning: z.string().describe('One or two plain sentences on why.'),
    tableTalk: z.string().describe('One short line said out loud at the table, or an empty string. Never reveal your cards.'),
    choice: z.enum(ids)
  })
  const reasoning = input.reasoning === 'unset' ? undefined : (input.reasoning ?? option.reasoning)
  const started = Date.now()
  const { output, usage } = await generateText({
    model: option.id,
    instructions: INSTRUCTIONS,
    prompt: renderPrompt(input.view, menu),
    output: Output.object({ schema }),
    // Reasoning models think in output tokens; a low cap starves the JSON.
    // No temperature: the Claude 5 and GPT-6 families reject it.
    maxOutputTokens: 4000,
    abortSignal: withTimeout(input.signal),
    maxRetries: 1,
    providerOptions: { gateway: { caching: 'auto' } },
    ...(reasoning ? { reasoning } : {})
  })
  const usageOut = { input: usage?.inputTokens ?? 0, output: usage?.outputTokens ?? 0 }
  const chosen = output ? menu.find(o => o.id === output.choice) : undefined
  if (!output || !chosen) {
    return { ...fallbackDecision(menu, option.id, started, 'Illegal choice', output?.choice), usage: usageOut }
  }
  const tableTalk = cleanTableTalk(output.tableTalk, input.view)
  return {
    menuId: chosen.id,
    action: chosen.action,
    reasoning: output.reasoning.trim(),
    ...(tableTalk ? { tableTalk } : {}),
    fallback: false,
    model: option.id,
    latencyMs: Date.now() - started,
    usage: usageOut
  }
}

/**
 * Decision models answer one choice question over the menu. They get the same
 * table information as the LLMs, as JSON, and return a probability per option;
 * their "reasoning" is the chosen option's text plus the ranked spread.
 */
async function decideWithEvaluation(option: ModelOption, input: DecideInput, menu: MenuOption[]): Promise<Decision> {
  const criteria = Object.fromEntries(menu.map(o => [o.id, o.describe])) as Record<MenuId, string>
  const state = tableState(input.view)
  const signal = withTimeout(input.signal)
  const ask = (instructions: string) => decideWithModel({
    model: option.id,
    state,
    questions: { action: { type: 'choice', instructions, criteria } },
    abortSignal: signal,
    maxRetries: 1
  })
  const started = Date.now()
  let result: Awaited<ReturnType<typeof ask>>
  try {
    result = await ask(EVAL_QUESTION)
  } catch (err) {
    // Luna Decisions occasionally refuses a phrasing outright (deterministically, per state);
    // a plainer rewording of the same question gets an answer.
    if (!Experimental_DecisionRefusalError.isInstance(err)) throw err
    console.warn('[decide] refusal, retrying reworded', option.id)
    result = await ask(EVAL_QUESTION_RETRY)
  }
  const answer = result.answers.action
  const usage = { input: result.usage.inputTokens ?? 0, output: result.usage.outputTokens ?? 0 }
  const chosen = menu.find(o => o.id === answer.choice)
  if (!chosen) return { ...fallbackDecision(menu, option.id, started, 'Illegal choice', answer.choice), usage }
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

function actionLines(view: SeatView): string[] {
  return view.log.map((e, i) => {
    // Preflop the blinds are the opening bet.
    const facingBet = e.street === 'preflop'
      || view.log.slice(0, i).some(p => p.street === e.street && p.raiseTo !== undefined)
    const talk = e.tableTalk ? ` — says "${e.tableTalk}"` : ''
    return `${e.street}: ${nameOf(view, e.seatId)} ${eventWords(e, facingBet)}${talk}`
  })
}

export function renderPrompt(view: SeatView, menu: MenuOption[]): string {
  const { me } = view
  const lines: string[] = []
  const others = view.opponents.map(o => displayName(o.name)).join(', ')
  lines.push(`Hand #${view.handNo}, ${view.street}. Big blind ${view.bigBlind}.`)
  lines.push(`You are ${me.name}, ${positionWords(view.position)}, playing against ${others}.`)
  lines.push('', `Your cards: ${view.hole.join(' ')}`)
  lines.push(`Board: ${view.board.length ? view.board.join(' ') : '(no community cards yet)'}`)
  lines.push('', `Pot: ${view.pot} (every chip put in this hand, including this street).`)
  const myBlind = blindWords(view, blindPosted(view, me.id, me.committed))
  lines.push(`You: ${me.stack} behind, ${me.committed} in front of you this street${myBlind ? `; you ${myBlind}` : ''}. To call: ${view.toCall}.`)
  lines.push('', 'Other players:')
  for (const o of view.opponents) {
    const status = o.folded ? 'folded' : o.allIn ? 'all-in' : 'in the hand'
    const blind = blindWords(view, blindPosted(view, o.id, o.committed))
    lines.push(`- ${displayName(o.name)}: ${o.stack} behind, ${o.committed} in front this street, ${status}${blind ? `; ${blind}` : ''}`)
  }
  const log = actionLines(view)
  lines.push('', 'Action so far this hand (after the blinds):', ...(log.length ? log.map(l => `- ${l}`) : ['- none yet']))
  lines.push('', 'Your options (pick one id):', ...menu.map(o => `- ${o.id} — ${o.describe}`))
  return lines.join('\n')
}

export function tableState(view: SeatView) {
  return {
    game: 'No-limit Texas Hold\'em cash game',
    hand_number: view.handNo,
    street: view.street,
    me: {
      name: view.me.name,
      position: view.position,
      hole_cards: view.hole,
      stack_behind: view.me.stack,
      in_front_this_street: view.me.committed,
      blind_posted: blindPosted(view, view.me.id, view.me.committed)
    },
    board: view.board,
    pot: view.pot,
    to_call: view.toCall,
    big_blind: view.bigBlind,
    opponents: view.opponents.map(o => ({
      name: displayName(o.name),
      stack_behind: o.stack,
      in_front_this_street: o.committed,
      status: o.folded ? 'folded' : o.allIn ? 'all-in' : 'in the hand',
      blind_posted: blindPosted(view, o.id, o.committed)
    })),
    action_so_far: actionLines(view)
  }
}

/** Trim to 80 chars and drop any line that names one of the speaker's hole cards. */
function cleanTableTalk(text: string, view: SeatView): string | undefined {
  const t = text.trim().replace(/\s+/g, ' ')
  if (!t) return undefined
  if (view.hole.some(c => new RegExp(`\\b${c}\\b`).test(t))) return undefined
  return t.length > TABLE_TALK_MAX ? `${t.slice(0, TABLE_TALK_MAX - 1).trimEnd()}…` : t
}
