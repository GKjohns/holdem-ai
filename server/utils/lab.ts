/**
 * B4 Strategy Lab data: reads `data/lab/<run>/` (cards, predictions, allocations, memos, planner
 * records and one run file per lab table) and computes every number the planner prompts, the
 * pilot gate and /lab show. Relative imports and node:fs only, so bench/lab.ts and B5 notebooks
 * run it under bare Node. Every number comes from stats.ts; the planner only interprets them.
 *
 * Units: a lab "match" is one duplicate match (all rotations of one seed) at one table. Leads over
 * the control are paired: card and control sat at the same table on the same seeds, and the
 * bootstrap resamples whole matches (stats.ts `leaderboard`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { findModel } from '../../shared/utils/models.ts'
import type { NarrateHand, NarrateSeat } from '../../shared/utils/narration.ts'
import { costUsd } from '../../shared/utils/pricing.ts'
import { parseRun, playerOf } from '../../shared/utils/runs.ts'
import type { ParsedRun, RunEndLine, RunHandLine, RunPlayer } from '../../shared/utils/runs.ts'
import { leaderboard, matchAggregates, seatStats } from '../../shared/utils/stats.ts'
import type { Interval, MatchAgg, SeatStats } from '../../shared/utils/stats.ts'
import { CONTROL_ID, NO_CHAMPION_ID, heldOutVerdict, verdict } from '../../shared/utils/strategy.ts'
import type { StrategyCard, Verdict } from '../../shared/utils/strategy.ts'
import { completeMatches } from './results.ts'

// ── files ───────────────────────────────────────────────────────────────────────────────────

export interface LabConfig {
  run: string
  base: string
  generations: number
  /** Cards in gen 0, and in every later generation. */
  cards: number
  nextCards: number
  /** Hand cap per tournament. */
  hands: number
  /** Matches per card in round 1; extra matches for survivors in round 2; Thompson top-up matches. */
  r1: number
  r2: number
  topup: number
  heldoutMatches: number
  heldoutField: string[]
  /** Reference field beside the card, control and champion. */
  field: string[]
  seed: number
  fake: boolean
  planner: string
}

export interface AllocationRound {
  round: number
  kind: 'equal' | 'halving' | 'thompson'
  /** Total matches per card after this round. */
  matches: Record<string, number>
  /** Lead over the control per card when the round was allocated (rounds 2+). */
  ranking?: { cardId: string, lead: number | null, se: number | null }[]
}
export interface Allocation { gen: number, rounds: AllocationRound[] }

export interface Memo {
  gen: number
  headline: string
  confirmed: string[]
  refuted: string[]
  noise: string[]
  surprises: string[]
}

export interface Predictions { gen: number, writtenAt: string, cards: StrategyCard[] }
export interface GenOutcome { gen: number, championIn: string, championOut: string, why: string, writtenAt: string }

export interface PlannerRecord {
  key: string
  kind: 'gen0' | 'next' | 'field_notes'
  gen: number
  model: string
  writtenAt: string
  attempts: { usage: { input: number, output: number }, latencyMs: number, errors: string[] }[]
  prompt: string
  output: unknown
}

export interface HeldoutPlan { writtenAt: string, cardIds: string[], players: RunPlayer[], baseSeed: number, matches: number, trainingSeeds: number, overlap: number }

export interface LabFiles {
  dir: string
  config: LabConfig | null
  cards: StrategyCard[]
  predictions: Predictions[]
  allocations: Allocation[]
  outcomes: GenOutcome[]
  memos: Memo[]
  planner: PlannerRecord[]
  /** Training tables (slug g<gen>-<cardId>) and the held-out table (slug heldout). */
  tables: { slug: string, run: ParsedRun, mtimeMs: number }[]
  heldout: HeldoutPlan | null
  fieldNotes: string | null
  /** The planner's structured notes (sections of field_notes.md). */
  notes: (Record<'headline' | 'whatWins' | 'whatLoses' | 'priorsWrong' | 'noise' | 'nextTests', string> & { model: string }) | null
  events: { type: string, ts: string, [k: string]: unknown }[]
}

