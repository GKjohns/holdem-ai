<script setup lang="ts">
import type { TableState } from '~~/shared/utils/types'
import { potTotal } from '~~/shared/utils/table'
import { costUsd } from '~~/shared/utils/pricing'
import type { DecisionRecord, HandRecord } from '~/composables/useTable'

const props = defineProps<{
  state: TableState
  actionLabels: string[]
  blindsNote: string
  thinking: string | null
  /** Chips the human owes, when it's their turn. */
  humanToCall: number | null
  /** Watch mode, or a finished hand: show reasoning / probabilities. */
  reveal: boolean
  /** This hand's AI decisions. Pass [] while sealed. */
  decisions: DecisionRecord[]
  watching?: boolean
  history: HandRecord[]
  startingStacks: Record<string, number>
  /** Every AI decision this session, for the Stats tab's latency and cost columns. */
  allDecisions: DecisionRecord[]
}>()

const tab = ref<'talk' | 'hands' | 'chips' | 'stats'>('talk')
const tabs = computed(() => [
  { label: 'Table talk', value: 'talk' },
  { label: 'Hands', value: 'hands', badge: props.history.length ? { label: String(props.history.length), color: 'neutral' as const, variant: 'soft' as const } : undefined },
  { label: 'Chips', value: 'chips' },
  { label: 'Stats', value: 'stats' }
])

const STREET_LABEL: Record<string, string> = { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River', complete: 'Done' }
const streetLabel = computed(() => STREET_LABEL[props.state.street] ?? '')

const decisionMap = computed(() => new Map(props.decisions.map(d => [d.logIndex, d.decision])))
/** Play mode, hand over: the per-seat review replaces the live log. */
const reviewing = computed(() => !props.watching && props.state.street === 'complete' && props.reveal && props.state.handNo > 0)
const handCost = computed(() => props.decisions.reduce((a, d) => a + costUsd(d.decision.model, d.decision.usage), 0))

/** What each seat may show in the review: showdown cards, plus your own. */
const held = computed(() => {
  const out: Record<string, TableState['seats'][number]['hole']> = {}
  for (const s of props.state.seats) {
    const shown = props.state.result?.shown[s.id]?.cards
    if (shown) out[s.id] = shown
    else if (props.watching && s.hole.length) out[s.id] = s.hole
  }
  return out
})
</script>

<template>
  <UCard :ui="{ header: 'px-3 py-2.5 sm:px-3', body: 'p-0 sm:p-0', footer: 'px-4 py-3 sm:px-4' }">
    <template #header>
      <div class="flex items-center gap-2">
        <UTabs
          v-model="tab"
          :items="tabs"
          :content="false"
          size="xs"
          color="neutral"
          class="flex-1 min-w-0"
          :ui="{ list: 'w-auto', trigger: 'grow-0' }"
        />
        <UBadge
          v-if="state.handNo"
          :label="`#${state.handNo} · ${streetLabel}`"
          color="neutral"
          variant="soft"
          class="shrink-0"
        />
      </div>
    </template>

    <div class="lg:max-h-[max(560px,calc(100vh-190px))] overflow-y-auto">
      <template v-if="tab === 'talk'">
        <template v-if="reviewing">
          <div class="px-4 pt-3 pb-2 flex items-baseline gap-2">
            <h3 class="text-[13px] font-semibold text-highlighted">
              Hand review
            </h3>
            <span class="text-xs text-dimmed">every AI decision this hand, by seat</span>
          </div>
          <HandReview
            :seats="state.seats"
            :decisions="decisions"
            :action-labels="actionLabels"
            :deltas="state.result?.deltas ?? {}"
            :held="held"
          />
          <p
            v-if="!decisions.length"
            class="px-4 pb-4 text-sm text-dimmed"
          >
            No AI acted this hand.
          </p>
        </template>
        <HandLog
          v-else-if="state.handNo"
          :seats="state.seats"
          :log="state.log"
          :board="state.board"
          :action-labels="actionLabels"
          :blinds-note="blindsNote"
          :reveal="reveal"
          :decisions="decisionMap"
          :thinking="thinking"
          :human-to-call="humanToCall"
          :pot="potTotal(state)"
        />
        <p
          v-else
          class="px-4 py-8 text-sm text-dimmed text-center"
        >
          Shuffling up…
        </p>
      </template>
      <HandHistory
        v-else-if="tab === 'hands'"
        :hands="history"
        :seats="state.seats"
        :has-human="!watching"
      />
      <ChipChart
        v-else-if="tab === 'chips'"
        :seats="state.seats"
        :hands="history"
        :starting-stacks="startingStacks"
      />
      <SeatStatsTable
        v-else
        :seats="state.seats"
        :hands="history"
        :decisions="allDecisions"
      />
    </div>

    <template #footer>
      <div class="flex items-center gap-1.5 text-xs text-muted">
        <template v-if="tab === 'talk' && reviewing">
          <UIcon
            name="i-lucide-lock-open"
            class="size-[13px] shrink-0"
          />
          {{ decisions.length }} AI {{ decisions.length === 1 ? 'decision' : 'decisions' }} · ${{ handCost.toFixed(3) }} this hand. The full action log is under Hands.
        </template>
        <template v-else-if="tab === 'stats'">
          <UIcon
            name="i-lucide-sigma"
            class="size-[13px] shrink-0"
          />
          {{ history.length }} finished {{ history.length === 1 ? 'hand' : 'hands' }}. Computed in stats.ts from the action log; no seated model ever sees these numbers.
        </template>
        <template v-else-if="tab !== 'talk'">
          <UIcon
            name="i-lucide-history"
            class="size-[13px] shrink-0"
          />
          Finished hands only{{ watching ? '' : ', so nothing from the hand in play shows here' }}. Kept in memory until you leave.
        </template>
        <template v-else-if="watching">
          <UIcon
            name="i-lucide-eye"
            class="size-[13px] shrink-0"
          />
          Nobody human is seated, so every card, reasoning and probability is live. Each model still sees only its own cards.
        </template>
        <template v-else>
          <UIcon
            name="i-lucide-lock"
            class="size-[13px] shrink-0"
          />
          Model reasoning and decision probabilities are sealed until the hand ends, so nothing leaks mid-hand.
        </template>
      </div>
    </template>
  </UCard>
</template>
