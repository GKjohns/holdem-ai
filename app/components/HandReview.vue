<script setup lang="ts">
import type { Card, Seat } from '~~/shared/utils/types'
import { findModel } from '~~/shared/utils/models'
import type { DecisionRecord } from '~/composables/useTable'

const props = defineProps<{
  seats: Pick<Seat, 'id' | 'name' | 'modelId'>[]
  decisions: DecisionRecord[]
  actionLabels: string[]
  deltas: Record<string, number>
  /** Hole cards each seat may show: showdown cards in Play mode, everything in Watch mode. */
  held: Record<string, Card[]>
}>()

const STREET: Record<string, string> = { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River' }

const fmtMs = (ms: number) => ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`

/** One accordion row per AI seat that made a decision this hand, in seat order. */
const items = computed(() => props.seats
  .filter(s => s.modelId)
  .map((s) => {
    const decs = props.decisions.filter(d => d.seatId === s.id)
    const total = decs.reduce((a, d) => a + d.decision.latencyMs, 0)
    return {
      value: s.id,
      seat: s,
      decs,
      summary: `${decs.length} ${decs.length > 1 ? 'decisions' : 'decision'} · ${fmtMs(total)}`
    }
  })
  .filter(i => i.decs.length))

// Open the first LLM by default: its prose is the most readable thing in the review.
const firstOpen = computed(() => items.value.find(i => findModel(i.seat.modelId)?.kind === 'llm')?.value ?? items.value[0]?.value)
const open = ref<string[]>([])
watch(() => props.decisions, () => {
  open.value = firstOpen.value ? [firstOpen.value] : []
}, { immediate: true })

const delta = (id: string) => props.deltas[id] ?? 0
</script>

<template>
  <UAccordion
    v-model="open"
    type="multiple"
    :items="items"
    :ui="{ item: 'border-b border-muted last:border-b-0', trigger: 'px-4 py-2.5 min-w-0', label: 'min-w-0 flex-1', body: 'px-4 pb-3 pt-0' }"
  >
    <template #default="{ item }">
      <span class="flex items-center gap-2 min-w-0 text-[13px]">
        <span
          class="size-2 rounded-full bg-(--c) shrink-0"
          :style="{ '--c': seatColor(item.seat.modelId) }"
        />
        <span class="font-semibold text-highlighted truncate">{{ item.seat.name }}</span>
        <UBadge
          :label="kindLabel(item.seat.modelId)!"
          size="sm"
          variant="outline"
          color="neutral"
        />
        <span class="text-xs text-dimmed font-normal tabular-nums whitespace-nowrap">{{ item.summary }}</span>
      </span>
    </template>
    <template #body="{ item }">
      <div class="flex items-center gap-1.5 text-xs text-muted mb-2">
        <template v-if="held[item.value]?.length">
          Held
          <PlayingCard
            v-for="c in held[item.value]"
            :key="c"
            :card="c"
            size="sm"
          />
        </template>
        <span v-else>Cards not shown</span>
        <span
          class="ml-auto num text-[13px] font-semibold"
          :class="delta(item.value) > 0 ? 'text-success' : delta(item.value) < 0 ? 'text-error' : 'text-muted'"
        >{{ delta(item.value) > 0 ? '+' : delta(item.value) < 0 ? '−' : '±' }}{{ Math.abs(delta(item.value)).toLocaleString() }}</span>
      </div>
      <div
        v-for="d in item.decs"
        :key="d.logIndex"
        class="py-1.5 border-t border-muted first:border-t-0"
      >
        <div class="flex items-center gap-2 text-[12.5px]">
          <span class="stat-label w-[52px] shrink-0">{{ STREET[d.street] ?? d.street }}</span>
          <b class="font-semibold text-highlighted">{{ actionLabels[d.logIndex] ?? d.decision.action.type }}</b>
          <span class="ml-auto text-[11px] text-dimmed tabular-nums">{{ d.decision.latencyMs.toLocaleString() }} ms</span>
        </div>
        <p
          v-if="d.decision.tableTalk"
          class="mt-0.5 ml-[60px] text-[12.5px] italic"
        >
          “{{ d.decision.tableTalk }}”
        </p>
        <DecisionDetail
          :decision="d.decision"
          detailed
          class="ml-[60px]!"
        />
      </div>
    </template>
  </UAccordion>
</template>
