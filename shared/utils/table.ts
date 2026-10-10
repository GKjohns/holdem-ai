/**
 * Pure no-limit hold'em engine. No Vue, no DOM: the client drives the table
 * with it, and bench scripts run it under bare Node. Every exported function
 * returns a new state; illegal input throws.
 */
import type {
  ActionEvent, Card, GameFormat, HandResult, LegalActions, PastHand, PlayerAction, Seat, SeatView, TableConfig, TableState
} from './types.ts'
import { fullDeck, shuffle } from './cards.ts'
import { rankHand } from './handRank.ts'
import type { RankedHand } from './handRank.ts'
import { seededRng } from './rng.ts'

export function newTable(config: TableConfig, seed: number): TableState {
  const { players, smallBlind, bigBlind } = config
  if (players.length < 2 || players.length > 6) throw new Error('A table seats 2–6 players')
  if (!(smallBlind > 0 && bigBlind >= smallBlind)) throw new Error('Bad blinds')
  const stacks = Array.isArray(config.stacks) ? config.stacks : players.map(() => config.stacks as number)
  if (stacks.length !== players.length) throw new Error('One stack per player')
  return {
    handNo: 0,
    seed,
    deck: [],
    board: [],
    seats: players.map((p, i) => ({
      id: p.id,
      name: p.name,
      modelId: p.modelId,
      stack: stacks[i]!,
      hole: [],
      committed: 0,
      totalCommitted: 0,
      folded: false,
      allIn: false,
      busted: stacks[i]! <= 0,
      actedThisRound: false
    })),
    // -1 so the first hand's button lands on seat 0.
    button: -1,
    toAct: null,
    street: 'complete',
    smallBlind,
    bigBlind,
    currentBet: 0,
    lastRaiseSize: bigBlind,
    log: []
  }
}

/** Seats with chips that can still be dealt in. */
export function activeSeatCount(state: TableState): number {
  return state.seats.filter(s => s.stack > 0).length
}

export function startHand(prev: TableState): TableState {
  if (prev.street !== 'complete') throw new Error('Hand still in progress')
  const state = structuredClone(prev)
  for (const s of state.seats) {
    s.busted = s.stack <= 0
    s.hole = []
    s.committed = 0
    s.totalCommitted = 0
    s.folded = s.busted
    s.allIn = false
    s.actedThisRound = false
    s.lastAction = s.busted ? 'busted' : undefined
  }
  const live = state.seats.filter(s => !s.busted).length
  if (live < 2) throw new Error('Need at least two players with chips')

  state.handNo += 1
  state.board = []
  state.log = []
  state.result = undefined
  state.street = 'preflop'
  state.button = nextIndex(state, state.button, s => !s.busted)

  // Heads-up: the button posts the small blind.
  const sb = live === 2 ? state.button : nextIndex(state, state.button, s => !s.busted)
  const bb = nextIndex(state, sb, s => !s.busted)
  post(state.seats[sb]!, state.smallBlind, 'small blind')
  post(state.seats[bb]!, state.bigBlind, 'big blind')
  // Callers owe the full big blind even if the BB is short.
  state.currentBet = state.bigBlind
  state.lastRaiseSize = state.bigBlind

  const rng = seededRng((state.seed ^ Math.imul(state.handNo, 0x9E3779B1)) >>> 0)
  state.deck = shuffle(fullDeck(), rng)
  for (let round = 0; round < 2; round++) {
    let i = state.button
    for (let k = 0; k < live; k++) {
      i = nextIndex(state, i, s => !s.busted)
      state.seats[i]!.hole.push(state.deck.shift()!)
    }
  }

  // Preflop action starts left of the BB (heads-up that's the button).
  return advance(state, bb)
}

export function legalActions(state: TableState): LegalActions | null {
  if (state.toAct === null) return null
  return legalFor(state, state.seats[state.toAct]!)
}