const readJson = <T>(f: string): T | null => existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) as T : null
const parsedCache = new Map<string, { key: string, run: ParsedRun }>()

/** Parses a run file once per (mtime, size): table files are large and /lab polls. */
function loadRun(file: string): { run: ParsedRun, mtimeMs: number } {
  const st = statSync(file)
  const key = `${st.mtimeMs}:${st.size}`
  let hit = parsedCache.get(file)
  if (hit?.key !== key) {
    hit = { key, run: parseRun(readFileSync(file, 'utf8')) }
    parsedCache.set(file, hit)
  }
  return { run: hit.run, mtimeMs: st.mtimeMs }
}

export function labDir(run: string, root = process.cwd()): string {
  return join(root, 'data', 'lab', run)
}

export function loadLab(dir: string): LabFiles {
  const gens = existsSync(dir) ? readdirSync(dir).filter(d => /^gen\d+$/.test(d)).sort((a, b) => Number(a.slice(3)) - Number(b.slice(3))) : []
  const predictions = gens.map(g => readJson<Predictions>(join(dir, g, 'predictions.json'))).filter((p): p is Predictions => !!p)
  const runsDir = join(dir, 'runs')
  const tables = existsSync(runsDir)
    ? readdirSync(runsDir).filter(f => f.endsWith('.jsonl') && !f.endsWith('.cache.jsonl')).sort().map((f) => {
        const { run, mtimeMs } = loadRun(join(runsDir, f))
        return { slug: f.slice(0, -'.jsonl'.length), run, mtimeMs }
      })
    : []
  const plannerDir = join(dir, 'planner')
  const planner = existsSync(plannerDir) ? readdirSync(plannerDir).filter(f => f.endsWith('.json')).sort().map(f => readJson<PlannerRecord>(join(plannerDir, f))!) : []
  const eventsFile = join(dir, 'lab.jsonl')
  const events = existsSync(eventsFile)
    ? readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
        try {
          return [JSON.parse(l)]
        } catch {
          return []
        }
      })
    : []
  return {
    dir,
    config: readJson<LabConfig>(join(dir, 'config.json')),
    cards: predictions.flatMap(p => p.cards),
    predictions,
    allocations: gens.map(g => readJson<Allocation>(join(dir, g, 'allocation.json'))).filter((a): a is Allocation => !!a),
    outcomes: gens.map(g => readJson<GenOutcome>(join(dir, g, 'outcome.json'))).filter((a): a is GenOutcome => !!a),
    memos: gens.map(g => readJson<Memo>(join(dir, g, 'memo.json'))).filter((a): a is Memo => !!a),
    planner,
    tables,
    heldout: readJson<HeldoutPlan>(join(dir, 'heldout.json')),
    fieldNotes: existsSync(join(dir, 'field_notes.md')) ? readFileSync(join(dir, 'field_notes.md'), 'utf8') : null,
    notes: readJson(join(dir, 'field_notes.json')),
    events
  }
}

export const tableSlug = (gen: number, cardId: string) => `g${gen}-${cardId}`
export const HELDOUT_SLUG = 'heldout'

// ── numbers ─────────────────────────────────────────────────────────────────────────────────

export interface Lead {
  matches: number
  hands: number
  bb100: Interval
  control: Interval
  /** Player − control bb/100, paired on the same matches. */
  lead: Interval
}

type Units = Map<string, MatchAgg>

/** 1 for "m01". */
export const matchNo = (matchId: string) => Number(matchId.slice(1))

/**
 * Per complete match at each table: chips per player (keys prefixed by table slug). `upTo` limits a
 * table to its first N matches, so a decision replayed later sees only the matches it saw then.
 */
