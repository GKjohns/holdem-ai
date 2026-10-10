/**
 * Turns a parsed run file into what /results shows. Pure (relative imports) so tests and B5's
 * notebook can call it under bare Node. Every number comes from stats.ts; CIs use only complete
 * matches (all rotations of a seed finished), because a half-played match isn't duplicate-balanced.
 */
import { findModel } from '../../shared/utils/models.ts'
import { statsLine } from '../../shared/utils/narration.ts'
import type { SeatScout } from '../../shared/utils/narration.ts'
import { costUsd } from '../../shared/utils/pricing.ts'
import type { ParsedRun, RunHandLine, TournamentLine } from '../../shared/utils/runs.ts'
import { bb100Series, chipFlow, finishDistribution, leaderboard, matchAggregates, plackettLuce, seatStats } from '../../shared/utils/stats.ts'
import type { LeaderRow, PairDiff, SeatStats, StatsHand } from '../../shared/utils/stats.ts'

export interface RunListItem {
  slug: string
  lineup: string[]
  format: string
  fake: boolean
  tournamentsDone: number
  tournamentsPlanned: number | null
  matchesComplete: number
  hands: number
  costUsd: number
  status: string | null
  updated: string
}

export interface ModelOps {
  modelId: string
  decisions: number
  fallbacks: number
  /** Decision models: refusals answered on the reworded retry. */
  retried: number
  avgMs: number | null
  p95Ms: number | null
  costUsd: number
  hands: number
}

export interface RunDetail {
  item: RunListItem
  models: { id: string, label: string, vendor: string, kind: string }[]
  players: number
  maxHands: number
  /** Complete matches used for the stats below (all, or the first N when asked). */
  matchesUsed: number
  leaderboard: LeaderRow[]
  pairs: PairDiff[]
  finishes: Record<string, number[]>
  plackettLuce: Record<string, number>
  flow: Record<string, Record<string, number>>
  series: { tournamentId: string, hands: number, bb100: Record<string, number | null> }[]
  style: (SeatStats & { modelId: string })[]
  ops: ModelOps[]
  scouting: {
    markdown: string
    sampleTournamentId: string
    costUsd: number
    model: string
    hands: number
    overview: string
    seats: (SeatScout & { name: string, modelId: string, stats: string | null })[]
  } | null
  command: string
}

export function completeMatches(run: ParsedRun): string[] {
  const n = run.start?.lineup.length ?? 0
  const per = new Map<string, number>()
  for (const t of run.tournaments) per.set(t.matchId, (per.get(t.matchId) ?? 0) + 1)
  return [...per.entries()].filter(([, c]) => c === n).map(([m]) => m).sort()
}

export function listItem(slug: string, run: ParsedRun, updated: string): RunListItem {
  const end = run.ends.at(-1)
  return {
    slug,
    lineup: run.start?.lineup ?? [],
    format: run.start?.format ?? '?',
    fake: run.start?.fake ?? false,
    tournamentsDone: run.tournaments.length,
    tournamentsPlanned: end?.tournamentsPlanned ?? null,
    matchesComplete: completeMatches(run).length,
    hands: run.hands.length,
    costUsd: run.tournaments.reduce((a, t) => a + t.costUsd, 0),
    status: end?.status ?? null,
    updated
  }
}

/** A run hand with seat ids replaced by model ids, for per-model style stats. */
function byModel(h: RunHandLine): StatsHand & { decisions: { seatId: string, decision: RunHandLine['decisions'][number]['decision'] }[] } {
  const m = (id: string) => h.seats.find(s => s.id === id)?.modelId ?? id
  const keys = <T>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [m(k), v]))
  return {
    handNo: h.handNo,
    board: h.board,
    log: h.log.map(e => ({ ...e, seatId: m(e.seatId) })),
    holes: keys(h.holes),
    shown: keys(h.result.shown),
    pots: h.result.pots.map(p => ({ ...p, eligible: p.eligible.map(m), winners: p.winners.map(m) })),
    decisions: h.decisions.map(d => ({ seatId: m(d.seatId), decision: d.decision }))
  }
}

