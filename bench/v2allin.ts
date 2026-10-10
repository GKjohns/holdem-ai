/**
 * v2 all-in luck check: for hands that ended all-in with cards to come (one pot, 2+ hands shown),
 * replace each shown player's result with its equity share of the pot (Monte Carlo runouts) and
 * recompute bb/100 per player. Analysis only.  node bench/v2allin.ts <slug>...
 */
import { readFileSync } from 'node:fs'
import { compareHands, rankHand } from '../shared/utils/handRank.ts'
import { fullDeck } from '../shared/utils/cards.ts'
import { seededRng } from '../shared/utils/rng.ts'
import { playerOf } from '../shared/utils/runs.ts'
import type { RunHandLine } from '../shared/utils/runs.ts'
import type { Card } from '../shared/utils/types.ts'

const SEEN: Record<string, number> = { preflop: 0, flop: 3, turn: 4, river: 5 }
const rng = seededRng(42)
for (const slug of process.argv.slice(2)) {
  const hands = readFileSync(`data/runs/${slug}.jsonl`, 'utf8').split('\n').filter(l => l.includes('"type":"hand"')).map(l => JSON.parse(l) as RunHandLine)
  const actual: Record<string, number> = {}, adj: Record<string, number> = {}, n: Record<string, number> = {}, luck: Record<string, number> = {}
  let used = 0, skipped = 0
  for (const h of hands) {
    const shown = Object.keys(h.result.shown)
    const lastStreet = h.log.at(-1)?.street ?? 'preflop'
    const known = SEEN[lastStreet] ?? 5
    let ev: Record<string, number> | null = null
    if (shown.length >= 2 && known < 5) {
      if (h.result.pots.length !== 1) skipped++
      else {
        const pot = h.result.pots[0]!.amount
        const board = h.board.slice(0, known) as Card[]
        const dead = new Set<string>([...board, ...shown.flatMap(id => h.holes[id]!)])
        const deck = fullDeck().filter(c => !dead.has(c))
        const wins: Record<string, number> = Object.fromEntries(shown.map(id => [id, 0]))
        const N = 3000
        for (let i = 0; i < N; i++) {
          const d = deck.slice()
          const run: Card[] = []
          for (let k = 0; k < 5 - known; k++) run.push(d.splice(Math.floor(rng() * d.length), 1)[0]!)
          const ranked = shown.map(id => ({ id, r: rankHand([...h.holes[id]!, ...board, ...run] as Card[]) }))
          let best = [ranked[0]!]
          for (const x of ranked.slice(1)) {
            const c = compareHands(x.r, best[0]!.r)
            if (c > 0) best = [x]
            else if (c === 0) best.push(x)
          }
          for (const b of best) wins[b.id]! += 1 / best.length
        }
        ev = {}
        for (const id of shown) {
          const invested = (h.result.deltas[id] ?? 0) - (h.result.pots[0]!.winners.includes(id) ? pot / h.result.pots[0]!.winners.length : 0)
          ev[id] = (wins[id]! / N) * pot + invested
        }
        used++
      }
    }
    for (const s of h.seats) {
      if (!(h.stacksBefore[s.id]! > 0)) continue
      const p = playerOf(s)
      const a = (h.result.deltas[s.id] ?? 0) / h.bigBlind
      const e = ev && s.id in ev ? ev[s.id]! / h.bigBlind : a
      actual[p] = (actual[p] ?? 0) + a
      adj[p] = (adj[p] ?? 0) + e
      luck[p] = (luck[p] ?? 0) + (a - e)
      n[p] = (n[p] ?? 0) + 1
    }
  }
  console.log(`${slug}: ${used} all-in hands adjusted, ${skipped} side-pot hands left as dealt`)
  for (const p of Object.keys(n)) console.log(`  ${p.padEnd(30)} bb/100 actual ${(100 * actual[p]! / n[p]!).toFixed(1).padStart(7)}  all-in adjusted ${(100 * adj[p]! / n[p]!).toFixed(1).padStart(7)}  luck ${luck[p]!.toFixed(1)} bb`)
}
