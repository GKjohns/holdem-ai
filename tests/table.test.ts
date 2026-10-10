import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  activeSeatCount, applyAction, legalActions, newTable, potTotal, seatView, startHand
} from '../shared/utils/table.ts'
import { fullDeck } from '../shared/utils/cards.ts'
import { seededRng } from '../shared/utils/rng.ts'
import type { Card, PlayerAction, TableState } from '../shared/utils/types.ts'

const ids = (n: number) => Array.from({ length: n }, (_, i) => (i === 0 ? 'you' : `seat-${i}`))

function table(stacks: number[], seed = 1): TableState {
  return newTable({
    players: ids(stacks.length).map(id => ({ id, name: id, modelId: id === 'you' ? null : 'test/model' })),
    stacks,
    smallBlind: 5,
    bigBlind: 10
  }, seed)
}

const who = (s: TableState) => (s.toAct === null ? null : s.seats[s.toAct]!.id)
const act = (s: TableState, action: PlayerAction) => applyAction(s, who(s)!, action)
const seat = (s: TableState, id: string) => s.seats.find(x => x.id === id)!
// Once a hand is complete the pot has been paid out, but totalCommitted is kept for display.
const chips = (s: TableState) => s.seats.reduce((n, x) => n + x.stack, 0) + (s.street === 'complete' ? 0 : potTotal(s))

/** Fix hole cards and the runout. Deck order: burn, flop×3, burn, turn, burn, river. */
function rig(s: TableState, holes: Record<string, string>, board: string): TableState {
  const next = structuredClone(s)
  const used = new Set<string>([...Object.values(holes).join(' ').split(' '), ...board.split(' ')])
  const spare = fullDeck().filter(c => !used.has(c))
  for (const [id, cards] of Object.entries(holes)) seat(next, id).hole = cards.split(' ') as Card[]
  const b = board.split(' ') as Card[]
  next.deck = [spare[0]!, b[0]!, b[1]!, b[2]!, spare[1]!, b[3]!, spare[2]!, b[4]!, ...spare.slice(3, 10)]
  return next
}

test('three-handed blinds and preflop order', () => {
  const s = startHand(table([1000, 1000, 1000]))
  assert.equal(s.button, 0)
  assert.equal(seat(s, 'seat-1').committed, 5)
  assert.equal(seat(s, 'seat-2').committed, 10)
  assert.equal(s.currentBet, 10)
  assert.equal(who(s), 'you')
  assert.equal(s.seats.every(x => x.hole.length === 2), true)
  assert.equal(new Set(s.seats.flatMap(x => x.hole)).size, 6)
  assert.equal(seatView(s, 'you').position, 'button')
  assert.equal(seatView(s, 'seat-1').position, 'small blind')
  assert.equal(seatView(s, 'seat-2').position, 'big blind')
})

test('heads-up: button posts SB, acts first preflop and last postflop', () => {
  let s = startHand(table([1000, 1000]))
  assert.equal(seat(s, 'you').committed, 5)
  assert.equal(seat(s, 'seat-1').committed, 10)
  assert.equal(who(s), 'you')
  s = act(s, { type: 'call' })
  assert.equal(who(s), 'seat-1', 'BB gets the option')
  s = act(s, { type: 'check' })
  assert.equal(s.street, 'flop')
  assert.equal(s.board.length, 3)
  assert.equal(who(s), 'seat-1', 'BB acts first postflop')
  s = act(s, { type: 'check' })
  assert.equal(who(s), 'you')
  s = act(s, { type: 'check' })
  assert.equal(s.street, 'turn')
  assert.equal(who(s), 'seat-1')
})

test('BB option: limped pot lets the BB check or raise, and a raise reopens action', () => {
  let s = startHand(table([1000, 1000, 1000]))
  s = act(s, { type: 'call' })
  s = act(s, { type: 'call' })
  assert.equal(who(s), 'seat-2')
  const legal = legalActions(s)!
  assert.equal(legal.canCheck, true)
  assert.equal(legal.canRaise, true)
  assert.equal(legal.minRaiseTo, 20)

  const checked = act(s, { type: 'check' })
  assert.equal(checked.street, 'flop')
  assert.equal(who(checked), 'seat-1', 'SB first postflop')

  const raised = act(s, { type: 'raise', to: 40 })
  assert.equal(raised.street, 'preflop')
  assert.equal(who(raised), 'you')
  assert.equal(legalActions(raised)!.canRaise, true)
})