export function unitsOf(tables: LabFiles['tables'], upTo?: (slug: string) => number): Units {
  const out: Units = new Map()
  for (const t of tables) {
    const limit = upTo?.(t.slug) ?? Infinity
    const done = new Set(completeMatches(t.run).filter(m => matchNo(m) <= limit))
    const tournaments = t.run.tournaments.filter(x => done.has(x.matchId))
    const hands = t.run.hands.filter(h => done.has(h.matchId)).map(h => ({ ...h, deltas: h.result.deltas }))
    for (const [m, agg] of matchAggregates(hands, tournaments)) out.set(`${t.slug}/${m}`, agg)
  }
  return out
}

/** A player's bb/100 and its paired lead over the control, over the units where both sat. */
export function leadOf(units: Units, playerId: string, opts: { iters?: number } = {}): Lead {
  const sub: Units = new Map([...units].filter(([, a]) => a[playerId] && a[CONTROL_ID]))
  const empty = { value: null, lo: null, hi: null }
  if (!sub.size) return { matches: 0, hands: 0, bb100: empty, control: empty, lead: empty }
  const b = leaderboard(sub, [playerId, CONTROL_ID], { iters: opts.iters ?? 2000, seed: 7 })
  return { matches: b.matches, hands: b.rows[0]!.hands, bb100: b.rows[0]!.bb100, control: b.rows[1]!.bb100, lead: b.pairs[0]!.bb100 }
}

/** Standard error from a 95% percentile interval (for Thompson draws); wide when unknown. */
export function seOf(iv: Interval, fallback = 80): number {
  return iv.lo !== null && iv.hi !== null && iv.hi > iv.lo ? (iv.hi - iv.lo) / 3.92 : fallback
}

export const isTraining = (slug: string) => /^g\d+-/.test(slug)
export const genOfSlug = (slug: string) => Number(/^g(\d+)-/.exec(slug)?.[1] ?? -1)

/** UI / prompt label for a lab player. */
export function playerLabel(id: string, cards: StrategyCard[], base = 'openai/gpt-6-luna'): string {
  const short = (findModel(base)?.label ?? base).replace(/^GPT-6 /, '')
  if (id === CONTROL_ID) return `${short} (control, no card)`
  if (id === NO_CHAMPION_ID) return `${short} (no card, seat 2)`
  const c = cards.find(x => x.id === id)
  if (c) return `${short} · ${c.name}`
  return findModel(id)?.label ?? id
}

/** Style stats per player over the given tables (seat ids mapped to player ids). */
export function playerStyles(tables: LabFiles['tables'], players: string[]): SeatStats[] {
  const hands = tables.flatMap(t => t.run.hands).map((h) => {
    const p = (id: string) => {
      const s = h.seats.find(x => x.id === id)
      return s ? playerOf(s) : id
    }
    const keys = <T>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [p(k), v]))
    return {
      handNo: h.handNo, board: h.board, log: h.log.map(e => ({ ...e, seatId: p(e.seatId) })), holes: keys(h.holes),
      shown: keys(h.result.shown), pots: h.result.pots.map(x => ({ ...x, eligible: x.eligible.map(p), winners: x.winners.map(p) })),
      decisions: h.decisions.map(d => ({ seatId: p(d.seatId), decision: d.decision }))
    }
  })
  return seatStats(players, hands, hands.flatMap(h => h.decisions))
}

