import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seatStats, sessionCost } from '../shared/utils/stats.ts'
import type { ActionEvent, Card, Decision, HandResult } from '../shared/utils/types.ts'

const ev = (seatId: string, street: ActionEvent['street'], type: 'fold' | 'check' | 'call' | 'all_in', added = 0): ActionEvent =>
  ({ seatId, street, action: { type }, added })
const raise = (seatId: string, street: ActionEvent['street'], to: number, added: number): ActionEvent =>
  ({ seatId, street, action: { type: 'raise', to }, added, raiseTo: to })
const holes = (ids: string[]) => Object.fromEntries(ids.map(id => [id, ['As', 'Kd'] as Card[]]))
const pot = (amount: number, winners: string[]): HandResult['pots'][number] => ({ amount, eligible: winners, winners, handName: 'Pair' })
const shown = (ids: string[]) => Object.fromEntries(ids.map(id => [id, { cards: [] as Card[], best5: [] as Card[], handName: 'Pair' }]))
const FLOP: Card[] = ['2c', '7d', 'Jh']
const RIVER: Card[] = ['2c', '7d', 'Jh', '9s', '3c']

// Three seats, four hands; c busts before hand 4.
const hands = [
  // 1: a raises, b calls, c (BB) folds. Flop: a bets, b calls. Turn: a bets, b raises, a calls. River checks; showdown, b wins.
  { handNo: 1, board: RIVER, holes: holes(['a', 'b', 'c']), shown: shown(['a', 'b']), pots: [pot(400, ['b'])], log: [
    raise('a', 'preflop', 30, 30), ev('b', 'preflop', 'call', 25), ev('c', 'preflop', 'fold'),
    raise('a', 'flop', 40, 40), ev('b', 'flop', 'call', 40),
    raise('a', 'turn', 60, 60), raise('b', 'turn', 180, 180), ev('a', 'turn', 'call', 120),
    ev('b', 'river', 'check'), ev('a', 'river', 'check')
  ] },
  // 2: everyone limps / checks to the flop, c bets, a and b fold. No showdown.
  { handNo: 2, board: FLOP, holes: holes(['a', 'b', 'c']), shown: {}, pots: [pot(30, ['c'])], log: [
    ev('a', 'preflop', 'call', 10), ev('b', 'preflop', 'call', 5), ev('c', 'preflop', 'check'),
    ev('b', 'flop', 'check'), raise('c', 'flop', 20, 20), ev('a', 'flop', 'fold'), ev('b', 'flop', 'fold')
  ] },
  // 3: a folds, b shoves (a raise), c calls all-in short (all_in that only calls). Runout, split pot.
  { handNo: 3, board: RIVER, holes: holes(['a', 'b', 'c']), shown: shown(['b', 'c']), pots: [pot(200, ['b', 'c'])], log: [
    ev('a', 'preflop', 'fold'), { ...raise('b', 'preflop', 500, 495), action: { type: 'all_in' } }, ev('c', 'preflop', 'all_in', 90)
  ] },
  // 4: c is busted; a raises, b folds.
  { handNo: 4, board: [], holes: { ...holes(['a', 'b']), c: [] }, shown: {}, pots: [pot(25, ['a'])], log: [
    raise('a', 'preflop', 30, 30), ev('b', 'preflop', 'fold')
  ] }
]

const dec = (model: string, latencyMs: number, input: number, output: number): Decision =>
  ({ menuId: 'call', action: { type: 'call' }, reasoning: '', fallback: false, model, latencyMs, usage: { input, output } })

test('VPIP, PFR, AF, WTSD, W$SD per seat on a hand-built fixture', () => {
  const [a, b, c] = seatStats(['a', 'b', 'c'], hands, [])
  // a: dealt 4; VPIP hands 1,2,4 (3/4); PFR hands 1,4 (2/4); postflop bets 2 (flop, turn), calls 1 (turn) → AF 2.
  // Saw the flop in 1 and 2; showdown in 1 (lost) → WTSD 50%, W$SD 0%.
  assert.deepEqual([a!.hands, a!.vpip, a!.pfr, a!.af, a!.wtsd, a!.wsd], [4, 75, 50, 2, 50, 0])
  // b: VPIP 1,2,3 (3/4); PFR hand 3 only; postflop: flop call, turn raise → AF 1. Saw flop 1,2,3; showdowns 1,3, won both.
  assert.deepEqual([b!.hands, b!.vpip, b!.pfr, b!.af, b!.wsd], [4, 75, 25, 1, 100])
  assert.ok(Math.abs(b!.wtsd! - 200 / 3) < 1e-9)
  // c: dealt 3 (sat out hand 4); VPIP hand 3 (short all-in call), no PFR; postflop flop bet only → AF ∞.
  // Saw flop 2 and 3 (folded preflop in 1); showdown 3, split → won.
  assert.ok(Math.abs(c!.vpip! - 100 / 3) < 1e-9)
  assert.deepEqual([c!.hands, c!.pfr, c!.af, c!.wtsd, c!.wsd], [3, 0, Infinity, 50, 100])
})

test('empty denominators are null, not 0 or NaN', () => {
  const [s] = seatStats(['z'], hands, [])
  assert.deepEqual([s!.hands, s!.vpip, s!.pfr, s!.af, s!.wtsd, s!.wsd, s!.avgMs], [0, null, null, null, null, null, null])
  const [a] = seatStats(['a'], [hands[3]!], [])
  assert.equal(a!.wtsd, null) // never saw a flop
  assert.equal(a!.af, null) // no postflop action
})

test('avg decision ms and cost come from decisions; session cost sums them', () => {
  const ds = [
    { seatId: 'a', decision: dec('openai/gpt-6-sol', 1000, 1_000_000, 0) },
    { seatId: 'a', decision: dec('openai/gpt-6-sol', 3000, 0, 100_000) },
    { seatId: 'b', decision: dec('typesafe-ai/jev', 250, 1_000_000, 0) }
  ]
  const [a, b] = seatStats(['a', 'b'], hands, ds)
  assert.deepEqual([a!.decisions, a!.avgMs, a!.costUsd], [2, 2000, 3])
  assert.deepEqual([b!.decisions, b!.avgMs, b!.costUsd], [1, 250, 0.042])
  assert.equal(sessionCost(ds), 3.042)
})
