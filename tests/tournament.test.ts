import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SNG_TURBO, bustsThisHand, levelIndex, survivorsPlaced, withLevel } from '../shared/utils/tournament.ts'
import { matchSeed, rotate, schedule } from '../shared/utils/duplicate.ts'
import { bb100Series, chipFlow, finishDistribution, leaderboard, matchAggregates, plackettLuce } from '../shared/utils/stats.ts'
import type { RunHandLite, RunTournamentLite } from '../shared/utils/stats.ts'
import { newTable, startHand } from '../shared/utils/table.ts'

test('blinds step up every 10 hands and the last level repeats', () => {
  const L = SNG_TURBO.levels
  assert.equal(levelIndex(L, 1), 0)
  assert.equal(levelIndex(L, 10), 0)
  assert.equal(levelIndex(L, 11), 1)
  assert.equal(levelIndex(L, 21), 2)
  assert.equal(levelIndex(L, 80), 7)
  assert.equal(levelIndex(L, 500), 7)
  assert.deepEqual(L.slice(0, 3).map(l => `${l.sb}/${l.bb}`), ['10/20', '20/40', '40/80'])
})

test('withLevel sets the next hand\'s blinds and startHand posts them', () => {
  let s = newTable({ players: ['a', 'b', 'c'].map(id => ({ id, name: id, modelId: null })), stacks: 1500, smallBlind: 1, bigBlind: 2 }, 3)
  s = { ...s, handNo: 10 }
  const { state, level } = withLevel(s, SNG_TURBO.levels)
  assert.equal(level, 1)
  const h = startHand(state)
  assert.equal(h.bigBlind, 40)
  assert.equal(h.seats.reduce((n, x) => n + x.committed, 0), 60)
  assert.equal(h.lastRaiseSize, 40)
})

test('simultaneous busts: the bigger starting stack places higher; equal stacks tie', () => {
  const before = { a: 300, b: 800, c: 300, d: 2000, e: 0 }
  const after = { a: 0, b: 0, c: 0, d: 3400, e: 0 }
  const f = bustsThisHand(before, after, 1, 42)
  assert.deepEqual(f.map(x => [x.seatId, x.place]), [['b', 2], ['a', 3], ['c', 3]])
  assert.ok(f.every(x => x.bustHand === 42))
  assert.deepEqual(bustsThisHand({ a: 5 }, { a: 5 }, 2, 1), [])
})

test('survivors at the hand cap are placed by stack', () => {
  const f = survivorsPlaced({ a: 100, b: 900, c: 0, d: 900 })
  assert.deepEqual(f.map(x => [x.seatId, x.place]), [['b', 1], ['d', 1], ['a', 3]])
})

test('duplicate schedule: every model sits in every seat once per match, same seed per match', () => {
  const lineup = ['A', 'B', 'C', 'D']
  const s = schedule(lineup, 2, 99)
  assert.equal(s.length, 8)
  const m1 = s.filter(t => t.matchId === 'm01')
  assert.equal(new Set(m1.map(t => t.seed)).size, 1)
  assert.notEqual(m1[0]!.seed, s.find(t => t.matchId === 'm02')!.seed)
  for (let seat = 0; seat < 4; seat++) assert.deepEqual(m1.map(t => t.seats[seat]).sort(), lineup)
  assert.deepEqual(rotate(lineup, 1), ['B', 'C', 'D', 'A'])
  assert.equal(matchSeed(99, 0), matchSeed(99, 0))
})

// Two matches, two models, heads-up: A wins 1 bb/hand in m1 and 3 bb/hand in m2.
const seats = (r: number) => r === 0 ? [{ id: 's1', modelId: 'A' }, { id: 's2', modelId: 'B' }] : [{ id: 's1', modelId: 'B' }, { id: 's2', modelId: 'A' }]
const hands: RunHandLite[] = []
const tournaments: RunTournamentLite[] = []
for (const [matchId, edge] of [['m1', 1], ['m2', 3]] as const) {
  for (const r of [0, 1]) {
    const tId = `${matchId}-r${r}`
    const st = seats(r)
    const aSeat = st.find(x => x.modelId === 'A')!.id
    const bSeat = st.find(x => x.modelId === 'B')!.id
    for (let k = 1; k <= 10; k++) hands.push({ matchId, tournamentId: tId, handNo: k, bigBlind: 20, seats: st, deltas: { [aSeat]: 20 * edge, [bSeat]: -20 * edge } })
    tournaments.push({ matchId, tournamentId: tId, finish: [{ seatId: aSeat, modelId: 'A', place: 1 }, { seatId: bSeat, modelId: 'B', place: 2 }] })
  }
}

test('bb/100 per model with match-level bootstrap CIs and pair differences', () => {
  const { rows, pairs, matches } = leaderboard(matchAggregates(hands, tournaments), ['A', 'B'], { iters: 500 })
  assert.equal(matches, 2)
  const a = rows.find(r => r.modelId === 'A')!
  assert.equal(a.hands, 40)
  assert.equal(a.bb100.value, 200)
  assert.equal(a.bb100.lo, 100)
  assert.equal(a.bb100.hi, 300)
  assert.equal(a.avgFinish.value, 1)
  assert.equal(pairs[0]!.bb100.value, 400)
  assert.ok(pairs[0]!.bb100.lo! > 0, 'A − B separates from zero')
})

test('finish distribution, chip flow, convergence series and Plackett–Luce', () => {
  assert.deepEqual(finishDistribution(tournaments, ['A', 'B'], 2), { A: [4, 0], B: [0, 4] })
  const flow = chipFlow(hands, ['A', 'B'])
  assert.equal(flow.A!.B, 80)
  assert.equal(flow.B!.A, -80)
  const series = bb100Series(hands, tournaments.map(t => t.tournamentId), ['A', 'B'])
  assert.equal(series.length, 4)
  assert.equal(series[0]!.bb100.A, 100)
  assert.equal(series.at(-1)!.bb100.A, 200)
  const pl = plackettLuce([['A', 'B', 'C'], ['A', 'C', 'B'], ['B', 'A', 'C']], ['A', 'B', 'C'])
  assert.ok(pl.A! > pl.B! && pl.B! > pl.C!)
})