function legalFor(state: TableState, seat: Seat): LegalActions {
  const owed = Math.max(0, state.currentBet - seat.committed)
  const maxRaiseTo = seat.committed + seat.stack
  const othersCanCall = state.seats.some(s => s !== seat && inHand(s) && !s.allIn)
  // A seat that already acted may re-raise only if the raising since its last action adds up to a full raise.
  // Acting (check/call/raise) leaves committed at the bet level it faced, so that's the gap to measure.
  const reopened = !seat.actedThisRound || state.currentBet - seat.committed >= state.lastRaiseSize
  const canRaise = inHand(seat) && !seat.allIn && seat.stack > owed && othersCanCall && reopened
  return {
    seatId: seat.id,
    toCall: Math.min(owed, seat.stack),
    canCheck: owed === 0,
    canRaise,
    minRaiseTo: Math.min(state.currentBet + state.lastRaiseSize, maxRaiseTo),
    maxRaiseTo
  }
}

export function applyAction(prev: TableState, seatId: string, action: PlayerAction): TableState {
  if (prev.toAct === null) throw new Error('No one is to act')
  const actor = prev.seats[prev.toAct]!
  if (actor.id !== seatId) throw new Error(`Not ${seatId}'s turn (${actor.id} to act)`)
  const legal = legalFor(prev, actor)
  const state = structuredClone(prev)
  const seat = state.seats[state.toAct!]!
  const street = state.street
  const event: ActionEvent = { seatId, street, action, added: 0 }

  let type = action.type
  let raiseTo = action.type === 'raise' ? action.to : 0
  if (type === 'all_in') {
    raiseTo = seat.committed + seat.stack
    // An all-in that doesn't exceed the bet is just a (short) call.
    if (raiseTo <= state.currentBet) type = 'call'
  }

  switch (type) {
    case 'fold':
      seat.folded = true
      seat.lastAction = 'folds'
      break
    case 'check':
      if (!legal.canCheck) throw new Error(`${seatId} cannot check facing ${legal.toCall}`)
      seat.lastAction = 'checks'
      break
    case 'call': {
      if (legal.canCheck) throw new Error(`${seatId} has nothing to call`)
      event.added = moveChips(seat, legal.toCall)
      seat.lastAction = seat.allIn ? `calls ${event.added}, all-in` : `calls ${event.added}`
      break
    }
    case 'raise':
    case 'all_in': {
      if (!legal.canRaise) throw new Error(`${seatId} cannot raise`)
      if (!Number.isInteger(raiseTo) || raiseTo < legal.minRaiseTo || raiseTo > legal.maxRaiseTo) {
        throw new Error(`${seatId} raise to ${raiseTo} outside ${legal.minRaiseTo}–${legal.maxRaiseTo}`)
      }
      const increment = raiseTo - state.currentBet
      const wasBet = state.currentBet === 0
      event.added = moveChips(seat, raiseTo - seat.committed)
      event.raiseTo = raiseTo
      if (increment >= state.lastRaiseSize) {
        // Full raise reopens action for everyone else.
        state.lastRaiseSize = increment
        for (const s of state.seats) if (s !== seat && inHand(s) && !s.allIn) s.actedThisRound = false
      }
      state.currentBet = raiseTo
      const verb = wasBet ? `bets ${raiseTo}` : `raises to ${raiseTo}`
      seat.lastAction = seat.allIn ? `${verb}, all-in` : verb
      break
    }
  }

  seat.actedThisRound = true
  state.log.push(event)
  return advance(state, state.toAct!)
}

/** Attach table talk to the most recent log event (the server returns it with the decision). */
export function withTableTalk(prev: TableState, seatId: string, tableTalk: string): TableState {
  const state = structuredClone(prev)
  const last = state.log.at(-1)
  if (last && last.seatId === seatId && tableTalk) last.tableTalk = tableTalk
  return state
}

/** How many of its own lines a seat is reminded of (a player remembers what they just said). */
export const PRIOR_TALK_MAX = 5

/**
 * A seat's own recent lines for `priorTableTalk`: everything it said this session, oldest first,
 * deduplicated by most recent use, last `max`. A line said again moves to the end, so a habit like
 * "Your move." stays in the window instead of aging out behind newer one-offs.
 */
export function recentTalk(said: string[], max = PRIOR_TALK_MAX): string[] {
  const out: string[] = []
  for (const line of said) {
    const t = line.trim()
    if (!t) continue
    const i = out.indexOf(t)
    if (i >= 0) out.splice(i, 1)
    out.push(t)
  }
  return out.slice(-max)
}

