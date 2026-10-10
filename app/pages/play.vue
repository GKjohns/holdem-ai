<script setup lang="ts">
import { DEFAULT_LINEUP, MODELS } from '~~/shared/utils/models'
import { legalActions } from '~~/shared/utils/table'
import type { Lineup } from '~/composables/useLineup'
import { HAND_CAP } from '~/composables/useTable'

const route = useRoute()
const lineup = useLineup()
const { meta, leaveRequests, costCap, narratorOn } = useTableHeader()

// Debug params (no setup screen needed):
//   ?stacks=100,500,1000,1000,1000  starting stacks per seat (side-pot screenshots)
//   ?seats=jev,gpt-6-luna           opponents by id or id suffix
//   ?mode=watch                     all-AI table
const q = route.query
const debugStacks = typeof q.stacks === 'string'
  ? q.stacks.split(',').map(Number).filter(n => Number.isInteger(n) && n >= 0)
  : undefined
const debugSeats = typeof q.seats === 'string'
  ? q.seats.split(',').map(s => MODELS.find(m => m.id === s || m.id.endsWith(`/${s}`))?.id).filter(id => id !== undefined)
  : undefined
const debugMode = q.mode === 'watch' ? 'watch' as const : q.mode === 'play' ? 'play' as const : undefined

function resolveLineup(): Lineup | null {
  const base: Lineup = { mode: 'play', seats: DEFAULT_LINEUP.slice(), stack: 1000, smallBlind: 5, bigBlind: 10, ...lineup.value }
  if (debugMode) base.mode = debugMode
  const max = base.mode === 'watch' ? 6 : 5
  if (debugSeats?.length) return { ...base, seats: debugSeats.slice(0, max) }
  if (lineup.value) return base
  if (debugStacks && debugStacks.length >= 2) {
    const n = base.mode === 'watch' ? debugStacks.length : debugStacks.length - 1
    return { ...base, seats: Array.from({ length: Math.min(max, n) }, (_, i) => DEFAULT_LINEUP[i % DEFAULT_LINEUP.length]!) }
  }
  return null
}

// A reload (or HMR) resumes the saved session silently: setup clears the snapshot before a new table, and a
// debug URL resumes only a session with the same mode and seats. /play is client-only (routeRules in
// nuxt.config), so localStorage is readable here.
const requested = resolveLineup()
const saved = loadSnapshot()
const snapshot = saved && (!requested || (requested.mode === saved.lineup.mode && requested.seats.join() === saved.lineup.seats.join())) ? saved : null
if (snapshot) {
  lineup.value = snapshot.lineup
  if (snapshot.cap > 0) costCap.value = snapshot.cap
  if (typeof snapshot.narratorOn === 'boolean') narratorOn.value = snapshot.narratorOn
}
const resolved = snapshot?.lineup ?? requested
if (!resolved) await navigateTo('/')

const table = useTable(resolved ?? { mode: 'play', seats: DEFAULT_LINEUP, stack: 1000, smallBlind: 5, bigBlind: 10 }, { stacks: debugStacks, cap: costCap, narratorOn, restore: snapshot ?? undefined })
const { narrations, narrating, narrationFailed, narratorSpent, scouting, scoutingStatus, scoutingMd } = table
const { state, hasHuman, thinking, decisions, actionLabels, blindsNote, human, humanLegal, humanMenu, canDeal, finished, toActSeat, pace, history, startingStacks, spent, capped } = table

const complete = computed(() => state.value.street === 'complete')
const waitingOn = computed(() => toActSeat.value && toActSeat.value.modelId ? toActSeat.value.name : null)
const summary = computed(() => {
  const r = state.value.result
  if (!r || !human.value) return ''
  const delta = r.deltas.you ?? 0
  const shown = r.shown.you?.handName
  if (delta > 0) return `You won ${(delta + human.value.totalCommitted).toLocaleString()}${shown ? ` with ${shown.toLowerCase()}` : ''}`
  if (human.value.folded) return delta < 0 ? `You folded and lost ${(-delta).toLocaleString()}` : 'You folded'
  if (delta === 0) return 'You broke even this hand'
  return `You lost ${(-delta).toLocaleString()}${shown ? ` with ${shown.toLowerCase()}` : ''}`
})
const humanToCall = computed(() => table.isHumanTurn.value ? legalActions(state.value)?.toCall ?? null : null)

// Information hygiene: with a human seated, nothing about AI decisions reaches the panel mid-hand.
const reveal = computed(() => canRevealReasoning({ hasHuman, street: state.value.street }))
const handDecisions = computed(() => reveal.value ? decisions.value.filter(d => d.handNo === state.value.handNo) : [])

