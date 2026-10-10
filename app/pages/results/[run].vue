<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { RunDetail } from '~~/server/utils/results'
import type { LeaderRow } from '~~/shared/utils/stats'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const slug = computed(() => String(route.params.run))
const matches = computed(() => Number(route.query.matches) || undefined)

const { data, status, error } = await useFetch<RunDetail>('/api/results', {
  query: computed(() => ({ run: slug.value, ...(matches.value ? { matches: matches.value } : {}) }))
})
useSeoMeta({ title: () => `${slug.value} · Results · Hold'em AI` })

const d = computed(() => data.value)
const label = (id: string) => d.value?.models.find(m => m.id === id)?.label ?? id
const kindOf = (id: string) => d.value?.models.find(m => m.id === id)?.kind === 'evaluation' ? 'Decision' : 'LLM'
const signed = (v: number | null, digits = 0) => v === null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`
const ci = (iv: { lo: number | null, hi: number | null }, digits = 0) => iv.lo === null || iv.hi === null ? 'n/a' : `${signed(iv.lo, digits)} to ${signed(iv.hi, digits)}`

// "Stats over" selector: every complete match, or the first N (watch the CIs narrow).
const total = computed(() => d.value?.item.matchesComplete ?? 0)
const matchOptions = computed(() => {
  const ns = [2, 3, 5, 10, 15, 20, 30].filter(n => n < total.value)
  return [{ label: `All ${total.value} matches`, value: 0 }, ...ns.map(n => ({ label: `First ${n} matches`, value: n }))]
})
const matchPick = computed({
  get: () => matches.value ?? 0,
  set: v => router.replace({ query: { ...route.query, matches: v ? String(v) : undefined } })
})

type Row = LeaderRow & { label: string, kind: string, wins: number, pl: number | null }
const rows = computed<Row[]>(() => {
  if (!d.value) return []
  return d.value.leaderboard
    .map(r => ({
      ...r,
      label: label(r.modelId),
      kind: kindOf(r.modelId),
      wins: d.value!.finishes[r.modelId]?.[0] ?? 0,
      pl: d.value!.plackettLuce[r.modelId] ?? null
    }))
    .sort((a, b) => (b.bb100.value ?? -Infinity) - (a.bb100.value ?? -Infinity))
})
const scale = computed(() => {
  const vs = rows.value.flatMap(r => [r.bb100.lo, r.bb100.hi, r.bb100.value]).filter((v): v is number => v !== null)
  const m = Math.max(10, ...vs.map(Math.abs))
  return { min: Math.min(0, ...vs, -m * 0.1), max: Math.max(0, ...vs, m * 0.1) }
})
const num = { th: 'text-right', td: 'text-right tabular-nums' }
const columns: TableColumn<Row>[] = [
  { accessorKey: 'label', header: 'Model' },
  { id: 'bb100', header: 'bb/100', meta: { class: num } },
  { id: 'ci', header: '95% CI (match bootstrap)', meta: { class: { th: 'w-[34%]', td: 'w-[34%]' } } },
  { id: 'finish', header: 'Avg finish', meta: { class: num } },
  { accessorKey: 'wins', header: '1st', meta: { class: num } },
  { accessorKey: 'pl', header: 'PL', meta: { class: num } },
  { accessorKey: 'hands', header: 'Hands', meta: { class: num } }
]

const separated = computed(() => (d.value?.pairs ?? [])
  .filter(p => p.bb100.lo !== null && p.bb100.hi !== null && (p.bb100.lo > 0 || p.bb100.hi < 0))
  .map(p => (p.bb100.value ?? 0) >= 0 ? p : { a: p.b, b: p.a, bb100: { value: -(p.bb100.value ?? 0), lo: -p.bb100.hi!, hi: -p.bb100.lo! }, avgFinish: p.avgFinish })
  .sort((x, y) => (y.bb100.value ?? 0) - (x.bb100.value ?? 0)))

const ordered = computed(() => rows.value.map(r => r.modelId))
const finishMax = computed(() => Math.max(1, ...Object.values(d.value?.finishes ?? {}).flat()))
const flowMax = computed(() => Math.max(1, ...Object.values(d.value?.flow ?? {}).flatMap(r => Object.values(r).map(Math.abs))))
const flowCell = (v: number) => {
  const a = Math.round((Math.abs(v) / flowMax.value) * 42)
  return { background: `color-mix(in oklab, var(${v >= 0 ? '--div-pos' : '--div-neg'}) ${a}%, transparent)` }
}
const ordinal = (n: number) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`

