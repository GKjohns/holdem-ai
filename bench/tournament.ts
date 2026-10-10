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
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { decide, INSTRUCTIONS, renderPrompt, tableState } from '../server/utils/decide.ts'
import { scoutingReport } from '../server/utils/narrate.ts'
import { schedule } from '../shared/utils/duplicate.ts'
import type { ScheduledTournament } from '../shared/utils/duplicate.ts'
import { buildMenu } from '../shared/utils/menu.ts'
import { findModel } from '../shared/utils/models.ts'
import { narratorCost, scoutingMarkdown } from '../shared/utils/narration.ts'
import type { NarrateHand } from '../shared/utils/narration.ts'
import { costUsd, PRICING } from '../shared/utils/pricing.ts'
import { seededRng } from '../shared/utils/rng.ts'
import { parseRun } from '../shared/utils/runs.ts'
import type { RunDecisionRecord, RunEndLine, RunHandLine, RunScoutingLine, RunSeat, RunStartLine, TournamentLine } from '../shared/utils/runs.ts'
import { applyAction, newTable, seatView, startHand, withTableTalk } from '../shared/utils/table.ts'
import { SNG_TURBO, bustsThisHand, survivorsPlaced, withLevel } from '../shared/utils/tournament.ts'
import type { Finish, TournamentFormat } from '../shared/utils/tournament.ts'
import type { Decision, SeatView, TableState } from '../shared/utils/types.ts'

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
if (lineup.length < 2 || lineup.length > 6) throw new Error('2–6 models')
if (new Set(lineup).size !== lineup.length) throw new Error('Each model once per lineup')
const format = args.format === 'cash' ? 'cash' : 'sng'
const matches = Number(args.matches)
const budget = Number(args.budget)
const concurrency = Math.max(1, Number(args.concurrency))
const baseSeed = Number(args.seed)
const fake = args.fake!
const DECISION_WATCHDOG_MS = Number(args['decision-watchdog']) * 1000
const HAND_WATCHDOG_MS = Number(args['hand-watchdog']) * 1000
const FAKE_DELAY_MS = Number(args['fake-delay'])

const tournamentFormat: TournamentFormat = format === 'cash'
  // Cash: fixed blinds, busted seats rebuy, a fixed number of hands per rotation.
  ? { stack: 2000, levels: [{ sb: 10, bb: 20, hands: 1e9 }], maxHands: Number(args.hands ?? 50) }
  : { ...SNG_TURBO, maxHands: Number(args.hands ?? SNG_TURBO.maxHands) }

const short = (id: string) => id.split('/').at(-1)!.replace(/^gpt-6-|^claude-|-preview$/g, '').replace(/[^a-z0-9.]+/gi, '-')
const today = new Date().toISOString().slice(0, 10).replaceAll('-', '')
const slug = args.slug ?? `${today}_${lineup.map(short).join('_')}`
if (!/^[\w.-]{3,120}$/.test(slug)) throw new Error('Bad slug')
const DIR = join(process.cwd(), 'data', 'runs')
const RUN_FILE = join(DIR, `${slug}.jsonl`)
const CACHE_FILE = join(DIR, `${slug}.cache.jsonl`)

if (!args['dry-run'] && !fake && !process.env.AI_GATEWAY_API_KEY) throw new Error('AI_GATEWAY_API_KEY missing — run with node --env-file=.env')

const plan = schedule(lineup, matches, baseSeed)
const now = () => new Date().toISOString()
const base = { source: 'batch' as const, runId: slug }

// ── random deciders (fake runs and the dry-run estimate) ──────────────────────────────────────

/** Passive-leaning random play, seeded per decision so a fake run replays identically. */
function randomDecision(modelId: string, view: SeatView, key: string): Decision {
  const rng = seededRng(Number.parseInt(createHash('sha1').update(key).digest('hex').slice(0, 8), 16))
  const menu = buildMenu(view)
  const passive = menu.find(o => o.id === 'check') ?? menu.find(o => o.id === 'call')!
  const raises = menu.filter(o => o.action.type === 'raise' || o.action.type === 'all_in')
  const r = rng()
  const pick = r < 0.6 || !raises.length
    ? (r < 0.45 || !menu.some(o => o.id === 'fold') ? passive : menu.find(o => o.id === 'fold')!)
    : raises[Math.floor(rng() * raises.length)]!
  return { menuId: pick.id, action: pick.action, reasoning: 'fake (random) decision', fallback: false, model: modelId, latencyMs: 0, usage: { input: 0, output: 0 } }
}