watchEffect(() => {
  meta.value = state.value.handNo
    ? { handNo: state.value.handNo, smallBlind: state.value.smallBlind, bigBlind: state.value.bigBlind, costUsd: spent.value, capped: capped.value }
    : null
})
// Session summary: on "Leave table", or by itself when the session can't go on.
const summaryOpen = ref(false)
const summaryReason = ref<string | null>(null)
const summaryMinutes = ref(1)
let pausedFor: typeof pace.value | null = null

function openSummary(reason: string | null) {
  summaryReason.value = reason
  summaryMinutes.value = Math.max(1, Math.round((Date.now() - table.startedAt.value) / 60_000))
  // Watch mode keeps dealing behind a modal; hold it while the summary is up.
  if (!hasHuman && pace.value !== 'pause' && !finished.value) {
    pausedFor = pace.value
    pace.value = 'pause'
  }
  summaryOpen.value = true
  table.endSession(reason)
  table.requestScouting()
}
watch(summaryOpen, (open) => {
  if (!open && pausedFor) {
    pace.value = pausedFor
    pausedFor = null
  }
})
watch(leaveRequests, () => openSummary(null))
watch(finished, (why) => {
  if (!why) return
  const h = human.value
  openSummary(!h ? 'finished' : h.stack <= 0 ? 'busted' : state.value.seats.every(s => s.id === h.id || s.stack <= 0) ? 'cleaned' : 'finished')
})

const summaryTable = computed(() => summaryRows(state.value.seats, startingStacks, history.value, decisions.value))
/** The cost table's "Narrator" row: every Booth call this session (hand write-ups + the scouting report). */
const narratorRow = computed(() => {
  const calls = [...Object.values(narrations.value), ...(scouting.value ? [scouting.value] : [])]
  if (!calls.length) return null
  return {
    model: calls[0]!.model,
    hands: Object.keys(narrations.value).length,
    avgMs: Math.round(calls.reduce((a, c) => a + c.latencyMs, 0) / calls.length),
    costUsd: narratorSpent.value
  }
})
const startingStackLabel = computed(() => {
  const v = Object.values(startingStacks)
  return v.every(x => x === v[0]) ? v[0]!.toLocaleString() : 'mixed'
})

function playAgain() {
  summaryOpen.value = false
  pausedFor = null
  table.reset()
}
function newTable() {
  table.stop()
  summaryOpen.value = false
  navigateTo('/')
}

// Restored: pick up where it stopped (re-requests an in-flight AI turn; Watch deals on). Fresh: deal hand 1.
onMounted(() => snapshot && state.value.handNo > 0 ? table.resume() : table.deal())
onBeforeUnmount(() => {
  meta.value = null
})
</script>

<template>
  <div class="max-w-[1240px] mx-auto px-4 pt-5 pb-12">
    <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px] items-start">
      <section class="min-w-0">
        <PokerTable
          :state="state"
          :thinking="thinking"
          :god-view="!hasHuman"
        />
        <ActionBar
          v-if="human"
          :hole="human.hole"
          :stack="human.stack"
          :legal="humanLegal"
          :menu="humanMenu"
          :waiting-on="waitingOn"
          :complete="complete && state.handNo > 0"
          :summary="summary"
          :can-deal="canDeal"
          :finished="finished"
          :big-blind="state.bigBlind"
          @act="table.act"
          @deal="table.deal"
        />
        <WatchBar
          v-else
          v-model:pace="pace"
          :hand-no="state.handNo"
          :hand-cap="HAND_CAP"
          :seat-count="state.seats.length"
          :finished="finished"
          :cap="costCap"
          :capped="capped"
        />
      </section>
      <aside class="min-w-0">
        <TableTalk
          v-model:narrator-on="narratorOn"
          :state="state"
          :action-labels="actionLabels"
          :blinds-note="blindsNote"
          :thinking="thinking"
          :human-to-call="humanToCall"
          :reveal="reveal"
          :decisions="handDecisions"
          :watching="!hasHuman"
          :history="history"
          :starting-stacks="startingStacks"
          :all-decisions="decisions"
          :narrations="narrations"
          :narrating="narrating"
          :narration-failed="narrationFailed"
        />
      </aside>
    </div>
    <SessionSummary
      v-model:open="summaryOpen"
      :rows="summaryTable"
      :hands="history.length"
      :minutes="summaryMinutes"
      :small-blind="state.smallBlind"
      :big-blind="state.bigBlind"
      :starting-stack="startingStackLabel"
      :reason="summaryReason"
      :watching="!hasHuman"
      :narrator="narratorRow"
      :scouting="scouting"
      :scouting-status="scoutingStatus"
      :scouting-md="scoutingMd"
      :seats="state.seats"
      @scout="table.requestScouting(true)"
      @again="playAgain"
      @new-table="newTable"
    />
  </div>
</template>