/** The hands with the biggest swings (in big blinds) for a player, as god-view NarrateHands. */
export function decisiveHands(tables: LabFiles['tables'], playerId: string, cards: StrategyCard[], base: string, n = 5): { hand: NarrateHand, seats: NarrateSeat[], tournamentId: string, slug: string, bb: number }[] {
  const scored: { h: RunHandLine, slug: string, seatId: string, bb: number }[] = []
  for (const t of tables) {
    for (const h of t.run.hands) {
      const seat = h.seats.find(s => playerOf(s) === playerId)
      if (!seat) continue
      const d = h.result.deltas[seat.id] ?? 0
      if (d) scored.push({ h, slug: t.slug, seatId: seat.id, bb: d / h.bigBlind })
    }
  }
  scored.sort((a, b) => Math.abs(b.bb) - Math.abs(a.bb) || a.slug.localeCompare(b.slug) || a.h.handNo - b.h.handNo)
  return scored.slice(0, n).map(({ h, slug, bb }) => ({
    slug,
    bb,
    tournamentId: h.tournamentId,
    seats: h.seats.map(s => ({ id: s.id, name: `${playerLabel(playerOf(s), cards, base)} [at the table: ${s.name}]`, modelId: s.modelId })),
    hand: {
      handNo: h.handNo, board: h.board, button: h.button, pots: h.result.pots, shown: h.result.shown, deltas: h.result.deltas,
      stacksAfter: h.stacksAfter, holes: h.holes, log: h.log, actionLabels: h.actionLabels, blindsNote: h.blinds,
      decisions: h.decisions.map(d => ({ seatId: d.seatId, street: d.street, logIndex: d.logIndex, decision: d.decision }))
    }
  }))
}

/** Every deck seed any run on disk has dealt (B3 runs and every lab table), excluding `exceptSlug`. */
export function seenSeeds(root: string, exceptFile?: string): Set<number> {
  const out = new Set<number>()
  const dirs = [join(root, 'data', 'runs')]
  const lab = join(root, 'data', 'lab')
  if (existsSync(lab)) for (const r of readdirSync(lab)) dirs.push(join(lab, r, 'runs'))
  for (const d of dirs) {
    if (!existsSync(d)) continue
    for (const f of readdirSync(d).filter(x => x.endsWith('.jsonl') && !x.endsWith('.cache.jsonl'))) {
      const file = join(d, f)
      if (file === exceptFile) continue
      const { run } = loadRun(file)
      for (const t of run.tournaments) out.add(t.seed)
      for (const h of [...run.hands, ...run.partialHands]) out.add(h.seed)
    }
  }
  return out
}

/** Planner spend from its records (every attempt is a paid call). */
export function plannerSpend(records: PlannerRecord[]): number {
  return records.reduce((a, r) => a + r.attempts.reduce((b, x) => b + costUsd(r.model, x.usage), 0), 0)
}

/** Table spend: every decision in every table cache (each cache line is one paid call). */
export function tableSpend(dir: string): number {
  const runsDir = join(dir, 'runs')
  if (!existsSync(runsDir)) return 0
  let usd = 0
  for (const f of readdirSync(runsDir).filter(x => x.endsWith('.cache.jsonl'))) {
    for (const raw of readFileSync(join(runsDir, f), 'utf8').split('\n')) {
      if (!raw.trim()) continue
      try {
        const e = JSON.parse(raw)
        usd += costUsd(e.decision.model, e.decision.usage)
      } catch { /* half-written line */ }
    }
  }
  return usd
}

// ── the /lab view ──────────────────────────────────────────────────────────────────────────

export interface LabCardRow {
  cardId: string
  label: string
  gen: number
  kind: StrategyCard['kind']
  matches: number
  hands: number
  bb100: Interval
  lead: Interval
  predicted: StrategyCard['predicted']
  verdict: Verdict
  /** Still in after the halving round. */
  survived: boolean
}

