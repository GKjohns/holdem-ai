/**
 * The duplicate-seeded tournament runner, shared by bench/tournament.ts (B3, one lineup) and
 * bench/lab.ts (B4, many lab tables at once through one pool and one budget).
 *
 * A run is one file `<dir>/<slug>.jsonl` (+ `<slug>.cache.jsonl`): run_start, one `hand` line per
 * hand (god view + every SeatView and Decision), one `tournament` line per finished tournament,
 * run_end per invocation. Schema: shared/utils/runs.ts and AGENTS.md § Batch runs.
 *
 * Resumable and idempotent: every live decision is appended to the cache the moment it lands. A
 * rerun skips finished (seed, rotation) pairs and replays cached decisions for unfinished ones, so
 * a rerun of a finished run costs $0. Raising `matches` on the same slug extends the run.
 *
 * Watchdogs: decide() bounds each call at 30 s of awake time; on top, each decision has a wall-clock
 * watchdog and each hand one too (a stuck hand abandons its tournament for this invocation; a rerun
 * picks it up). Run long batches under `caffeinate -ims` so the Mac stays awake.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { decide, renderPrompt, SNG_INSTRUCTIONS, tableState } from '../server/utils/decide.ts'
import { schedule } from '../shared/utils/duplicate.ts'
import type { ScheduledTournament } from '../shared/utils/duplicate.ts'
import { buildMenu } from '../shared/utils/menu.ts'
import { findModel } from '../shared/utils/models.ts'
import { costUsd, PRICING } from '../shared/utils/pricing.ts'
import { seededRng } from '../shared/utils/rng.ts'
import { parseRun } from '../shared/utils/runs.ts'
import type { RunDecisionRecord, RunEndLine, RunHandLine, RunPlayer, RunSeat, RunStartLine, TournamentLine } from '../shared/utils/runs.ts'
import { applyAction, newTable, pastHand, recentTalk, seatView, startHand, withMemory, withTableTalk } from '../shared/utils/table.ts'
import { bustsThisHand, sngFormat, survivorsPlaced, withLevel } from '../shared/utils/tournament.ts'
import type { Finish, TournamentFormat } from '../shared/utils/tournament.ts'
import type { Card, Decision, PastHand, SeatView, TableState } from '../shared/utils/types.ts'

/** Shared by every run in one process: `--budget` caps `spent`, which includes earlier invocations. */
export interface Spend { spent: number, cap: number, halted: boolean, live: number, replayed: number }

export interface RunOptions {
  dir: string
  slug: string
  players: RunPlayer[]
  matches: number
  baseSeed: number
  format: 'sng' | 'cash'
  tournament: TournamentFormat
  fake: boolean
  /** Extra run_start fields (B4 lab tables). */
  lab?: RunStartLine['lab']
  decisionWatchdogMs?: number
  handWatchdogMs?: number
  /** decide()'s own deadline per call (awake time). Default CALL_TIMEOUT_MS (30 s); v2 runs use 60 s. */
  decisionTimeoutMs?: number
  /**
   * v2 seat information: the structure sheet and payouts in `game`, knocked-out players, and the
   * remembered hands (`history` / `myCards`). Off for B3/B4 runs, so their views (and cache hashes)
   * are unchanged and they still resume from cache.
   */
  memory?: boolean
  fakeDelayMs?: number
}

/** B3 lineups are plain models: player id = model id, the roster label at the table, no card. */
export function plainPlayers(modelIds: string[]): RunPlayer[] {
  return modelIds.map(id => ({ id, modelId: id, name: findModel(id)?.label ?? id }))
}

const isPlain = (players: RunPlayer[]) => players.every(p => p.id === p.modelId && !p.card && p.name === (findModel(p.modelId)?.label ?? p.modelId))

