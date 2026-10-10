<script setup lang="ts">
import type { Decision } from '~~/shared/utils/types'
import { DEFAULT_LINEUP, MODELS } from '~~/shared/utils/models'
import { legalActions } from '~~/shared/utils/table'
import type { Lineup } from '~/composables/useLineup'
import { HAND_CAP } from '~/composables/useTable'

const route = useRoute()
const lineup = useLineup()
const { meta, leaveRequests } = useTableHeader()

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

const resolved = resolveLineup()
if (!resolved) await navigateTo('/')

const table = useTable(resolved ?? { mode: 'play', seats: DEFAULT_LINEUP, stack: 1000, smallBlind: 5, bigBlind: 10 }, { stacks: debugStacks })
const { state, hasHuman, thinking, decisions, actionLabels, blindsNote, human, humanLegal, humanMenu, canDeal, finished, toActSeat, pace } = table

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
const handDecisions = computed(() => {
  const m = new Map<number, Decision>()
  if (!reveal.value) return m
  for (const d of decisions.value) if (d.handNo === state.value.handNo) m.set(d.logIndex, d.decision)
  return m
})

watchEffect(() => {
  meta.value = state.value.handNo ? { handNo: state.value.handNo, smallBlind: state.value.smallBlind, bigBlind: state.value.bigBlind } : null
})
// Sprint 4 swaps this for the session summary modal.
watch(leaveRequests, () => {
  table.stop()
  navigateTo('/')
})

onMounted(() => table.deal())
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
        />
      </section>
      <aside class="min-w-0">
        <TableTalk
          :state="state"
          :action-labels="actionLabels"
          :blinds-note="blindsNote"
          :thinking="thinking"
          :human-to-call="humanToCall"
          :reveal="reveal"
          :decisions="handDecisions"
          :watching="!hasHuman"
        />
      </aside>
    </div>
  </div>
</template>
