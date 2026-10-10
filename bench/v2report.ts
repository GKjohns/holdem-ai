/**
 * v2 analysis: standings with small-sample CIs, guest-seat comparisons, persona leads, the v1 → v2
 * checks (short-stack shoves, river folds holding the winner, misread sets, talk and history use,
 * bet sizing) computed the SAME way on v1 and v2 run files, cost and latency, and notable hands.
 * Analysis only (god view of finished hands); nothing here reaches a seated model.
 *
 *   node bench/v2report.ts [personaSlug]  → prints a summary, writes internal_docs/20261011_v2_fairness/out/*.json
 *   V2_OUT=/tmp/x node bench/v2report.ts 20261012_v2B_sol   → same, written elsewhere
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { costUsd } from '../shared/utils/pricing.ts'
import { findModel } from '../shared/utils/models.ts'
import { compareHands, rankHand } from '../shared/utils/handRank.ts'
import { parseRun, playerOf } from '../shared/utils/runs.ts'
import type { ParsedRun, RunHandLine, TournamentLine } from '../shared/utils/runs.ts'
import type { Card } from '../shared/utils/types.ts'

const ROOT = process.cwd()
/** V2_OUT redirects the outputs (e.g. a second persona table without overwriting out/personas_raw.json). */
const OUT = process.env.V2_OUT ?? join(ROOT, 'internal_docs', '20261011_v2_fairness', 'out')
const RUNS = join(ROOT, 'data', 'runs')
const PAYOUTS = [50, 30, 20]
const load = (slug: string): ParsedRun | null => existsSync(join(RUNS, `${slug}.jsonl`)) ? parseRun(readFileSync(join(RUNS, `${slug}.jsonl`), 'utf8')) : null
const label = (id: string) => findModel(id)?.label ?? id
const r1 = (x: number | null) => x === null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10

// ── small-sample intervals ──────────────────────────────────────────────────────────────────────
const T975: Record<number, number> = { 1: 12.71, 2: 4.30, 3: 3.18, 4: 2.78, 5: 2.57, 6: 2.45, 7: 2.36, 8: 2.31, 9: 2.26, 10: 2.23, 12: 2.18, 14: 2.14, 17: 2.11, 20: 2.09, 24: 2.06, 29: 2.05 }
function tcrit(df: number): number {
  const ks = Object.keys(T975).map(Number).sort((a, b) => a - b)
  return T975[ks.filter(k => k <= df).at(-1) ?? 1]!
}
/** Mean with a t-interval over independent units (rotations / matches). */
export function tInterval(xs: number[]): { value: number | null, lo: number | null, hi: number | null, n: number } {
  const n = xs.length
  if (!n) return { value: null, lo: null, hi: null, n }
  const m = xs.reduce((a, b) => a + b, 0) / n
  if (n < 2) return { value: m, lo: null, hi: null, n }
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1))
  const h = tcrit(n - 1) * sd / Math.sqrt(n)
  return { value: m, lo: m - h, hi: m + h, n }
}
const iv = (x: ReturnType<typeof tInterval>) => ({ value: r1(x.value), lo: r1(x.lo), hi: r1(x.hi), n: x.n })

/**
 * bb/100 over groups of units: the pooled rate (Σ bb / Σ hands), with a percentile bootstrap over the
 * groups (seeded). A mean of per-tournament rates would let a 12-hand tournament swing it.
 */
function ratioBoot(groups: { bb: number, hands: number }[], iters = 4000): { value: number | null, lo: number | null, hi: number | null, n: number } {
  const g = groups.filter(x => x.hands > 0)
  const n = g.length
  if (!n) return { value: null, lo: null, hi: null, n }
  const rate = (xs: typeof g) => 100 * xs.reduce((a, x) => a + x.bb, 0) / xs.reduce((a, x) => a + x.hands, 0)
  if (n < 2) return { value: rate(g), lo: null, hi: null, n }
  let seed = 12345
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32)
  const draws: number[] = []
  for (let i = 0; i < iters; i++) draws.push(rate(Array.from({ length: n }, () => g[Math.floor(rnd() * n)]!)))
  draws.sort((a, b) => a - b)
  return { value: rate(g), lo: draws[Math.floor(0.025 * iters)]!, hi: draws[Math.floor(0.975 * iters)]!, n }
}
const grp = (us: Unit[], p: string) => ({ bb: us.reduce((a, u) => a + (u.bb[p] ?? 0), 0), hands: us.reduce((a, u) => a + (u.hands[p] ?? 0), 0) })