export function runDetail(slug: string, run: ParsedRun, updated: string, opts: { matches?: number } = {}): RunDetail {
  const lineup = run.start?.lineup ?? []
  const all = completeMatches(run)
  const used = new Set(opts.matches ? all.slice(0, opts.matches) : all)
  const tournaments: TournamentLine[] = run.tournaments.filter(t => used.has(t.matchId))
  const tIds = new Set(tournaments.map(t => t.tournamentId))
  const hands = run.hands.filter(h => tIds.has(h.tournamentId))

  const lite = hands.map(h => ({ ...h, deltas: h.result.deltas }))
  const board = leaderboard(matchAggregates(lite, tournaments), lineup)
  const rankings = tournaments.map(t => t.finish.map(f => f.modelId))
  const modelHands = hands.map(byModel)
  const style = seatStats(lineup, modelHands, modelHands.flatMap(h => h.decisions)).map(s => ({ ...s, modelId: s.seatId }))

  const ops: ModelOps[] = lineup.map((modelId) => {
    const ds = hands.flatMap(h => h.decisions.filter(d => d.decision.model === modelId).map(d => d.decision))
    const live = ds.filter(d => !d.fallback).map(d => d.latencyMs).sort((a, b) => a - b)
    return {
      modelId,
      decisions: ds.length,
      fallbacks: ds.filter(d => d.fallback).length,
      retried: ds.filter(d => d.retried).length,
      avgMs: live.length ? Math.round(live.reduce((a, b) => a + b, 0) / live.length) : null,
      p95Ms: live.length ? live[Math.floor(0.95 * (live.length - 1))]! : null,
      costUsd: ds.reduce((a, d) => a + costUsd(d.model, d.usage), 0),
      hands: board.rows.find(r => r.modelId === modelId)?.hands ?? 0
    }
  })

  const s = run.start
  const flags = s
    ? [`--lineup ${s.lineup.join(',')}`, `--matches ${Math.max(1, Math.ceil((run.ends.at(-1)?.tournamentsPlanned ?? lineup.length) / Math.max(lineup.length, 1)))}`,
        s.format === 'cash' ? '--format cash' : '', `--hands ${s.tournament.maxHands}`, `--seed ${s.baseSeed}`, s.fake ? '--fake' : '', `--slug ${slug}`, `--budget ${Math.ceil((run.ends.at(-1)?.totalSpentUsd ?? 0) + 1)}`, '--concurrency 6']
    : []
  return {
    item: listItem(slug, run, updated),
    models: lineup.map((id) => {
      const m = findModel(id)
      return { id, label: m?.label ?? id, vendor: m?.vendor ?? '?', kind: m?.kind ?? '?' }
    }),
    players: lineup.length,
    maxHands: s?.tournament.maxHands ?? 0,
    matchesUsed: used.size,
    leaderboard: board.rows,
    pairs: board.pairs,
    finishes: finishDistribution(tournaments, lineup, lineup.length),
    plackettLuce: rankings.length ? plackettLuce(rankings, lineup) : {},
    flow: chipFlow(lite, lineup),
    series: bb100Series(lite, tournaments.map(t => t.tournamentId).sort(), lineup, 50),
    style,
    ops,
    scouting: scoutingView(run),
    command: `caffeinate -ims node --env-file=.env bench/tournament.ts ${flags.filter(Boolean).join(' ')}`
  }
}

/** The run's scouting report with seat ids (from its sample tournament) resolved to models. */
function scoutingView(run: ParsedRun): RunDetail['scouting'] {
  const sc = run.scouting
  if (!sc) return null
  const sample = run.tournaments.find(t => t.tournamentId === sc.sampleTournamentId)
  const seat = (id: string) => sample?.seats.find(s => s.id === id)
  const r = sc.report
  return {
    markdown: sc.markdown,
    sampleTournamentId: sc.sampleTournamentId,
    costUsd: costUsd(r.model, r.usage),
    model: r.model,
    hands: r.hands,
    overview: r.overview,
    seats: r.seats.map((x) => {
      const st = r.stats.find(y => y.seatId === x.seatId)
      return { ...x, name: seat(x.seatId)?.name ?? x.seatId, modelId: seat(x.seatId)?.modelId ?? '', stats: st ? statsLine(st) : null }
    })
  }
}
