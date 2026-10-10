import { test } from 'node:test'
import assert from 'node:assert/strict'
import { potLabel, stackSeries, summaryRows } from '../app/utils/session.ts'
import type { Decision } from '../shared/utils/types.ts'

const dec = (model: string, latencyMs: number, input: number, output: number): Decision => ({
  menuId: 'call', action: { type: 'call' }, reasoning: '', fallback: false, model, latencyMs, usage: { input, output }
})

test('summary rows: net, hands won, avg ms, cost; human has no cost or timing', () => {
  const seats = [
    { id: 'you', name: 'You', modelId: null, stack: 1300 },
    { id: 'seat-1', name: 'GPT-6 Sol', modelId: 'openai/gpt-6-sol', stack: 700 }
  ]
  const hands = [
    { handNo: 1, pots: [{ amount: 40, eligible: ['you', 'seat-1'], winners: ['you'], handName: 'Uncontested' }], stacksAfter: { 'you': 1020, 'seat-1': 980 } },
    { handNo: 2, pots: [{ amount: 600, eligible: ['you', 'seat-1'], winners: ['you'], handName: 'Flush' }], stacksAfter: { 'you': 1300, 'seat-1': 700 } }
  ]
  const rows = summaryRows(seats, { 'you': 1000, 'seat-1': 1000 }, hands, [
    { seatId: 'seat-1', decision: dec('openai/gpt-6-sol', 1000, 1_000_000, 0) },
    { seatId: 'seat-1', decision: dec('openai/gpt-6-sol', 3000, 0, 100_000) }
  ])
  assert.deepEqual(rows.map(r => [r.id, r.net, r.handsWon]), [['you', 300, 2], ['seat-1', -300, 0]])
  assert.equal(rows[0]!.costUsd, null)
  assert.equal(rows[0]!.avgMs, null)
  assert.equal(rows[1]!.avgMs, 2000)
  assert.equal(rows[1]!.costUsd, 3) // $2 input + $1 output
})

test('stack series starts at hand 0 and fills busted seats with 0', () => {
  const s = stackSeries(['a', 'b'], { a: 500, b: 500 }, [{ handNo: 1, pots: [], stacksAfter: { a: 1000, b: 0 } }])
  assert.deepEqual(s, [{ handNo: 0, stacks: { a: 500, b: 500 } }, { handNo: 1, stacks: { a: 1000, b: 0 } }])
})

test('pot labels', () => {
  assert.equal(potLabel(0, 1), null)
  assert.deepEqual([0, 1].map(i => potLabel(i, 2)), ['Main pot', 'Side pot'])
  assert.deepEqual([0, 1, 2].map(i => potLabel(i, 3)), ['Main pot', 'Side pot 1', 'Side pot 2'])
})
