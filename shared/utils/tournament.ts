/**
 * Sit-and-go layer over the engine: a blind schedule and finish order. Pure (relative imports,
 * no Nuxt) so tests and bench scripts run it under bare Node. The engine itself is unchanged:
 * blinds are set on the state between hands, and busts are read off the stacks.
 */
import type { TableState } from './types.ts'

export interface BlindLevel { sb: number, bb: number, hands: number }

export interface TournamentFormat {
  stack: number
  levels: BlindLevel[]
  /** Hand cap: if more than one seat is left, the rest are placed by stack. */
  maxHands: number
}

/** 6-max turbo: 1,500 chips, blinds double every 10 hands. The last level repeats. */
export const SNG_TURBO: TournamentFormat = {
  stack: 1500,
  levels: [10, 20, 40, 80, 160, 320, 640, 1280].map(sb => ({ sb, bb: sb * 2, hands: 10 })),
  maxHands: 120
}

/** Level index (0-based) for a 1-based hand number. */
export function levelIndex(levels: BlindLevel[], handNo: number): number {
  let end = 0
  for (let i = 0; i < levels.length; i++) {
    end += levels[i]!.hands
    if (handNo <= end) return i
  }
  return levels.length - 1
}

/** The state with the blinds for the next hand set; call before startHand(). */
export function withLevel(state: TableState, levels: BlindLevel[]): { state: TableState, level: number } {
  const level = levelIndex(levels, state.handNo + 1)
  const { sb, bb } = levels[level]!
  return { state: { ...state, smallBlind: sb, bigBlind: bb }, level }
}

export interface Finish {
  seatId: string
  /** 1 = winner. Seats that bust together with equal starting stacks share the better place. */
  place: number
  /** Hand they busted on; null for seats still holding chips at the end. */
  bustHand: number | null
  /** Stack at the start of the bust hand (or the final stack for survivors). */
  stack: number
}

/**
 * Seats that went from chips to zero this hand, placed below everyone still alive.
 * Simultaneous busts: the bigger starting stack places higher (TDA); equal stacks tie.
 */
export function bustsThisHand(before: Record<string, number>, after: Record<string, number>, aliveAfter: number, handNo: number): Finish[] {
  const busted = Object.keys(before)
    .filter(id => before[id]! > 0 && (after[id] ?? 0) === 0)
    .sort((a, b) => before[b]! - before[a]!)
  return busted.map((seatId) => {
    const ahead = busted.filter(o => before[o]! > before[seatId]!).length
    return { seatId, place: aliveAfter + ahead + 1, bustHand: handNo, stack: before[seatId]! }
  })
}

/** Survivors at the end (one winner, or several at the hand cap), placed by stack; ties share. */
export function survivorsPlaced(stacks: Record<string, number>): Finish[] {
  const alive = Object.keys(stacks).filter(id => stacks[id]! > 0).sort((a, b) => stacks[b]! - stacks[a]!)
  return alive.map(seatId => ({
    seatId,
    place: alive.filter(o => stacks[o]! > stacks[seatId]!).length + 1,
    bustHand: null,
    stack: stacks[seatId]!
  }))
}