test('min-raise follows the last full raise size', () => {
  let s = startHand(table([1000, 1000, 1000]))
  s = act(s, { type: 'raise', to: 30 })
  assert.equal(s.lastRaiseSize, 20)
  assert.equal(legalActions(s)!.minRaiseTo, 50)
  assert.throws(() => act(s, { type: 'raise', to: 40 }), /outside/)
  s = act(s, { type: 'raise', to: 80 })
  assert.equal(s.lastRaiseSize, 50)
  assert.equal(legalActions(s)!.minRaiseTo, 130)
  s = act(s, { type: 'fold' })
  s = act(s, { type: 'call' })
  assert.equal(s.street, 'flop')
  assert.equal(s.lastRaiseSize, 10)
  assert.equal(legalActions(s)!.minRaiseTo, 10, 'minimum bet postflop is the big blind')
  assert.throws(() => act(s, { type: 'raise', to: 5 }), /outside/)
  assert.throws(() => act(s, { type: 'call' }), /nothing to call/)
})

test('a short all-in does not reopen action for seats that already acted', () => {
  let s = startHand(table([1000, 1000, 45]))
  s = act(s, { type: 'raise', to: 30 }) // you
  s = act(s, { type: 'call' }) // SB
  s = act(s, { type: 'all_in' }) // BB: 45 total, only 15 more
  assert.equal(seat(s, 'seat-2').allIn, true)
  assert.equal(s.currentBet, 45)
  assert.equal(s.lastRaiseSize, 20, 'short raise leaves the raise size alone')
  assert.equal(who(s), 'you')
  const legal = legalActions(s)!
  assert.equal(legal.canRaise, false)
  assert.equal(legal.toCall, 15)
  assert.equal(seatView(s, 'you').canRaise, false)
  assert.throws(() => act(s, { type: 'raise', to: 65 }), /cannot raise/)
  assert.throws(() => act(s, { type: 'all_in' }), /cannot raise/)
  s = act(s, { type: 'call' })
  assert.equal(legalActions(s)!.canRaise, false)
  s = act(s, { type: 'call' })
  assert.equal(s.street, 'flop')
})

test('a seat that has not acted may still raise over a short all-in', () => {
  // Button 'you' (40 chips), SB seat-1, BB seat-2, UTG seat-3.
  let s = startHand(table([40, 1000, 1000, 1000]))
  assert.equal(who(s), 'seat-3')
  s = act(s, { type: 'raise', to: 30 })
  s = act(s, { type: 'all_in' }) // you: 40, a short raise
  assert.equal(who(s), 'seat-1')
  const legal = legalActions(s)!
  assert.equal(legal.canRaise, true)
  assert.equal(legal.minRaiseTo, 60)
})

test('short-stacked blinds post what they have and are all-in', () => {
  const sb = startHand(table([1000, 3, 1000]))
  assert.equal(seat(sb, 'seat-1').committed, 3)
  assert.equal(seat(sb, 'seat-1').allIn, true)

  let bb = startHand(table([1000, 1000, 6]))
  assert.equal(seat(bb, 'seat-2').committed, 6)
  assert.equal(bb.currentBet, 10, 'callers still owe the full big blind')
  assert.equal(legalActions(bb)!.toCall, 10)
  bb = act(bb, { type: 'fold' })
  bb = act(bb, { type: 'fold' })
  assert.equal(bb.street, 'complete')
  assert.deepEqual(bb.result!.deltas, { 'you': 0, 'seat-1': -5, 'seat-2': 5 })
  assert.equal(seat(bb, 'seat-2').stack, 11)

  // Heads-up, BB all-in for less than the SB: nobody has a decision; run it out.
  const hu = startHand(table([1000, 3]))
  assert.equal(hu.street, 'complete')
  assert.equal(hu.board.length, 5)
  assert.equal(seat(hu, 'you').totalCommitted, 3, 'uncalled 2 of the small blind returned')
  assert.equal(chips(hu), 1003)
})

test('uncalled bets are returned', () => {
  let s = startHand(table([1000, 1000]))
  s = act(s, { type: 'raise', to: 300 })
  s = act(s, { type: 'fold' })
  assert.deepEqual(s.result!.deltas, { 'you': 10, 'seat-1': -10 })
  assert.equal(s.result!.pots[0]!.amount, 20)
  assert.deepEqual(s.result!.shown, {}, 'fold-win shows no cards')

  let p = startHand(table([1000, 1000]))
  p = act(p, { type: 'call' })
  p = act(p, { type: 'check' })
  p = act(p, { type: 'raise', to: 100 }) // seat-1 bets the flop
  p = act(p, { type: 'fold' })
  assert.equal(seat(p, 'seat-1').stack, 1010)
  assert.equal(seat(p, 'you').stack, 990)
})

