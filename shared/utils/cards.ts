import type { Card, Rank, Suit } from './types.ts'

export const RANKS: Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']
export const SUITS: Suit[] = ['s', 'h', 'd', 'c']

const SUIT_SYMBOL: Record<Suit, string> = { s: '♠', h: '♥', d: '♦', c: '♣' }

/** 2 → 2 … A → 14. */
export function rankValue(card: Card): number {
  return RANKS.indexOf(card[0] as Rank) + 2
}

export function suitOf(card: Card): Suit {
  return card[1] as Suit
}

export function fullDeck(): Card[] {
  return SUITS.flatMap(s => RANKS.map(r => `${r}${s}` as Card))
}

/** Fisher–Yates; returns a new array. */
export function shuffle<T>(deck: T[], rng: () => number): T[] {
  const out = deck.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = out[i]!
    out[i] = out[j]!
    out[j] = tmp
  }
  return out
}

/** 'Td' → '10♦'. */
export function cardLabel(card: Card): string {
  const r = card[0] === 'T' ? '10' : card[0]
  return `${r}${SUIT_SYMBOL[suitOf(card)]}`
}

/** Accepts 'As', 'as', 'AS', '10s'. Throws on anything else. */
export function parseCard(text: string): Card {
  const t = text.trim()
  const rank = (t.startsWith('10') ? 'T' : t[0]?.toUpperCase()) as Rank
  const suit = t.slice(t.startsWith('10') ? 2 : 1).toLowerCase() as Suit
  if (!RANKS.includes(rank) || !SUITS.includes(suit)) throw new Error(`Not a card: ${text}`)
  return `${rank}${suit}`
}