/** `game` is the format the floor announces (cash, or the sit-and-go blind level); omitted = not stated. */
export function seatView(state: TableState, seatId: string, game?: GameFormat): SeatView {
  const seat = state.seats.find(s => s.id === seatId)
  if (!seat) throw new Error(`No seat ${seatId}`)
  const legal = legalFor(state, seat)
  const isTurn = state.toAct !== null && state.seats[state.toAct] === seat
  return {
    handNo: state.handNo,
    street: state.street,
    board: state.board.slice(),
    hole: seat.hole.slice(),
    me: { id: seat.id, name: seat.name, stack: seat.stack, committed: seat.committed, inPot: seat.totalCommitted },
    pot: potTotal(state),
    toCall: legal.toCall,
    minRaiseTo: legal.minRaiseTo,
    maxRaiseTo: legal.maxRaiseTo,
    canRaise: isTurn && legal.canRaise,
    bigBlind: state.bigBlind,
    position: positionOf(state, state.seats.indexOf(seat)),
    opponents: state.seats
      .filter(s => s !== seat && !s.busted)
      .map(s => ({
        id: s.id, name: s.name, stack: s.stack, committed: s.committed, folded: s.folded, allIn: s.allIn,
        position: positionOf(state, state.seats.indexOf(s)), inPot: s.totalCommitted
      })),
    seatOrder: seatOrder(state),
    log: structuredClone(state.log),
    ...(game ? { game: structuredClone(game) } : {}),
    ...(state.street === 'complete' || state.street === 'showdown' ? {} : { actingAfter: actingAfter(state, seat), pots: currentPots(state) })
  }
}

/** Seat indexes of the small and big blind this hand (heads-up, the button is the small blind). */
function blindIndexes(state: TableState): { sb: number, bb: number } {
  const live = state.seats.filter(s => !s.busted).length
  const sb = live === 2 ? state.button : nextIndex(state, state.button, s => !s.busted)
  return { sb, bb: nextIndex(state, sb, s => !s.busted) }
}

/**
 * Who acts after `seat` on this street if nobody raises: the seats after it in this street's order
 * (preflop from left of the big blind, later streets from left of the button) that are still in
 * the hand with chips. What a player sees by looking left.
 */
export function actingAfter(state: TableState, seat: Seat): string[] {
  const n = state.seats.length
  const first = state.street === 'preflop' ? blindIndexes(state).bb : state.button
  const order = Array.from({ length: n }, (_, k) => state.seats[(first + 1 + k) % n]!).filter(s => !s.busted)
  const me = order.indexOf(seat)
  if (me < 0) return []
  return order.slice(me + 1).filter(s => inHand(s) && !s.allIn).map(s => s.id)
}

/**
 * The pot as the dealer splits it right now: one pot, or once someone is all-in, a main pot and
 * side pots, each with the seats that can still win it. Layers are cut at each all-in player's
 * total; a seat that isn't all-in can still match any layer.
 */
export function currentPots(state: TableState): { amount: number, eligible: string[] }[] {
  const contenders = state.seats.filter(inHand)
  const caps = [...new Set(contenders.filter(s => s.allIn).map(s => s.totalCommitted))].sort((a, b) => a - b)
  if (!caps.length) return [{ amount: potTotal(state), eligible: contenders.map(s => s.id) }]
  const out: { amount: number, eligible: string[] }[] = []
  let prev = 0
  for (const cap of [...caps, Infinity]) {
    const amount = state.seats.reduce((sum, s) => sum + Math.min(s.totalCommitted, cap) - Math.min(s.totalCommitted, prev), 0)
    const eligible = contenders.filter(s => !s.allIn || s.totalCommitted >= cap).map(s => s.id)
    prev = cap
    if (amount > 0) out.push({ amount, eligible })
  }
  return out
}

/** A finished hand as the whole table saw it (no hole cards unless shown at showdown). */
export function pastHand(state: TableState): PastHand {
  if (state.street !== 'complete' || !state.result) throw new Error('Hand not finished')
  const n = state.seats.length
  const dealt = Array.from({ length: n }, (_, k) => state.seats[(state.button + k) % n]!).filter(s => !s.busted)
  return {
    handNo: state.handNo,
    smallBlind: state.smallBlind,
    bigBlind: state.bigBlind,
    players: dealt.map(s => ({ id: s.id, name: s.name, stack: s.stack - (state.result!.deltas[s.id] ?? 0) })),
    log: structuredClone(state.log),
    board: state.board.slice(),
    shown: Object.fromEntries(Object.entries(state.result.shown).map(([id, x]) => [id, x.cards.slice()])),
    pots: state.result.pots.map(p => ({ amount: p.amount, winners: p.winners.slice() })),
    busted: dealt.filter(s => s.stack === 0).map(s => s.id)
  }
}