test('all-in runout: board completes, shorter stack caps the pot, excess returned', () => {
  let s = rig(startHand(table([1000, 300])), { 'you': 'As Ad', 'seat-1': 'Ks Kd' }, '2c 7d 9h Js 3s')
  s = act(s, { type: 'all_in' })
  assert.equal(who(s), 'seat-1')
  s = act(s, { type: 'call' })
  assert.equal(s.street, 'complete')
  assert.deepEqual(s.board, ['2c', '7d', '9h', 'Js', '3s'])
  assert.equal(s.result!.pots.length, 1)
  assert.equal(s.result!.pots[0]!.amount, 600)
  assert.deepEqual(s.result!.pots[0]!.winners, ['you'])
  assert.equal(seat(s, 'you').stack, 1300)
  assert.equal(seat(s, 'seat-1').stack, 0)
  assert.deepEqual(Object.keys(s.result!.shown).sort(), ['seat-1', 'you'])
  assert.equal(s.result!.shown.you!.handName, 'Pair of aces')
})

test('three-way all-in builds a main pot and a side pot', () => {
  let s = rig(
    startHand(table([100, 300, 1000])),
    { 'you': 'As Ad', 'seat-1': 'Ks Kd', 'seat-2': 'Qs Qd' },
    '2c 7d 9h Js 3s'
  )
  s = act(s, { type: 'all_in' }) // you 100
  s = act(s, { type: 'all_in' }) // SB 300
  assert.equal(who(s), 'seat-2')
  assert.equal(legalActions(s)!.canRaise, false, 'nobody left to raise against')
  s = act(s, { type: 'call' })
  assert.equal(s.street, 'complete')
  const pots = s.result!.pots
  assert.equal(pots.length, 2)
  assert.deepEqual(pots[0], { amount: 300, eligible: ['you', 'seat-1', 'seat-2'], winners: ['you'], handName: 'Pair of aces' })
  assert.deepEqual(pots[1], { amount: 400, eligible: ['seat-1', 'seat-2'], winners: ['seat-1'], handName: 'Pair of kings' })
  assert.equal(seat(s, 'you').stack, 300)
  assert.equal(seat(s, 'seat-1').stack, 400)
  assert.equal(seat(s, 'seat-2').stack, 700)
  assert.deepEqual(s.result!.deltas, { 'you': 200, 'seat-1': 100, 'seat-2': -300 })
})

test('split pot gives the odd chip to the first winner left of the button', () => {
  let s = rig(
    startHand(table([1000, 1000, 1000])),
    { 'you': '2c 3c', 'seat-1': '4h 6h', 'seat-2': '4d 5d' },
    'Ts Jd Qh Kc Ad'
  )
  s = act(s, { type: 'call' }) // you
  s = act(s, { type: 'fold' }) // SB leaves 5 in
  s = act(s, { type: 'check' }) // BB
  for (let i = 0; i < 6; i++) s = act(s, { type: 'check' })
  assert.equal(s.street, 'complete')
  const pot = s.result!.pots[0]!
  assert.equal(pot.amount, 25)
  assert.deepEqual(pot.winners, ['seat-2', 'you'])
  assert.equal(pot.handName, 'Straight, ace high')
  assert.equal(seat(s, 'seat-2').stack, 1003)
  assert.equal(seat(s, 'you').stack, 1002)
  assert.equal(seat(s, 'seat-1').stack, 995)
})

test('fold-through ends the hand without a showdown', () => {
  let s = startHand(table([1000, 1000, 1000]))
  s = act(s, { type: 'fold' })
  s = act(s, { type: 'fold' })
  assert.equal(s.street, 'complete')
  assert.equal(s.toAct, null)
  assert.equal(s.board.length, 0)
  assert.deepEqual(s.result!.shown, {})
  assert.deepEqual(s.result!.pots[0]!.winners, ['seat-2'])
  assert.deepEqual(s.result!.deltas, { 'you': 0, 'seat-1': -5, 'seat-2': 5 })
})

test('human may fold when check is free', () => {
  let s = startHand(table([1000, 1000]))
  s = act(s, { type: 'call' })
  s = act(s, { type: 'fold' }) // BB folds instead of checking its option
  assert.deepEqual(s.result!.pots[0]!.winners, ['you'])
})

