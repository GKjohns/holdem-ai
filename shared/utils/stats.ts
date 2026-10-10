/**
 * Per-seat session stats from finished hands and decision logs. Pure (relative imports, no Nuxt)
 * so tests and bench scripts run it under bare Node. These numbers go to the UI, the narrator and
 * the planner only, never into a seated model's prompt.
 *
 * Definitions (standard HUD conventions):
 * - VPIP: hands where the seat put chips in preflop by choice (call, raise or all-in; blinds don't count).
 * - PFR: hands with a preflop raise.
 * - AF: postflop (bets + raises) / calls.
 * - WTSD: hands that reached showdown, out of hands where the seat saw the flop.
 * - W$SD: showdowns where the seat won at least one pot.
 */
import { costUsd } from './pricing.ts'
import { seededRng } from './rng.ts'
import type { ActionEvent, Card, Decision, HandResult } from './types.ts'

export interface StatsHand {
  handNo: number
  board: Card[]
  log: ActionEvent[]
  /** Hole cards per seat; an empty array means the seat sat out (busted). */
  holes: Record<string, Card[]>
  shown: HandResult['shown']
  pots: HandResult['pots']
}
export interface StatsDecision { seatId: string, decision: Decision }

export interface SeatStats {
  seatId: string
  hands: number
  /** Percentages 0–100, or null when the denominator is 0. */
  vpip: number | null
  pfr: number | null
  /** null with no postflop calls or aggression; Infinity when aggressive but never called. */
  af: number | null
  wtsd: number | null
  wsd: number | null
  /** Raw counts behind the rates, for the narrator and tests. */
  counts: { vpip: number, pfr: number, bets: number, calls: number, sawFlop: number, showdowns: number, wonAtShowdown: number }
  decisions: number
  avgMs: number | null
  costUsd: number
}

const pct = (n: number, d: number) => d ? (n / d) * 100 : null

export function seatStats(seatIds: string[], hands: StatsHand[], decisions: StatsDecision[]): SeatStats[] {
  return seatIds.map((id) => {
    const c = { vpip: 0, pfr: 0, bets: 0, calls: 0, sawFlop: 0, showdowns: 0, wonAtShowdown: 0 }
    let dealt = 0
    for (const h of hands) {
      if (!h.holes[id]?.length) continue
      dealt++
      const mine = h.log.filter(e => e.seatId === id)
      const pre = mine.filter(e => e.street === 'preflop')
      if (pre.some(e => e.added > 0)) c.vpip++
      if (pre.some(e => e.raiseTo !== undefined)) c.pfr++
      for (const e of mine) {
        if (e.street === 'preflop' || e.added === 0) continue
        if (e.raiseTo !== undefined) c.bets++
        else c.calls++
      }
      const foldedPre = pre.some(e => e.action.type === 'fold')
      if (h.board.length >= 3 && !foldedPre) {
        c.sawFlop++
        if (h.shown[id]) {
          c.showdowns++
          if (h.pots.some(p => p.winners.includes(id))) c.wonAtShowdown++
        }
      }
    }
    const mine = decisions.filter(d => d.seatId === id).map(d => d.decision)
    return {
      seatId: id,
      hands: dealt,
      vpip: pct(c.vpip, dealt),
      pfr: pct(c.pfr, dealt),
      af: c.calls ? c.bets / c.calls : c.bets ? Infinity : null,
      wtsd: pct(c.showdowns, c.sawFlop),
      wsd: pct(c.wonAtShowdown, c.showdowns),
      counts: c,
      decisions: mine.length,
      avgMs: mine.length ? Math.round(mine.reduce((a, d) => a + d.latencyMs, 0) / mine.length) : null,
      costUsd: mine.reduce((a, d) => a + costUsd(d.model, d.usage), 0)
    }
  })
}

/** Gateway cost of every decision so far (pricing.ts × usage). */
export function sessionCost(decisions: { decision: Decision }[]): number {
  return decisions.reduce((a, d) => a + costUsd(d.decision.model, d.decision.usage), 0)
}

// ── batch runs (B3): bb/100 and finish order with match-level bootstrap CIs ─────────────────

/** The slice of a run's `hand` line the run stats need. */
export interface RunHandLite {
  matchId: string
  tournamentId: string
  handNo: number
  bigBlind: number
  seats: { id: string, modelId: string | null }[]
  deltas: Record<string, number>
}
export interface RunTournamentLite {
  matchId: string
  tournamentId: string
  finish: { seatId: string, modelId: string, place: number }[]
}