/** Hands per memory block: a seat remembers this block of 10 hands and the one before. */
export const MEMORY_BLOCK = 10

/**
 * The earlier hands a seat remembers on hand `handNo`: those since the start of the previous block
 * of MEMORY_BLOCK hands (10–19 hands). Within a block the window only grows, so the rendered
 * history is a stable prompt prefix that prompt caching can reuse.
 */
export function memoryWindow(history: PastHand[], handNo: number, block = MEMORY_BLOCK): PastHand[] {
  const start = Math.floor((handNo - 1) / block) * block + 1 - block
  return history.filter(h => h.handNo >= start && h.handNo < handNo)
}

/** Adds the remembered hands, and this seat's own cards in them, to a view. */
export function withMemory(view: SeatView, history: PastHand[], holes: Map<number, Record<string, Card[]>>): SeatView {
  const remembered = memoryWindow(history, view.handNo)
  if (!remembered.length) return view
  const myCards = remembered
    .map(h => ({ handNo: h.handNo, cards: holes.get(h.handNo)?.[view.me.id] ?? [] }))
    .filter(x => x.cards.length === 2)
  return { ...view, history: remembered, ...(myCards.length ? { myCards } : {}) }
}

/** Seats still in the game, clockwise from the button. */
export function seatOrder(state: TableState): string[] {
  const n = state.seats.length
  return Array.from({ length: n }, (_, k) => state.seats[(state.button + k) % n]!)
    .filter(s => !s.busted)
    .map(s => s.id)
}

export function potTotal(state: TableState): number {
  return state.seats.reduce((sum, s) => sum + s.totalCommitted, 0)
}

export function positionOf(state: TableState, index: number): string {
  const live = state.seats.map((s, i) => ({ s, i })).filter(x => !x.s.busted)
  const n = live.length
  const btn = live.findIndex(x => x.i === state.button)
  const me = live.findIndex(x => x.i === index)
  if (btn < 0 || me < 0) return 'out'
  const k = (me - btn + n) % n
  if (k === 0) return 'button'
  if (n === 2) return 'big blind'
  if (k === 1) return 'small blind'
  if (k === 2) return 'big blind'
  if (k === n - 1) return 'cutoff'
  return k === 3 ? 'early' : 'middle'
}

// ── internals ────────────────────────────────────────────────────────────────

function inHand(s: Seat): boolean {
  return !s.busted && !s.folded
}

function nextIndex(state: TableState, from: number, pred: (s: Seat) => boolean): number {
  const n = state.seats.length
  for (let k = 1; k <= n; k++) {
    const i = (((from + k) % n) + n) % n
    if (pred(state.seats[i]!)) return i
  }
  throw new Error('No seat matches')
}

function moveChips(seat: Seat, amount: number): number {
  const paid = Math.min(amount, seat.stack)
  seat.stack -= paid
  seat.committed += paid
  seat.totalCommitted += paid
  if (seat.stack === 0) seat.allIn = true
  return paid
}

function post(seat: Seat, amount: number, label: string) {
  const paid = moveChips(seat, amount)
  seat.lastAction = seat.allIn ? `posts ${label} ${paid}, all-in` : `posts ${label} ${paid}`
}

function needsToAct(state: TableState, s: Seat): boolean {
  return inHand(s) && !s.allIn && (!s.actedThisRound || s.committed < state.currentBet)
}

/** After an action (or the blinds): pick the next actor, or close the round and move on. */
function advance(state: TableState, from: number): TableState {
  const contenders = state.seats.filter(inHand)
  if (contenders.length === 1) return finishUncontested(state, contenders[0]!)

  const canAct = contenders.filter(s => !s.allIn)
  // A lone seat with chips that already covers every all-in opponent has nothing left to decide
  // (e.g. heads-up, the SB facing a BB who was all-in for less than the small blind).
  const lone = canAct.length === 1
    && canAct[0]!.committed >= Math.max(...contenders.filter(s => s.allIn).map(s => s.committed))
  if (canAct.length > 0 && !lone && canAct.some(s => needsToAct(state, s))) {
    state.toAct = nextIndex(state, from, s => needsToAct(state, s))
    return state
  }

  returnUncalled(state)
  state.toAct = null
  if (canAct.length <= 1 || state.street === 'river') {
    while (state.board.length < 5) dealStreet(state)
    return showdown(state)
  }
  dealStreet(state)
  for (const s of state.seats) {
    s.committed = 0
    s.actedThisRound = false
  }
  state.currentBet = 0
  state.lastRaiseSize = state.bigBlind
  // Postflop action starts left of the button (heads-up that's the big blind).
  state.toAct = nextIndex(state, state.button, s => needsToAct(state, s))
  return state
}

