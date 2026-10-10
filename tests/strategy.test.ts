import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockLanguageModelV4 } from 'ai/test'
import { decide, INSTRUCTIONS, instructionsFor } from '../server/utils/decide.ts'
import { leadOf, unitsOf } from '../server/utils/lab.ts'
import type { LabFiles } from '../server/utils/lab.ts'
import type { ParsedRun, RunHandLine, TournamentLine } from '../shared/utils/runs.ts'
import { aliasesFor, axisDiff, bannedContent, exploreQuota, heldOutVerdict, thompsonTopUp, validateGeneration, verdict } from '../shared/utils/strategy.ts'
import type { Axes, StrategyCard } from '../shared/utils/strategy.ts'
import { newTable, seatView, startHand } from '../shared/utils/table.ts'

const axes = (o: Partial<Axes> = {}): Axes => ({ looseness: 'medium', aggression: 'balanced', bluffing: 'sometimes', sizing: 'pot', showdown: 'selective', adaptation: 'situational', talk: 'friendly', ...o })
const words = 'Play solid poker from late position, raise your good hands, and fold the weak ones early. '.repeat(4)
let n = 0
const card = (o: Partial<StrategyCard> = {}): StrategyCard => ({
  id: `c${++n}`, gen: 0, kind: 'explore', parentIds: [], changed: '', name: `Card ${n}`, card: words, axes: axes(),
  hypothesis: 'It wins.', predicted: { bb100: 10, rank: 1, vsControl: 5 }, ...o
})

test('explore quota: gen 0 all explore, then round(0.4 n)', () => {
  assert.deepEqual(exploreQuota(8, 0), { explore: 8, exploit: 0 })
  assert.deepEqual(exploreQuota(5, 1), { explore: 2, exploit: 3 })
  assert.deepEqual(exploreQuota(4, 1), { explore: 2, exploit: 2 })
  assert.deepEqual(exploreQuota(8, 2), { explore: 3, exploit: 5 })
})

test('a generation that breaks the explore quota or the distance rules is rejected', () => {
  const a = card({ axes: axes({ looseness: 'tight', aggression: 'passive' }), predicted: { bb100: 0, rank: 1, vsControl: 0 } })
  const b = card({ axes: axes({ looseness: 'loose', aggression: 'aggressive' }), predicted: { bb100: 0, rank: 2, vsControl: 0 } })
  assert.deepEqual(validateGeneration([a, b], { gen: 0, n: 2, tested: [], parentPool: [] }), [])
  // Too close to each other: only one axis apart.
  const c = card({ axes: axes({ looseness: 'tight', aggression: 'aggressive' }), predicted: { bb100: 0, rank: 2, vsControl: 0 } })
  assert.match(validateGeneration([a, c], { gen: 0, n: 2, tested: [], parentPool: [] }).join(), /fewer than 2 axes/)

  // Gen 1 with 5 cards needs exactly 3 exploit + 2 explore; here 1 + 4.
  const tested = [a, b]
  const mut = card({ gen: 1, kind: 'exploit', parentIds: [a.id], changed: 'river bets bigger', axes: { ...a.axes, sizing: 'overbet' }, predicted: { bb100: 0, rank: 1, vsControl: 0 } })
  const ex = (k: number, o: Partial<Axes>) => card({ gen: 1, axes: axes({ looseness: 'medium', aggression: 'balanced', ...o }), predicted: { bb100: 0, rank: k, vsControl: 0 } })
  const gen1 = [mut, ex(2, { talk: 'silent', bluffing: 'rare' }), ex(3, { talk: 'needling', bluffing: 'frequent' }), ex(4, { talk: 'deceptive', showdown: 'sticky' }), ex(5, { adaptation: 'fixed', sizing: 'small' })]
  const errs = validateGeneration(gen1, { gen: 1, n: 5, tested, parentPool: [a.id, b.id] })
  assert.match(errs.join(), /explore quota: need exactly 2 explore and 3 exploit/)
})

