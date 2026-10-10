/**
 * Shared types for the engine, the action menu, and /api/decide.
 * Pure module: no Nuxt auto-imports, so `node --test` and bench scripts can load it.
 */

export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A'
export type Suit = 's' | 'h' | 'd' | 'c'
export type Card = `${Rank}${Suit}`

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'complete'

export interface Seat {
  id: string
  name: string
  modelId: string | null
  stack: number
  hole: Card[]
  /** Chips put in on the current street. */
  committed: number
  /** Chips put in this hand (side pots). */
  totalCommitted: number
  folded: boolean
  allIn: boolean
  /** Stack 0 at hand start → sits out. */
  busted: boolean
  /** Reset each street, and for everyone else on a full raise. */
  actedThisRound: boolean
  lastAction?: string
}

export type PlayerAction
  = | { type: 'fold' }
    | { type: 'check' }
    | { type: 'call' }
    /** "Raise to" total for the street; a bet is a raise when currentBet is 0. */
    | { type: 'raise', to: number }
    | { type: 'all_in' }

export interface ActionEvent {
  seatId: string
  street: Street
  action: PlayerAction
  /** Chips moved from stack by this action. */
  added: number
  raiseTo?: number
  tableTalk?: string
}

export interface HandResult {
  pots: { amount: number, eligible: string[], winners: string[], handName: string }[]
  /** Seats reaching showdown. Empty when the hand ended on a fold. */
  shown: Record<string, { cards: Card[], best5: Card[], handName: string }>
  deltas: Record<string, number>
}

export interface TableState {
  handNo: number
  seed: number
  deck: Card[]
  board: Card[]
  seats: Seat[]
  button: number
  toAct: number | null
  street: Street
  smallBlind: number
  bigBlind: number
  /** Highest street commitment. */
  currentBet: number
  /** Increment of the last full bet/raise (starts at bigBlind). Min raise-to = currentBet + lastRaiseSize. */
  lastRaiseSize: number
  log: ActionEvent[]
  result?: HandResult
}

export interface TableConfig {
  players: { id: string, name: string, modelId: string | null }[]
  /** One starting stack for everyone, or one per player. */
  stacks: number | number[]
  smallBlind: number
  bigBlind: number
}

export interface LegalActions {
  seatId: string
  /** Chips needed to call, capped at the stack (a short call is all-in). */
  toCall: number
  canCheck: boolean
  canRaise: boolean
  /** Lowest legal raise-to; equals maxRaiseTo when the only raise is a short all-in. */
  minRaiseTo: number
  /** committed + stack. */
  maxRaiseTo: number
}

/**
 * The ONLY thing sent to /api/decide: what a human in that seat could see or be
 * told by the dealer. Nothing derived (no odds, no hand strength).
 */
export interface SeatView {
  handNo: number
  street: Street
  board: Card[]
  hole: Card[]
  /** `inPot` (v2): every chip this seat has put in this hand, all streets. */
  me: { id: string, name: string, stack: number, committed: number, inPot?: number }
  /** All chips in, including the current street. */
  pot: number
  toCall: number
  minRaiseTo: number
  maxRaiseTo: number
  /** False when a short all-in didn't reopen action for this seat. */
  canRaise: boolean
  bigBlind: number
  position: string
  opponents: { id: string, name: string, stack: number, committed: number, folded: boolean, allIn: boolean, position: string, inPot?: number }[]
  /** Seat ids still in the game, clockwise starting from the button (includes `me`). */
  seatOrder: string[]
  log: ActionEvent[]
  /** Lines this seat has already said this session (client-supplied; LLMs are told not to repeat them). */
  priorTableTalk?: string[]
  /**
   * The game format, as the floor would announce it: a cash game with fixed blinds, or a sit-and-go
   * with its current blind level and how many hands are left at it. Optional so B3–B5 run files
   * (written before this field existed) still parse; a view without it reads as a cash game.
   */
  game?: GameFormat
  // ── v2 (2026-10-11): what else a human at the table knows. All optional, so older run files parse. ──
  /** Seats still in the hand (not all-in) that act after this one on this street, in order. */
  actingAfter?: string[]
  /** The pot as the dealer splits it: one entry, or main + side pots once someone is all-in. */
  pots?: { amount: number, eligible: string[] }[]
  /** Players already knocked out (sit-and-go), in bust order. */
  eliminated?: { id: string, name: string, place: number, handNo: number }[]
  /** Earlier hands at this table a player would remember (public events only); see memoryWindow(). */
  history?: PastHand[]
  /** This seat's own hole cards in those hands. */
  myCards?: { handNo: number, cards: Card[] }[]
}

/**
 * One finished hand as everyone at the table saw it: no hole cards except those shown at showdown,
 * no hand names. Built by pastHand() in table.ts.
 */
export interface PastHand {
  handNo: number
  smallBlind: number
  bigBlind: number
  /** Seats dealt in, clockwise starting with the button, with their stacks at the start of the hand. */
  players: { id: string, name: string, stack: number }[]
  log: ActionEvent[]
  board: Card[]
  /** Hole cards turned face up at showdown. */
  shown: Record<string, Card[]>
  pots: { amount: number, winners: string[] }[]
  /** Seats that ran out of chips on this hand. */
  busted: string[]
}

export type GameFormat
  = | { type: 'cash' }
    | {
      type: 'sng'
      /** 1-based blind level. */
      level: number
      /** Hands still to be played at this level after the current one (0 = last hand at this level). */
      handsLeftAtLevel: number
      /** Blinds at the next level; absent at the last level, which repeats. */
      next?: { smallBlind: number, bigBlind: number }
      /** v2: the structure sheet. Players who started, chips each, hands per level, payout % by place. */
      entrants?: number
      startingStack?: number
      handsPerLevel?: number
      payouts?: number[]
    }

/**
 * v2 added ⅓, ¾ and 1½× pot presets and `raise_to` (language models only: any amount, sent as
 * `amount`). Older run files only use the v1 ids.
 */
export type MenuId = 'fold' | 'check' | 'call' | 'raise_min' | 'raise_third_pot' | 'raise_half_pot' | 'raise_3q_pot' | 'raise_pot' | 'raise_1_5x_pot' | 'raise_2x_pot' | 'raise_to' | 'all_in'

export interface MenuOption {
  id: MenuId
  action: PlayerAction
  label: string
  /** One sentence in words, with chip amounts and the resulting pot. */
  describe: string
}

export interface Decision {
  menuId: MenuId
  action: PlayerAction
  reasoning: string
  tableTalk?: string
  probabilities?: Partial<Record<MenuId, number>>
  fallback: boolean
  requested?: string
  /** A decision model refused the first phrasing and answered a reworded retry. */
  retried?: boolean
  /** The first call timed out across a system sleep (wall time ≫ awake time), so it was asked again. */
  retriedAfterSleep?: boolean
  /** A decision model's `choice` wasn't its own top probability (the SDK rejects these; we keep the choice). */
  choiceNotTop?: boolean
  model: string
  latencyMs: number
  /** `input` counts every prompt token; v2 also logs how many of them were cache reads / writes. */
  usage: { input: number, output: number, cacheRead?: number, cacheWrite?: number }
}
