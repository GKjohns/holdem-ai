<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { Seat } from '~~/shared/utils/types'
import { seatStats, type SeatStats } from '~~/shared/utils/stats'
import type { DecisionRecord, HandRecord } from '~/composables/useTable'

const props = defineProps<{
  seats: Pick<Seat, 'id' | 'name' | 'modelId'>[]
  hands: HandRecord[]
  /** Every AI decision this session (latency and cost only; nothing about reasoning is shown). */
  decisions: DecisionRecord[]
}>()

type Row = SeatStats & { name: string, modelId: string | null }

const rows = computed<Row[]>(() => {
  const byId = new Map(props.seats.map(s => [s.id, s]))
  return seatStats(props.seats.map(s => s.id), props.hands, props.decisions).map(st => ({
    ...st,
    name: byId.get(st.seatId)!.name,
    modelId: byId.get(st.seatId)!.modelId
  }))
})

const num = { th: 'text-right px-1', td: 'text-right tabular-nums px-1' }
const columns: TableColumn<Row>[] = [
  { accessorKey: 'name', header: 'Seat', meta: { class: { th: 'pl-3 pr-1', td: 'pl-3 pr-1' } } },
  { accessorKey: 'vpip', header: 'VPIP', meta: { class: num } },
  { accessorKey: 'pfr', header: 'PFR', meta: { class: num } },
  { accessorKey: 'af', header: 'AF', meta: { class: num } },
  { accessorKey: 'wtsd', header: 'WTSD', meta: { class: num } },
  { accessorKey: 'wsd', header: 'W$SD', meta: { class: num } },
  { accessorKey: 'avgMs', header: 'Avg', meta: { class: num } },
  { accessorKey: 'costUsd', header: 'Cost', meta: { class: { th: 'text-right pl-1 pr-3', td: 'text-right tabular-nums pl-1 pr-3' } } }
]

/** The storyboard's short labels, so eight columns fit the 360 px panel. */
const short = (name: string) => name.replace('GPT-6 ', '').replace('Claude ', '').replace(' Decisions', ' Dec.').replace(' 3.1 Pro', '')
const pct = (v: number | null) => v === null ? '—' : `${Math.round(v)}%`
const af = (v: number | null) => v === null ? '—' : v === Infinity ? '∞' : v.toFixed(1)
const ms = (v: number | null) => v === null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`
const usd = (r: Row) => r.modelId === null ? '—' : r.costUsd > 0 && r.costUsd < 0.001 ? `$${r.costUsd.toFixed(4)}` : `$${r.costUsd.toFixed(3)}`
</script>

<template>
  <div>
    <p
      v-if="!hands.length"
      class="px-4 py-8 text-sm text-dimmed text-center"
    >
      Stats start after the first finished hand.
    </p>
    <div
      v-else
      class="overflow-x-auto"
      data-testid="seat-stats"
    >
      <UTable
        :data="rows"
        :columns="columns"
        :ui="{ th: 'text-[11px] whitespace-nowrap py-2', td: 'text-xs py-2 whitespace-nowrap' }"
      >
        <template #name-cell="{ row }">
          <span class="inline-flex items-center gap-1.5">
            <span
              class="size-2 rounded-full bg-(--c) shrink-0"
              :style="{ '--c': chartColor(row.original.modelId) }"
            />
            <span class="min-w-0">
              <b class="block font-semibold text-highlighted leading-tight">{{ short(row.original.name) }}</b>
              <span class="block text-[11px] text-dimmed leading-tight">{{ row.original.hands }} {{ row.original.hands === 1 ? 'hand' : 'hands' }}</span>
            </span>
          </span>
        </template>
        <template #vpip-cell="{ row }">
          {{ pct(row.original.vpip) }}
        </template>
        <template #pfr-cell="{ row }">
          {{ pct(row.original.pfr) }}
        </template>
        <template #af-cell="{ row }">
          {{ af(row.original.af) }}
        </template>
        <template #wtsd-cell="{ row }">
          {{ pct(row.original.wtsd) }}
        </template>
        <template #wsd-cell="{ row }">
          {{ pct(row.original.wsd) }}
        </template>
        <template #avgMs-cell="{ row }">
          <span :class="row.original.avgMs === null && 'text-dimmed'">{{ ms(row.original.avgMs) }}</span>
        </template>
        <template #costUsd-cell="{ row }">
          <span :class="row.original.modelId === null && 'text-dimmed'">{{ usd(row.original) }}</span>
        </template>
      </UTable>
    </div>
    <dl
      v-if="hands.length"
      class="px-4 py-3 border-t border-default grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-0.5 text-[11.5px] text-muted"
    >
      <dt class="font-medium text-toned">
        VPIP
      </dt><dd>put chips in preflop by choice (blinds don't count)</dd>
      <dt class="font-medium text-toned">
        PFR
      </dt><dd>raised preflop</dd>
      <dt class="font-medium text-toned">
        AF
      </dt><dd>postflop bets and raises per call</dd>
      <dt class="font-medium text-toned">
        WTSD
      </dt><dd>went to showdown, of hands that saw the flop</dd>
      <dt class="font-medium text-toned">
        W$SD
      </dt><dd>won a pot at showdown</dd>
    </dl>
  </div>
</template>
