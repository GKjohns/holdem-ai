/**
 * Sit-and-go layer over the engine: a blind schedule and finish order. Pure (relative imports,
 * no Nuxt) so tests and bench scripts run it under bare Node. The engine itself is unchanged:
 * blinds are set on the state between hands, and busts are read off the stacks.
 */
import type { GameFormat, TableState } from './types.ts'

export interface BlindLevel { sb: number, bb: number, hands: number }

export interface TournamentFormat {
  stack: number
  levels: BlindLevel[]
  /** Hand cap: if more than one seat is left, the rest are placed by stack. */
  maxHands: number
  /** v2: prize-pool % by place (1st first), announced to the seats. Absent on B3/B4 runs. */
  payouts?: number[]
}

/** 6-max turbo: 1,500 chips, blinds double every 10 hands. The last level repeats. */
export const SNG_TURBO: TournamentFormat = {
  stack: 1500,
  levels: [10, 20, 40, 80, 160, 320, 640, 1280].map(sb => ({ sb, bb: sb * 2, hands: 10 })),
  maxHands: 120
}

/**
 * v2 (2026-10-11): same start as the turbo (1,500 chips, 10/20, doubling every 10 hands), but the
 * blinds keep doubling to 10,240/20,480, so a 6-handed table always finishes: from hand 71 the big
 * blind (2,560) is over a quarter of all 9,000 chips. The 250-hand cap is a safety net, never reached in
 * practice, and the seats are told there's no hand limit. Pays 50/30/20.
 */
export const SNG_V2: TournamentFormat = {
  stack: 1500,
  levels: Array.from({ length: 11 }, (_, i) => 10 * 2 ** i).map(sb => ({ sb, bb: sb * 2, hands: 10 })),
  maxHands: 250,
  payouts: [50, 30, 20]
}

/** Prize share (% of the pool) for a finishing place; 0 out of the money. */
export function payoutFor(payouts: number[] | undefined, place: number): number {
  return payouts?.[place - 1] ?? 0
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

/**
 * What a player at a sit-and-go is told about the blinds on hand `handNo` (1-based). With `sheet`
 * (v2) it also carries the structure sheet: field size, starting stack, hands per level, payouts.
 */
export function sngFormat(levels: BlindLevel[], handNo: number, sheet?: { entrants: number, startingStack: number, payouts?: number[] }): GameFormat {
  const level = levelIndex(levels, handNo)
  const end = levels.slice(0, level + 1).reduce((n, l) => n + l.hands, 0)
  const last = level === levels.length - 1
  const next = levels[level + 1]
  return {
    type: 'sng',
    level: level + 1,
    // The last level repeats, so it has no "next".
    handsLeftAtLevel: last ? 0 : Math.max(0, end - handNo),
    ...(next ? { next: { smallBlind: next.sb, bigBlind: next.bb } } : {}),
    ...(sheet
      ? {
          entrants: sheet.entrants,
          startingStack: sheet.startingStack,
          handsPerLevel: levels[level]!.hands,
          ...(sheet.payouts ? { payouts: sheet.payouts.slice() } : {})
        }
      : {})
  }
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
