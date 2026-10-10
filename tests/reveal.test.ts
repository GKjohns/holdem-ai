import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canRevealReasoning, canShowHoleCards } from '../app/utils/reveal.ts'

const MID_HAND = ['preflop', 'flop', 'turn', 'river', 'showdown']

test('Play mode keeps reasoning sealed until the hand is complete', () => {
  for (const street of MID_HAND) assert.equal(canRevealReasoning({ hasHuman: true, street }), false, street)
  assert.equal(canRevealReasoning({ hasHuman: true, street: 'complete' }), true)
})

test('Watch mode reveals reasoning live on every street', () => {
  for (const street of [...MID_HAND, 'complete']) assert.equal(canRevealReasoning({ hasHuman: false, street }), true, street)
})

test('AI hole cards are face up only when nobody is playing', () => {
  assert.equal(canShowHoleCards({ hasHuman: true, seatIsHuman: false }), false)
  assert.equal(canShowHoleCards({ hasHuman: true, seatIsHuman: true }), true)
  assert.equal(canShowHoleCards({ hasHuman: false, seatIsHuman: false }), true)
})
