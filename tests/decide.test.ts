import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockLanguageModelV4, Experimental_DecisionMockModelV4 } from 'ai/test'
import { decide } from '../server/utils/decide.ts'
import { newTable, seatView, startHand } from '../shared/utils/table.ts'

const view = seatView(startHand(newTable({
  players: [
    { id: 'seat-1', name: 'GPT-6 Luna', modelId: 'openai/gpt-6-luna' },
    { id: 'seat-2', name: 'Jev', modelId: 'typesafe-ai/jev' },
    { id: 'seat-3', name: 'GPT-6 Luna Decisions', modelId: 'openai/gpt-6-luna-decisions' }
  ],
  stacks: 1000,
  smallBlind: 5,
  bigBlind: 10
}, 7)), 'seat-1')

/** Never settles and never looks at the abort signal: the worst a provider path can do. */
const forever = () => new Promise<never>(() => {})
const T = 150

test('an LLM call that ignores the abort signal still returns a fallback at the deadline', async () => {
  const model = new MockLanguageModelV4({ doGenerate: forever })
  const t0 = Date.now()
  const d = await decide({ modelId: 'openai/gpt-6-luna', view, model, timeoutMs: T })
  const ms = Date.now() - t0
  assert.equal(d.fallback, true)
  assert.match(d.reasoning, /^Timed out/)
  assert.ok(ms >= T - 5 && ms < T + 500, `took ${ms} ms`)
})

test('the SDK retry is inside the same deadline (a model that errors then hangs)', async () => {
  let calls = 0
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      calls++
      if (calls === 1) throw Object.assign(new Error('overloaded'), { isRetryable: true, name: 'AI_APICallError' })
      return forever()
    }
  })
  const t0 = Date.now()
  const d = await decide({ modelId: 'openai/gpt-6-luna', view, model, timeoutMs: T })
  assert.equal(d.fallback, true)
  assert.ok(Date.now() - t0 < T + 500)
})

test('a decision model that refuses, then hangs on the reworded retry, is bounded by one deadline', async () => {
  let calls = 0
  const model = new Experimental_DecisionMockModelV4({
    supportedQuestionTypes: ['choice'],
    doDecide: async () => {
      calls++
      if (calls === 1) return { answers: { action: { type: 'refusal' } }, warnings: [] }
      return forever()
    }
  })
  const t0 = Date.now()
  const d = await decide({ modelId: 'openai/gpt-6-luna-decisions', view, model, timeoutMs: T })
  const ms = Date.now() - t0
  assert.equal(calls, 2, 'the reworded retry was made')
  assert.equal(d.fallback, true)
  assert.ok(ms < T + 500, `took ${ms} ms`)
})

test('a caller abort ends a hung call immediately', async () => {
  const model = new MockLanguageModelV4({ doGenerate: forever })
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), 30)
  const t0 = Date.now()
  const d = await decide({ modelId: 'openai/gpt-6-luna', view, model, timeoutMs: 10_000, signal: ctrl.signal })
  assert.equal(d.fallback, true)
  assert.ok(Date.now() - t0 < 1000)
})

test('a healthy decision model answer passes through with probabilities', async () => {
  const model = new Experimental_DecisionMockModelV4({
    supportedQuestionTypes: ['choice'],
    doDecide: async ({ questions }) => {
      const ids = Object.keys((questions.action as { criteria: Record<string, string> }).criteria)
      const probabilities = Object.fromEntries(ids.map(id => [id, id === 'call' ? 1 : 0]))
      return { answers: { action: { type: 'choice', choice: 'call', probabilities } }, usage: { inputTokens: 500 }, warnings: [] }
    }
  })
  const d = await decide({ modelId: 'typesafe-ai/jev', view, model, timeoutMs: T })
  assert.equal(d.fallback, false)
  assert.equal(d.menuId, 'call')
  assert.equal(d.usage.input, 500)
})

test('a decision model whose choice is not its own top probability keeps the choice, flagged', async () => {
  const model = new Experimental_DecisionMockModelV4({
    supportedQuestionTypes: ['choice'],
    doDecide: async ({ questions }) => {
      const ids = Object.keys((questions.action as { criteria: Record<string, string> }).criteria)
      const probabilities = Object.fromEntries(ids.map(id => [id, id === 'fold' ? 0.7 : id === 'call' ? 0.3 : 0]))
      return { answers: { action: { type: 'choice', choice: 'call', probabilities } }, warnings: [] }
    }
  })
  const d = await decide({ modelId: 'typesafe-ai/jev', view, model, timeoutMs: T })
  assert.equal(d.fallback, false)
  assert.equal(d.menuId, 'call')
  assert.equal(d.choiceNotTop, true)
  assert.equal(d.probabilities?.fold, 0.7)
})