// ── cost estimate: simulated decisions × measured $/decision ──────────────────────────────────

/**
 * Decisions per seated hand per model, from real (non-fake) batch runs: random play busts seats
 * far faster than models do, so the simulation undercounts decisions (the 5-seat estimate came out
 * at a third of real play). Used instead of the simulated count when a model has ≥ 50 seated hands.
 */
function measuredDecisionsPerHand(): Record<string, { perHand: number, hands: number }> {
  const acc: Record<string, { d: number, h: number }> = {}
  if (!existsSync(DIR)) return {}
  for (const f of readdirSync(DIR).filter(f => f.endsWith('.jsonl') && !f.endsWith('.cache.jsonl'))) {
    const run = parseRun(readFileSync(join(DIR, f), 'utf8'))
    if (!run.start || run.start.fake) continue
    for (const h of [...run.hands, ...run.partialHands]) {
      for (const s of h.seats) {
        if (!(h.stacksBefore[s.id]! > 0)) continue
        const a = acc[s.modelId] ??= { d: 0, h: 0 }
        a.h++
        a.d += h.decisions.filter(d => d.seatId === s.id).length
      }
    }
  }
  return Object.fromEntries(Object.entries(acc).filter(([, a]) => a.h >= 50).map(([m, a]) => [m, { perHand: a.d / a.h, hands: a.h }]))
}

/** Mean $/decision per model from every real decision already on disk (sessions + runs). */
function measuredCostPerDecision(): Record<string, { usd: number, n: number }> {
  const sums: Record<string, { usd: number, n: number }> = {}
  const scan = (dir: string) => {
    if (!existsSync(dir)) return
    for (const f of readdirSync(dir).filter(f => f.endsWith('.jsonl') && !f.endsWith('.cache.jsonl'))) {
      for (const raw of readFileSync(join(dir, f), 'utf8').split('\n')) {
        if (!raw.includes('"type":"hand"')) continue
        try {
          const l = JSON.parse(raw)
          for (const d of l.decisions ?? []) {
            const dec = d.decision as Decision
            if (dec.fallback || !(dec.usage.input || dec.usage.output)) continue
            const s = sums[dec.model] ??= { usd: 0, n: 0 }
            s.usd += costUsd(dec.model, dec.usage)
            s.n++
          }
        } catch { /* partial line */ }
      }
    }
  }
  scan(join(process.cwd(), 'data', 'sessions'))
  scan(DIR)
  return Object.fromEntries(Object.entries(sums).map(([m, s]) => [m, { usd: s.usd / s.n, n: s.n }]))
}

/** Fallback when a model has no history: chars/4 tokens (scaled as in selfplay.ts) × pricing. */
function tokenEstimate(modelId: string, view: SeatView): number {
  const kind = findModel(modelId)!.kind
  const menu = buildMenu(view)
  const chars = kind === 'llm'
    ? INSTRUCTIONS.length + renderPrompt(view, menu).length
    : JSON.stringify(tableState(view)).length + JSON.stringify(menu.map(o => o.describe)).length
  const scale = kind === 'llm' ? 1.3 : modelId === 'typesafe-ai/jev' ? 3.1 : 1.9
  return costUsd(modelId, { input: Math.ceil(chars / 4 * scale), output: kind === 'llm' ? 250 : 0 })
}

// ── one tournament ────────────────────────────────────────────────────────────────────────────

interface CacheEntry { viewHash: string, decision: Decision }
const viewHash = (v: SeatView) => createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 16)
const cacheKey = (tournamentId: string, handNo: number, logIndex: number) => `${tournamentId}|${handNo}|${logIndex}`

class Halt extends Error {}
class HandStuck extends Error {}

interface Ctx {
  spent: number
  live: number
  replayed: number
  halted: boolean
  cache: Map<string, CacheEntry>
  /** Dry-run: count decisions per model and estimated cost instead of writing anything. */
  estimate?: { decisions: Record<string, number>, usd: Record<string, number>, hands: number }
  write: (line: object) => void
  inFlight: Map<string, number>
}

const PRIOR_TALK_MAX = 6