interface ModelAgg { bb: number, hands: number, placeSum: number, tournaments: number }
export type MatchAgg = Record<string, ModelAgg>

const modelOf = (h: RunHandLite, seatId: string) => h.seats.find(s => s.id === seatId)?.modelId ?? seatId

/** Per match, per model: bb won (chip delta / that hand's big blind), hands dealt, finish places. */
export function matchAggregates(hands: RunHandLite[], tournaments: RunTournamentLite[]): Map<string, MatchAgg> {
  const out = new Map<string, MatchAgg>()
  const agg = (matchId: string, modelId: string) => {
    const m = out.get(matchId) ?? out.set(matchId, {}).get(matchId)!
    return (m[modelId] ??= { bb: 0, hands: 0, placeSum: 0, tournaments: 0 })
  }
  for (const h of hands) {
    for (const [seatId, delta] of Object.entries(h.deltas)) {
      const a = agg(h.matchId, modelOf(h, seatId))
      a.bb += delta / h.bigBlind
      a.hands++
    }
  }
  for (const t of tournaments) {
    for (const f of t.finish) {
      const a = agg(t.matchId, f.modelId)
      a.placeSum += f.place
      a.tournaments++
    }
  }
  return out
}

export interface Interval { value: number | null, lo: number | null, hi: number | null }
export interface LeaderRow {
  modelId: string
  hands: number
  tournaments: number
  bb100: Interval
  avgFinish: Interval
}
export interface PairDiff { a: string, b: string, bb100: Interval, avgFinish: Interval }

function pctile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))
  return sorted[i]!
}

/**
 * bb/100 and average finish per model, with percentile 95% CIs from resampling whole matches
 * (the duplicate unit: rotations of one seed share cards, so they're resampled together).
 * Also every pair's difference (a − b) with its own CI, which is the honest separation test.
 */
export function leaderboard(aggs: Map<string, MatchAgg>, models: string[], opts: { iters?: number, seed?: number } = {}): { rows: LeaderRow[], pairs: PairDiff[], matches: number } {
  const iters = opts.iters ?? 2000
  const rng = seededRng(opts.seed ?? 1)
  const matches = [...aggs.values()]
  const point = (sample: MatchAgg[]) => models.map((id) => {
    let bb = 0, hands = 0, places = 0, ts = 0
    for (const m of sample) {
      const a = m[id]
      if (!a) continue
      bb += a.bb
      hands += a.hands
      places += a.placeSum
      ts += a.tournaments
    }
    return { bb100: hands ? (bb / hands) * 100 : NaN, finish: ts ? places / ts : NaN, hands, ts }
  })
  const base = point(matches)
  const draws = models.map(() => ({ bb: [] as number[], fin: [] as number[] }))
  const pairIdx: [number, number][] = []
  for (let i = 0; i < models.length; i++) for (let j = i + 1; j < models.length; j++) pairIdx.push([i, j])
  const pairDraws = pairIdx.map(() => ({ bb: [] as number[], fin: [] as number[] }))
  if (matches.length > 1) {
    for (let k = 0; k < iters; k++) {
      const sample = Array.from({ length: matches.length }, () => matches[Math.floor(rng() * matches.length)]!)
      const p = point(sample)
      p.forEach((x, i) => {
        if (Number.isFinite(x.bb100)) draws[i]!.bb.push(x.bb100)
        if (Number.isFinite(x.finish)) draws[i]!.fin.push(x.finish)
      })
      pairIdx.forEach(([i, j], n) => {
        const d1 = p[i]!.bb100 - p[j]!.bb100
        const d2 = p[i]!.finish - p[j]!.finish
        if (Number.isFinite(d1)) pairDraws[n]!.bb.push(d1)
        if (Number.isFinite(d2)) pairDraws[n]!.fin.push(d2)
      })
    }
  }
  const iv = (value: number, sample: number[]): Interval => {
    const s = sample.slice().sort((a, b) => a - b)
    return { value: Number.isFinite(value) ? value : null, lo: pctile(s, 0.025), hi: pctile(s, 0.975) }
  }
  const rows = models.map((modelId, i) => ({
    modelId,
    hands: base[i]!.hands,
    tournaments: base[i]!.ts,
    bb100: iv(base[i]!.bb100, draws[i]!.bb),
    avgFinish: iv(base[i]!.finish, draws[i]!.fin)
  }))
  const pairs = pairIdx.map(([i, j], n) => ({
    a: models[i]!,
    b: models[j]!,
    bb100: iv(base[i]!.bb100 - base[j]!.bb100, pairDraws[n]!.bb),
    avgFinish: iv(base[i]!.finish - base[j]!.finish, pairDraws[n]!.fin)
  }))
  return { rows, pairs, matches: matches.length }
}

