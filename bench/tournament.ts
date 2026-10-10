/**
 * Duplicate-seeded tournaments, headless: the engine + decide() directly, many tournaments at once.
 *
 *   node --env-file=.env bench/tournament.ts --lineup typesafe-ai/jev,openai/gpt-6-luna-decisions,... \
 *     --matches 10 --budget 5 --concurrency 6 --slug 20261010_main
 *   ... --dry-run      cost estimate only (simulated play × measured $/decision), no gateway calls
 *   ... --fake         full run with seeded random deciders, $0 (pipeline, resume and /results tests)
 *   ... --scout        after the run, one scouting report for the lineup (~$0.05)
 *
 * A match is one deck seed replayed once per seat rotation (shared/utils/duplicate.ts). Output is
 * data/runs/<slug>.jsonl: run_start, one `hand` line per hand (god view + every SeatView and
 * Decision), one `tournament` line per finished tournament, run_end per invocation. Schema:
 * shared/utils/runs.ts and AGENTS.md § Batch runs.
 *
 * Resumable and idempotent: every live decision is appended to <slug>.cache.jsonl the moment it
 * lands. A rerun skips finished (seed, rotation) pairs and replays cached decisions for unfinished
 * ones, so a rerun of a finished run costs $0 and a killed run loses at most the in-flight calls.
 * Raising --matches on the same slug extends the run with new seeds.
 *
 * Watchdogs: decide() bounds each call at 30 s of awake time; on top, each decision has a 45 s
 * wall-clock watchdog and each hand a 5 min one (a stuck hand abandons its tournament for this
 * invocation; a rerun picks it up). Run long batches under `caffeinate -ims` so the Mac stays awake.
 *
 * The runner itself lives in bench/runner.ts (shared with the B4 lab, bench/lab.ts).
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { scoutingReport } from '../server/utils/narrate.ts'
import { findModel } from '../shared/utils/models.ts'
import { narratorCost, scoutingMarkdown } from '../shared/utils/narration.ts'
import type { NarrateHand } from '../shared/utils/narration.ts'
import { parseRun } from '../shared/utils/runs.ts'
import type { RunEndLine, RunHandLine, RunScoutingLine } from '../shared/utils/runs.ts'
import { SNG_TURBO } from '../shared/utils/tournament.ts'
import type { TournamentFormat } from '../shared/utils/tournament.ts'
import { estimateRun, openRun, plainPlayers, runPool } from './runner.ts'
import type { RunOptions, Spend } from './runner.ts'

const { values: args } = parseArgs({
  options: {
    'lineup': { type: 'string', default: 'typesafe-ai/jev,openai/gpt-6-luna-decisions,openai/gpt-6-luna,anthropic/claude-haiku-5.5' },
    'matches': { type: 'string', default: '1' },
    'format': { type: 'string', default: 'sng' },
    'hands': { type: 'string' },
    'budget': { type: 'string', default: '1' },
    'concurrency': { type: 'string', default: '4' },
    'slug': { type: 'string' },
    'seed': { type: 'string', default: '20261010' },
    'dry-run': { type: 'boolean', default: false },
    'fake': { type: 'boolean', default: false },
    'scout': { type: 'boolean', default: false },
    'decision-watchdog': { type: 'string', default: '45' },
    'hand-watchdog': { type: 'string', default: '300' },
    'fake-delay': { type: 'string', default: '0' }
  }
})

const lineup = args.lineup!.split(',').map(s => s.trim()).filter(Boolean)
for (const id of lineup) if (!findModel(id)) throw new Error(`Unknown model ${id}`)
if (new Set(lineup).size !== lineup.length) throw new Error('Each model once per lineup')
const format = args.format === 'cash' ? 'cash' : 'sng'
const matches = Number(args.matches)
const budget = Number(args.budget)
const concurrency = Math.max(1, Number(args.concurrency))
const fake = args.fake!

const tournamentFormat: TournamentFormat = format === 'cash'
  // Cash: fixed blinds, busted seats rebuy, a fixed number of hands per rotation.
  ? { stack: 2000, levels: [{ sb: 10, bb: 20, hands: 1e9 }], maxHands: Number(args.hands ?? 50) }
  : { ...SNG_TURBO, maxHands: Number(args.hands ?? SNG_TURBO.maxHands) }

const short = (id: string) => id.split('/').at(-1)!.replace(/^gpt-6-|^claude-|-preview$/g, '').replace(/[^a-z0-9.]+/gi, '-')
const today = new Date().toISOString().slice(0, 10).replaceAll('-', '')
const slug = args.slug ?? `${today}_${lineup.map(short).join('_')}`
const DIR = join(process.cwd(), 'data', 'runs')
const RUN_FILE = join(DIR, `${slug}.jsonl`)
const now = () => new Date().toISOString()
const base = { source: 'batch' as const, runId: slug }

if (!args['dry-run'] && !fake && !process.env.AI_GATEWAY_API_KEY) throw new Error('AI_GATEWAY_API_KEY missing — run with node --env-file=.env')

const opts: RunOptions = {
  dir: DIR, slug, players: plainPlayers(lineup), matches, baseSeed: Number(args.seed), format, tournament: tournamentFormat, fake,
  decisionWatchdogMs: Number(args['decision-watchdog']) * 1000, handWatchdogMs: Number(args['hand-watchdog']) * 1000, fakeDelayMs: Number(args['fake-delay'])
}

// ── scouting report for the lineup ───────────────────────────────────────────────────────────

async function scout() {
  const run = parseRun(readFileSync(RUN_FILE, 'utf8'))
  if (!run.tournaments.length) throw new Error('No finished tournaments to scout')
  // Sample: the finished tournament with the median hand count, listed in full; stats span every hand.
  const byLen = run.tournaments.slice().sort((a, b) => a.hands - b.hands)
  const sample = byLen[Math.floor(byLen.length / 2)]!
  const seatOfModel = new Map(sample.seats.map(s => [s.modelId, s.id]))
  const toNarrate = (h: RunHandLine, remap: boolean): NarrateHand => {
    const m = (id: string) => remap ? seatOfModel.get(h.seats.find(s => s.id === id)?.modelId ?? '') ?? id : id
    const keys = <T>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [m(k), v]))
    return {
      handNo: h.handNo, board: h.board, button: h.button,
      pots: h.result.pots.map(p => ({ ...p, eligible: p.eligible.map(m), winners: p.winners.map(m) })),
      shown: keys(h.result.shown), deltas: keys(h.result.deltas), stacksAfter: keys(h.stacksAfter), holes: keys(h.holes),
      log: h.log.map(e => ({ ...e, seatId: m(e.seatId) })), actionLabels: h.actionLabels, blindsNote: h.blinds,
      decisions: h.decisions.map(d => ({ seatId: m(d.seatId), street: d.street, logIndex: d.logIndex, decision: d.decision }))
    }
  }
  const hands = run.hands.filter(h => h.tournamentId === sample.tournamentId).map(h => toNarrate(h, false))
  const statsHands = run.hands.map(h => toNarrate(h, true))
  console.log(`scouting: stats over ${statsHands.length} hands, sample ${sample.tournamentId} (${hands.length} hands)…`)
  const report = await scoutingReport({ seats: sample.seats, hands, statsHands })
  const nameOf = (id: string) => sample.seats.find(s => s.id === id)?.name ?? id
  const markdown = scoutingMarkdown(report, nameOf, `Scouting report: ${slug} (${run.tournaments.length} tournaments; hand numbers from ${sample.tournamentId})`)
  const line: RunScoutingLine = { type: 'scouting_report', ...base, ts: now(), sampleTournamentId: sample.tournamentId, report, markdown }
  appendFileSync(RUN_FILE, `${JSON.stringify(line)}\n`)
  writeFileSync(join(DIR, `${slug}_scouting.md`), markdown)
  console.log(`scouting report written ($${narratorCost([report]).toFixed(4)}) → data/runs/${slug}_scouting.md`)
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────

const est = await estimateRun(opts)
console.log(`  budget $${budget}`)
if (args['dry-run']) process.exit(0)

const run = openRun(opts)
const { priorSpend } = run
console.log(`\n── ${fake ? 'FAKE ' : ''}run ${slug}: ${run.plan.length - run.pending.length}/${run.plan.length} tournaments already done, ${run.cachedDecisions} cached decisions, $${priorSpend.toFixed(3)} spent by earlier invocations, concurrency ${concurrency}, budget $${budget} for the whole run`)
if (priorSpend + est.perHand * est.handsPerMatch * run.pending.length / lineup.length > budget && !fake) console.log(`  note: the estimate is over the budget; the run halts cleanly at $${budget} and resumes later`)

const spend: Spend = { spent: priorSpend, cap: budget, halted: false, live: 0, replayed: 0 }
const inFlight = new Map<string, number>()
let interrupted = false
const stop = () => {
  if (interrupted) process.exit(130)
  interrupted = true
  spend.halted = true
  console.log('\ninterrupt: finishing in-flight calls, then stopping (Ctrl-C again to quit now)')
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
const heartbeat = setInterval(() => {
  const live = [...inFlight.entries()].map(([id, h]) => `${id.split('/').at(-1)}#${h}`).join(' ')
  console.log(`  … $${(spend.spent - priorSpend).toFixed(3)} live this invocation, $${spend.spent.toFixed(3)} run total · ${spend.live} live / ${spend.replayed} replayed decisions · in flight: ${live || '—'}`)
}, 60_000)

const { failures } = await runPool(run.pending.map(t => ({ label: t.tournamentId, run: () => run.play(t, spend, inFlight) })), concurrency, () => spend.halted)
clearInterval(heartbeat)

const status: RunEndLine['status'] = interrupted ? 'interrupted' : spend.halted ? 'budget' : failures ? 'errors' : 'complete'
const end = run.end(status)
console.log(`\n══ ${status}: ${end.tournamentsDone}/${run.plan.length} tournaments · live spend this invocation $${end.spentUsd.toFixed(4)} (run total $${end.totalSpentUsd.toFixed(4)}) (${spend.live} live, ${spend.replayed} replayed decisions) → data/runs/${slug}.jsonl`)
if (status === 'budget') console.log(`  budget reached; rerun with a higher --budget to continue`)

if (args.scout && status === 'complete') await scout()