function dealStreet(state: TableState) {
  state.deck.shift() // burn
  const n = state.board.length === 0 ? 3 : 1
  for (let i = 0; i < n; i++) state.board.push(state.deck.shift()!)
  state.street = state.board.length === 3 ? 'flop' : state.board.length === 4 ? 'turn' : 'river'
}

/** The part of the top bet nobody matched goes back before pots are built. */
function returnUncalled(state: TableState) {
  const sorted = state.seats.slice().sort((a, b) => b.totalCommitted - a.totalCommitted)
  const top = sorted[0]!
  const excess = top.totalCommitted - (sorted[1]?.totalCommitted ?? 0)
  if (excess <= 0) return
  top.stack += excess
  top.totalCommitted -= excess
  top.committed = Math.max(0, top.committed - excess)
  if (top.stack > 0) top.allIn = false
  state.currentBet = Math.max(...state.seats.map(s => s.committed))
}

function finishUncontested(state: TableState, winner: Seat): TableState {
  returnUncalled(state)
  const amount = potTotal(state)
  winner.stack += amount
  const deltas: Record<string, number> = {}
  for (const s of state.seats) if (!s.busted) deltas[s.id] = (s === winner ? amount : 0) - s.totalCommitted
  state.result = {
    pots: [{ amount, eligible: [winner.id], winners: [winner.id], handName: 'Uncontested' }],
    shown: {},
    deltas
  }
  return complete(state)
}

function showdown(state: TableState): TableState {
  state.street = 'showdown'
  const contenders = state.seats.filter(inHand)
  const ranked = new Map<Seat, RankedHand>()
  const shown: HandResult['shown'] = {}
  for (const s of contenders) {
    const r = rankHand([...s.hole, ...state.board] as Card[])
    ranked.set(s, r)
    shown[s.id] = { cards: s.hole.slice(), best5: r.best5, handName: r.name }
  }

  // Odd chips go to winners in seat order starting left of the button.
  const n = state.seats.length
  const order = (s: Seat) => (state.seats.indexOf(s) - state.button - 1 + n) % n

  const winnings = new Map<Seat, number>()
  const pots: HandResult['pots'] = []
  const levels = [...new Set(contenders.map(s => s.totalCommitted))].sort((a, b) => a - b)
  let prevLevel = 0
  levels.forEach((level, li) => {
    let amount = 0
    for (const s of state.seats) {
      const cap = li === levels.length - 1 ? Infinity : level
      amount += Math.min(s.totalCommitted, cap) - Math.min(s.totalCommitted, prevLevel)
    }
    const eligible = contenders.filter(s => s.totalCommitted >= level)
    prevLevel = level
    if (amount <= 0) return
    const best = Math.max(...eligible.map(s => ranked.get(s)!.rank))
    const winners = eligible.filter(s => ranked.get(s)!.rank === best).sort((a, b) => order(a) - order(b))
    const share = Math.floor(amount / winners.length)
    let odd = amount - share * winners.length
    for (const w of winners) {
      const extra = odd > 0 ? 1 : 0
      odd -= extra
      winnings.set(w, (winnings.get(w) ?? 0) + share + extra)
    }
    pots.push({
      amount,
      eligible: eligible.map(s => s.id),
      winners: winners.map(s => s.id),
      handName: ranked.get(winners[0]!)!.name
    })
  })

  const deltas: Record<string, number> = {}
  for (const s of state.seats) {
    if (s.busted) continue
    const won = winnings.get(s) ?? 0
    s.stack += won
    deltas[s.id] = won - s.totalCommitted
  }
  state.result = { pots, shown, deltas }
  return complete(state)
}

function complete(state: TableState): TableState {
  state.street = 'complete'
  state.toAct = null
  return state
}