export function validatePlayers(players: RunPlayer[]): void {
  for (const p of players) {
    const m = findModel(p.modelId)
    if (!m) throw new Error(`Unknown model ${p.modelId}`)
    if (p.card && m.kind !== 'llm') throw new Error(`${p.id}: strategy cards need a language model`)
  }
  if (players.length < 2 || players.length > 6) throw new Error('2–6 players')
  if (new Set(players.map(p => p.id)).size !== players.length) throw new Error('Each player once per lineup')
  if (new Set(players.map(p => p.name)).size !== players.length) throw new Error('Table names must be distinct')
}

// ── random deciders (fake runs and the dry-run estimate) ──────────────────────────────────────

/** Passive-leaning random play, seeded per decision so a fake run replays identically. */
export function randomDecision(modelId: string, view: SeatView, key: string): Decision {
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

// ── measured costs (estimates) ───────────────────────────────────────────────────────────────

/** Every non-cache .jsonl under the given dirs. */
function runFiles(dirs: string[]): string[] {
  return dirs.filter(d => existsSync(d)).flatMap(d => readdirSync(d).filter(f => f.endsWith('.jsonl') && !f.endsWith('.cache.jsonl')).map(f => join(d, f)))
}

/** Where real decisions live: B1/B2 sessions, B3 runs, and every lab run's table files. */
export function dataDirs(root = process.cwd()): string[] {
  const lab = join(root, 'data', 'lab')
  const labRuns = existsSync(lab) ? readdirSync(lab).map(r => join(lab, r, 'runs')).filter(existsSync) : []
  return [join(root, 'data', 'sessions'), join(root, 'data', 'runs'), ...labRuns]
}

/**
 * Decisions per seated hand per model, from real (non-fake) batch runs: random play busts seats
 * far faster than models do, so a simulation undercounts decisions. Models with ≥ 50 seated hands.
 */
export function measuredDecisionsPerHand(dirs = dataDirs()): Record<string, { perHand: number, hands: number }> {
  const acc: Record<string, { d: number, h: number }> = {}
  for (const f of runFiles(dirs.filter(d => !d.endsWith('sessions')))) {
    const run = parseRun(readFileSync(f, 'utf8'))
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

/** Mean $/decision and input tokens per model from every real decision on disk. */
export function measuredCostPerDecision(dirs = dataDirs()): Record<string, { usd: number, n: number, input: number }> {
  const sums: Record<string, { usd: number, n: number, input: number }> = {}
  for (const f of runFiles(dirs)) {
    for (const raw of readFileSync(f, 'utf8').split('\n')) {
      if (!raw.includes('"type":"hand"')) continue
      try {
        const l = JSON.parse(raw)
        for (const d of l.decisions ?? []) {
          const dec = d.decision as Decision
          if (dec.fallback || !(dec.usage.input || dec.usage.output)) continue
          const s = sums[dec.model] ??= { usd: 0, n: 0, input: 0 }
          s.usd += costUsd(dec.model, dec.usage)
          s.input += dec.usage.input
          s.n++
        }
      } catch { /* partial line */ }
    }
  }
  return Object.fromEntries(Object.entries(sums).map(([m, s]) => [m, { usd: s.usd / s.n, n: s.n, input: s.input / s.n }]))
}

/** Mean hands per finished (not capped) tournament over real runs with this many players. */
export function measuredTournamentLength(players: number, dirs = dataDirs()): { hands: number, n: number } | null {
  const lens = runFiles(dirs.filter(d => !d.endsWith('sessions')))
    .map(f => parseRun(readFileSync(f, 'utf8')))
    .filter(r => r.start && !r.start.fake && r.start.lineup.length === players)
    .flatMap(r => r.tournaments.filter(t => t.reason === 'finished').map(t => t.hands))
  return lens.length >= 3 ? { hands: lens.reduce((a, b) => a + b, 0) / lens.length, n: lens.length } : null
}

/** Fallback when a model has no history: chars/4 tokens (scaled as in selfplay.ts) × pricing. */
export function tokenEstimate(modelId: string, view: SeatView, card?: string): number {
  const kind = findModel(modelId)!.kind
  const menu = buildMenu(view, { custom: kind === 'llm' })
  const chars = kind === 'llm'
    ? SNG_INSTRUCTIONS.length + renderPrompt(view, menu, card).length
    : JSON.stringify(tableState(view)).length + JSON.stringify(menu.map(o => o.describe)).length
  const scale = kind === 'llm' ? 1.3 : modelId === 'typesafe-ai/jev' ? 3.1 : 1.9
  return costUsd(modelId, { input: Math.ceil(chars / 4 * scale), output: kind === 'llm' ? 250 : 0 })
}

// ── one run ─────────────────────────────────────────────────────────────────────────────────

interface CacheEntry { viewHash: string, decision: Decision }
const cacheKey = (tournamentId: string, handNo: number, logIndex: number) => `${tournamentId}|${handNo}|${logIndex}`
/** The card is part of what the model saw, so a changed card never replays an old decision. */
const viewHash = (v: SeatView, card?: string) => createHash('sha1').update(JSON.stringify(v) + (card ? `\n${card}` : '')).digest('hex').slice(0, 16)

export class Halt extends Error {}
class HandStuck extends Error {}

const now = () => new Date().toISOString()

export interface RunHandle {
  slug: string
  file: string
  plan: ScheduledTournament[]
  pending: ScheduledTournament[]
  done: Set<string>
  /** Spend of earlier invocations, from this run's cache (every cache line is one paid call). */
  priorSpend: number
  cachedDecisions: number
  play: (t: ScheduledTournament, spend: Spend, inFlight?: Map<string, number>) => Promise<void>
  /** Writes run_end with this run's own live spend and decision counts for this invocation. */
  end: (status: RunEndLine['status']) => RunEndLine
}

/**
 * Opens (or resumes) a run: writes run_start for a new file, otherwise checks it's the same run,
 * compacts away hand lines of unfinished tournaments (replayed from the cache) and loads the cache.
 */
export function openRun(opts: RunOptions): RunHandle {
  validatePlayers(opts.players)
  if (!/^[\w.-]{3,120}$/.test(opts.slug)) throw new Error('Bad slug')
  const lineup = opts.players.map(p => p.id)
  const byId = new Map(opts.players.map(p => [p.id, p]))
  const RUN_FILE = join(opts.dir, `${opts.slug}.jsonl`)
  const CACHE_FILE = join(opts.dir, `${opts.slug}.cache.jsonl`)
  const plan = schedule(lineup, opts.matches, opts.baseSeed)
  const base = { source: 'batch' as const, runId: opts.slug }
  const DECISION_WATCHDOG_MS = opts.decisionWatchdogMs ?? 45_000
  const HAND_WATCHDOG_MS = opts.handWatchdogMs ?? 300_000
  const plain = isPlain(opts.players)

  mkdirSync(opts.dir, { recursive: true })
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
  // B3 run_start lines are unchanged (no `players`), so existing runs resume and replay as before.
  const startLine: RunStartLine = {
    type: 'run_start', ...base, ts: now(), lineup, format: opts.format, tournament: opts.tournament, baseSeed: opts.baseSeed, fake: opts.fake, narrator: false,
    ...(plain ? {} : { players: opts.players }), ...(opts.lab ? { lab: opts.lab } : {}), ...(opts.memory ? { memory: true as const } : {})
  }
  const identity = (s: RunStartLine) => JSON.stringify([s.lineup, s.format, s.tournament, s.baseSeed, s.fake, s.players ?? null, ...(s.memory ? ['memory'] : [])])
  let done = new Set<string>()
  if (!existsSync(RUN_FILE)) {
    writeFileSync(RUN_FILE, `${JSON.stringify(startLine)}\n`)
  } else {
    const text = readFileSync(RUN_FILE, 'utf8')
    const run = parseRun(text)
    if (!run.start) throw new Error(`${RUN_FILE} has no run_start`)
    if (identity(run.start) !== identity(startLine)) throw new Error(`${RUN_FILE} was started with a different lineup/players/format/seed; use another slug`)
    done = new Set(run.tournaments.map(t => t.tournamentId))
    // Hands of unfinished tournaments are dropped and replayed from the cache, so a tournament's
    // hand lines are always one contiguous, complete set.
    if (run.partialHands.length || run.badLines) {
      const kept = text.split('\n').filter((raw) => {
        if (!raw.trim()) return false
        try {
          const l = JSON.parse(raw)
          return l.type !== 'hand' || done.has(l.tournamentId)
        } catch {
          return false
        }
      })
      writeFileSync(`${RUN_FILE}.tmp`, `${kept.join('\n')}\n`)
      renameSync(`${RUN_FILE}.tmp`, RUN_FILE)
      console.log(`resume ${opts.slug}: dropped ${run.partialHands.length} hand lines of unfinished tournaments (replayed from cache) and ${run.badLines} bad lines`)
    }
  }
  const write = (line: object) => appendFileSync(RUN_FILE, `${JSON.stringify(line)}\n`)
  // This run's share of the (possibly shared) spend, for its run_end line.
  const mine = { spent: 0, live: 0, replayed: 0 }

  /** A wall-clock watchdog over decide(): its own deadline is awake time, this one is a backstop. */
  async function watchedDecide(modelId: string, view: SeatView, card: string | undefined, handSignal: AbortSignal): Promise<Decision> {
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
      return await Promise.race([decide({ modelId, view, signal: ctrl.signal, ...(card ? { strategyCard: card } : {}), ...(opts.decisionTimeoutMs ? { timeoutMs: opts.decisionTimeoutMs } : {}) }), backstop])
    } finally {
      clearTimeout(timer)
      handSignal.removeEventListener('abort', onHand)
    }
  }

  async function play(t: ScheduledTournament, spend: Spend, inFlight = new Map<string, number>()): Promise<void> {
    const started = Date.now()
    const seats: RunSeat[] = t.seats.map((pid, i) => {
      const p = byId.get(pid)!
      return { id: `seat-${i + 1}`, name: p.name, modelId: p.modelId, ...(p.id !== p.modelId ? { playerId: p.id } : {}), ...(p.cardId ? { cardId: p.cardId } : {}) }
    })
    const playerOfSeat = new Map(seats.map((s, i) => [s.id, byId.get(t.seats[i]!)!]))
    let state: TableState = newTable({ players: seats.map(s => ({ id: s.id, name: s.name, modelId: s.modelId })), stacks: opts.tournament.stack, smallBlind: 1, bigBlind: 2 }, t.seed)
    const talk = new Map<string, string[]>()
    const finishes: Finish[] = []
    // v2 memory: every finished hand as the table saw it, and each seat's own hole cards per hand.
    const past: PastHand[] = []
    const holes = new Map<number, Record<string, Card[]>>()
    const sheet = { entrants: seats.length, startingStack: opts.tournament.stack, ...(opts.tournament.payouts ? { payouts: opts.tournament.payouts } : {}) }
    let rebuys = 0
    let engineErrors = 0
    let chipsConserved = true
    let decisions = 0, fallbacks = 0, retried = 0, cost = 0
    const live = () => state.seats.filter(s => s.stack > 0).length

    while (live() >= 2 && state.handNo < opts.tournament.maxHands) {
      if (opts.format === 'cash') {
        for (const s of state.seats) {
          if (s.stack <= 0) {
            s.stack = opts.tournament.stack
            rebuys++
          }
        }
      }
      const leveled = withLevel(state, opts.tournament.levels)
      const stacksBefore = Object.fromEntries(leveled.state.seats.map(s => [s.id, s.stack]))
      state = startHand(leveled.state)
      inFlight.set(`${opts.slug}/${t.tournamentId}`, state.handNo)
      const blinds = state.seats.filter(s => s.lastAction?.startsWith('posts')).map(s => `${s.name} ${s.lastAction}`).join(' · ')
      const actionLabels: string[] = []
      const records: RunDecisionRecord[] = []
      let handErrors = 0
      const handCtrl = new AbortController()
      const handTimer = setTimeout(() => handCtrl.abort(new HandStuck('hand watchdog')), HAND_WATCHDOG_MS)
      try {
        while (state.toAct !== null && state.street !== 'complete') {
          if (spend.halted) throw new Halt()
          const seat = state.seats[state.toAct]!
          const player = playerOfSeat.get(seat.id)!
          const modelId = player.modelId
          const prior = recentTalk(talk.get(seat.id) ?? [])
          const game = opts.format === 'sng' ? sngFormat(opts.tournament.levels, state.handNo, opts.memory ? sheet : undefined) : { type: 'cash' as const }
          let view: SeatView = { ...seatView(state, seat.id, game), ...(prior.length ? { priorTableTalk: prior } : {}) }
          if (opts.memory) {
            view = withMemory(view, past, holes)
            if (opts.format === 'sng' && finishes.length) {
              view.eliminated = finishes.slice().sort((a, b) => b.place - a.place)
                .map(f => ({ id: f.seatId, name: seats.find(x => x.id === f.seatId)!.name, place: f.place, handNo: f.bustHand ?? 0 }))
            }
          } else {
            // B3/B4 views had none of the v2 fields; keep them byte-identical so old caches replay.
            delete view.actingAfter
            delete view.pots
            delete view.me.inPot
            for (const o of view.opponents) delete o.inPot
          }
          const logIndex = state.log.length
          const key = cacheKey(t.tournamentId, state.handNo, logIndex)
          const hash = viewHash(view, player.card)
          let decision: Decision
          const cached = cache.get(key)
          if (cached && cached.viewHash === hash) {
            decision = cached.decision
            spend.replayed++
            mine.replayed++
          } else {
            if (cached) console.warn(`  ! ${opts.slug} ${key}: cached view differs, asking live`)
            if (spend.spent >= spend.cap) {
              spend.halted = true
              throw new Halt()
            }
            if (opts.fake) {
              // Fake runs go through the same cache path as live ones, so kill/resume is testable for $0.
              if (opts.fakeDelayMs) await new Promise(r => setTimeout(r, opts.fakeDelayMs))
              decision = randomDecision(modelId, view, `${key}|${hash}`)
            } else {
              decision = await watchedDecide(modelId, view, player.card, handCtrl.signal)
            }
            if (handCtrl.signal.aborted) throw handCtrl.signal.reason
            spend.spent += costUsd(modelId, decision.usage)
            spend.live++
            mine.spent += costUsd(modelId, decision.usage)
            mine.live++
            cache.set(key, { viewHash: hash, decision })
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
            console.error(`  ! ${opts.slug} ${t.tournamentId} #${state.handNo} engine rejected ${seat.name} ${JSON.stringify(decision.action)}: ${(err as Error).message}`)
            const menu = buildMenu(view)
            state = applyAction(state, seat.id, (menu.find(o => o.id === 'check') ?? menu.find(o => o.id === 'fold')!).action)
          }
          if (decision.tableTalk) talk.set(seat.id, [...(talk.get(seat.id) ?? []), decision.tableTalk])
          actionLabels.push(state.seats.find(s => s.id === seat.id)!.lastAction ?? decision.action.type)
          records.push({ handNo: state.handNo, seatId: seat.id, street: view.street, logIndex, view, decision })
        }
      } finally {
        clearTimeout(handTimer)
      }
      engineErrors += handErrors
      const stacksAfter = Object.fromEntries(state.seats.map(s => [s.id, s.stack]))
      const total = state.seats.reduce((n, s) => n + s.stack, 0)
      if (total !== opts.tournament.stack * (seats.length + rebuys)) {
        chipsConserved = false
        engineErrors++
        console.error(`  ! ${opts.slug} ${t.tournamentId} #${state.handNo} chips not conserved: ${total}`)
      }
      const busts = opts.format === 'sng' ? bustsThisHand(stacksBefore, stacksAfter, live(), state.handNo) : []
      finishes.push(...busts)
      past.push(pastHand(state))
      holes.set(state.handNo, Object.fromEntries(state.seats.map(s => [s.id, s.hole.slice()])))
      const line: RunHandLine = {
        type: 'hand', ...base, ts: now(), sessionId: t.tournamentId, mode: 'batch',
        matchId: t.matchId, tournamentId: t.tournamentId, rotation: t.rotation, seed: t.seed,
        handNo: state.handNo, level: leveled.level, smallBlind: state.smallBlind, bigBlind: state.bigBlind,
        button: state.button, seats, holes: Object.fromEntries(state.seats.map(s => [s.id, s.hole.slice()])),
        board: state.board.slice(), blinds, log: state.log, actionLabels, decisions: records,
        result: state.result!, stacksBefore, stacksAfter, busts,
        ...(handErrors ? { engineErrors: handErrors } : {})
      }
      write(line)
    }
    inFlight.delete(`${opts.slug}/${t.tournamentId}`)

    const final = Object.fromEntries(state.seats.map(s => [s.id, s.stack]))
    const placed = opts.format === 'sng'
      ? [...survivorsPlaced(final), ...finishes]
      : survivorsPlaced(Object.fromEntries(state.seats.map(s => [s.id, s.stack + 1])))
    const finish = placed
      .sort((a, b) => a.place - b.place)
      .map((f) => {
        const s = seats.find(x => x.id === f.seatId)!
        return { ...f, modelId: s.modelId, name: s.name, ...(s.playerId ? { playerId: s.playerId } : {}) }
      })
    const line: TournamentLine = {
      type: 'tournament', ...base, ts: now(), sessionId: t.tournamentId, matchId: t.matchId, tournamentId: t.tournamentId,
      rotation: t.rotation, seed: t.seed, seats, hands: state.handNo,
      reason: live() >= 2 ? 'hand_cap' : 'finished', finish,
      costUsd: cost, decisions, fallbacks, retried, engineErrors, chipsConserved, wallMs: Date.now() - started
    }
    write(line)
    const winner = finish[0]!
    console.log(`✓ ${opts.slug} ${t.tournamentId} ${String(state.handNo).padStart(3)} hands · 1st ${winner.name} · $${cost.toFixed(3)} · fallbacks ${fallbacks}/${decisions} · spend $${spend.spent.toFixed(3)} of $${spend.cap}`)
  }

  function end(status: RunEndLine['status']): RunEndLine {
    const finished = parseRun(readFileSync(RUN_FILE, 'utf8')).tournaments.length
    const line: RunEndLine = {
      type: 'run_end', ...base, ts: now(), status, spentUsd: mine.spent, totalSpentUsd: priorSpend + mine.spent,
      liveDecisions: mine.live, replayedDecisions: mine.replayed, tournamentsDone: finished, tournamentsPlanned: plan.length
    }
    write(line)
    return line
  }

  return {
    slug: opts.slug, file: RUN_FILE, plan, done, priorSpend, cachedDecisions: cache.size,
    pending: plan.filter(t => !done.has(t.tournamentId)),
    play, end
  }
}

/**
 * Runs tasks with at most `concurrency` in flight. A task that throws Halt stops its worker; any
 * other error is reported and the worker moves on (a rerun resumes that tournament).
 */
export async function runPool(tasks: { label: string, run: () => Promise<void> }[], concurrency: number, stopped: () => boolean): Promise<{ failures: number }> {
  let next = 0
  let failures = 0
  async function worker() {
    while (!stopped() && next < tasks.length) {
      const t = tasks[next++]!
      try {
        await t.run()
      } catch (err) {
        if (err instanceof Halt) break
        failures++
        console.error(`✗ ${t.label} abandoned for this invocation (${(err as Error).message}); a rerun resumes it`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
  return { failures }
}

// ── dry-run estimate for one lineup (B3 CLI) ────────────────────────────────────────────────

/**
 * Simulates match 1 with random play to count decisions, then prices them with measured
 * $/decision and decisions/hand where the data exists, and real tournament lengths.
 */
export async function estimateRun(opts: RunOptions): Promise<{ perHand: number, handsPerMatch: number }> {
  const players = opts.players
  const measured = measuredCostPerDecision()
  const estimateCost: Record<string, number> = Object.fromEntries(players.filter(p => (measured[p.modelId]?.n ?? 0) >= 10).map(p => [p.id, measured[p.modelId]!.usd]))
  const decisions: Record<string, number> = {}
  const usd: Record<string, number> = {}
  let hands = 0
  for (const t of schedule(players.map(p => p.id), 1, opts.baseSeed)) {
    const seatPlayers = t.seats.map(pid => players.find(p => p.id === pid)!)
    let state: TableState = newTable({ players: seatPlayers.map((p, i) => ({ id: `seat-${i + 1}`, name: p.name, modelId: p.modelId })), stacks: opts.tournament.stack, smallBlind: 1, bigBlind: 2 }, t.seed)
    while (state.seats.filter(s => s.stack > 0).length >= 2 && state.handNo < opts.tournament.maxHands) {
      state = startHand(withLevel(state, opts.tournament.levels).state)
      while (state.toAct !== null && state.street !== 'complete') {
        const seat = state.seats[state.toAct]!
        const p = seatPlayers[state.toAct]!
        const view = seatView(state, seat.id, sngFormat(opts.tournament.levels, state.handNo))
        decisions[p.id] = (decisions[p.id] ?? 0) + 1
        usd[p.id] = (usd[p.id] ?? 0) + (estimateCost[p.id] ?? tokenEstimate(p.modelId, view, p.card))
        state = applyAction(state, seat.id, randomDecision(p.modelId, view, `${t.tournamentId}|${state.handNo}|${state.log.length}`).action)
      }
      hands++
    }
  }
  const real = measuredDecisionsPerHand()
  let perHand = 0
  console.log(`\n── Estimate (match 1 simulated with random passive-leaning play: ${hands} hands)`)
  for (const p of players) {
    const simPerHand = (decisions[p.id] ?? 0) / hands
    const dph = real[p.modelId]?.perHand ?? simPerHand
    const usdPerDecision = (usd[p.id] ?? 0) / Math.max(decisions[p.id] ?? 0, 1)
    perHand += dph * usdPerDecision
    const src = estimateCost[p.id] !== undefined ? `measured $${estimateCost[p.id]!.toFixed(5)}/decision (n=${measured[p.modelId]!.n})` : `token estimate (no history; $${PRICING[p.modelId]?.input}/$${PRICING[p.modelId]?.output} per 1M)`
    const dsrc = real[p.modelId] ? `measured over ${real[p.modelId]!.hands} seated hands` : 'simulated'
    console.log(`  ${p.id.padEnd(32)} ${dph.toFixed(2)} decisions/hand (${dsrc}) · ${src}`)
  }
  const realT = measuredTournamentLength(players.length)
  const handsPerT = realT ? realT.hands : opts.tournament.maxHands
  const handsPerMatch = Math.min(handsPerT, opts.tournament.maxHands) * players.length
  console.log(`  hands/tournament: ${realT ? `measured ${handsPerT.toFixed(0)} (n=${realT.n})` : `assumed the cap, ${opts.tournament.maxHands}`}`)
  console.log(`  ≈ $${perHand.toFixed(4)}/hand · ≈ $${(perHand * handsPerMatch).toFixed(2)}/match (${players.length} tournaments) · ${opts.matches} matches ≈ $${(perHand * handsPerMatch * opts.matches).toFixed(2)}`)
  return { perHand, handsPerMatch }
}