/** How often each model finished 1st, 2nd, …: counts[place - 1]. */
export function finishDistribution(tournaments: RunTournamentLite[], models: string[], players: number): Record<string, number[]> {
  const out = Object.fromEntries(models.map(m => [m, Array.from({ length: players }, () => 0)]))
  for (const t of tournaments) for (const f of t.finish) if (out[f.modelId]) out[f.modelId]![f.place - 1]!++
  return out
}

/**
 * Net chips (in big blinds) that moved from b to a, summed over hands: each loser's loss is
 * split across that hand's winners in proportion to what they won. flow[a][b] = −flow[b][a].
 */
export function chipFlow(hands: RunHandLite[], models: string[]): Record<string, Record<string, number>> {
  const flow = Object.fromEntries(models.map(a => [a, Object.fromEntries(models.map(b => [b, 0]))]))
  for (const h of hands) {
    const entries = Object.entries(h.deltas)
    const won = entries.filter(([, d]) => d > 0)
    const total = won.reduce((n, [, d]) => n + d, 0)
    if (!total) continue
    for (const [loser, d] of entries) {
      if (d >= 0) continue
      for (const [winner, w] of won) {
        const amount = (-d * (w / total)) / h.bigBlind
        const a = modelOf(h, winner)
        const b = modelOf(h, loser)
        if (flow[a]?.[b] === undefined || flow[b]?.[a] === undefined) continue
        flow[a]![b]! += amount
        flow[b]![a]! -= amount
      }
    }
  }
  return flow
}

/**
 * Cumulative bb/100 per model after each completed tournament, in schedule order (does it converge?).
 * null until a model has `minHands` hands, so a handful of early hands doesn't set the scale.
 */
export function bb100Series(hands: RunHandLite[], tournamentOrder: string[], models: string[], minHands = 1): { tournamentId: string, hands: number, bb100: Record<string, number | null> }[] {
  const byT = new Map<string, RunHandLite[]>()
  for (const h of hands) (byT.get(h.tournamentId) ?? byT.set(h.tournamentId, []).get(h.tournamentId)!).push(h)
  const bb = Object.fromEntries(models.map(m => [m, 0]))
  const n = Object.fromEntries(models.map(m => [m, 0]))
  let total = 0
  return tournamentOrder.filter(t => byT.has(t)).map((t) => {
    for (const h of byT.get(t)!) {
      total++
      for (const [seatId, d] of Object.entries(h.deltas)) {
        const m = modelOf(h, seatId)
        if (bb[m] === undefined) continue
        bb[m] += d / h.bigBlind
        n[m]!++
      }
    }
    return { tournamentId: t, hands: total, bb100: Object.fromEntries(models.map(m => [m, n[m]! >= Math.max(1, minHands) ? (bb[m]! / n[m]!) * 100 : null])) }
  })
}

/**
 * Plackett–Luce strengths from finish orders (Hunter's MM algorithm), normalized to mean log 0.
 * Each ranking lists model ids best to worst; ties are broken by list order.
 */
export function plackettLuce(rankings: string[][], models: string[], iters = 200): Record<string, number> {
  const gamma = Object.fromEntries(models.map(m => [m, 1]))
  const wins = Object.fromEntries(models.map(m => [m, 0]))
  for (const r of rankings) for (let i = 0; i < r.length - 1; i++) if (wins[r[i]!] !== undefined) wins[r[i]!]!++
  for (let it = 0; it < iters; it++) {
    const denom = Object.fromEntries(models.map(m => [m, 0]))
    for (const r of rankings) {
      for (let i = 0; i < r.length - 1; i++) {
        const rest = r.slice(i)
        const s = rest.reduce((n, m) => n + (gamma[m] ?? 0), 0)
        for (const m of rest) if (denom[m] !== undefined) denom[m]! += 1 / s
      }
    }
    for (const m of models) gamma[m] = denom[m] ? Math.max(1e-9, wins[m]! / denom[m]!) : gamma[m]!
    const meanLog = models.reduce((n, m) => n + Math.log(gamma[m]!), 0) / models.length
    for (const m of models) gamma[m] = gamma[m]! / Math.exp(meanLog)
  }
  return Object.fromEntries(models.map(m => [m, Math.log(gamma[m]!)]))
}