test('exploit cards: one change per mutation, crossover axes from the parents, parents from the top cards', () => {
  const p1 = card({ axes: axes({ looseness: 'tight', aggression: 'passive' }) })
  const p2 = card({ axes: axes({ looseness: 'loose', aggression: 'aggressive', talk: 'silent' }) })
  const ctx = { gen: 1, n: 1, tested: [p1, p2], parentPool: [p1.id, p2.id] }
  // n = 1 → quota 0 explore / 1 exploit.
  const two = card({ gen: 1, kind: 'exploit', parentIds: [p1.id], changed: 'x', axes: { ...p1.axes, sizing: 'small', talk: 'silent' } })
  assert.match(validateGeneration([two], ctx).join(), /a mutation changes one thing/)
  const cross = card({ gen: 1, kind: 'exploit', parentIds: [p1.id, p2.id], changed: 'x', axes: { ...p1.axes, talk: 'needling' } })
  assert.match(validateGeneration([cross], ctx).join(), /talk come from neither/)
  const outsider = card({ gen: 1, kind: 'exploit', parentIds: ['nope'], changed: 'x', axes: p1.axes })
  assert.match(validateGeneration([outsider], ctx).join(), /not one of the top cards/)
  const unnamed = card({ gen: 1, kind: 'exploit', parentIds: [p1.id], changed: ' ', axes: p1.axes })
  assert.match(validateGeneration([unnamed], ctx).join(), /name the single thing changed/)
})

test('cards are style only: numbers from the data are rejected', () => {
  assert.deepEqual(bannedContent(words), [])
  assert.ok(bannedContent('Jev calls 68% of the time').length)
  assert.ok(bannedContent('Their VPIP is high, so value bet').length)
  assert.ok(bannedContent('You are a 3 to 1 favorite here').length)
  assert.ok(bannedContent('Call when the pot odds are 4:1 or better').length)
  assert.deepEqual(bannedContent('Bet about one river in three; size 2x pot when you have the nuts.'), [])
  const bad = card({ card: `${words} Their win rate against you is poor.` })
  assert.match(validateGeneration([bad], { gen: 0, n: 1, tested: [], parentPool: [] }).join(), /style guidance only/)
})

test('verdicts: a pre-registered direction against the lead CI; held-out overfit flag', () => {
  assert.equal(verdict(20, { value: 30, lo: 5, hi: 60 }), 'confirmed')
  assert.equal(verdict(20, { value: -30, lo: -60, hi: -5 }), 'refuted')
  assert.equal(verdict(20, { value: 10, lo: -20, hi: 40 }), 'inconclusive')
  assert.equal(verdict(-20, { value: -30, lo: -60, hi: -5 }), 'confirmed')
  assert.equal(verdict(0, { value: 3, lo: -20, hi: 30 }), 'confirmed')
  assert.equal(verdict(20, { value: null, lo: null, hi: null }), 'inconclusive')
  assert.equal(heldOutVerdict({ value: -5, lo: -40 }), 'overfit')
  assert.equal(heldOutVerdict({ value: 25, lo: 4 }), 'holds')
  assert.equal(heldOutVerdict({ value: 25, lo: -10 }), 'inconclusive')
})

test('Thompson top-up is seeded and favors the stronger arm; aliases are a seeded shuffle', () => {
  const arms = [{ id: 'a', mean: 60, se: 10 }, { id: 'b', mean: 0, se: 10 }]
  assert.deepEqual(thompsonTopUp(arms, 5, 3), thompsonTopUp(arms, 5, 3))
  assert.equal(thompsonTopUp(arms, 20, 3).a, 20)
  assert.deepEqual(aliasesFor(3, 9), aliasesFor(3, 9))
  assert.equal(new Set(aliasesFor(6, 9)).size, 6)
  assert.equal(axisDiff(axes(), axes({ talk: 'silent', sizing: 'small' })), 2)
})

