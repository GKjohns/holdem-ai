/**
 * B5 notebook helpers: a fast 7-card evaluator (validated against the engine's rankHand in
 * 00_check_eval.ts) and equity estimators. Analysis only: nothing here reaches a seated model.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseRun } from '../../../../shared/utils/runs.ts'
import type { ParsedRun } from '../../../../shared/utils/runs.ts'

export const ROOT = new URL('../../../../', import.meta.url).pathname
export const OUT = new URL('./out/', import.meta.url).pathname
export const CACHE = new URL('./cache/', import.meta.url).pathname

const RANKS = '23456789TJQKA'
const SUITS = 'shdc'
export const cardInt = (c: string) => RANKS.indexOf(c[0]!) * 4 + SUITS.indexOf(c[1]!)

// Highest straight top (0..12, 3 = wheel five-high) for a 13-bit rank mask, or -1.
const STRAIGHT = new Int8Array(8192).fill(-1)
for (let m = 0; m < 8192; m++) {
  for (let top = 12; top >= 4; top--) {
    const need = 0b11111 << (top - 4)
    if ((m & need) === need) { STRAIGHT[m] = top; break }
  }
  if (STRAIGHT[m] === -1 && (m & 0b1000000001111) === 0b1000000001111) STRAIGHT[m] = 3
}
const POP = new Uint8Array(8192)
for (let m = 1; m < 8192; m++) POP[m] = POP[m >> 1]! + (m & 1)
const topBits = (m: number, k: number) => {
  let out = 0, n = 0
  for (let r = 12; r >= 0 && n < k; r--) if (m & (1 << r)) { out = out * 16 + r; n++ }
  for (; n < k; n++) out *= 16
  return out
}

/** Comparable score for 5–7 card ints; category = Math.floor(score / 16**5). */
export function evalCards(cs: number[]): number {
  const cnt = new Uint8Array(13)
  const sm = [0, 0, 0, 0]
  let rm = 0
  for (const c of cs) {
    const r = c >> 2
    cnt[r]!++
    sm[c & 3]! |= 1 << r
    rm |= 1 << r
  }
  const C = 16 ** 5
  for (let s = 0; s < 4; s++) {
    if (POP[sm[s]!]! >= 5) {
      const sf = STRAIGHT[sm[s]!]!
      if (sf >= 0) return 8 * C + sf
      // a flush beats anything below; quads/boat checked first only if possible (7 cards: flush excludes boat? no)
      const flushScore = 5 * C + topBits(sm[s]!, 5)
      // quads or full house can coexist with a flush in 7 cards
      const q = quadsOrBoat(cnt, rm)
      return q > flushScore ? q : flushScore
    }
  }
  const qb = quadsOrBoat(cnt, rm)
  if (qb) return qb
  const st = STRAIGHT[rm]!
  if (st >= 0) return 4 * C + st
  let trips = -1, p1 = -1, p2 = -1
  for (let r = 12; r >= 0; r--) {
    if (cnt[r] === 3 && trips < 0) trips = r
    else if (cnt[r]! >= 2) { if (p1 < 0) p1 = r; else if (p2 < 0) p2 = r }
  }
  if (trips >= 0) return 3 * C + trips * 256 + topBits(rm & ~(1 << trips), 2)
  if (p2 >= 0) return 2 * C + p1 * 256 + p2 * 16 + topBits(rm & ~(1 << p1) & ~(1 << p2), 1)
  if (p1 >= 0) return 1 * C + p1 * 4096 + topBits(rm & ~(1 << p1), 3)
  return topBits(rm, 5)
}
function quadsOrBoat(cnt: Uint8Array, rm: number): number {
  const C = 16 ** 5
  let trips = -1, pair = -1
  for (let r = 12; r >= 0; r--) {
    if (cnt[r] === 4) return 7 * C + r * 16 + (topBits(rm & ~(1 << r), 1) >> 16 * 0)
  }
  for (let r = 12; r >= 0; r--) {
    if (cnt[r]! >= 3 && trips < 0) trips = r
    else if (cnt[r]! >= 2 && pair < 0) pair = r
  }
  if (trips >= 0) {
    // second trips counts as the pair
    for (let r = 12; r >= 0; r--) if (r !== trips && cnt[r]! >= 2) { pair = Math.max(pair, r); break }
    if (pair >= 0) return 6 * C + trips * 16 + pair
  }
  return 0
}
export const category = (score: number) => Math.floor(score / 16 ** 5)
export const CATEGORY_NAMES = ['high_card', 'pair', 'two_pair', 'trips', 'straight', 'flush', 'full_house', 'quads', 'straight_flush']