// ── per-unit results ────────────────────────────────────────────────────────────────────────────
interface Unit { key: string, bb: Record<string, number>, hands: Record<string, number>, chips: Record<string, number>, prize: Record<string, number>, place: Record<string, number> }

/** One unit per tournament: bb won and hands per player, chips net, prize share (50/30/20), place. */
function units(run: ParsedRun, players: number): Unit[] {
  const byT = new Map<string, RunHandLine[]>()
  for (const h of run.hands) (byT.get(h.tournamentId) ?? byT.set(h.tournamentId, []).get(h.tournamentId)!).push(h)
  return run.tournaments.map((t: TournamentLine) => {
    const u: Unit = { key: `${t.matchId}|${t.rotation}`, bb: {}, hands: {}, chips: {}, prize: {}, place: {} }
    for (const h of byT.get(t.tournamentId) ?? []) {
      for (const s of h.seats) {
        if (!(h.stacksBefore[s.id]! > 0)) continue
        const p = playerOf(s)
        u.bb[p] = (u.bb[p] ?? 0) + (h.result.deltas[s.id] ?? 0) / h.bigBlind
        u.hands[p] = (u.hands[p] ?? 0) + 1
        u.chips[p] = (u.chips[p] ?? 0) + (h.result.deltas[s.id] ?? 0)
      }
    }
    for (const f of t.finish) {
      const p = f.playerId ?? f.modelId
      // Shared places split the pooled payouts of the places they cover.
      const tied = t.finish.filter(g => g.place === f.place).length
      const pool = PAYOUTS.slice(f.place - 1, f.place - 1 + tied).reduce((a, b) => a + b, 0)
      u.prize[p] = pool / tied
      u.place[p] = f.place
    }
    void players
    return u
  })
}

const bb100 = (us: Unit[], p: string) => {
  const bb = us.reduce((a, u) => a + (u.bb[p] ?? 0), 0)
  const n = us.reduce((a, u) => a + (u.hands[p] ?? 0), 0)
  return n ? (bb / n) * 100 : NaN
}

/** Standings for one run: per player, intervals over tournaments (one match) or matches. */
function standings(run: ParsedRun) {
  const lineup = run.start!.lineup
  const us = units(run, lineup.length)
  const byMatch = new Map<string, Unit[]>()
  for (const u of us) (byMatch.get(u.key.split('|')[0]!) ?? byMatch.set(u.key.split('|')[0]!, []).get(u.key.split('|')[0]!)!).push(u)
  const matchUnits = [...byMatch.values()].filter(m => m.length === lineup.length)
  const perUnit = matchUnits.length >= 3 ? matchUnits : us.map(u => [u])
  return {
    unit: matchUnits.length >= 3 ? 'match' : 'tournament',
    tournaments: us.length,
    rows: lineup.map(p => ({
      player: p,
      label: run.start!.players?.find(x => x.id === p)?.cardId ?? label(p),
      hands: us.reduce((a, u) => a + (u.hands[p] ?? 0), 0),
      bb100: iv(ratioBoot(perUnit.map(g => grp(g, p)))),
      bb100Pooled: r1(bb100(us, p)),
      prize: iv(tInterval(perUnit.map(g => g.reduce((a, u) => a + (u.prize[p] ?? 0), 0) / g.length))),
      avgFinish: r1(us.reduce((a, u) => a + (u.place[p] ?? 0), 0) / us.length),
      wins: us.filter(u => u.place[p] === 1).length,
      chipsPerTournament: Math.round(us.reduce((a, u) => a + (u.chips[p] ?? 0), 0) / us.length)
    })).sort((a, b) => (b.prize.value ?? 0) - (a.prize.value ?? 0)),
    units: us
  }
}

