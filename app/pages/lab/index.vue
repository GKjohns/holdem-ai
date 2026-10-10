<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { LabListItem } from '~~/server/utils/lab'

useSeoMeta({ title: 'Strategy Lab · Hold\'em AI' })

const { data, status } = await useFetch<{ runs: LabListItem[] }>('/api/lab')
const runs = computed(() => data.value?.runs ?? [])
const num = { th: 'text-right', td: 'text-right tabular-nums' }
const columns: TableColumn<LabListItem>[] = [
  { accessorKey: 'run', header: 'Lab run' },
  { accessorKey: 'gens', header: 'Generations', meta: { class: num } },
  { accessorKey: 'cards', header: 'Cards', meta: { class: num } },
  { accessorKey: 'hands', header: 'Hands', meta: { class: num } },
  { accessorKey: 'spend', header: 'Cost', meta: { class: num } },
  { accessorKey: 'status', header: 'Status' }
]
const statusColor = (s: string) => s === 'complete' ? 'success' : s === 'budget' || s === 'interrupted' ? 'warning' : s === 'errors' ? 'error' : 'neutral'
</script>

<template>
  <div class="max-w-[1240px] mx-auto px-4 py-6">
    <div class="flex items-baseline gap-3 mb-1">
      <h1 class="font-serif text-2xl text-highlighted">
        Strategy Lab
      </h1>
      <span class="text-sm text-muted">Fable writes strategy cards; duplicate matches decide which win</span>
    </div>
    <p class="text-sm text-muted mb-5 max-w-[72ch]">
      A player is one cheap base model plus a strategy card. Every card plays at its own table against the same field, with a card-less copy of the base model as the control. Runs start from the terminal (<code class="text-xs">bench/lab.ts</code>); this page reads <code class="text-xs">data/lab/</code>.
    </p>
    <UCard :ui="{ body: 'p-0 sm:p-0' }">
      <UTable
        :data="runs"
        :columns="columns"
        :loading="status === 'pending'"
        data-testid="lab-runs"
      >
        <template #run-cell="{ row }">
          <NuxtLink
            :to="`/lab/${row.original.run}`"
            class="font-medium text-highlighted hover:underline"
          >{{ row.original.run }}</NuxtLink>
          <UBadge
            v-if="row.original.fake"
            label="fake"
            color="neutral"
            variant="outline"
            size="sm"
            class="ml-2"
          />
        </template>
        <template #hands-cell="{ row }">
          {{ row.original.hands.toLocaleString() }}
        </template>
        <template #spend-cell="{ row }">
          ${{ row.original.spend.toFixed(2) }}
        </template>
        <template #status-cell="{ row }">
          <UBadge
            :label="row.original.status"
            :color="statusColor(row.original.status)"
            variant="soft"
            size="sm"
          />
        </template>
        <template #empty>
          <div class="py-8 text-sm text-dimmed text-center">
            No lab runs yet. Start one with <code>node --env-file=.env bench/lab.ts --run &lt;slug&gt; --dry-run</code>.
          </div>
        </template>
      </UTable>
    </UCard>
  </div>
</template>