test('a busted seat sits out and the button skips it', () => {
  let s = rig(
    startHand(table([1000, 10, 1000])),
    { 'you': 'As Ad', 'seat-1': '7c 2d', 'seat-2': '8h 3s' },
    'Kc Qd 9h 5s 4c'
  )
  s = act(s, { type: 'raise', to: 30 })
  s = act(s, { type: 'call' }) // SB calls all-in for 5 more
  s = act(s, { type: 'fold' })
  assert.equal(s.street, 'complete')
  assert.equal(seat(s, 'seat-1').stack, 0)
  assert.equal(seat(s, 'you').stack, 1020)
  assert.equal(activeSeatCount(s), 2)

  s = startHand(s)
  assert.equal(seat(s, 'seat-1').busted, true)
  assert.deepEqual(seat(s, 'seat-1').hole, [])
  assert.equal(s.button, 2, 'button moves from 0 past busted seat 1')
  assert.equal(seat(s, 'seat-2').committed, 5, 'heads-up button posts the small blind')
  assert.equal(seat(s, 'you').committed, 10)
  assert.equal(seatView(s, 'you').opponents.length, 1)

  s = act(s, { type: 'fold' })
  s = startHand(s)
  assert.equal(s.button, 0)
})

test('seatView strips every other seat\'s hole cards', () => {
  const s = startHand(table([1000, 1000, 1000, 1000, 1000, 1000]))
  for (const x of s.seats) {
    const view = seatView(s, x.id)
    const text = JSON.stringify(view)
    assert.deepEqual(view.hole, x.hole)
    for (const other of s.seats) {
      if (other === x) continue
      for (const c of other.hole) assert.equal(text.includes(c), false, `${x.id} can see ${other.id}'s ${c}`)
    }
  }
  const positions = s.seats.map(x => seatView(s, x.id).position)
  assert.deepEqual(positions, ['button', 'small blind', 'big blind', 'early', 'middle', 'cutoff'])
})

test('illegal turns and actions throw', () => {
  const s = startHand(table([1000, 1000, 1000]))
  assert.throws(() => applyAction(s, 'seat-1', { type: 'call' }), /Not seat-1's turn/)
  assert.throws(() => act(s, { type: 'check' }), /cannot check/)
  assert.throws(() => act(s, { type: 'raise', to: 1001 }), /outside/)
  assert.throws(() => startHand(s), /in progress/)
})

test('property: chips are conserved across 500 seeded random-action hands', () => {
  const rng = seededRng(20261009)
  const pick = <T>(xs: T[]) => xs[Math.floor(rng() * xs.length)]!
  let s: TableState | null = null
  let tables = 0
  let showdowns = 0
  let sidePots = 0
  for (let hand = 0; hand < 500; hand++) {
    if (!s || activeSeatCount(s) < 2) {
      const n = 2 + Math.floor(rng() * 5)
      s = table(Array.from({ length: n }, () => pick([15, 40, 100, 250, 600])), hand + 1)
      tables++
    }
    const before = Object.fromEntries(s.seats.map(x => [x.id, x.stack]))
    const total = chips(s)
    s = startHand(s)
    let steps = 0
    while (s.street !== 'complete') {
      assert.ok(++steps < 200, 'hand did not terminate')
      const legal = legalActions(s)!
      const actor = s.seats[s.toAct!]!
      assert.equal(actor.folded || actor.allIn || actor.busted, false)
      const r = rng()
      let action: PlayerAction
      if (r < 0.15) action = { type: 'fold' }
      else if (r < 0.6) action = legal.canCheck ? { type: 'check' } : { type: 'call' }
      else if (r < 0.7 && legal.canRaise) action = { type: 'all_in' }
      else if (legal.canRaise) {
        const to = legal.minRaiseTo + Math.floor(rng() * (legal.maxRaiseTo - legal.minRaiseTo + 1))
        action = { type: 'raise', to }
      } else action = legal.canCheck ? { type: 'check' } : { type: 'call' }
      s = applyAction(s, actor.id, action)
      assert.equal(chips(s), total)
      for (const x of s.seats) {
        assert.ok(x.stack >= 0 && x.committed >= 0 && x.committed <= x.totalCommitted)
      }
    }
    const result = s.result!
    assert.equal(s.seats.reduce((n, x) => n + x.stack, 0), total)
    assert.equal(Object.values(result.deltas).reduce((a, b) => a + b, 0), 0)
    assert.equal(result.pots.reduce((n, p) => n + p.amount, 0), potTotal(s))
    for (const x of s.seats) {
      if (!x.busted) assert.equal(x.stack - before[x.id]!, result.deltas[x.id], `${x.id} delta`)
    }
    if (Object.keys(result.shown).length) {
      showdowns++
      assert.equal(s.board.length, 5)
    }
    if (result.pots.length > 1) sidePots++
  }
  // The random walk must actually exercise the interesting paths.
  assert.ok(tables > 5, `tables ${tables}`)
  assert.ok(showdowns > 50, `showdowns ${showdowns}`)
  assert.ok(sidePots > 10, `side pots ${sidePots}`)
})