// ── behaviour checks (identical definitions for v1 and v2) ─────────────────────────────────────
const RE = {
  set: /\b(?:i (?:have|hold|flopped|turned|made)|with|holding|my)\b[^.;]{0,25}\b(?:a set|set of|top set|middle set|bottom set|trips)\b/i,
  hypo: /\b(?:if|could|would|might|unless|any|if i|to make)\b[^.;]{0,15}\b(?:set|trips)\b/i,
  talk: /\b(?:said|says|saying|claims?|claimed|table talk|talk(?:ing)?|told)\b/i,
  history: /\b(?:earlier|previous(?:ly)?|last (?:hand|orbit|time)|hand #?\d+|showed|has shown|have shown|has been (?:\w+ )?(?:aggressive|passive|loose|tight|raising|betting|calling)|keeps (?:betting|raising|calling|limping)|calling station|calls (?:a lot|everything|light|down)|repeatedly|tends? to|tendenc)/i,
  format: /\b(?:bubble|payouts?|paid places?|in the money|pay jump|ladder|third place|3rd place|finish(?:ing)? (?:position|place))\b/i
}

interface Traits {
  decisions: number
  hands: number
  shortSpots: number
  shortShoves: number
  riverFoldsHU: number
  riverFoldsWinner: number
  facedRiverBet: number
  foldedRiverBet: number
  setClaims: number
  setWrong: number
  talkLines: number
  reasoningTalk: number
  reasoningHistory: number
  reasoningFormat: number
  reasoningN: number
  postflopBets: number
  overbets: number
  raiseTo: number
  vpipHands: number
  pfrHands: number
  usd: number
  latency: number[]
  fallbacks: number
}
const blank = (): Traits => ({ decisions: 0, hands: 0, shortSpots: 0, shortShoves: 0, riverFoldsHU: 0, riverFoldsWinner: 0, facedRiverBet: 0, foldedRiverBet: 0, setClaims: 0, setWrong: 0, talkLines: 0, reasoningTalk: 0, reasoningHistory: 0, reasoningFormat: 0, reasoningN: 0, postflopBets: 0, overbets: 0, raiseTo: 0, vpipHands: 0, pfrHands: 0, usd: 0, latency: [], fallbacks: 0 })

function traits(runs: ParsedRun[], key: (s: { modelId: string | null, playerId?: string }) => string): Record<string, Traits> {
  const out: Record<string, Traits> = {}
  for (const run of runs) {
    for (const h of run.hands) {
      const seatKey = new Map(h.seats.map(s => [s.id, key(s)]))
      for (const s of h.seats) {
        if (!(h.stacksBefore[s.id]! > 0)) continue
        const t = out[seatKey.get(s.id)!] ??= blank()
        t.hands++
        const pre = h.log.filter(e => e.seatId === s.id && e.street === 'preflop')
        if (pre.some(e => e.action.type !== 'fold' && e.action.type !== 'check')) t.vpipHands++
        if (pre.some(e => e.raiseTo !== undefined)) t.pfrHands++
      }
      for (const d of h.decisions) {
        const t = out[seatKey.get(d.seatId)!] ??= blank()
        const dec = d.decision
        const v = d.view
        t.decisions++
        t.usd += costUsd(dec.model, dec.usage)
        if (!dec.fallback) t.latency.push(dec.latencyMs)
        else t.fallbacks++
        if (dec.tableTalk) t.talkLines++
        if (dec.menuId === 'raise_to') t.raiseTo++
        const isLlm = findModel(dec.model)?.kind === 'llm'
        if (isLlm && dec.reasoning) {
          t.reasoningN++
          if (RE.talk.test(dec.reasoning)) t.reasoningTalk++
          if (RE.history.test(dec.reasoning)) t.reasoningHistory++
          if (RE.format.test(dec.reasoning)) t.reasoningFormat++
          if (v.street !== 'preflop' && RE.set.test(dec.reasoning) && !RE.hypo.test(dec.reasoning)) {
            t.setClaims++
            const ranks = [...v.hole, ...v.board].map(c => c[0])
            const hasSet = v.hole.some(c => ranks.filter(r => r === c[0]).length >= 3)
            if (!hasSet) t.setWrong++
          }
        }
        const stackBb = (v.me.stack + v.me.committed) / v.bigBlind
        if (v.street === 'preflop' && stackBb < 15) {
          t.shortSpots++
          if (dec.action.type === 'all_in' || (dec.action.type === 'raise' && dec.action.to >= v.maxRaiseTo)) t.shortShoves++
        }
        const isAggro = dec.action.type === 'raise' || dec.action.type === 'all_in'
        if (v.street !== 'preflop' && isAggro && v.toCall === 0) {
          t.postflopBets++
          const to = dec.action.type === 'raise' ? dec.action.to : v.maxRaiseTo
          if (to - v.me.committed >= 1.25 * v.pot && to < v.maxRaiseTo) t.overbets++
        }
        if (v.street === 'river' && v.toCall > 0) {
          t.facedRiverBet++
          if (dec.action.type === 'fold') t.foldedRiverBet++
          const live = v.opponents.filter(o => !o.folded)
          if (dec.action.type === 'fold' && live.length === 1 && h.board.length === 5) {
            t.riverFoldsHU++
            const mine = rankHand([...v.hole, ...h.board] as Card[])
            const theirs = rankHand([...h.holes[live[0]!.id]!, ...h.board] as Card[])
            if (compareHands(mine, theirs) > 0) t.riverFoldsWinner++
          }
        }
      }
    }
  }
  return out
}

const pct = (a: number, b: number) => b ? Math.round((1000 * a) / b) / 10 : null
function traitRow(id: string, t: Traits) {
  const L = t.latency.slice().sort((a, b) => a - b)
  return {
    id, label: label(id), hands: t.hands, decisions: t.decisions,
    vpip: pct(t.vpipHands, t.hands), pfr: pct(t.pfrHands, t.hands),
    shortStackShovePct: pct(t.shortShoves, t.shortSpots), shortSpots: t.shortSpots,
    foldToRiverBetPct: pct(t.foldedRiverBet, t.facedRiverBet),
    riverFoldsHoldingWinner: `${t.riverFoldsWinner}/${t.riverFoldsHU}`, riverFoldsHoldingWinnerPct: pct(t.riverFoldsWinner, t.riverFoldsHU),
    setClaimsWrong: `${t.setWrong}/${t.setClaims}`,
    talkRatePct: pct(t.talkLines, t.decisions),
    reasoningMentionsTalkPct: pct(t.reasoningTalk, t.reasoningN),
    reasoningMentionsHistoryPct: pct(t.reasoningHistory, t.reasoningN),
    reasoningMentionsPayoutsPct: pct(t.reasoningFormat, t.reasoningN),
    overbetPctOfPostflopBets: pct(t.overbets, t.postflopBets), raiseToPct: pct(t.raiseTo, t.decisions),
    usdPerDecision: t.decisions ? Math.round((t.usd / t.decisions) * 1e5) / 1e5 : null, usd: Math.round(t.usd * 1000) / 1000,
    meanLatencyS: L.length ? Math.round(L.reduce((a, b) => a + b, 0) / L.length / 100) / 10 : null,
    p95LatencyS: L.length ? Math.round(L[Math.floor(0.95 * (L.length - 1))]! / 100) / 10 : null,
    fallbacks: t.fallbacks
  }
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true })
const v1 = load('20261010_main')!
const guests = [['openai/gpt-6-sol', '20261011_v2A_sol'], ['anthropic/claude-opus-5.5', '20261011_v2A_opus'], ['anthropic/claude-fable-5.1', '20261011_v2A_fable']] as const
const tables = guests.map(([g, slug]) => ({ guest: g, slug, run: load(slug) })).filter(x => x.run?.start)
const lines: string[] = []
const say = (s = '') => {
  lines.push(s)
  console.log(s)
}

