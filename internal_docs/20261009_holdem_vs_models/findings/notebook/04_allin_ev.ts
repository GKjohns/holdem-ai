/**
 * All-in luck. For every hand where betting closed with cards still to come (all live players but
 * at most one all-in), replace the actual result with each player's equity share of every pot
 * layer (exact runout enumeration on the turn, Monte Carlo with 4,000 boards before that).
 * luck = actual delta − expected delta. Writes cache/allin_<table>.csv and out/allin_main.json.
 *   node 04_allin_ev.ts
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CACHE, OUT, ROOT, cardInt, evalCards, rand, readRun, reseed } from './lib.ts'
import { playerOf } from '../../../../shared/utils/runs.ts'
import type { RunHandLine } from '../../../../shared/utils/runs.ts'

function layerEquities(hands: Record<string, number[]>, board: number[], iters = 4000): Record<string, number> {
  // equity of each id winning (tie-split) over random completions; returns per-id share given eligibility handled by caller
  const ids = Object.keys(hands)
  const dead = new Set([...board, ...ids.flatMap(i => hands[i]!)])
  const live: number[] = []
  for (let c = 0; c < 52; c++) if (!dead.has(c)) live.push(c)
  const need = 5 - board.length
  const eq: Record<string, number> = Object.fromEntries(ids.map(i => [i, 0]))
  let n = 0
  const score = (fb: number[]) => {
    let best = -1
    const s: Record<string, number> = {}
    for (const i of ids) { s[i] = evalCards([...hands[i]!, ...fb]); if (s[i]! > best) best = s[i]! }
    const w = ids.filter(i => s[i] === best)
    for (const i of w) eq[i]! += 1 / w.length
    n++
  }
  if (need === 0) score(board)
  else if (need === 1) for (const c of live) score([...board, c])
  else if (need === 2) { for (let a = 0; a < live.length; a++) for (let b = a + 1; b < live.length; b++) score([...board, live[a]!, live[b]!]) } else {
    const arr = live.slice()
    for (let k = 0; k < iters; k++) {
      for (let j = 0; j < need; j++) { const x = j + Math.floor(rand() * (arr.length - j)); const t = arr[j]!; arr[j] = arr[x]!; arr[x] = t }
      score([...board, ...arr.slice(0, need)])
    }
  }
  for (const i of ids) eq[i]! /= n
  return eq
}

let skippedMismatch = 0
/** Per-seat expected delta at the moment betting closed, or null when it closed on the river / by folds. */
function allinEv(h: RunHandLine): { ev: Record<string, number>, street: string, live: string[] } | null {
  if (Object.keys(h.result.shown).length < 2) return null
  // contributions: blinds + every chip added
  const contrib: Record<string, number> = Object.fromEntries(h.seats.map(s => [s.id, 0]))
  const byName = new Map(h.seats.map(s => [s.name, s.id]))
  for (const part of h.blinds.split(' · ')) {
    const m = part.match(/^(.+?) posts (?:small|big) blind (\d+)/)
    const id = m ? byName.get(m[1]!.trim()) : undefined
    if (id) contrib[id]! += Number(m![2])
  }
  for (const e of h.log) contrib[e.seatId]! += e.added
  // an uncalled bet (the top contribution above the second-highest) is returned to its owner
  const sorted = Object.entries(contrib).sort((a, b) => b[1] - a[1])
  if (sorted.length > 1 && sorted[0]![1] > sorted[1]![1]) contrib[sorted[0]![0]] = sorted[1]![1]
  const total = Object.values(contrib).reduce((a, b) => a + b, 0)
  const potTotal = h.result.pots.reduce((a, p) => a + p.amount, 0)
  if (total !== potTotal) { skippedMismatch++; return null }
  const folded = new Set(h.log.filter(e => e.action.type === 'fold').map(e => e.seatId))
  const live = h.seats.map(s => s.id).filter(id => (h.holes[id]?.length ?? 0) === 2 && !folded.has(id))
  // when did betting close? board cards dealt at the last action's street
  const last = h.log.at(-1)
  if (!last) return null
  const streetBoard: Record<string, number> = { preflop: 0, flop: 3, turn: 4, river: 5 }
  const known = streetBoard[last.street] ?? 5
  if (known >= 5) return null
  const board = h.board.slice(0, known).map(cardInt)
  const hands = Object.fromEntries(live.map(id => [id, h.holes[id]!.map(cardInt)]))
  reseed((h.seed ^ (h.handNo * 2654435761)) >>> 0)
  // pot layers
  const levels = [...new Set(live.map(id => contrib[id]!))].sort((a, b) => a - b)
  const ev: Record<string, number> = Object.fromEntries(h.seats.map(s => [s.id, -contrib[s.id]!]))
  let prev = 0
  for (const L of levels) {
    let amount = 0
    for (const id of Object.keys(contrib)) amount += Math.max(0, Math.min(contrib[id]!, L) - prev)
    const elig = live.filter(id => contrib[id]! >= L)
    if (elig.length === 1) ev[elig[0]!]! += amount
    else {
      const eq = layerEquities(Object.fromEntries(elig.map(id => [id, hands[id]!])), board)
      for (const id of elig) ev[id]! += amount * eq[id]!
    }
    prev = L
  }
  return { ev, street: last.street, live }
}

const run = readRun(join(ROOT, 'data/runs/20261010_main.jsonl'))
const rows: string[] = ['tournamentId,matchId,handNo,bb,seatId,model,street,actualBb,evBb,luckBb,nLive']
const agg: Record<string, { hands: number, actual: number, luck: number, allins: number }> = {}
const tagg: Record<string, Record<string, number>> = {}
let n = 0
for (const h of run.hands) {
  for (const s of h.seats) {
    if (!(h.holes[s.id]?.length)) continue
    const m = playerOf(s)
    agg[m] ??= { hands: 0, actual: 0, luck: 0, allins: 0 }
    agg[m].hands++
    agg[m].actual += (h.result.deltas[s.id] ?? 0) / h.bigBlind
  }
  const r = allinEv(h)
  if (!r) continue
  n++
  for (const id of r.live) {
    const s = h.seats.find(x => x.id === id)!
    const m = playerOf(s)
    const act = (h.result.deltas[id] ?? 0) / h.bigBlind
    const evb = r.ev[id]! / h.bigBlind
    agg[m]!.luck += act - evb
    agg[m]!.allins++
    ;(tagg[h.matchId] ??= {})[m] = ((tagg[h.matchId] ??= {})[m] ?? 0) + act - evb
    rows.push([h.tournamentId, h.matchId, h.handNo, h.bigBlind, id, m, r.street, act.toFixed(3), evb.toFixed(3), (act - evb).toFixed(3), r.live.length].join(','))
  }
}
writeFileSync(join(CACHE, 'allin_main.csv'), rows.join('\n') + '\n')
const out = Object.fromEntries(Object.entries(agg).map(([m, a]) => [m, {
  hands: a.hands, allinShowdowns: a.allins, bb100: 100 * a.actual / a.hands, luckBb: a.luck, adjustedBb100: 100 * (a.actual - a.luck) / a.hands
}]))
writeFileSync(join(OUT, 'allin_main.json'), JSON.stringify({ allinHands: n, skippedMismatch, models: out, luckByMatch: tagg }, null, 1))
console.log('all-in hands with cards to come:', n, 'skipped (pot mismatch):', skippedMismatch)
for (const [m, a] of Object.entries(out)) console.log(m.padEnd(30), a.allinShowdowns, 'bb100', a.bb100.toFixed(1), 'luck bb', a.luckBb.toFixed(1), 'adj bb100', a.adjustedBb100.toFixed(1))