export interface LabDetail {
  run: string
  config: LabConfig | null
  fake: boolean
  status: string
  spend: { tables: number, planner: number, total: number, cap: number | null }
  fieldNotes: string | null
  notes: LabFiles['notes']
  cards: (StrategyCard & { label: string })[]
  gens: {
    gen: number
    championIn: string
    championInLabel: string
    championOut: string | null
    championWhy: string | null
    predictionsWrittenAt: string
    firstHandAt: string | null
    rounds: AllocationRound[]
    memo: Memo | null
    rows: LabCardRow[]
    champion: Lead & { id: string, label: string }
    hands: number
  }[]
  pooled: (Lead & { cardId: string, label: string, gen: number })[]
  control: { bb100: Interval, matches: number, hands: number }
  scatter: { cardId: string, label: string, gen: number, predicted: number, actual: number | null, lo: number | null, hi: number | null }[]
  heldout: {
    matches: number
    planned: number
    field: string[]
    players: { id: string, label: string }[]
    rows: { cardId: string, label: string, heldout: Lead, training: Interval, verdict: 'holds' | 'overfit' | 'inconclusive' }[]
    others: { id: string, label: string, bb100: Interval }[]
    seedsUnseen: boolean
    trainingSeeds: number
  } | null
  styles: (SeatStats & { label: string })[]
}

export function labDetail(files: LabFiles): LabDetail {
  const cfg = files.config
  const base = cfg?.base ?? 'openai/gpt-6-luna'
  const cards = files.cards
  const label = (id: string) => playerLabel(id, cards, base)
  const training = files.tables.filter(t => isTraining(t.slug))
  const units = unitsOf(training)
  const lastEnd = files.events.filter(e => e.type === 'lab_end').at(-1) as { status?: string } | undefined
  const tables = tableSpendFromRuns(files.tables)
  const planner = plannerSpend(files.planner)

  const gens: LabDetail['gens'] = files.predictions.map((p) => {
    const g = p.gen
    const genTables = training.filter(t => genOfSlug(t.slug) === g)
    const genUnits = unitsOf(genTables)
    const alloc = files.allocations.find(a => a.gen === g)
    const outcome = files.outcomes.find(o => o.gen === g)
    const championIn = g === 0 ? NO_CHAMPION_ID : files.outcomes.find(o => o.gen === g - 1)?.championOut ?? NO_CHAMPION_ID
    const halving = alloc?.rounds.find(r => r.kind === 'halving')
    const firstHand = genTables.flatMap(t => [...t.run.hands, ...t.run.partialHands].map(h => h.ts)).sort()[0] ?? null
    const rows = p.cards.map((c) => {
      const own = unitsOf(genTables.filter(t => t.slug === tableSlug(g, c.id)))
      const l = leadOf(own, c.id)
      return {
        cardId: c.id, label: label(c.id), gen: g, kind: c.kind, matches: l.matches, hands: l.hands, bb100: l.bb100, lead: l.lead,
        predicted: c.predicted, verdict: verdict(c.predicted.vsControl, l.lead),
        survived: halving ? (halving.matches[c.id] ?? 0) > (alloc!.rounds[0]!.matches[c.id] ?? 0) : true
      }
    }).sort((a, b) => (b.lead.value ?? -Infinity) - (a.lead.value ?? -Infinity))
    return {
      gen: g, championIn, championInLabel: label(championIn), championOut: outcome?.championOut ?? null, championWhy: outcome?.why ?? null,
      predictionsWrittenAt: p.writtenAt, firstHandAt: firstHand, rounds: alloc?.rounds ?? [], memo: files.memos.find(m => m.gen === g) ?? null,
      rows, champion: { id: championIn, label: label(championIn), ...leadOf(genUnits, championIn) },
      hands: genTables.reduce((n, t) => n + t.run.hands.length, 0)
    }
  })

  const pooled = cards.map(c => ({ cardId: c.id, label: label(c.id), gen: c.gen, ...leadOf(units, c.id) }))
    .filter(r => r.matches > 0)
    .sort((a, b) => (b.lead.value ?? -Infinity) - (a.lead.value ?? -Infinity))
  const controlB = units.size ? leaderboard(units, [CONTROL_ID], { seed: 7 }) : null

  const scatter = gens.flatMap(g => g.rows.map(r => ({ cardId: r.cardId, label: r.label, gen: g.gen, predicted: r.predicted.bb100, actual: r.bb100.value, lo: r.bb100.lo, hi: r.bb100.hi })))

  let heldout: LabDetail['heldout'] = null
  const ht = files.tables.find(t => t.slug === HELDOUT_SLUG)
  if (files.heldout) {
    const hu = ht ? unitsOf([ht]) : new Map()
    const others = files.heldout.players.filter(p => !files.heldout!.cardIds.includes(p.id))
    const hb = hu.size ? leaderboard(hu, others.map(p => p.id), { seed: 7 }) : null
    heldout = {
      matches: hu.size,
      planned: files.heldout.matches,
      field: cfg?.heldoutField ?? [],
      players: files.heldout.players.map(p => ({ id: p.id, label: label(p.id) })),
      rows: files.heldout.cardIds.map((id) => {
        const h = leadOf(hu, id)
        return { cardId: id, label: label(id), heldout: h, training: leadOf(units, id).lead, verdict: heldOutVerdict(h.lead) }
      }),
      others: others.map((p, i) => ({ id: p.id, label: label(p.id), bb100: hb?.rows[i]?.bb100 ?? { value: null, lo: null, hi: null } })),
      seedsUnseen: files.heldout.overlap === 0,
      trainingSeeds: files.heldout.trainingSeeds
    }
  }

  const stylePlayers = [CONTROL_ID, ...pooled.map(r => r.cardId), ...(cfg?.field ?? [])]
  const styles = playerStyles(training, stylePlayers).map(s => ({ ...s, label: label(s.seatId) })).filter(s => s.hands > 0)

  return {
    run: cfg?.run ?? files.dir.split('/').at(-1)!,
    config: cfg,
    fake: cfg?.fake ?? false,
    status: lastEnd?.status ?? (files.events.some(e => e.type === 'lab_start') ? 'running' : 'empty'),
    spend: { tables, planner, total: tables + planner, cap: (files.events.filter(e => e.type === 'lab_start').at(-1) as { budget?: number } | undefined)?.budget ?? null },
    fieldNotes: files.fieldNotes,
    notes: files.notes,
    cards: cards.map(c => ({ ...c, label: label(c.id) })),
    gens,
    pooled,
    control: { bb100: controlB?.rows[0]?.bb100 ?? { value: null, lo: null, hi: null }, matches: controlB?.matches ?? 0, hands: controlB?.rows[0]?.hands ?? 0 },
    scatter,
    heldout,
    styles
  }
}