// Study A: per table, then guests paired by rotation across tables.
const tableStandings = tables.map(t => ({ guest: t.guest, slug: t.slug, ...standings(t.run!) }))
for (const t of tableStandings) {
  say(`\n## ${t.slug} (${t.tournaments} tournaments, interval unit: ${t.unit})`)
  for (const r of t.rows) say(`  ${r.label.padEnd(22)} prize ${r.prize.value}% [${r.prize.lo}, ${r.prize.hi}]  bb/100 ${r.bb100.value} [${r.bb100.lo}, ${r.bb100.hi}] (pooled ${r.bb100Pooled})  finish ${r.avgFinish}  wins ${r.wins}  hands ${r.hands}`)
}
const rot = (t: typeof tableStandings[number]) => new Map(t.units.map(u => [u.key, u]))
const guestPairs: object[] = []
for (let i = 0; i < tableStandings.length; i++) {
  for (let j = i + 1; j < tableStandings.length; j++) {
    const A = tableStandings[i]!, B = tableStandings[j]!
    const ua = rot(A), ub = rot(B)
    const keys = [...ua.keys()].filter(k => ub.has(k))
    // Paired bootstrap over rotations: the same resampled rotations on both tables, pooled rates.
    const pairBoot = (() => {
      const n = keys.length
      if (n < 2) return { value: null, lo: null, hi: null, n }
      const diff = (ks: string[]) => bb100(ks.map(k => ua.get(k)!), A.guest) - bb100(ks.map(k => ub.get(k)!), B.guest)
      let seed = 777
      const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32)
      const draws = Array.from({ length: 4000 }, () => diff(Array.from({ length: n }, () => keys[Math.floor(rnd() * n)]!))).sort((x, y) => x - y)
      return { value: diff(keys), lo: draws[100]!, hi: draws[3899]!, n }
    })()
    const dPrize = keys.map(k => (ua.get(k)!.prize[A.guest] ?? 0) - (ub.get(k)!.prize[B.guest] ?? 0))
    const row = { a: label(A.guest), b: label(B.guest), pairedTournaments: keys.length, bb100: iv(pairBoot), prize: iv(tInterval(dPrize)) }
    guestPairs.push(row)
    say(`  guest ${row.a} − ${row.b}: bb/100 ${row.bb100.value} [${row.bb100.lo}, ${row.bb100.hi}], prize ${row.prize.value} pts [${row.prize.lo}, ${row.prize.hi}] over ${keys.length} paired tournaments`)
  }
}
// The cheap field pooled over the three tables (units = table × rotation).
const field = ['anthropic/claude-haiku-5.5', 'openai/gpt-6-luna', 'openai/gpt-6-luna-decisions', 'typesafe-ai/jev']
const allUnits = tableStandings.flatMap(t => t.units)
const fieldRows = [...tables.map(t => t.guest), ...field].map((p) => {
  const us = allUnits.filter(u => u.hands[p])
  return { player: p, label: label(p), tournaments: us.length, prize: iv(tInterval(us.map(u => u.prize[p] ?? 0))), bb100: iv(ratioBoot(us.map(u => grp([u], p)))), bb100Pooled: r1(bb100(us, p)), avgFinish: r1(us.reduce((a, u) => a + (u.place[p] ?? 0), 0) / Math.max(us.length, 1)), wins: us.filter(u => u.place[p] === 1).length }
}).sort((a, b) => (b.prize.value ?? 0) - (a.prize.value ?? 0))
say('\n## Study A pooled (guests: their own table; field: all tables)')
for (const r of fieldRows) say(`  ${r.label.padEnd(22)} prize ${r.prize.value}% [${r.prize.lo}, ${r.prize.hi}]  bb/100 ${r.bb100.value} [${r.bb100.lo}, ${r.bb100.hi}] (pooled ${r.bb100Pooled})  finish ${r.avgFinish}  wins ${r.wins}/${r.tournaments}`)

