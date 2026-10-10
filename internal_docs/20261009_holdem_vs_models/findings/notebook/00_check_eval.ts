/** Validates lib.ts evalCards against the engine's rankHand on 200k random 7-card pairs. */
import { rankHand } from '../../../../shared/utils/handRank.ts'
import { evalCards, cardInt, rand, reseed, category, CATEGORY_NAMES } from './lib.ts'
const RANKS = '23456789TJQKA', SUITS = 'shdc'
const deck = [...SUITS].flatMap(s => [...RANKS].map(r => r + s))
reseed(7)
let bad = 0, catBad = 0
const N = 200000
for (let i = 0; i < N; i++) {
  const d = deck.slice()
  for (let j = 0; j < 9; j++) { const x = j + Math.floor(rand() * (52 - j)); [d[j], d[x]] = [d[x]!, d[j]!] }
  const board = d.slice(4, 9), a = [d[0]!, d[1]!, ...board], b = [d[2]!, d[3]!, ...board]
  const ra = rankHand(a as any), rb = rankHand(b as any)
  const ea = evalCards(a.map(cardInt)), eb = evalCards(b.map(cardInt))
  if (Math.sign(ra.rank - rb.rank) !== Math.sign(ea - eb)) bad++
  const want = ra.category.replace('three_of_a_kind', 'trips').replace('four_of_a_kind', 'quads')
  if (CATEGORY_NAMES[category(ea)] !== want) catBad++
}
console.log(JSON.stringify({ pairs: N, orderMismatches: bad, categoryMismatches: catBad }))
