import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rankHand } from '../shared/utils/handRank.ts'
import type { Card } from '../shared/utils/types.ts'

const h = (s: string) => s.split(' ') as Card[]
const r = (s: string) => rankHand(h(s))

test('every category is named and ordered', () => {
  const ladder = [
    ['As Kd 9h 7c 4s 3d 2h', 'high_card', 'High card, ace'],
    ['As Ad 9h 7c 4s 3d 2h', 'pair', 'Pair of aces'],
    ['As Ad 7h 7c 4s 3d 2h', 'two_pair', 'Two pair, aces and sevens'],
    ['7s 7d 7h Ac 4s 3d 2h', 'three_of_a_kind', 'Three of a kind, sevens'],
    ['6s 7d 8h 9c Ts 3d 2h', 'straight', 'Straight, ten high'],
    ['As Ks 9s 7s 4s 3d 2h', 'flush', 'Flush, ace high'],
    ['Ks Kd Kh 7c 7s 3d 2h', 'full_house', 'Full house, kings full of sevens'],
    ['9s 9d 9h 9c 4s 3d 2h', 'four_of_a_kind', 'Four of a kind, nines'],
    ['5h 6h 7h 8h 9h Ad 2c', 'straight_flush', 'Straight flush, nine high'],
    ['Ts Js Qs Ks As 2d 3c', 'straight_flush', 'Royal flush']
  ] as const
  let prev = -1
  for (const [cards, category, name] of ladder) {
    const res = r(cards)
    assert.equal(res.category, category, cards)
    assert.equal(res.name, name)
    assert.ok(res.rank > prev, `${name} should beat the previous rung`)
    assert.equal(res.best5.length, 5)
    prev = res.rank
  }
})

test('wheel is a five-high straight and loses to a six-high', () => {
  const wheel = r('As 2d 3h 4c 5s Kd Qh')
  assert.equal(wheel.category, 'straight')
  assert.equal(wheel.name, 'Straight, five high')
  assert.deepEqual(wheel.best5, h('5s 4c 3h 2d As'))
  assert.ok(r('2d 3h 4c 5s 6d Kd Qh').rank > wheel.rank)
  const steelWheel = r('Ah 2h 3h 4h 5h Kd Qc')
  assert.equal(steelWheel.name, 'Straight flush, five high')
})

test('kickers decide pairs, two pair, trips and high card', () => {
  assert.ok(r('As Ad Kh 7c 4s 3d 2h').rank > r('Ac Ah Qh 7c 4s 3d 2h').rank)
  assert.ok(r('As Ad 7h 7c Ks 3d 2h').rank > r('Ac Ah 7d 7s Qs 3d 2h').rank)
  assert.ok(r('7s 7d 7h Ac Ks 3d 2h').rank > r('7s 7d 7h Ac Qs 3d 2h').rank)
  assert.ok(r('As Kd 9h 7c 5s 3d 2h').rank > r('As Kd 9h 7c 4s 3d 2h').rank)
  // Only the best five count: the sixth card doesn't break the tie.
  assert.equal(r('As Ad Kh Qc Js 3d 2h').rank, r('Ac Ah Kd Qs Jh 4d 2c').rank)
})

test('picks the best five of seven', () => {
  // A nine-high straight is available, but the eight-high straight flush is better.
  assert.equal(r('4s 5s 6s 7s 8s 9d 3c').name, 'Straight flush, eight high')
  // Two trips → full house using the higher trips.
  assert.equal(r('Ks Kd Kh 7c 7s 7d 2h').name, 'Full house, kings full of sevens')
  // Three pair → best two pair with the best kicker.
  const tp = r('As Ad 7h 7c 5s 5d Kh')
  assert.equal(tp.name, 'Two pair, aces and sevens')
  assert.equal(tp.best5.at(-1), 'Kh')
})

test('identical hands tie (split pot)', () => {
  assert.equal(r('Ts Jd Qh Kc As 2d 3h').rank, r('Td Jc Qs Kh Ac 2d 3h').rank)
  assert.notEqual(r('As Ad 9h 7c 4s 3d 2h').rank, r('As Ad 9h 7c 5s 3d 2h').rank)
})

test('rejects bad input sizes', () => {
  assert.throws(() => rankHand(h('As Kd')))
})
