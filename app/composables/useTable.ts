import type { ActionEvent, Card, Decision, HandResult, MenuId, PlayerAction, SeatView, Street, TableState } from '~~/shared/utils/types'
import { activeSeatCount, applyAction, legalActions, newTable, seatView, startHand, withTableTalk } from '~~/shared/utils/table'
import { buildMenu } from '~~/shared/utils/menu'
import { findModel } from '~~/shared/utils/models'
import type { Lineup } from './useLineup'

export const HUMAN_ID = 'you'
export const HAND_CAP = 100
const CLIENT_TIMEOUT_MS = 35_000
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
const PRIOR_TALK_MAX = 6

export function useTable(lineup: Lineup, opts: { stacks?: number[], seed?: number } = {}) {
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
  const state = shallowRef<TableState>(freshTable(opts.seed))
  /** Stacks when the session started (net chips and the chart's hand 0). */
  const startingStacks = Object.fromEntries(state.value.seats.map(s => [s.id, s.stack])) as Record<string, number>
  const history = ref<HandRecord[]>([])
  const startedAt = ref(Date.now())

  /** Seat id currently waiting on /api/decide. */
  const thinking = ref<string | null>(null)
  /** Every AI decision this session; the hand review (and Watch mode's live panel) reads it. */
  const decisions = ref<DecisionRecord[]>([])
  /** Engine `lastAction` text per log index for the current hand ("calls 40, all-in"). */
  const actionLabels = ref<string[]>([])
  /** "You post 5 · GPT-6 Sol posts 10" for the current hand (blinds aren't log events). */
  const blindsNote = ref('')
  const pace = ref<Pace>('1x')

  const toast = useToast()
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
  }

  function priorTalk(seatId: string): string[] {
    const lines: string[] = []
    for (const d of decisions.value) {
      const t = d.seatId === seatId ? d.decision.tableTalk : undefined
      if (t && !lines.includes(t)) lines.push(t)
    }
    return lines.slice(-PRIOR_TALK_MAX)
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

      const handNo = state.value.handNo
      const logIndex = state.value.log.length
      const prior = priorTalk(seat.id)
      const view: SeatView = { ...seatView(state.value, seat.id), ...(prior.length ? { priorTableTalk: prior } : {}) }
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
    deal()
  }

  function stop() {
    runId++
    controller?.abort()
    controller = null
    thinking.value = null
  }

  onBeforeUnmount(stop)

  return {
    state, hasHuman, thinking, decisions, actionLabels, blindsNote, pace,
    history, startingStacks, startedAt, lineup,
    toActSeat, isHumanTurn, human, humanLegal, humanMenu, canDeal, finished,
    deal, act, stop, reset, resume: runAI
  }
}

export type Table = ReturnType<typeof useTable>
