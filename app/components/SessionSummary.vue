<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { SummaryRow } from '~/utils/session'
import type { Seat } from '~~/shared/utils/types'
import { statsLine, type ScoutingReport } from '~~/shared/utils/narration'
import { findModel } from '~~/shared/utils/models'

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
  /** The Booth's spend, shown as its own "Narrator" row; null when it never ran. */
  narrator: { model: string, hands: number, avgMs: number, costUsd: number } | null
  scouting: ScoutingReport | null
  scoutingStatus: 'idle' | 'loading' | 'error'
  scoutingMd: string
  seats: Pick<Seat, 'id' | 'name' | 'modelId'>[]
}>()

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ again: [], newTable: [], scout: [] }>()

type Row = SummaryRow & { narrator?: boolean }
const tableRows = computed<Row[]>(() => props.narrator
  ? [...props.rows, { id: 'narrator', name: 'Narrator', modelId: props.narrator.model, stack: 0, net: 0, handsWon: 0, decisions: props.narrator.hands, avgMs: props.narrator.avgMs, costUsd: props.narrator.costUsd, narrator: true }]
  : props.rows)

const you = computed(() => props.rows.find(r => r.id === 'you'))
const best = computed(() => props.rows.find(r => r.modelId))
const cost = computed(() => tableRows.value.reduce((a, r) => a + (r.costUsd ?? 0), 0))

const seatOf = (id: string) => props.seats.find(s => s.id === id)
const narratorName = computed(() => props.scouting ? (findModel(props.scouting.model)?.label ?? props.scouting.model) : '')
const toast = useToast()
const copied = ref(false)
async function copyMarkdown() {
  try {
    await navigator.clipboard.writeText(props.scoutingMd)
    copied.value = true
    setTimeout(() => (copied.value = false), 2000)
  } catch {
    toast.add({ title: 'Couldn\'t reach the clipboard', description: 'The report is also saved next to the session log in data/sessions/.', color: 'warning' })
  }
}
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n).toLocaleString()}`

const title = computed(() => {
  if (props.reason === 'cleaned') return 'You cleaned out the table'
  if (props.reason === 'busted') return 'You\'re out of chips'
  return props.watching && props.reason ? 'The table is finished' : 'Session summary'
})

const columns: TableColumn<Row>[] = [
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
          :data="tableRows"
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
              <span
                v-if="row.original.narrator"
                class="text-xs text-dimmed"
              >{{ row.original.decisions }} {{ row.original.decisions === 1 ? 'hand' : 'hands' }}{{ scouting ? ' + report' : '' }}</span>
              <UBadge
                v-else-if="kindLabel(row.original.modelId)"
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
              v-if="row.original.narrator"
              class="text-dimmed"
            >—</span>
            <span
              v-else
              class="num font-medium"
              :class="row.original.net > 0 ? 'text-success' : row.original.net < 0 ? 'text-error' : 'text-muted'"
            >{{ signed(row.original.net) }}</span>
          </template>
          <template #handsWon-cell="{ row }">
            <span :class="row.original.narrator && 'text-dimmed'">{{ row.original.narrator ? '—' : row.original.handsWon }}</span>
          </template>
          <template #avgMs-cell="{ row }">
            <span :class="row.original.avgMs === null && 'text-dimmed'">{{ fmtMs(row.original.avgMs) }}</span>
          </template>
          <template #costUsd-cell="{ row }">
            <span :class="row.original.costUsd === null && 'text-dimmed'">{{ row.original.costUsd === null ? '—' : usd(row.original.costUsd) }}</span>
          </template>
        </UTable>
      </div>
      <div
        class="border-t border-default px-4 py-4 sm:px-6"
        data-testid="scouting-report"
      >
        <div class="flex items-center gap-2 flex-wrap">
          <UIcon
            name="i-lucide-mic"
            class="size-4 text-muted"
          />
          <h3 class="text-[15px] font-semibold text-highlighted">
            Scouting report
          </h3>
          <span
            v-if="scouting"
            class="text-xs text-dimmed"
          >{{ scouting.hands }} hands · {{ narratorName }}</span>
          <UButton
            v-if="scouting"
            class="ml-auto"
            size="xs"
            color="neutral"
            variant="outline"
            :icon="copied ? 'i-lucide-check' : 'i-lucide-clipboard-copy'"
            :label="copied ? 'Copied' : 'Copy as Markdown'"
            @click="copyMarkdown"
          />
        </div>
        <div
          v-if="scoutingStatus === 'loading' && !scouting"
          class="mt-3 space-y-2"
        >
          <p class="text-[13px] text-muted">
            The Booth is scouting every seat from the stats and the notable hands…
          </p>
          <USkeleton class="h-3.5 w-11/12" />
          <USkeleton class="h-3.5 w-4/5" />
          <USkeleton class="h-3.5 w-2/3" />
        </div>
        <div
          v-else-if="!scouting"
          class="mt-2 flex items-center gap-3 flex-wrap"
        >
          <p class="text-[13px] text-muted">
            {{ scoutingStatus === 'error' ? 'The narrator didn\'t answer.' : hands ? 'A profile of each model from this session\'s stats and hands: style, tendencies, how to beat it. One narrator call.' : 'Play a hand first.' }}
          </p>
          <UButton
            v-if="hands"
            size="xs"
            color="neutral"
            variant="outline"
            icon="i-lucide-sparkles"
            :label="scoutingStatus === 'error' ? 'Try again' : 'Write the scouting report'"
            @click="emit('scout')"
          />
        </div>
        <template v-else>
          <p class="mt-2 text-[13px] leading-relaxed text-toned">
            {{ scouting.overview }}
          </p>
          <div
            v-for="s in scouting.seats"
            :key="s.seatId"
            class="mt-4"
          >
            <div class="flex items-center gap-2 flex-wrap">
              <span
                class="size-2 rounded-full bg-(--c) shrink-0"
                :style="{ '--c': chartColor(seatOf(s.seatId)?.modelId ?? null) }"
              />
              <b class="text-[14px] font-semibold text-highlighted">{{ seatOf(s.seatId)?.name ?? s.seatId }}</b>
              <UBadge
                :label="s.styleLabel"
                size="sm"
                color="neutral"
                variant="soft"
              />
            </div>
            <p
              v-if="scouting.stats.find(x => x.seatId === s.seatId)"
              class="mt-1 text-[11.5px] text-dimmed tabular-nums"
            >
              {{ statsLine(scouting.stats.find(x => x.seatId === s.seatId)!) }}
            </p>
            <ul class="mt-1.5 list-disc pl-5 text-[13px] leading-relaxed text-toned space-y-0.5">
              <li
                v-for="(t, i) in s.tendencies"
                :key="i"
              >
                {{ t }}
              </li>
            </ul>
            <dl class="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[13px] leading-relaxed">
              <dt class="text-muted">
                Signature
              </dt>
              <dd class="text-toned">
                <span class="num font-medium text-highlighted">#{{ s.signatureHand.handNo }}</span> {{ s.signatureHand.why }}
              </dd>
              <dt class="text-muted">
                Beat it
              </dt>
              <dd class="text-toned">
                {{ s.howToBeat }}
              </dd>
              <dt class="text-muted">
                Voice
              </dt>
              <dd class="text-toned">
                {{ s.voice }}
              </dd>
            </dl>
          </div>
        </template>
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