/** A wall-clock watchdog over decide(): its own deadline is awake time, this one is a backstop. */
async function watchedDecide(modelId: string, view: SeatView, handSignal: AbortSignal): Promise<Decision> {
  const ctrl = new AbortController()
  const onHand = () => ctrl.abort(handSignal.reason)
  handSignal.addEventListener('abort', onHand, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const started = Date.now()
  const backstop = new Promise<Decision>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort(new Error('watchdog'))
      const menu = buildMenu(view)
      const pick = menu.find(o => o.id === 'check') ?? menu.find(o => o.id === 'fold')!
      resolve({ menuId: pick.id, action: pick.action, reasoning: `Watchdog: no answer in ${DECISION_WATCHDOG_MS / 1000} s — auto-${pick.id === 'check' ? 'checked' : 'folded'}.`, fallback: true, model: modelId, latencyMs: Date.now() - started, usage: { input: 0, output: 0 } })
    }, DECISION_WATCHDOG_MS)
  })
  try {
    return await Promise.race([decide({ modelId, view, signal: ctrl.signal }), backstop])
  } finally {
    clearTimeout(timer)
    handSignal.removeEventListener('abort', onHand)
  }
}

async function playTournament(t: ScheduledTournament, ctx: Ctx): Promise<void> {
  const started = Date.now()
  const seats: RunSeat[] = t.seats.map((modelId, i) => ({ id: `seat-${i + 1}`, name: findModel(modelId)!.label, modelId }))
  const modelOf = new Map(seats.map(s => [s.id, s.modelId]))
  let state: TableState = newTable({ players: seats, stacks: tournamentFormat.stack, smallBlind: 1, bigBlind: 2 }, t.seed)
  const talk = new Map<string, string[]>()
  const finishes: Finish[] = []
  let rebuys = 0
  let engineErrors = 0
  let chipsConserved = true
  let decisions = 0, fallbacks = 0, retried = 0, cost = 0
  const live = () => state.seats.filter(s => s.stack > 0).length

  while (live() >= 2 && state.handNo < tournamentFormat.maxHands) {
    if (format === 'cash') {
      for (const s of state.seats) {
        if (s.stack <= 0) {
          s.stack = tournamentFormat.stack
          rebuys++
        }
      }
    }
    const leveled = withLevel(state, tournamentFormat.levels)
    const stacksBefore = Object.fromEntries(leveled.state.seats.map(s => [s.id, s.stack]))
    state = startHand(leveled.state)
    ctx.inFlight.set(t.tournamentId, state.handNo)
    const blinds = state.seats.filter(s => s.lastAction?.startsWith('posts')).map(s => `${s.name} ${s.lastAction}`).join(' · ')
    const actionLabels: string[] = []
    const records: RunDecisionRecord[] = []
    let handErrors = 0
    const handCtrl = new AbortController()
    const handTimer = setTimeout(() => handCtrl.abort(new HandStuck('hand watchdog')), HAND_WATCHDOG_MS)
    try {
      while (state.toAct !== null && state.street !== 'complete') {
        if (ctx.halted) throw new Halt()
        const seat = state.seats[state.toAct]!
        const modelId = seat.modelId!
        const prior = (talk.get(seat.id) ?? []).slice(-PRIOR_TALK_MAX)
        const view: SeatView = { ...seatView(state, seat.id), ...(prior.length ? { priorTableTalk: prior } : {}) }
        const logIndex = state.log.length
        const key = cacheKey(t.tournamentId, state.handNo, logIndex)
        const hash = viewHash(view)
        let decision: Decision
        const cached = ctx.cache.get(key)
        if (cached && cached.viewHash === hash) {
          decision = cached.decision
          ctx.replayed++
        } else if (ctx.estimate) {
          decision = randomDecision(modelId, view, `${key}|${hash}`)
          ctx.estimate.decisions[modelId] = (ctx.estimate.decisions[modelId] ?? 0) + 1
          ctx.estimate.usd[modelId] = (ctx.estimate.usd[modelId] ?? 0) + (estimateCost[modelId] ?? tokenEstimate(modelId, view))
        } else {
          if (cached) console.warn(`  ! ${key}: cached view differs, asking live`)
          if (ctx.spent >= budget) {
            ctx.halted = true
            throw new Halt()
          }
          if (fake) {
            // Fake runs go through the same cache path as live ones, so kill/resume is testable for $0.
            if (FAKE_DELAY_MS) await new Promise(r => setTimeout(r, FAKE_DELAY_MS))
            decision = randomDecision(modelId, view, `${key}|${hash}`)
          } else {
            decision = await watchedDecide(modelId, view, handCtrl.signal)
          }
          if (handCtrl.signal.aborted) throw handCtrl.signal.reason
          ctx.spent += costUsd(modelId, decision.usage)
          ctx.live++
          ctx.cache.set(key, { viewHash: hash, decision })
          appendFileSync(CACHE_FILE, `${JSON.stringify({ key, viewHash: hash, decision })}\n`)
        }
        decisions++
        cost += costUsd(modelId, decision.usage)
        if (decision.fallback) fallbacks++
        if (decision.retried) retried++
        try {
          state = applyAction(state, seat.id, decision.action)
          if (decision.tableTalk) state = withTableTalk(state, seat.id, decision.tableTalk)
        } catch (err) {
          handErrors++
          console.error(`  ! ${t.tournamentId} #${state.handNo} engine rejected ${seat.name} ${JSON.stringify(decision.action)}: ${(err as Error).message}`)
          const menu = buildMenu(view)
          state = applyAction(state, seat.id, (menu.find(o => o.id === 'check') ?? menu.find(o => o.id === 'fold')!).action)
        }
        if (decision.tableTalk) {
          const lines = talk.get(seat.id) ?? []
          if (!lines.includes(decision.tableTalk)) talk.set(seat.id, [...lines, decision.tableTalk])
        }
        actionLabels.push(state.seats.find(s => s.id === seat.id)!.lastAction ?? decision.action.type)
        records.push({ handNo: state.handNo, seatId: seat.id, street: view.street, logIndex, view, decision })
      }
    } finally {
      clearTimeout(handTimer)
    }
    engineErrors += handErrors
    const stacksAfter = Object.fromEntries(state.seats.map(s => [s.id, s.stack]))
    const total = state.seats.reduce((n, s) => n + s.stack, 0)
    if (total !== tournamentFormat.stack * (seats.length + rebuys)) {
      chipsConserved = false
      engineErrors++
      console.error(`  ! ${t.tournamentId} #${state.handNo} chips not conserved: ${total}`)
    }
    const busts = format === 'sng' ? bustsThisHand(stacksBefore, stacksAfter, live(), state.handNo) : []
    finishes.push(...busts)
    if (ctx.estimate) {
      ctx.estimate.hands++
      continue
    }
    const line: RunHandLine = {
      type: 'hand', ...base, ts: now(), sessionId: t.tournamentId, mode: 'batch',
      matchId: t.matchId, tournamentId: t.tournamentId, rotation: t.rotation, seed: t.seed,
      handNo: state.handNo, level: leveled.level, smallBlind: state.smallBlind, bigBlind: state.bigBlind,
      button: state.button, seats, holes: Object.fromEntries(state.seats.map(s => [s.id, s.hole.slice()])),
      board: state.board.slice(), blinds, log: state.log, actionLabels, decisions: records,
      result: state.result!, stacksBefore, stacksAfter, busts,
      ...(handErrors ? { engineErrors: handErrors } : {})
    }
    ctx.write(line)
  }
  ctx.inFlight.delete(t.tournamentId)
  if (ctx.estimate) return

  const final = Object.fromEntries(state.seats.map(s => [s.id, s.stack]))
  const placed = format === 'sng'
    ? [...survivorsPlaced(final), ...finishes]
    : survivorsPlaced(Object.fromEntries(state.seats.map(s => [s.id, s.stack + 1])))
  const finish = placed
    .sort((a, b) => a.place - b.place)
    .map(f => ({ ...f, modelId: modelOf.get(f.seatId)!, name: seats.find(s => s.id === f.seatId)!.name }))
  const line: TournamentLine = {
    type: 'tournament', ...base, ts: now(), sessionId: t.tournamentId, matchId: t.matchId, tournamentId: t.tournamentId,
    rotation: t.rotation, seed: t.seed, seats, hands: state.handNo,
    reason: live() >= 2 ? 'hand_cap' : 'finished', finish,
    costUsd: cost, decisions, fallbacks, retried, engineErrors, chipsConserved, wallMs: Date.now() - started
  }
  ctx.write(line)
  const winner = finish[0]!
  console.log(`✓ ${t.tournamentId} ${String(state.handNo).padStart(3)} hands · 1st ${winner.name} · $${cost.toFixed(3)} · fallbacks ${fallbacks}/${decisions} · run spend $${ctx.spent.toFixed(3)} of $${budget}`)
}

