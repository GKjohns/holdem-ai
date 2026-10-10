<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import { findModel } from '~~/shared/utils/models'
import type { RunListItem } from '~~/server/utils/results'

useSeoMeta({ title: 'Results · Hold\'em AI' })

const { data, status } = await useFetch<{ runs: RunListItem[] }>('/api/results')
const runs = computed(() => data.value?.runs ?? [])

const shortName = (id: string) => (findModel(id)?.label ?? id).replace('GPT-6 ', '').replace('Claude ', '').replace(' 3.1 Pro', '')
const columns: TableColumn<RunListItem>[] = [
  { accessorKey: 'slug', header: 'Run' },
  { accessorKey: 'lineup', header: 'Lineup' },
  { accessorKey: 'matchesComplete', header: 'Matches', meta: { class: { th: 'text-right', td: 'text-right tabular-nums' } } },
  { accessorKey: 'hands', header: 'Hands', meta: { class: { th: 'text-right', td: 'text-right tabular-nums' } } },
  { accessorKey: 'costUsd', header: 'Cost', meta: { class: { th: 'text-right', td: 'text-right tabular-nums' } } },
  { accessorKey: 'status', header: 'Status' }
]
const statusColor = (s: string | null) => s === 'complete' ? 'success' : s === 'budget' || s === 'interrupted' ? 'warning' : s === 'errors' ? 'error' : 'neutral'
</script>

<template>
  <div class="max-w-[1240px] mx-auto px-4 py-6">
    <div class="flex items-baseline gap-3 mb-1">
      <h1 class="font-serif text-2xl text-highlighted">
        Results
      </h1>
      <span class="text-sm text-muted">Duplicate-seeded tournaments from <code class="text-xs">bench/tournament.ts</code></span>
    </div>
    <p class="text-sm text-muted mb-5 max-w-[70ch]">
      Each match replays one deck seed once per seat rotation, so every model plays every seat's cards. Runs are started from the terminal; this page only reads <code class="text-xs">data/runs/</code>.
    </p>
    <UCard :ui="{ body: 'p-0 sm:p-0' }">
      <UTable
        :data="runs"
        :columns="columns"
        :loading="status === 'pending'"
        data-testid="runs-table"
      >
        <template #slug-cell="{ row }">
          <NuxtLink
            :to="`/results/${row.original.slug}`"
            class="font-medium text-highlighted hover:underline"
          >{{ row.original.slug }}</NuxtLink>
          <UBadge
            v-if="row.original.fake"
            label="fake"
            color="neutral"
            variant="outline"
            size="sm"
            class="ml-2"
          />
        </template>
        <template #lineup-cell="{ row }">
          <span class="text-muted">{{ row.original.lineup.map(shortName).join(' · ') }}</span>
        </template>
        <template #matchesComplete-cell="{ row }">
          {{ row.original.matchesComplete }}
          <span class="text-dimmed">· {{ row.original.tournamentsDone }}{{ row.original.tournamentsPlanned ? `/${row.original.tournamentsPlanned}` : '' }} t</span>
        </template>
        <template #hands-cell="{ row }">
          {{ row.original.hands.toLocaleString() }}
        </template>
        <template #costUsd-cell="{ row }">
          ${{ row.original.costUsd.toFixed(2) }}
        </template>
        <template #status-cell="{ row }">
          <UBadge
            :label="row.original.status ?? 'running'"
            :color="statusColor(row.original.status)"
            variant="soft"
            size="sm"
          />
        </template>
        <template #empty>
          <div class="py-8 text-sm text-dimmed text-center">
            No runs yet. Start one with <code>node --env-file=.env bench/tournament.ts --dry-run</code>.
          </div>
        </template>
      </UTable>
    </UCard>
  </div>
</template>