const view = seatView(startHand(newTable({
  players: [
    { id: 'seat-1', name: 'Ash', modelId: 'openai/gpt-6-luna' },
    { id: 'seat-2', name: 'Jev', modelId: 'typesafe-ai/jev' }
  ],
  stacks: 1000,
  smallBlind: 5,
  bigBlind: 10
}, 3)), 'seat-1')

test('a strategy card rides in the LLM instructions, never in the seat view; decision models refuse cards', async () => {
  assert.equal(instructionsFor(), INSTRUCTIONS)
  assert.ok(instructionsFor('Be a maniac.').endsWith('Be a maniac.'))
  let system = ''
  const model = new MockLanguageModelV4({
    doGenerate: async (opts) => {
      system = JSON.stringify(opts.prompt.filter(m => m.role === 'system'))
      return { content: [{ type: 'text', text: JSON.stringify({ reasoning: 'r', tableTalk: '', choice: 'fold' }) }], finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } }, warnings: [] }
    }
  })
  const d = await decide({ modelId: 'openai/gpt-6-luna', view, model, strategyCard: 'Fold everything but aces.' })
  assert.equal(d.fallback, false)
  assert.match(system, /Fold everything but aces/)
  assert.ok(!JSON.stringify(view).includes('Fold everything'))
  const e = await decide({ modelId: 'typesafe-ai/jev', view, strategyCard: 'x' })
  assert.equal(e.fallback, true)
})

test('lab leads: paired over complete matches; upTo replays a ranking with only the matches it saw', () => {
  // One table, players c1 and control, heads-up: c1 wins 1 bb/hand in m01 and loses 1 in m02.
  const hands: RunHandLine[] = []
  const tournaments: TournamentLine[] = []
  for (const [m, edge] of [['m01', 1], ['m02', -1]] as const) {
    for (const r of [0, 1]) {
      const tId = `${m}-r${r}`
      const seats = r === 0 ? [{ id: 's1', name: 'Ash', modelId: 'openai/gpt-6-luna', playerId: 'c1' }, { id: 's2', name: 'Elm', modelId: 'openai/gpt-6-luna', playerId: 'control' }] : [{ id: 's1', name: 'Elm', modelId: 'openai/gpt-6-luna', playerId: 'control' }, { id: 's2', name: 'Ash', modelId: 'openai/gpt-6-luna', playerId: 'c1' }]
      const c1 = seats.find(s => s.playerId === 'c1')!.id
      const ct = seats.find(s => s.playerId === 'control')!.id
      for (let k = 1; k <= 10; k++) hands.push({ matchId: m, tournamentId: tId, handNo: k, bigBlind: 20, seats, result: { pots: [], shown: {}, deltas: { [c1]: 20 * edge, [ct]: -20 * edge } } } as unknown as RunHandLine)
      tournaments.push({ matchId: m, tournamentId: tId, finish: [{ seatId: c1, modelId: 'openai/gpt-6-luna', playerId: 'c1', place: edge > 0 ? 1 : 2 }, { seatId: ct, modelId: 'openai/gpt-6-luna', playerId: 'control', place: edge > 0 ? 2 : 1 }] } as unknown as TournamentLine)
    }
  }
  const run = { start: { lineup: ['c1', 'control'] }, hands, partialHands: [], tournaments, ends: [], scouting: null, badLines: 0 } as unknown as ParsedRun
  const tables: LabFiles['tables'] = [{ slug: 'g0-c1', run, mtimeMs: 0 }]
  const all = leadOf(unitsOf(tables), 'c1', { iters: 300 })
  assert.equal(all.matches, 2)
  assert.equal(all.bb100.value, 0)
  assert.equal(all.lead.value, 0)
  const first = leadOf(unitsOf(tables, () => 1), 'c1', { iters: 300 })
  assert.equal(first.matches, 1)
  assert.equal(first.lead.value, 200)
})
