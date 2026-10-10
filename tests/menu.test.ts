import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildMenu, menuToAction } from '../shared/utils/menu.ts'
import { activeSeatCount, applyAction, legalActions, newTable, seatView, startHand } from '../shared/utils/table.ts'
import { seededRng } from '../shared/utils/rng.ts'
import type { PlayerAction, SeatView, TableState } from '../shared/utils/types.ts'

function view(over: Partial<SeatView> & { stack?: number, committed?: number }): SeatView {
  const { stack = 1000, committed = 0, ...rest } = over
  return {
    handNo: 1,
    street: 'flop',
    board: ['2c', '7d', '9h'],
    hole: ['As', 'Kd'],
    me: { id: 'seat-1', name: 'Test', stack, committed },
    pot: 100,
    toCall: 0,
    minRaiseTo: 10,
    maxRaiseTo: committed + stack,
    canRaise: true,
    bigBlind: 10,
    position: 'button',
    opponents: [{ id: 'you', name: 'You', stack: 1000, committed: 0, folded: false, allIn: false }],
    log: [],
    ...rest
  }
}

const ids = (v: SeatView) => buildMenu(v).map(o => o.id)
const to = (v: SeatView, id: string) => (menuToAction(buildMenu(v), id) as { to: number } | undefined)?.to

test('unopened pot: check plus bet sizes; no fold when check is free', () => {
  const v = view({})
  assert.deepEqual(ids(v), ['check', 'raise_min', 'raise_half_pot', 'raise_pot', 'raise_2x_pot', 'all_in'])
  assert.equal(to(v, 'raise_min'), 10)
  assert.equal(to(v, 'raise_half_pot'), 50)
  assert.equal(to(v, 'raise_pot'), 100)
  assert.equal(to(v, 'raise_2x_pot'), 200)
  const menu = buildMenu(v)
  assert.equal(menu.find(o => o.id === 'raise_half_pot')!.label, 'Bet 50')
  assert.equal(menu.find(o => o.id === 'check')!.describe, 'Check (pot stays 100)')
  assert.match(menu.find(o => o.id === 'raise_pot')!.describe, /^Bet 100, .*\(pot becomes 200\)$/)
  assert.deepEqual(menuToAction(menu, 'all_in'), { type: 'all_in' })
  assert.equal(menuToAction(menu, 'fold'), undefined)
})

test('facing a bet: sizing is currentBet + X × (pot after calling)', () => {
  // Pot 150 includes a 50 bet; calling makes it 200.
  const v = view({ pot: 150, toCall: 50, minRaiseTo: 100 })
  assert.deepEqual(ids(v), ['fold', 'call', 'raise_min', 'raise_half_pot', 'raise_pot', 'raise_2x_pot', 'all_in'])
  assert.equal(ids(v).includes('check'), false)
  assert.equal(to(v, 'raise_min'), 100)
  assert.equal(to(v, 'raise_half_pot'), 150)
  assert.equal(to(v, 'raise_pot'), 250)
  assert.equal(to(v, 'raise_2x_pot'), 450)
  const menu = buildMenu(v)
  assert.equal(menu.find(o => o.id === 'call')!.describe, 'Call 50 (pot becomes 200)')
  assert.match(menu.find(o => o.id === 'raise_pot')!.describe, /^Raise to 250, .*\(pot becomes 400\)$/)
  assert.equal(menu.find(o => o.id === 'all_in')!.describe, 'Go all-in, raising to 1000 (pot becomes 1150)')
})

test('presets at or above the stack collapse into all-in, duplicates are dropped', () => {
  const v = view({ pot: 150, toCall: 50, minRaiseTo: 100, stack: 250 })
  assert.deepEqual(ids(v), ['fold', 'call', 'raise_min', 'raise_half_pot', 'all_in'])
  // Half pot lands on the min raise exactly → one option.
  const dup = view({ pot: 15, toCall: 5, committed: 5, minRaiseTo: 20, street: 'preflop', board: [] })
  assert.deepEqual(ids(dup), ['fold', 'call', 'raise_min', 'raise_pot', 'raise_2x_pot', 'all_in'])
  assert.equal(new Set(buildMenu(dup).map(o => JSON.stringify(o.action))).size, buildMenu(dup).length)
  // Only a short all-in is possible.
  const short = view({ pot: 150, toCall: 50, minRaiseTo: 80, stack: 80 })
  assert.deepEqual(ids(short), ['fold', 'call', 'all_in'])
})

test('presets below the minimum raise are dropped', () => {
  // Facing 300 after a big re-raise: half pot (665) is under the 700 minimum.
  const v = view({ pot: 430, toCall: 300, minRaiseTo: 700, stack: 3000 })
  assert.deepEqual(ids(v), ['fold', 'call', 'raise_min', 'raise_pot', 'raise_2x_pot', 'all_in'])
  assert.equal(to(v, 'raise_min'), 700)
  assert.equal(to(v, 'raise_pot'), 1030)
  assert.equal(to(v, 'raise_2x_pot'), 1760)
})

test('no raise options when canRaise is false; short call is labeled all-in', () => {
  assert.deepEqual(ids(view({ pot: 150, toCall: 50, minRaiseTo: 100, canRaise: false })), ['fold', 'call'])
  const short = buildMenu(view({ pot: 300, toCall: 40, stack: 40, canRaise: false }))
  assert.deepEqual(short.map(o => o.id), ['fold', 'call'])
  assert.equal(short[1]!.label, 'Call 40 (all-in)')
})

test('every menu option is a legal engine action across random spots', () => {
  const rng = seededRng(7)
  let s: TableState | null = null
  let checked = 0
  for (let hand = 0; hand < 150; hand++) {
    if (!s || activeSeatCount(s) < 2) {
      const n = 2 + Math.floor(rng() * 5)
      s = newTable({
        players: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: `s${i}`, modelId: null })),
        stacks: Array.from({ length: n }, () => [30, 120, 500][Math.floor(rng() * 3)]!),
        smallBlind: 5,
        bigBlind: 10
      }, hand)
    }
    s = startHand(s)
    while (s.street !== 'complete') {
      const actor = s.seats[s.toAct!]!
      const menu = buildMenu(seatView(s, actor.id))
      const legal = legalActions(s)!
      assert.equal(menu.some(o => o.id === 'check'), legal.canCheck)
      assert.equal(menu.some(o => o.id.startsWith('raise') || o.id === 'all_in'), legal.canRaise)
      for (const o of menu) {
        assert.doesNotThrow(() => applyAction(s!, actor.id, o.action), `${o.id} ${JSON.stringify(o.action)}`)
        checked++
      }
      const choice: PlayerAction = menu[Math.floor(rng() * menu.length)]!.action
      s = applyAction(s, actor.id, choice)
    }
  }
  assert.ok(checked > 500)
})