// ── estimate ─────────────────────────────────────────────────────────────────────────────────

const measured = measuredCostPerDecision()
const estimateCost: Record<string, number> = Object.fromEntries(lineup.filter(m => (measured[m]?.n ?? 0) >= 10).map(m => [m, measured[m]!.usd]))

async function estimate() {
  const ctx: Ctx = { spent: 0, live: 0, replayed: 0, halted: false, cache: new Map(), estimate: { decisions: {}, usd: {}, hands: 0 }, write: () => {}, inFlight: new Map() }
  for (const t of plan.filter(x => x.matchIndex === 0)) await playTournament(t, ctx)
  const e = ctx.estimate!
  const real = measuredDecisionsPerHand()
  // Per model: decisions/hand from real runs when known (assumes it's seated every hand, a slight
  // overestimate late in a tournament), else the random simulation's count.
  let perHand = 0
  console.log(`\n── Estimate (match 1 simulated with random passive-leaning play: ${e.hands} hands)`)
  for (const m of lineup) {
    const simPerHand = (e.decisions[m] ?? 0) / e.hands
    const dph = real[m]?.perHand ?? simPerHand
    const usdPerDecision = (e.usd[m] ?? 0) / Math.max(e.decisions[m] ?? 0, 1)
    perHand += dph * usdPerDecision
    const src = estimateCost[m] !== undefined ? `measured $${estimateCost[m]!.toFixed(5)}/decision (n=${measured[m]!.n})` : `token estimate (no history; $${PRICING[m]?.input}/$${PRICING[m]?.output} per 1M)`
    const dsrc = real[m] ? `measured over ${real[m]!.hands} seated hands` : 'simulated'
    console.log(`  ${m.padEnd(32)} ${dph.toFixed(2)} decisions/hand (${dsrc}) · ${src}`)
  }
  // Hands per match: random play ends tournaments early, so use real tournament lengths when known.
  const realT = existsSync(DIR)
    ? readdirSync(DIR).filter(f => f.endsWith('.jsonl') && !f.endsWith('.cache.jsonl'))
        .map(f => parseRun(readFileSync(join(DIR, f), 'utf8'))).filter(r => r.start && !r.start.fake && r.start.lineup.length === lineup.length)
        .flatMap(r => r.tournaments.filter(t => t.reason === 'finished').map(t => t.hands))
    : []
  const handsPerT = realT.length >= 3 ? realT.reduce((a, b) => a + b, 0) / realT.length : tournamentFormat.maxHands
  const handsPerMatch = Math.min(handsPerT, tournamentFormat.maxHands) * lineup.length
  console.log(`  hands/tournament: ${realT.length >= 3 ? `measured ${handsPerT.toFixed(0)} (n=${realT.length})` : `assumed the cap, ${tournamentFormat.maxHands}`}`)
  console.log(`  ≈ $${perHand.toFixed(4)}/hand · ≈ $${(perHand * handsPerMatch).toFixed(2)}/match (${lineup.length} tournaments) · ${matches} matches ≈ $${(perHand * handsPerMatch * matches).toFixed(2)} · budget $${budget}`)
  return { perHand, handsPerMatch }
}