// v1 → v2 behaviour, same definitions.
const v1Traits = traits([v1], s => s.modelId ?? '')
const v2Traits = traits(tables.map(t => t.run!), s => s.modelId ?? '')
const styleRows = Object.keys({ ...v1Traits, ...v2Traits }).map(id => ({ id, label: label(id), v1: v1Traits[id] ? traitRow(id, v1Traits[id]!) : null, v2: v2Traits[id] ? traitRow(id, v2Traits[id]!) : null }))
say('\n## v1 → v2 behaviour (same definitions)')
for (const r of styleRows) {
  for (const [k, x] of [['v1', r.v1], ['v2', r.v2]] as const) {
    if (!x) continue
    say(`  ${k} ${r.label.padEnd(22)} VPIP ${x.vpip} PFR ${x.pfr} short-shove ${x.shortStackShovePct}% (${x.shortSpots}) foldRiverBet ${x.foldToRiverBetPct}% riverFoldWinner ${x.riverFoldsHoldingWinner} sets ${x.setClaimsWrong} talk ${x.talkRatePct}% rTalk ${x.reasoningMentionsTalkPct}% rHist ${x.reasoningMentionsHistoryPct}% rPay ${x.reasoningMentionsPayoutsPct}% overbet ${x.overbetPctOfPostflopBets}% raise_to ${x.raiseToPct}% $${x.usdPerDecision}/dec ${x.meanLatencyS}s p95 ${x.p95LatencyS}s fb ${x.fallbacks}`)
  }
}

