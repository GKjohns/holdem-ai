<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { SummaryRow } from '~/utils/session'

const props = defineProps<{
  rows: SummaryRow[]
  hands: number
  minutes: number
  smallBlind: number
  bigBlind: number
  startingStack: string
  /** Why the session ended on its own (bust / cleaned out / cap); null when the player left. */
  reason: string | null
  watching: boolean
}>()

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ again: [], newTable: [] }>()

const you = computed(() => props.rows.find(r => r.id === 'you'))
const best = computed(() => props.rows.find(r => r.modelId))
const cost = computed(() => props.rows.reduce((a, r) => a + (r.costUsd ?? 0), 0))
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n).toLocaleString()}`

const title = computed(() => {
  if (props.reason === 'cleaned') return 'You cleaned out the table'
  if (props.reason === 'busted') return 'You\'re out of chips'
  return props.watching && props.reason ? 'The table is finished' : 'Session summary'
})

const columns: TableColumn<SummaryRow>[] = [
  { accessorKey: 'name', header: 'Player' },
  { accessorKey: 'net', header: 'Net chips', meta: { class: { th: 'text-right', td: 'text-right' } } },
  { accessorKey: 'handsWon', header: 'Hands won', meta: { class: { th: 'text-right', td: 'text-right tabular-nums' } } },
  { accessorKey: 'avgMs', header: 'Avg decision', meta: { class: { th: 'text-right', td: 'text-right tabular-nums' } } },
  { accessorKey: 'costUsd', header: 'Cost', meta: { class: { th: 'text-right', td: 'text-right tabular-nums' } } }
]
/** Decision models cost fractions of a cent per hand; show enough digits that they aren't all $0.000. */
const usd = (v: number) => v > 0 && v < 0.0001 ? '<$0.0001' : `$${v > 0 && v < 0.001 ? v.toFixed(4) : v.toFixed(3)}`
const fmtMs = (ms: number | null) => ms === null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`
</script>

<template>
  <UModal
    v-model:open="open"
    :title="title"
    :description="`${hands} ${hands === 1 ? 'hand' : 'hands'} · ${minutes} min · blinds ${smallBlind}/${bigBlind} · ${startingStack} starting stacks`"
    :ui="{ content: 'sm:max-w-2xl', body: 'p-0 sm:p-0', footer: 'justify-end gap-2' }"
  >
    <template #body>
      <div
        class="grid grid-cols-3 border-b border-default"
        data-testid="session-summary"
      >
        <div class="px-4 py-3.5 sm:px-6">
          <div class="stat-label">
            {{ you ? 'You finished' : 'Chip leader' }}
          </div>
          <div
            v-if="you"
            class="num text-2xl mt-1.5"
            :class="you.net > 0 ? 'text-success' : you.net < 0 ? 'text-error' : 'text-highlighted'"
          >
            {{ signed(you.net) }}
          </div>
          <div
            v-else
            class="text-[17px] font-semibold text-highlighted mt-2 truncate"
          >
            {{ rows[0]?.name }}
          </div>
        </div>
        <div class="px-4 py-3.5 sm:px-6 border-l border-default min-w-0">
          <div class="stat-label">
            Best model
          </div>
          <div class="text-[15px] sm:text-[17px] font-semibold text-highlighted mt-2 truncate">
            {{ best?.name ?? '—' }}
          </div>
        </div>
        <div class="px-4 py-3.5 sm:px-6 border-l border-default">
          <div class="stat-label">
            Session cost
          </div>
          <div class="num text-2xl text-highlighted mt-1.5">
            {{ usd(cost) }}
          </div>
        </div>
      </div>
      <div class="overflow-x-auto">
        <UTable
          :data="rows"
          :columns="columns"
          :ui="{ th: 'text-xs whitespace-nowrap', td: 'text-[13px] py-2.5' }"
        >
          <template #name-cell="{ row }">
            <span class="inline-flex items-center gap-2 whitespace-nowrap">
              <span
                class="size-2 rounded-full bg-(--c) shrink-0"
                :style="{ '--c': chartColor(row.original.modelId) }"
              />
              <b class="font-semibold text-highlighted">{{ row.original.name }}</b>
              <UBadge
                v-if="kindLabel(row.original.modelId)"
                :label="kindLabel(row.original.modelId)!"
                size="sm"
                variant="outline"
                color="neutral"
                class="max-sm:hidden"
              />
            </span>
          </template>
          <template #net-cell="{ row }">
            <span
              class="num font-medium"
              :class="row.original.net > 0 ? 'text-success' : row.original.net < 0 ? 'text-error' : 'text-muted'"
            >{{ signed(row.original.net) }}</span>
          </template>
          <template #avgMs-cell="{ row }">
            <span :class="row.original.avgMs === null && 'text-dimmed'">{{ fmtMs(row.original.avgMs) }}</span>
          </template>
          <template #costUsd-cell="{ row }">
            <span :class="row.original.costUsd === null && 'text-dimmed'">{{ row.original.costUsd === null ? '—' : usd(row.original.costUsd) }}</span>
          </template>
        </UTable>
      </div>
    </template>
    <template #footer>
      <UButton
        label="New table"
        color="neutral"
        variant="outline"
        @click="emit('newTable')"
      />
      <UButton
        :label="watching ? 'Watch again (same table)' : 'Play again (same table)'"
        @click="emit('again')"
      />
    </template>
  </UModal>
</template>