const pct = (v: number | null) => v === null ? '—' : `${Math.round(v)}%`
const ms = (v: number | null) => v === null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`
const usd = (v: number) => v > 0 && v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`
const styleRows = computed(() => ordered.value.map((id) => {
  const s = d.value!.style.find(x => x.modelId === id)!
  const o = d.value!.ops.find(x => x.modelId === id)!
  return { id, s, o }
}))

async function copyCommand() {
  if (!d.value) return
  try {
    await navigator.clipboard.writeText(d.value.command)
    toast.add({ title: 'Command copied', description: 'Same slug: a rerun is free; raise --matches to extend.', color: 'success' })
  } catch {
    toast.add({ title: 'Couldn\'t reach the clipboard', description: d.value.command, color: 'warning' })
  }
}
</script>

<template>
  <div class="max-w-[1240px] mx-auto px-4 py-6">
    <UButton
      to="/results"
      icon="i-lucide-arrow-left"
      color="neutral"
      variant="link"
      size="sm"
      class="px-0 mb-2"
    >
      All runs
    </UButton>

    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      :title="`Couldn't load ${slug}`"
      :description="error.statusMessage"
    />

    <template v-else-if="d">
      <div class="flex flex-wrap items-start gap-x-4 gap-y-3 mb-5">
        <div class="grow min-w-0">
          <h1 class="font-serif text-2xl text-highlighted break-all">
            {{ slug }}
          </h1>
          <div class="mt-1.5 flex flex-wrap items-center gap-1.5 text-sm text-muted">
            <UBadge
              v-if="d.item.fake"
              label="fake run (random play)"
              color="warning"
              variant="soft"
              size="sm"
            />
            <span>{{ d.item.format === 'sng' ? `Sit-and-go, ${d.players}-max, hand cap ${d.maxHands}` : 'Cash' }}</span>
            <span>·</span>
            <span class="tabular-nums">{{ d.item.tournamentsDone }}{{ d.item.tournamentsPlanned ? `/${d.item.tournamentsPlanned}` : '' }} tournaments</span>
            <span>·</span>
            <span class="tabular-nums">{{ d.item.hands.toLocaleString() }} hands</span>
            <span>·</span>
            <span class="tabular-nums">{{ usd(d.item.costUsd) }}</span>
            <UBadge
              :label="d.item.status ?? 'running'"
              :color="d.item.status === 'complete' ? 'success' : 'warning'"
              variant="soft"
              size="sm"
            />
          </div>
        </div>
        <USelect
          v-model="matchPick"
          :items="matchOptions"
          size="sm"
          class="w-48"
          aria-label="Matches used for the stats"
          data-testid="matches-select"
        />
        <UButton
          icon="i-lucide-terminal"
          color="neutral"
          variant="outline"
          size="sm"
          @click="copyCommand"
        >
          Run this lineup again
        </UButton>
      </div>

      <p
        v-if="!d.matchesUsed"
        class="text-sm text-muted mb-5"
      >
        No complete match yet: CIs need every rotation of a seed finished.
      </p>

      <UCard
        :ui="{ header: 'px-4 py-3 sm:px-4', body: 'p-0 sm:p-0' }"
        class="mb-5"
      >
        <template #header>
          <div class="flex flex-wrap items-baseline gap-x-3">
            <h2 class="font-medium text-highlighted">
              Leaderboard
            </h2>
            <span class="text-xs text-muted">{{ d.matchesUsed }} complete {{ d.matchesUsed === 1 ? 'match' : 'matches' }} · CIs resample whole matches (2,000 draws) · bb/100 = chips won ÷ that hand's big blind, per 100 hands</span>
          </div>
        </template>
        <div class="overflow-x-auto">
          <UTable
            :data="rows"
            :columns="columns"
            :loading="status === 'pending'"
            data-testid="leaderboard"
          >
            <template #label-cell="{ row }">
              <div class="flex items-center gap-2 whitespace-nowrap">
                <span
                  class="size-2.5 rounded-full shrink-0"
                  :style="{ background: chartColor(row.original.modelId) }"
                />
                <span class="font-medium text-highlighted">{{ row.original.label }}</span>
                <UBadge
                  :label="row.original.kind"
                  color="neutral"
                  variant="outline"
                  size="sm"
                />
              </div>
            </template>
            <template #bb100-cell="{ row }">
              <span class="num text-base text-highlighted">{{ signed(row.original.bb100.value) }}</span>
            </template>
            <template #ci-cell="{ row }">
              <div class="flex items-center gap-2">
                <CiBar
                  :value="row.original.bb100.value"
                  :lo="row.original.bb100.lo"
                  :hi="row.original.bb100.hi"
                  :min="scale.min"
                  :max="scale.max"
                  :color="chartColor(row.original.modelId)"
                  :label="`${row.original.label}: ${signed(row.original.bb100.value)} bb/100, 95% CI ${ci(row.original.bb100)}`"
                  class="grow"
                />
                <span class="text-xs text-muted tabular-nums whitespace-nowrap w-[92px] text-right">{{ ci(row.original.bb100) }}</span>
              </div>
            </template>
            <template #finish-cell="{ row }">
              <span class="tabular-nums">{{ row.original.avgFinish.value?.toFixed(2) ?? '—' }}</span>
              <span class="block text-[11px] text-dimmed tabular-nums">{{ row.original.avgFinish.lo === null ? '' : `${row.original.avgFinish.lo.toFixed(2)}–${row.original.avgFinish.hi!.toFixed(2)}` }}</span>
            </template>
            <template #wins-cell="{ row }">
              {{ row.original.wins }}<span class="text-dimmed">/{{ row.original.tournaments }}</span>
            </template>
            <template #pl-cell="{ row }">
              {{ row.original.pl === null ? '—' : signed(row.original.pl, 2) }}
            </template>
            <template #hands-cell="{ row }">
              {{ row.original.hands.toLocaleString() }}
            </template>
          </UTable>
        </div>
        <div class="px-4 py-3 border-t border-default text-sm">
          <div class="stat-label mb-2">
            Pairs that separate (95% CI of the bb/100 difference excludes 0): {{ separated.length }} of {{ d.pairs.length }}
          </div>
          <ul
            v-if="separated.length"
            class="grid sm:grid-cols-2 gap-x-6 gap-y-1"
            data-testid="separated-pairs"
          >
            <li
              v-for="p in separated"
              :key="p.a + p.b"
              class="tabular-nums text-muted"
            >
              <span class="text-highlighted">{{ label(p.a) }}</span> beats <span class="text-highlighted">{{ label(p.b) }}</span>
              by {{ signed(p.bb100.value) }} <span class="text-dimmed">({{ ci(p.bb100) }})</span>
            </li>
          </ul>
          <p
            v-else
            class="text-muted"
          >
            None yet: every pair's interval still includes zero. That's noise, not a tie.
          </p>
          <p class="mt-2 text-xs text-dimmed">
            Avg finish: 1 is best, with its 95% CI under it. PL = Plackett–Luce log-strength fit to the finish orders (0 = average).
          </p>
        </div>
      </UCard>

      <div class="grid lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-5 mb-5">
        <UCard :ui="{ header: 'px-4 py-3 sm:px-4', body: 'p-4 sm:p-4' }">
          <template #header>
            <h2 class="font-medium text-highlighted">
              bb/100 over cumulative hands
            </h2>
            <p class="text-xs text-muted">
              Running estimate after each finished tournament. Lines that flatten out have converged.
            </p>
          </template>
          <ConvergenceChart
            :models="d.models"
            :series="d.series"
          />
        </UCard>
        <UCard :ui="{ header: 'px-4 py-3 sm:px-4', body: 'p-0 sm:p-0' }">
          <template #header>
            <h2 class="font-medium text-highlighted">
              Finish positions
            </h2>
            <p class="text-xs text-muted">
              Tournaments finished in each place (shade = count).
            </p>
          </template>
          <div class="overflow-x-auto">
            <table
              class="w-full text-sm"
              data-testid="finish-table"
            >
              <thead>
                <tr class="text-xs text-muted">
                  <th class="text-left font-normal px-3 py-2">
                    Model
                  </th>
                  <th
                    v-for="p in d.players"
                    :key="p"
                    class="font-normal px-1 py-2 text-center"
                  >
                    {{ ordinal(p) }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="id in ordered"
                  :key="id"
                  class="border-t border-default"
                >
                  <td class="px-3 py-1.5 whitespace-nowrap">
                    {{ label(id) }}
                  </td>
                  <td
                    v-for="(c, i) in d.finishes[id]"
                    :key="i"
                    class="px-1 py-1"
                  >
                    <UTooltip :text="`${label(id)}: ${ordinal(i + 1)} in ${c} of ${rows.find(r => r.modelId === id)?.tournaments ?? 0} tournaments`">
                      <div
                        class="rounded-[4px] text-center tabular-nums py-1 min-w-8"
                        :style="{ background: `color-mix(in oklab, var(--ui-text-highlighted) ${Math.round((c / finishMax) * 30)}%, transparent)` }"
                      >
                        {{ c }}
                      </div>
                    </UTooltip>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </UCard>
      </div>

      <div class="grid lg:grid-cols-2 gap-5 mb-5">
        <UCard :ui="{ header: 'px-4 py-3 sm:px-4', body: 'p-0 sm:p-0' }">
          <template #header>
            <h2 class="font-medium text-highlighted">
              Head to head: chip flow
            </h2>
            <p class="text-xs text-muted">
              Net big blinds the row model took from the column model. Each losing seat's chips are split across that hand's winners by share.
            </p>
          </template>
          <div class="overflow-x-auto">
            <table
              class="w-full text-sm"
              data-testid="flow-table"
            >
              <thead>
                <tr class="text-xs text-muted">
                  <th class="text-left font-normal px-3 py-2">
                    Took from →
                  </th>
                  <th
                    v-for="id in ordered"
                    :key="id"
                    class="font-normal px-1 py-2 text-center whitespace-nowrap"
                  >
                    {{ label(id).replace('GPT-6 ', '').replace('Claude ', '').replace(' Decisions', ' Dec.').replace(' 3.1 Pro', '') }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="a in ordered"
                  :key="a"
                  class="border-t border-default"
                >
                  <td class="px-3 py-1.5 whitespace-nowrap">
                    {{ label(a) }}
                  </td>
                  <td
                    v-for="b in ordered"
                    :key="b"
                    class="px-1 py-1"
                  >
                    <div
                      v-if="a === b"
                      class="text-center text-dimmed"
                    >
                      ·
                    </div>
                    <UTooltip
                      v-else
                      :text="`${label(a)} ${d.flow[a]![b]! >= 0 ? 'took' : 'lost'} ${Math.abs(d.flow[a]![b]!).toFixed(0)} bb ${d.flow[a]![b]! >= 0 ? 'from' : 'to'} ${label(b)}`"
                    >
                      <div
                        class="rounded-[4px] text-center tabular-nums py-1 min-w-10"
                        :style="flowCell(d.flow[a]![b]!)"
                      >
                        {{ signed(d.flow[a]![b]!) }}
                      </div>
                    </UTooltip>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </UCard>

        <UCard :ui="{ header: 'px-4 py-3 sm:px-4', body: 'p-0 sm:p-0' }">
          <template #header>
            <h2 class="font-medium text-highlighted">
              Style and reliability
            </h2>
            <p class="text-xs text-muted">
              From stats.ts over every hand in the matches above. Fallback = timeout, error or illegal choice (auto check/fold).
            </p>
          </template>
          <div class="overflow-x-auto">
            <table
              class="w-full text-sm tabular-nums"
              data-testid="style-table"
            >
              <thead>
                <tr class="text-xs text-muted">
                  <th class="text-left font-normal px-3 py-2">
                    Model
                  </th>
                  <th
                    v-for="h in ['VPIP', 'PFR', 'AF', 'WTSD', 'W$SD', 'Fallback', 'Avg ms', 'p95', '$/100 hands']"
                    :key="h"
                    class="font-normal px-2 py-2 text-right whitespace-nowrap"
                  >
                    {{ h }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="r in styleRows"
                  :key="r.id"
                  class="border-t border-default"
                >
                  <td class="px-3 py-1.5 whitespace-nowrap">
                    {{ label(r.id) }}
                  </td>
                  <td class="px-2 text-right">
                    {{ pct(r.s.vpip) }}
                  </td>
                  <td class="px-2 text-right">
                    {{ pct(r.s.pfr) }}
                  </td>
                  <td class="px-2 text-right">
                    {{ r.s.counts.calls ? (r.s.counts.bets / r.s.counts.calls).toFixed(1) : r.s.counts.bets ? '∞' : '—' }}
                  </td>
                  <td class="px-2 text-right">
                    {{ pct(r.s.wtsd) }}
                  </td>
                  <td class="px-2 text-right">
                    {{ pct(r.s.wsd) }}
                  </td>
                  <td
                    class="px-2 text-right"
                    :class="r.o.decisions && r.o.fallbacks / r.o.decisions >= 0.05 ? 'text-error' : ''"
                  >
                    {{ r.o.decisions ? `${((r.o.fallbacks / r.o.decisions) * 100).toFixed(1)}%` : '—' }}
                  </td>
                  <td class="px-2 text-right">
                    {{ ms(r.o.avgMs) }}
                  </td>
                  <td class="px-2 text-right">
                    {{ ms(r.o.p95Ms) }}
                  </td>
                  <td class="px-2 pr-3 text-right">
                    {{ r.o.hands ? usd((r.o.costUsd / r.o.hands) * 100) : '—' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </UCard>
      </div>

      <UCard
        :ui="{ header: 'px-4 py-3 sm:px-4', body: 'p-4 sm:p-4' }"
        class="mb-5"
        data-testid="run-scouting"
      >
        <template #header>
          <div class="flex flex-wrap items-baseline gap-x-3">
            <h2 class="font-medium text-highlighted">
              Scouting report
            </h2>
            <span
              v-if="d.scouting"
              class="text-xs text-muted"
            >stats over {{ d.scouting.hands.toLocaleString() }} hands · hand numbers from {{ d.scouting.sampleTournamentId }} · {{ usd(d.scouting.costUsd) }}</span>
          </div>
        </template>
        <p
          v-if="!d.scouting"
          class="text-sm text-muted"
        >
          No report yet. <code class="text-xs">bench/tournament.ts … --scout</code> writes one when a run completes (one narrator call, about $0.05).
        </p>
        <template v-else>
          <p class="text-sm mb-4 max-w-[80ch]">
            {{ d.scouting.overview }}
          </p>
          <div class="grid md:grid-cols-2 gap-4">
            <div
              v-for="s in d.scouting.seats"
              :key="s.seatId"
              class="rounded-md border border-default p-3"
            >
              <div class="flex items-center gap-2 mb-1">
                <span
                  class="size-2.5 rounded-full"
                  :style="{ background: chartColor(s.modelId) }"
                />
                <span class="font-medium text-highlighted">{{ s.name }}</span>
                <span class="text-sm text-muted">· {{ s.styleLabel }}</span>
              </div>
              <p
                v-if="s.stats"
                class="text-xs text-dimmed mb-2 tabular-nums"
              >
                {{ s.stats }}
              </p>
              <ul class="text-sm list-disc pl-4 space-y-0.5">
                <li
                  v-for="t in s.tendencies"
                  :key="t"
                >
                  {{ t }}
                </li>
              </ul>
              <p class="text-sm mt-2">
                <span class="text-muted">Signature hand #{{ s.signatureHand.handNo }}:</span> {{ s.signatureHand.why }}
              </p>
              <p class="text-sm mt-1">
                <span class="text-muted">How to beat it:</span> {{ s.howToBeat }}
              </p>
              <p class="text-sm mt-1 text-muted italic">
                {{ s.voice }}
              </p>
            </div>
          </div>
        </template>
      </UCard>

      <div class="text-xs text-dimmed">
        <span class="stat-label">CLI</span>
        <code class="block mt-1 break-all">{{ d.command }}</code>
      </div>
    </template>
  </div>
</template>
