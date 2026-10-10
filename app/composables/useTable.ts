import type { ActionEvent, Card, Decision, HandResult, MenuId, PastHand, PlayerAction, SeatView, Street, TableState } from '~~/shared/utils/types'
import { activeSeatCount, applyAction, legalActions, newTable, recentTalk, seatView, startHand, withMemory, withTableTalk } from '~~/shared/utils/table'
import { buildMenu } from '~~/shared/utils/menu'
import { seatStats, sessionCost } from '~~/shared/utils/stats'
import { narratorCost, scoutingMarkdown, type Narration, type ScoutingReport } from '~~/shared/utils/narration'
import { clearSnapshot, postLog, saveSnapshot, type TableSnapshot } from '~/utils/persist'
import { canNarrate } from '~/utils/reveal'
import { findModel } from '~~/shared/utils/models'
import { DEFAULT_COST_CAP, type Lineup } from './useLineup'

export const HUMAN_ID = 'you'
export const HAND_CAP = 100
const CLIENT_TIMEOUT_MS = 35_000
/** Longer than the server's narrator timeouts (45 s per hand, 60 s for the report), so the server's error wins. */
const NARRATE_CLIENT_TIMEOUT_MS = 50_000
const SCOUT_CLIENT_TIMEOUT_MS = 65_000
/** Play mode: decision models answer in ~300 ms, which feels instant without a floor. */
const PLAY_THINK_MS = 700

export type Pace = 'pause' | '1x' | '4x' | 'max'
/** Watch mode: minimum time per action, so 1× reads like a broadcast. */
export const PACE_FLOOR_MS: Record<Exclude<Pace, 'pause'>, number> = { '1x': 1_500, '4x': 400, 'max': 0 }
/** Watch mode: how long a finished hand's result stays up before the next deal. */
const DEAL_BEAT_MS: Record<Exclude<Pace, 'pause'>, number> = { '1x': 4_000, '4x': 2_000, 'max': 1_000 }

export interface DecisionRecord {
  handNo: number
  seatId: string
  street: Street
  /** Index into that hand's `state.log`. */
  logIndex: number
  decision: Decision
}

/** One finished hand, kept for the Hands / Chips tabs and the session summary. In memory only. */
export interface HandRecord {
  handNo: number
  board: Card[]
  button: number
  pots: HandResult['pots']
  shown: HandResult['shown']
  deltas: Record<string, number>
  /** Every seat's stack once the pot is paid (busted seats included, at 0). */
  stacksAfter: Record<string, number>
  /** Every seat's hole cards; the UI shows only what canShowHoleCards allows. */
  holes: Record<string, Card[]>
  log: ActionEvent[]
  actionLabels: string[]
  blindsNote: string
  decisions: DecisionRecord[]
}