// v1 m01 vs v2 Sol table m01: the same decks, the same lineup and seat order.
const solTable = tables.find(t => t.guest === 'openai/gpt-6-sol')?.run
let sameDecks: object | null = null
if (solTable) {
  const v1m01 = { ...v1, hands: v1.hands.filter(h => h.matchId === 'm01'), tournaments: v1.tournaments.filter(t => t.matchId === 'm01') }
  const a = standings(v1m01 as ParsedRun)
  const b = standings(solTable)
  sameDecks = { note: 'v1 B3 match m01 vs v2 Sol table m01: identical decks, lineup and seat order; v1 capped at 50 hands', v1: a.rows.map(r => ({ label: r.label, bb100: r.bb100Pooled, avgFinish: r.avgFinish, wins: r.wins })), v2: b.rows.map(r => ({ label: r.label, bb100: r.bb100Pooled, avgFinish: r.avgFinish, wins: r.wins })), v1Hands: v1m01.tournaments.map(t => t.hands), v2Hands: solTable.tournaments.map(t => t.hands) }
  say(`\n## same decks (v1 m01 vs v2 Sol table): ${JSON.stringify(sameDecks)}`)
}

// Study B: persona table(s).
const personaSlug = process.argv[2] ?? null
let personaOut: object | null = null
const pRun = personaSlug ? load(personaSlug) : null
if (pRun?.start) {
  const st = standings(pRun)
  const us = st.units
  const byMatch = new Map<string, Unit[]>()
  for (const u of us) (byMatch.get(u.key.split('|')[0]!) ?? byMatch.set(u.key.split('|')[0]!, []).get(u.key.split('|')[0]!)!).push(u)
  const complete = [...byMatch.values()].filter(m => m.length === pRun.start!.lineup.length)
  const leadUnits = complete.length >= 3 ? complete : us.map(u => [u])
  const leads = pRun.start.lineup.filter(p => p !== 'control').map(p => ({
    persona: p,
    vsControlBb100: iv(tInterval(leadUnits.map(g => bb100(g, p) - bb100(g, 'control')))),
    vsControlPrize: iv(tInterval(leadUnits.map(g => g.reduce((a, u) => a + (u.prize[p] ?? 0) - (u.prize.control ?? 0), 0) / g.length)))
  }))
  const pTraits = traits([pRun], s => s.playerId ?? s.modelId ?? '')
  personaOut = { slug: personaSlug, base: pRun.start.players?.[0]?.modelId, unit: complete.length >= 3 ? 'match' : 'tournament', completeMatches: complete.length, tournaments: us.length, standings: st.rows, leadsVsControl: leads, styles: Object.entries(pTraits).map(([id, t]) => ({ ...traitRow(id, t), label: id })) }
  say(`\n## personas ${personaSlug} (${us.length} tournaments, ${complete.length} complete matches)`)
  for (const r of st.rows) say(`  ${r.player.padEnd(12)} prize ${r.prize.value}% [${r.prize.lo}, ${r.prize.hi}]  bb/100 ${r.bb100.value} [${r.bb100.lo}, ${r.bb100.hi}]  finish ${r.avgFinish} wins ${r.wins}`)
  for (const l of leads) say(`  ${l.persona.padEnd(12)} vs control: bb/100 ${l.vsControlBb100.value} [${l.vsControlBb100.lo}, ${l.vsControlBb100.hi}], prize ${l.vsControlPrize.value} [${l.vsControlPrize.lo}, ${l.vsControlPrize.hi}]`)
  for (const s of personaOut.styles as ReturnType<typeof traitRow>[]) say(`  ${s.id.padEnd(12)} VPIP ${s.vpip} PFR ${s.pfr} shove ${s.shortStackShovePct}% foldRiver ${s.foldToRiverBetPct}% talk ${s.talkRatePct}% rHist ${s.reasoningMentionsHistoryPct}% overbet ${s.overbetPctOfPostflopBets}% $${s.usdPerDecision}`)
}

writeFileSync(join(OUT, 'standings.json'), `${JSON.stringify({ generated: new Date().toISOString(), design: 'guest-seat duplicate: three 5-max tables [guest, Haiku, Luna, Luna Decisions, Jev], one shared seed (20261010, = v1 m01 decks), 5 rotations each; prize share uses payouts 50/30/20; intervals are t-intervals over tournaments (n=5 per table) or matches', perTable: tableStandings.map(t => ({ guest: label(t.guest), slug: t.slug, tournaments: t.tournaments, unit: t.unit, rows: t.rows })), pooled: fieldRows, guestPairs, sameDecks }, null, 2)}\n`)
writeFileSync(join(OUT, 'styles_raw.json'), `${JSON.stringify(styleRows, null, 2)}\n`)
if (personaOut) writeFileSync(join(OUT, 'personas_raw.json'), `${JSON.stringify(personaOut, null, 2)}\n`)
writeFileSync(join(OUT, 'summary.txt'), `${lines.join('\n')}\n`)
