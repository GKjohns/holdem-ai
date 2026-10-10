import type { Card } from './types.ts'
import { rankValue, suitOf } from './cards.ts'

export type HandCategory
  = | 'high_card' | 'pair' | 'two_pair' | 'three_of_a_kind' | 'straight'
    | 'flush' | 'full_house' | 'four_of_a_kind' | 'straight_flush'

const CATEGORIES: HandCategory[] = [
  'high_card', 'pair', 'two_pair', 'three_of_a_kind', 'straight',
  'flush', 'full_house', 'four_of_a_kind', 'straight_flush'
]

export interface RankedHand {
  /** Comparable: higher wins, equal ties. */
  rank: number
  category: HandCategory
  best5: Card[]
  name: string
}

const SINGULAR = ['', '', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'jack', 'queen', 'king', 'ace']
const PLURAL = ['', '', 'twos', 'threes', 'fours', 'fives', 'sixes', 'sevens', 'eights', 'nines', 'tens', 'jacks', 'queens', 'kings', 'aces']

/** Best five-card hand from 5–7 cards ("Two pair, aces and sevens"). */
export function rankHand(cards: Card[]): RankedHand {
  if (cards.length < 5 || cards.length > 7) throw new Error(`rankHand needs 5–7 cards, got ${cards.length}`)
  let best: RankedHand | undefined
  for (const combo of combinations(cards, 5)) {
    const r = rankFive(combo)
    if (!best || r.rank > best.rank) best = r
  }
  return best!
}

/** Compare two ranked hands: >0 if a wins. */
export function compareHands(a: RankedHand, b: RankedHand): number {
  return a.rank - b.rank
}

function combinations<T>(items: T[], k: number): T[][] {
  const out: T[][] = []
  const pick = (start: number, acc: T[]) => {
    if (acc.length === k) {
      out.push(acc.slice())
      return
    }
    for (let i = start; i <= items.length - (k - acc.length); i++) {
      acc.push(items[i]!)
      pick(i + 1, acc)
      acc.pop()
    }
  }
  pick(0, [])
  return out
}

function rankFive(cards: Card[]): RankedHand {
  // Sort by (group size desc, rank desc) so best5 reads naturally: trips first, then kickers.
  const counts = new Map<number, number>()
  for (const c of cards) counts.set(rankValue(c), (counts.get(rankValue(c)) ?? 0) + 1)
  const sorted = cards.slice().sort((a, b) => {
    const ca = counts.get(rankValue(a))!
    const cb = counts.get(rankValue(b))!
    return cb - ca || rankValue(b) - rankValue(a)
  })
  const values = sorted.map(rankValue)
  const groups = [...counts.values()].sort((a, b) => b - a)

  const flush = cards.every(c => suitOf(c) === suitOf(cards[0]!))
  const distinct = [...counts.keys()].sort((a, b) => b - a)
  let straightHigh = 0
  if (distinct.length === 5) {
    if (distinct[0]! - distinct[4]! === 4) straightHigh = distinct[0]!
    else if (distinct.join() === '14,5,4,3,2') straightHigh = 5
  }

  let category: HandCategory
  let tiebreak: number[]
  let best5 = sorted
  if (straightHigh) {
    // Wheel plays the ace low: 5-4-3-2-A.
    if (straightHigh === 5) best5 = [...sorted.slice(1), sorted[0]!]
    category = flush ? 'straight_flush' : 'straight'
    tiebreak = [straightHigh]
  } else if (groups[0] === 4) {
    category = 'four_of_a_kind'
    tiebreak = [values[0]!, values[4]!]
  } else if (groups[0] === 3 && groups[1] === 2) {
    category = 'full_house'
    tiebreak = [values[0]!, values[3]!]
  } else if (flush) {
    category = 'flush'
    tiebreak = values
  } else if (groups[0] === 3) {
    category = 'three_of_a_kind'
    tiebreak = [values[0]!, values[3]!, values[4]!]
  } else if (groups[0] === 2 && groups[1] === 2) {
    category = 'two_pair'
    tiebreak = [values[0]!, values[2]!, values[4]!]
  } else if (groups[0] === 2) {
    category = 'pair'
    tiebreak = [values[0]!, values[2]!, values[3]!, values[4]!]
  } else {
    category = 'high_card'
    tiebreak = values
  }

  let rank = CATEGORIES.indexOf(category)
  for (let i = 0; i < 5; i++) rank = rank * 15 + (tiebreak[i] ?? 0)
  return { rank, category, best5, name: handName(category, tiebreak) }
}

function handName(category: HandCategory, t: number[]): string {
  const [a = 0, b = 0] = t
  switch (category) {
    case 'straight_flush': return a === 14 ? 'Royal flush' : `Straight flush, ${SINGULAR[a]} high`
    case 'four_of_a_kind': return `Four of a kind, ${PLURAL[a]}`
    case 'full_house': return `Full house, ${PLURAL[a]} full of ${PLURAL[b]}`
    case 'flush': return `Flush, ${SINGULAR[a]} high`
    case 'straight': return `Straight, ${SINGULAR[a]} high`
    case 'three_of_a_kind': return `Three of a kind, ${PLURAL[a]}`
    case 'two_pair': return `Two pair, ${PLURAL[a]} and ${PLURAL[b]}`
    case 'pair': return `Pair of ${PLURAL[a]}`
    case 'high_card': return `High card, ${SINGULAR[a]}`
  }
}