/** Lines a seat already said this session, newest last (deduped), so the LLM can vary its banter. */
export function useTable(lineup: Lineup, opts: { stacks?: number[], seed?: number, cap?: Ref<number>, narratorOn?: Ref<boolean>, restore?: TableSnapshot } = {}) {
  const snap = opts.restore
  const hasHuman = lineup.mode === 'play'
  const ais = lineup.seats.map((modelId, i) => {
    const label = findModel(modelId)?.label ?? modelId
    const dupes = lineup.seats.slice(0, i).filter(id => id === modelId).length
    return { id: `seat-${i + 1}`, name: dupes ? `${label} ${dupes + 1}` : label, modelId }
  })
  const players = hasHuman ? [{ id: HUMAN_ID, name: 'You', modelId: null }, ...ais] : ais
  const stacks = opts.stacks?.length === players.length ? opts.stacks : lineup.stack
  const freshTable = (seed = Math.floor(Math.random() * 2 ** 31)) => newTable(
    { players, stacks, smallBlind: lineup.smallBlind, bigBlind: lineup.bigBlind },
    seed
  )
  const state = shallowRef<TableState>(snap?.state ?? freshTable(opts.seed))
  /** Stacks when the session started (net chips and the chart's hand 0). */
  const startingStacks = snap?.startingStacks ?? Object.fromEntries(state.value.seats.map(s => [s.id, s.stack])) as Record<string, number>
  const history = ref<HandRecord[]>(snap?.history ?? [])
  const startedAt = ref(snap?.startedAt ?? Date.now())
  /** Names the on-disk log (data/sessions/<id>.jsonl); a reset starts a new one. */
  let sessionId = snap?.sessionId ?? crypto.randomUUID()

  /** Seat id currently waiting on /api/decide. */
  const thinking = ref<string | null>(null)
  /** Every AI decision this session; the hand review (and Watch mode's live panel) reads it. */
  const decisions = ref<DecisionRecord[]>(snap?.decisions ?? [])
  /** Engine `lastAction` text per log index for the current hand ("calls 40, all-in"). */
  const actionLabels = ref<string[]>(snap?.actionLabels ?? [])
  /** "You post 5 · GPT-6 Sol posts 10" for the current hand (blinds aren't log events). */
  const blindsNote = ref(snap?.blindsNote ?? '')
  const pace = ref<Pace>(snap?.pace ?? '1x')
  /** Session spend cap in USD; AI turns stop once spend reaches it. */
  const cap = opts.cap ?? ref(DEFAULT_COST_CAP)
  /** The Booth: one narrator call per finished hand, plus a scouting report when the session ends. */
  const narratorOn = opts.narratorOn ?? ref(true)
  const narrations = ref<Record<number, Narration>>(snap?.narrations ?? {})
  /** Hand numbers waiting on the narrator, and the ones it missed (error or timeout). */
  const narrating = ref<number[]>([])
  const narrationFailed = ref<number[]>([])
  const scouting = ref<ScoutingReport | null>(null)
  const scoutingStatus = ref<'idle' | 'loading' | 'error'>('idle')
  /** Aborted only on unload, unmount or reset: dealing the next hand must not cancel the Booth. */
  let boothController = new AbortController()
  const narratorSpent = computed(() => narratorCost(Object.values(narrations.value)) + narratorCost([scouting.value]))
  /** Gateway cost of this session's decisions and narration (pricing.ts × usage). */
  const spent = computed(() => sessionCost(decisions.value) + narratorSpent.value)
  /** True while the cap is holding AI turns back. */
  const capped = ref(false)
  /** Watch mode: the pace to go back to when the cap is lifted from the toast. */
  let paceBeforeCap: Exclude<Pace, 'pause'> = '1x'

  const toast = useToast()
  /** Each cap hit gets a fresh toast id: Nuxt UI removes by id after a delay, which would eat a re-added toast. */
  let capToastId: string | null = null
  let runId = 0
  let controller: AbortController | null = null

  const toActSeat = computed(() => state.value.toAct === null ? null : state.value.seats[state.value.toAct]!)
  const isHumanTurn = computed(() => hasHuman && toActSeat.value?.id === HUMAN_ID && !thinking.value)
  const human = computed(() => state.value.seats.find(s => s.id === HUMAN_ID) ?? null)
  const humanLegal = computed(() => isHumanTurn.value ? legalActions(state.value) : null)
  const humanMenu = computed(() => isHumanTurn.value ? buildMenu(seatView(state.value, HUMAN_ID)) : [])
  /** Why the table can't deal another hand, or null if it can. */
  const finished = computed<string | null>(() => {
    const s = state.value
    if (s.street !== 'complete') return null
    if (hasHuman && human.value!.stack <= 0) return 'You\'re out of chips.'
    if (activeSeatCount(s) < 2) {
      const leader = s.seats.find(x => x.stack > 0)
      return leader ? `${leader.name === 'You' ? 'You hold' : `${leader.name} holds`} every chip.` : 'Nobody left to play.'
    }
    if (!hasHuman && s.handNo >= HAND_CAP) return `Hand cap reached (${HAND_CAP}).`
    return null
  })
  const canDeal = computed(() => state.value.street === 'complete' && !finished.value)

  function sleep(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms)
      signal.addEventListener('abort', () => {
        clearTimeout(t)
        resolve()
      }, { once: true })
    })
  }

  async function waitWhilePaused(signal: AbortSignal) {
    while (pace.value === 'pause' && !signal.aborted) await sleep(150, signal)
  }

  function apply(seatId: string, action: PlayerAction, tableTalk?: string) {
    let next = applyAction(state.value, seatId, action)
    if (tableTalk) next = withTableTalk(next, seatId, tableTalk)
    const seat = next.seats.find(s => s.id === seatId)!
    actionLabels.value = [...actionLabels.value, seat.lastAction ?? action.type]
    state.value = next
  }

  /** Snapshot a finished hand into `history` (once per hand). */
  function recordIfComplete() {
    const s = state.value
    if (s.street !== 'complete' || !s.result || history.value.at(-1)?.handNo === s.handNo) return
    history.value.push({
      handNo: s.handNo,
      board: s.board.slice(),
      button: s.button,
      pots: s.result.pots,
      shown: s.result.shown,
      deltas: s.result.deltas,
      stacksAfter: Object.fromEntries(s.seats.map(x => [x.id, x.stack])),
      holes: Object.fromEntries(s.seats.map(x => [x.id, x.hole.slice()])),
      log: s.log,
      actionLabels: actionLabels.value.slice(),
      blindsNote: blindsNote.value,
      decisions: decisions.value.filter(d => d.handNo === s.handNo)
    })
    const h = history.value.at(-1)!
    postLog({
      type: 'hand', sessionId, mode: lineup.mode, seats: players, seed: s.seed,
      handNo: h.handNo, button: h.button, holes: h.holes, board: h.board, blinds: h.blindsNote,
      log: h.log, actionLabels: h.actionLabels, decisions: h.decisions,
      result: { pots: h.pots, shown: h.shown, deltas: h.deltas }, stacksAfter: h.stacksAfter
    })
    if (canNarrate({ street: s.street })) narrate(h)
  }

  const nameOf = (id: string) => players.find(p => p.id === id)?.name ?? id

  /** Ask the Booth about one finished hand. Async: never blocks the next deal; late is fine. */
  function narrate(h: HandRecord) {
    if (!import.meta.client || !narratorOn.value || spent.value >= cap.value) return
    if (narrations.value[h.handNo] || narrating.value.includes(h.handNo)) return
    const sid = sessionId
    const signal = boothController.signal
    narrating.value = [...narrating.value, h.handNo]
    narrationFailed.value = narrationFailed.value.filter(x => x !== h.handNo)
    $fetch<Narration>('/api/narrate', {
      method: 'POST',
      body: { seats: players, hand: h },
      signal: AbortSignal.any([signal, AbortSignal.timeout(NARRATE_CLIENT_TIMEOUT_MS)])
    }).then((n) => {
      if (signal.aborted || sid !== sessionId) return
      narrations.value = { ...narrations.value, [h.handNo]: n }
      postLog({ type: 'narration', sessionId: sid, mode: lineup.mode, handNo: h.handNo, narration: n })
    }).catch(() => {
      if (!signal.aborted && sid === sessionId) narrationFailed.value = [...narrationFailed.value, h.handNo]
    }).finally(() => {
      narrating.value = narrating.value.filter(x => x !== h.handNo)
    })
  }

  /** End-of-session scouting report. Runs by itself when the summary opens (narrator on, under the cap); `force` is the summary's button. */
  async function requestScouting(force = false) {
    if (!history.value.length || !players.some(p => p.modelId) || scoutingStatus.value === 'loading') return
    if (!force && (!narratorOn.value || spent.value >= cap.value)) return
    if (scouting.value?.hands === history.value.length) return
    const sid = sessionId
    const signal = boothController.signal
    scoutingStatus.value = 'loading'
    try {
      const headlines = Object.fromEntries(Object.values(narrations.value).map(n => [n.handNo, n.headline]))
      const report = await $fetch<ScoutingReport>('/api/scouting', {
        method: 'POST',
        body: { seats: players, hands: history.value, headlines },
        signal: AbortSignal.any([signal, AbortSignal.timeout(SCOUT_CLIENT_TIMEOUT_MS)])
      })
      if (sid !== sessionId) return
      scouting.value = report
      scoutingStatus.value = 'idle'
      postLog({ type: 'scouting_report', sessionId: sid, mode: lineup.mode, hands: report.hands, report, markdown: scoutingMarkdown(report, nameOf, `Scouting report · session ${sid.slice(0, 8)}`) })
    } catch {
      if (sid === sessionId) scoutingStatus.value = signal.aborted ? 'idle' : 'error'
    }
  }
  const scoutingMd = computed(() => scouting.value ? scoutingMarkdown(scouting.value, nameOf, `Scouting report · ${players.filter(p => p.modelId).map(p => p.name).join(', ')}`) : '')

  function logSessionStart() {
    postLog({
      type: 'session_start', sessionId, mode: lineup.mode, seats: players,
      config: { stacks: startingStacks, smallBlind: lineup.smallBlind, bigBlind: lineup.bigBlind, seed: state.value.seed }
    })
  }

  /** Session over (leave, bust, cap, new table): write the summary line and drop the resume snapshot. */
  function endSession(reason: string | null) {
    postLog({
      type: 'session_end', sessionId, mode: lineup.mode, hands: history.value.length, reason,
      costUsd: spent.value, narratorCostUsd: narratorSpent.value, stacks: Object.fromEntries(state.value.seats.map(x => [x.id, x.stack])),
      stats: seatStats(players.map(p => p.id), history.value, decisions.value)
    })
    clearSnapshot()
  }

  function persist() {
    saveSnapshot({
      v: 1, sessionId, lineup: { ...lineup, seats: lineup.seats.slice() }, startingStacks, startedAt: startedAt.value,
      state: state.value, history: history.value, decisions: decisions.value,
      actionLabels: actionLabels.value, blindsNote: blindsNote.value, pace: pace.value, costUsd: spent.value, cap: cap.value,
      narrations: narrations.value, narratorOn: narratorOn.value
    })
  }
  // After every applied action (state), decision, finished hand or pace change. Only once a hand is dealt.
  watch([state, () => decisions.value.length, () => history.value.length, pace, cap, () => Object.keys(narrations.value).length, narratorOn], () => {
    if (state.value.handNo > 0) persist()
  })
  if (!snap && import.meta.client) logSessionStart()

  /**
   * v2 memory for AI seats: finished hands as the table saw them (PastHand), rebuilt from the hand
   * history, so a model remembers what a human at the table would (withMemory() picks the window).
   */
  function pastHands(): { past: PastHand[], holes: Map<number, Record<string, Card[]>> } {
    const seats = state.value.seats
    const n = seats.length
    const past = history.value.map((h): PastHand => {
      const dealt = Array.from({ length: n }, (_, k) => seats[(h.button + k) % n]!).filter(s => (h.holes[s.id]?.length ?? 0) > 0)
      return {
        handNo: h.handNo,
        smallBlind: lineup.smallBlind,
        bigBlind: lineup.bigBlind,
        players: dealt.map(s => ({ id: s.id, name: s.name, stack: (h.stacksAfter[s.id] ?? 0) - (h.deltas[s.id] ?? 0) })),
        log: h.log,
        board: h.board,
        shown: Object.fromEntries(Object.entries(h.shown).map(([id, x]) => [id, x.cards])),
        pots: h.pots.map(p => ({ amount: p.amount, winners: p.winners })),
        busted: dealt.filter(s => (h.stacksAfter[s.id] ?? 0) === 0).map(s => s.id)
      }
    })
    return { past, holes: new Map(history.value.map(h => [h.handNo, h.holes])) }
  }

  /** This seat's own recent lines, most recently used last (see recentTalk()). */
  function priorTalk(seatId: string): string[] {
    return recentTalk(decisions.value.flatMap(d => d.seatId === seatId && d.decision.tableTalk ? [d.decision.tableTalk] : []))
  }

  function startNextHand() {
    const next = startHand(state.value)
    actionLabels.value = []
    blindsNote.value = next.seats
      .filter(s => s.lastAction?.startsWith('posts'))
      .map(s => `${s.name} ${s.id === HUMAN_ID ? s.lastAction!.replace('posts', 'post') : s.lastAction}`)
      .join(' · ')
    state.value = next
  }

  /** Check if free, else fold: the same fallback the server uses. */
  function clientFallback(view: SeatView, modelId: string, reason: string): Decision {
    const menuId: MenuId = view.toCall === 0 ? 'check' : 'fold'
    return {
      menuId,
      action: { type: menuId },
      reasoning: reason,
      fallback: true,
      model: modelId,
      latencyMs: 0,
      usage: { input: 0, output: 0 }
    }
  }

  async function requestDecision(modelId: string, view: SeatView, signal: AbortSignal): Promise<Decision> {
    try {
      return await $fetch<Decision>('/api/decide', {
        method: 'POST',
        body: { modelId, view },
        signal: AbortSignal.any([signal, AbortSignal.timeout(CLIENT_TIMEOUT_MS)])
      })
    } catch (err) {
      if (signal.aborted) throw err
      const e = err as { statusCode?: number, data?: { message?: string, statusMessage?: string }, message?: string }
      const message = e.data?.message || e.data?.statusMessage || e.message || 'Request failed'
      return clientFallback(view, modelId, `Client fallback: ${message}`)
    }
  }

  function announceFallback(name: string, d: Decision) {
    const what = d.requested ? `picked "${d.requested}", which wasn't legal` : 'timed out'
    toast.add({
      title: `${name} ${what} — ${d.action.type === 'check' ? 'checked' : 'folded'}`,
      color: 'warning',
      icon: 'i-lucide-timer-off'
    })
  }

  const nextCap = () => Math.ceil((Math.max(cap.value, spent.value) + 1) * 100) / 100

  function liftCap() {
    capped.value = false
    if (capToastId) toast.remove(capToastId)
    capToastId = null
    if (!hasHuman) pace.value = paceBeforeCap
    else if (toActSeat.value?.modelId) runAI()
  }

  /** The toast's resume: raise the cap by $1 (the watcher below does the rest). */
  function raiseCapAndResume() {
    cap.value = nextCap()
  }

  /** Stop AI turns at the cap: Watch pauses, Play stops before the next AI decision. */
  function hitCap() {
    capped.value = true
    if (!hasHuman && pace.value !== 'pause') {
      paceBeforeCap = pace.value
      pace.value = 'pause'
    }
    const next = nextCap()
    if (capToastId) toast.remove(capToastId)
    capToastId = `session-cap-${Date.now()}`
    toast.add({
      id: capToastId,
      title: `Session cap reached: $${spent.value.toFixed(3)} of $${cap.value.toFixed(2)}`,
      description: hasHuman ? 'AI turns are on hold.' : 'The table is paused.',
      color: 'warning',
      icon: 'i-lucide-circle-dollar-sign',
      duration: Infinity,
      progress: false,
      actions: [{ label: `Raise cap to $${next.toFixed(2)} and resume`, color: 'neutral', variant: 'outline', onClick: raiseCapAndResume }]
    })
  }

  // Raising the cap (toast button or the header input) lifts the hold and resumes where the cap stopped.
  watch(cap, (v) => {
    if (capped.value && spent.value < v) liftCap()
  })

  /** Drive AI seats until it's the human's turn or the hand ends; in Watch mode, keep dealing. */
  async function runAI() {
    const id = ++runId
    controller?.abort()
    controller = new AbortController()
    const signal = controller.signal

    while (id === runId) {
      if (!hasHuman) await waitWhilePaused(signal)
      if (signal.aborted || id !== runId) break

      const seat = toActSeat.value
      if (!seat) {
        if (hasHuman || !canDeal.value) break
        // Leave the result up for a beat; a pause during the beat restarts it on resume.
        do {
          await waitWhilePaused(signal)
          await sleep(DEAL_BEAT_MS[pace.value === 'pause' ? '1x' : pace.value], signal)
        } while (pace.value === 'pause' && !signal.aborted)
        if (signal.aborted || id !== runId || !canDeal.value) break
        startNextHand()
        continue
      }
      if (!seat.modelId) break
      if (spent.value >= cap.value) {
        hitCap()
        // Watch mode loops back into the pause wait; Play mode ends the loop until resumed.
        if (hasHuman) break
        continue
      }
      capped.value = false

      const handNo = state.value.handNo
      const logIndex = state.value.log.length
      const prior = priorTalk(seat.id)
      // Interactive tables are cash-style: fixed blinds, so the seat is told it's a cash game.
      const memory = pastHands()
      const view: SeatView = withMemory({ ...seatView(state.value, seat.id, { type: 'cash' }), ...(prior.length ? { priorTableTalk: prior } : {}) }, memory.past, memory.holes)
      thinking.value = seat.id
      const started = performance.now()
      let decision: Decision
      try {
        decision = await requestDecision(seat.modelId, view, signal)
      } catch {
        break
      }
      const floor = hasHuman ? PLAY_THINK_MS : pace.value === 'pause' ? 0 : PACE_FLOOR_MS[pace.value]
      const elapsed = performance.now() - started
      if (elapsed < floor) await sleep(floor - elapsed, signal)
      if (signal.aborted || id !== runId) break

      try {
        apply(seat.id, decision.action, decision.tableTalk)
      } catch (err) {
        // The server builds the menu from the same view, so this should never fire; fold/check rather than stall.
        decision = clientFallback(view, seat.modelId, `Engine rejected ${JSON.stringify(decision.action)}: ${(err as Error).message}`)
        apply(seat.id, decision.action)
      }
      if (decision.fallback) announceFallback(seat.name, decision)
      decisions.value.push({ handNo, seatId: seat.id, street: view.street, logIndex, decision })
      recordIfComplete()
      thinking.value = null
    }
    if (id === runId) thinking.value = null
  }

  function deal() {
    if (!canDeal.value) return
    stop()
    startNextHand()
    runAI()
  }

  function act(action: PlayerAction) {
    if (!isHumanTurn.value) return
    apply(HUMAN_ID, action)
    recordIfComplete()
    runAI()
  }

  /** Same seats and stacks, fresh session. */
  function reset() {
    stop()
    state.value = freshTable()
    decisions.value = []
    history.value = []
    actionLabels.value = []
    blindsNote.value = ''
    startedAt.value = Date.now()
    capped.value = false
    if (capToastId) toast.remove(capToastId)
    capToastId = null
    boothController.abort()
    boothController = new AbortController()
    narrations.value = {}
    narrating.value = []
    narrationFailed.value = []
    scouting.value = null
    scoutingStatus.value = 'idle'
    sessionId = crypto.randomUUID()
    logSessionStart()
    deal()
  }

  function stop() {
    runId++
    controller?.abort()
    controller = null
    thinking.value = null
  }

  // A reload kills the in-flight /api/decide; abort first so it isn't recorded as a fallback fold.
  // The snapshot keeps the AI on turn, and the restored table re-requests it.
  // Narration in flight is dropped too; the restored table re-asks for the last two hands.
  function unload() {
    stop()
    boothController.abort()
  }
  if (import.meta.client) window.addEventListener('beforeunload', unload)
  onBeforeUnmount(() => {
    if (import.meta.client) window.removeEventListener('beforeunload', unload)
    unload()
    if (capToastId) toast.remove(capToastId)
  })

  // Resumed: re-ask for recent hands the Booth hadn't finished. Toggled on: narrate the last hand.
  if (snap && import.meta.client) history.value.slice(-2).forEach(narrate)
  watch(narratorOn, (on) => {
    const last = history.value.at(-1)
    if (on && last) narrate(last)
  })

  return {
    narratorOn, narrations, narrating, narrationFailed, narratorSpent, scouting, scoutingStatus, scoutingMd, requestScouting,
    state, hasHuman, thinking, decisions, actionLabels, blindsNote, pace, cap, spent, capped, raiseCapAndResume,
    history, startingStacks, startedAt, lineup,
    toActSeat, isHumanTurn, human, humanLegal, humanMenu, canDeal, finished,
    deal, act, stop, reset, resume: runAI, endSession
  }
}

export type Table = ReturnType<typeof useTable>