let seed = 12345
export function rand() { // xorshift32, deterministic
  seed ^= seed << 13; seed >>>= 0
  seed ^= seed >>> 17
  seed ^= seed << 5; seed >>>= 0
  return seed / 4294967296
}
export function reseed(s: number) { seed = (s >>> 0) || 1 }

/**
 * Hero's equity (win + tie share) vs `opps` known hands (god view) or `nRandom` random hands,
 * over random completions of the board. Exact enumeration when ≤ 1 card to come; MC otherwise.
 */
export function equity(hero: number[], board: number[], opps: number[][], nRandom = 0, iters = 600): number {
  const dead = new Set([...hero, ...board, ...opps.flat()])
  const live: number[] = []
  for (let c = 0; c < 52; c++) if (!dead.has(c)) live.push(c)
  const need = 5 - board.length
  let total = 0, n = 0
  const run = (fullBoard: number[], others: number[][]) => {
    const h = evalCards([...hero, ...fullBoard])
    let best = -1, ties = 0
    for (const o of others) {
      const s = evalCards([...o, ...fullBoard])
      if (s > best) { best = s; ties = 0 }
      if (s === best) ties++
    }
    if (h > best) total += 1
    else if (h === best) total += 1 / (ties + 1)
    n++
  }
  if (nRandom === 0 && need <= 1) {
    if (need === 0) run(board, opps)
    else for (const c of live) run([...board, c], opps)
    return total / n
  }
  const arr = live.slice()
  for (let i = 0; i < iters; i++) {
    const k = need + 2 * nRandom
    for (let j = 0; j < k; j++) {
      const x = j + Math.floor(rand() * (arr.length - j))
      const t = arr[j]!; arr[j] = arr[x]!; arr[x] = t
    }
    const fb = [...board, ...arr.slice(0, need)]
    const others = [...opps]
    for (let r = 0; r < nRandom; r++) others.push([arr[need + 2 * r]!, arr[need + 2 * r + 1]!])
    run(fb, others)
  }
  return total / n
}

export function readRun(path: string): ParsedRun {
  return parseRun(readFileSync(path, 'utf8'))
}

/** Every batch run file on disk: B3 main + pilot, lab tables (training + held-out). */
export function runFiles(): { kind: 'main' | 'pilot' | 'lab' | 'lab_pilot' | 'heldout', path: string, table: string }[] {
  const out: { kind: 'main' | 'pilot' | 'lab' | 'lab_pilot' | 'heldout', path: string, table: string }[] = [
    { kind: 'main', path: join(ROOT, 'data/runs/20261010_main.jsonl'), table: 'main' },
    { kind: 'pilot', path: join(ROOT, 'data/runs/20261010_pilot.jsonl'), table: 'pilot' }
  ]
  for (const [dir, kind] of [['20261010_lab', 'lab'], ['20261010_lab_pilot', 'lab_pilot']] as const) {
    const d = join(ROOT, 'data/lab', dir, 'runs')
    if (!existsSync(d)) continue
    for (const f of readdirSync(d).sort()) {
      if (!f.endsWith('.jsonl') || f.endsWith('.cache.jsonl')) continue
      const isHeld = f === 'heldout.jsonl'
      out.push({ kind: isHeld && kind === 'lab' ? 'heldout' : kind, path: join(d, f), table: `${dir}/${f.replace('.jsonl', '')}` })
    }
  }
  return out
}