// ── resume: compact the run file, load the decision cache ────────────────────────────────────

/**
 * `priorSpend` is every live call this run has ever made (each cache line is one paid call, even
 * ones later superseded), so --budget caps the run's total across invocations, not each invocation.
 */
function loadAndCompact(): { done: Set<string>, cache: Map<string, CacheEntry>, priorSpend: number } {
  mkdirSync(DIR, { recursive: true })
  const cache = new Map<string, CacheEntry>()
  let priorSpend = 0
  if (existsSync(CACHE_FILE)) {
    for (const raw of readFileSync(CACHE_FILE, 'utf8').split('\n')) {
      if (!raw.trim()) continue
      try {
        const e = JSON.parse(raw)
        cache.set(e.key, { viewHash: e.viewHash, decision: e.decision })
        priorSpend += costUsd(e.decision.model, e.decision.usage)
      } catch { /* half-written last line */ }
    }
  }
  const startLine: RunStartLine = { type: 'run_start', ...base, ts: now(), lineup, format, tournament: tournamentFormat, baseSeed, fake, narrator: false }
  if (!existsSync(RUN_FILE)) {
    writeFileSync(RUN_FILE, `${JSON.stringify(startLine)}\n`)
    return { done: new Set(), cache, priorSpend }
  }
  const text = readFileSync(RUN_FILE, 'utf8')
  const run = parseRun(text)
  const s = run.start
  if (!s) throw new Error(`${RUN_FILE} has no run_start`)
  const same = JSON.stringify([s.lineup, s.format, s.tournament, s.baseSeed, s.fake]) === JSON.stringify([lineup, format, tournamentFormat, baseSeed, fake])
  if (!same) throw new Error(`${RUN_FILE} was started with a different lineup/format/seed; use another --slug`)
  // Hands of unfinished tournaments are dropped and replayed from the cache, so a tournament's
  // hand lines are always one contiguous, complete set.
  const doneIds = new Set(run.tournaments.map(t => t.tournamentId))
  if (run.partialHands.length || run.badLines) {
    const kept = text.split('\n').filter((raw) => {
      if (!raw.trim()) return false
      try {
        const l = JSON.parse(raw)
        return l.type !== 'hand' || doneIds.has(l.tournamentId)
      } catch {
        return false
      }
    })
    writeFileSync(`${RUN_FILE}.tmp`, `${kept.join('\n')}\n`)
    renameSync(`${RUN_FILE}.tmp`, RUN_FILE)
    console.log(`resume: dropped ${run.partialHands.length} hand lines of unfinished tournaments (replayed from cache) and ${run.badLines} bad lines`)
  }
  return { done: doneIds, cache, priorSpend }
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

const est = await estimate()
if (args['dry-run']) process.exit(0)

const { done, cache, priorSpend } = loadAndCompact()
const pending = plan.filter(t => !done.has(t.tournamentId))
console.log(`\n── ${fake ? 'FAKE ' : ''}run ${slug}: ${plan.length - pending.length}/${plan.length} tournaments already done, ${cache.size} cached decisions, $${priorSpend.toFixed(3)} spent by earlier invocations, concurrency ${concurrency}, budget $${budget} for the whole run`)
if (priorSpend + est.perHand * est.handsPerMatch * pending.length / lineup.length > budget && !fake) console.log(`  note: the estimate is over the budget; the run halts cleanly at $${budget} and resumes later`)

const ctx: Ctx = {
  spent: priorSpend, live: 0, replayed: 0, halted: false, cache, inFlight: new Map(),
  write: line => appendFileSync(RUN_FILE, `${JSON.stringify(line)}\n`)
}
let interrupted = false
let failures = 0
const stop = () => {
  if (interrupted) process.exit(130)
  interrupted = true
  ctx.halted = true
  console.log('\ninterrupt: finishing in-flight calls, then stopping (Ctrl-C again to quit now)')
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
const heartbeat = setInterval(() => {
  const live = [...ctx.inFlight.entries()].map(([id, h]) => `${id}#${h}`).join(' ')
  console.log(`  … $${(ctx.spent - priorSpend).toFixed(3)} live this invocation, $${ctx.spent.toFixed(3)} run total · ${ctx.live} live / ${ctx.replayed} replayed decisions · in flight: ${live || '—'}`)
}, 60_000)

let next = 0
async function worker() {
  while (!ctx.halted && next < pending.length) {
    const t = pending[next++]!
    try {
      await playTournament(t, ctx)
    } catch (err) {
      ctx.inFlight.delete(t.tournamentId)
      if (err instanceof Halt) break
      failures++
      console.error(`✗ ${t.tournamentId} abandoned for this invocation (${(err as Error).message}); a rerun resumes it`)
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker))
clearInterval(heartbeat)

const finished = parseRun(readFileSync(RUN_FILE, 'utf8')).tournaments.length
const status: RunEndLine['status'] = interrupted ? 'interrupted' : ctx.halted ? 'budget' : failures ? 'errors' : 'complete'
const end: RunEndLine = {
  type: 'run_end', ...base, ts: now(), status, spentUsd: ctx.spent - priorSpend, totalSpentUsd: ctx.spent, liveDecisions: ctx.live, replayedDecisions: ctx.replayed,
  tournamentsDone: finished, tournamentsPlanned: plan.length
}
ctx.write(end)
console.log(`\n══ ${status}: ${finished}/${plan.length} tournaments · live spend this invocation $${(ctx.spent - priorSpend).toFixed(4)} (run total $${ctx.spent.toFixed(4)}) (${ctx.live} live, ${ctx.replayed} replayed decisions) → data/runs/${slug}.jsonl`)
if (status === 'budget') console.log(`  budget reached; rerun with a higher --budget to continue`)

if (args.scout && status === 'complete') await scout()