/** Spend from the table run files (the caches hold the same calls; run files are already parsed). */
function tableSpendFromRuns(tables: LabFiles['tables']): number {
  let usd = 0
  for (const t of tables) {
    const end = t.run.ends.at(-1) as RunEndLine | undefined
    usd += end ? end.totalSpentUsd : t.run.tournaments.reduce((a, x) => a + x.costUsd, 0)
  }
  return usd
}

export interface LabListItem { run: string, fake: boolean, status: string, gens: number, cards: number, hands: number, spend: number, updated: string }

export function labList(root = process.cwd()): LabListItem[] {
  const lab = join(root, 'data', 'lab')
  if (!existsSync(lab)) return []
  return readdirSync(lab).filter(r => existsSync(join(lab, r, 'config.json'))).map((r) => {
    const f = loadLab(join(lab, r))
    const end = f.events.filter(e => e.type === 'lab_end').at(-1) as { status?: string } | undefined
    const updated = [statSync(join(lab, r, 'config.json')).mtimeMs, ...f.tables.map(t => t.mtimeMs)].reduce((a, b) => Math.max(a, b), 0)
    return {
      run: r, fake: f.config?.fake ?? false, status: end?.status ?? 'running', gens: f.predictions.length, cards: f.cards.length,
      hands: f.tables.reduce((n, t) => n + t.run.hands.length, 0), spend: tableSpendFromRuns(f.tables) + plannerSpend(f.planner),
      updated: new Date(updated).toISOString()
    }
  }).sort((a, b) => b.updated.localeCompare(a.updated))
}
