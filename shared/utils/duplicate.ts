/**
 * Duplicate seeding: a match is one deck seed replayed once per seat rotation, so every model
 * plays every seat's cards. The deck for hand k depends only on (seed, k), and seat index i
 * always gets seat i's cards, so rotation r puts lineup[(i + r) % n] in seat i.
 * Pure (relative imports, no Nuxt).
 */

export interface ScheduledTournament {
  /** e.g. "m03-r2" */
  tournamentId: string
  matchId: string
  matchIndex: number
  seed: number
  rotation: number
  /** modelId per seat index. */
  seats: string[]
}

/** Deterministic, well-spread 32-bit seed for match k of a run (splitmix-style hash). */
export function matchSeed(baseSeed: number, k: number): number {
  let x = (Math.imul(baseSeed >>> 0, 0x9E3779B1) + Math.imul(k + 1, 0x85EBCA6B)) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x7FEB352D) >>> 0
  x = Math.imul(x ^ (x >>> 15), 0x846CA68B) >>> 0
  return (x ^ (x >>> 16)) >>> 0
}

export function rotate<T>(lineup: T[], r: number): T[] {
  const n = lineup.length
  return lineup.map((_, i) => lineup[(i + r) % n]!)
}

export function schedule(lineup: string[], matches: number, baseSeed: number): ScheduledTournament[] {
  const out: ScheduledTournament[] = []
  for (let k = 0; k < matches; k++) {
    const matchId = `m${String(k + 1).padStart(2, '0')}`
    for (let r = 0; r < lineup.length; r++) {
      out.push({
        tournamentId: `${matchId}-r${r}`,
        matchId,
        matchIndex: k,
        seed: matchSeed(baseSeed, k),
        rotation: r,
        seats: rotate(lineup, r)
      })
    }
  }
  return out
}
