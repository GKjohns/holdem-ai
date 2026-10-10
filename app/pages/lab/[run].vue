<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { LabCardRow, LabDetail } from '~~/server/utils/lab'
import type { Interval } from '~~/shared/utils/stats'
import { AXIS_NAMES } from '~~/shared/utils/strategy'

const route = useRoute()
const slug = computed(() => String(route.params.run))
const { data, error } = await useFetch<LabDetail>('/api/lab', { query: computed(() => ({ run: slug.value })) })
useSeoMeta({ title: () => `${slug.value} · Strategy Lab · Hold'em AI` })
const d = computed(() => data.value)

const signed = (v: number | null | undefined, digits = 0) => v === null || v === undefined ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`
const ci = (iv: Interval) => iv.lo === null || iv.hi === null ? 'n/a' : `${signed(iv.lo)} to ${signed(iv.hi)}`
const usd = (v: number) => `$${v.toFixed(2)}`
const verdictColor = (v: string) => v === 'confirmed' || v === 'holds' ? 'success' : v === 'refuted' ? 'error' : v === 'overfit' ? 'warning' : 'neutral'
const statusColor = (s: string) => s === 'complete' ? 'success' : s === 'budget' || s === 'interrupted' ? 'warning' : s === 'errors' ? 'error' : 'neutral'
const cardOf = (id: string) => d.value?.cards.find(c => c.id === id)

/** One CI-bar scale for every lead on the page, so bars compare across tables. */
const scale = computed(() => {
  const ivs: Interval[] = [
    ...(d.value?.pooled.map(r => r.lead) ?? []),
    ...(d.value?.gens.flatMap(g => [...g.rows.map(r => r.lead), g.champion.lead]) ?? []),
    ...(d.value?.heldout?.rows.flatMap(r => [r.heldout.lead, r.training]) ?? [])
  ]
  const vs = ivs.flatMap(i => [i.lo, i.hi, i.value]).filter((v): v is number => v !== null)
  const m = Math.max(50, ...vs.map(Math.abs))
  return { min: -m, max: m }
})

// Planner notes: plain paragraphs and "- " bullets (markdown emphasis dropped).
function blocks(text: string) {
  const out: { type: 'p' | 'ul', items: string[] }[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\*\*|__/g, '').trim()
    if (!line) continue
    const bullet = /^[-*•]\s+/.test(line)
    const item = line.replace(/^[-*•]\s+|^\d+[.)]\s+/, '')
    const last = out.at(-1)
    if ((bullet || /^\d+[.)]\s/.test(line)) && last?.type === 'ul') last.items.push(item)
    else if (bullet || /^\d+[.)]\s/.test(line)) out.push({ type: 'ul', items: [item] })
    else out.push({ type: 'p', items: [line] })
  }
  return out
}
const noteSections = computed(() => {
  const n = d.value?.notes
  if (!n) return []
  return [
    { title: 'What wins', text: n.whatWins },
    { title: 'What loses', text: n.whatLoses },
    { title: 'Where the priors were wrong', text: n.priorsWrong },
    { title: 'Still noise', text: n.noise },
    { title: 'What to test next', text: n.nextTests }
  ]
})

const num = { th: 'text-right', td: 'text-right tabular-nums' }
type PooledRow = LabDetail['pooled'][number]
const pooledCols: TableColumn<PooledRow>[] = [
  { accessorKey: 'label', header: 'Card' },
  { accessorKey: 'gen', header: 'Gen', meta: { class: num } },
  { id: 'lead', header: 'Lead over control (bb/100)', meta: { class: num } },
  { id: 'bar', header: '95% CI', meta: { class: { th: 'w-[30%]', td: 'w-[30%]' } } },
  { id: 'bb', header: 'bb/100', meta: { class: num } },
  { accessorKey: 'matches', header: 'Matches', meta: { class: num } },
  { accessorKey: 'hands', header: 'Hands', meta: { class: num } }
]
const genCols: TableColumn<LabCardRow>[] = [
  { accessorKey: 'label', header: 'Card' },
  { id: 'lead', header: 'Lead', meta: { class: num } },
  { id: 'bar', header: '95% CI', meta: { class: { th: 'w-[26%]', td: 'w-[26%]' } } },
  { id: 'bb', header: 'bb/100', meta: { class: num } },
  { id: 'pred', header: 'Predicted lead · rank', meta: { class: num } },
  { accessorKey: 'verdict', header: 'Verdict' },
  { accessorKey: 'matches', header: 'Matches', meta: { class: num } }
]
type HeldRow = NonNullable<LabDetail['heldout']>['rows'][number]
const heldCols: TableColumn<HeldRow>[] = [
  { accessorKey: 'label', header: 'Card' },
  { id: 'train', header: 'Training lead', meta: { class: num } },
  { id: 'held', header: 'Held-out lead', meta: { class: num } },
  { id: 'bar', header: 'Held-out 95% CI', meta: { class: { th: 'w-[30%]', td: 'w-[30%]' } } },
  { accessorKey: 'verdict', header: 'Verdict' }
]

const leads = computed(() => Object.fromEntries((d.value?.cards ?? []).map(c => [c.id, d.value!.pooled.find(r => r.cardId === c.id)?.lead.value ?? null])))
const champions = computed(() => [...new Set((d.value?.gens ?? []).map(g => g.championOut).filter((x): x is string => !!x && !!cardOf(x)))])
const roundWords = (r: LabDetail['gens'][number]['rounds'][number], prev?: LabDetail['gens'][number]['rounds'][number]) => {
  const added = Object.entries(r.matches).map(([id, m]) => [id, m - (prev?.matches[id] ?? 0)] as const).filter(([, m]) => m > 0)
  if (r.kind === 'equal') return `Round 1: every card ${added[0]?.[1] ?? 0} matches`
  if (r.kind === 'halving') return `Round 2 (halving): ${added.map(([id, m]) => `${cardOf(id)?.name ?? id} +${m}`).join(', ') || 'no extra matches'}`
  return `Round 3 (Thompson top-up): ${added.map(([id, m]) => `${cardOf(id)?.name ?? id} +${m}`).join(', ')}`
}
const priorsWrong = computed(() => (d.value?.scatter ?? []).filter(p => p.actual !== null).map(p => ({ ...p, err: p.actual! - p.predicted })).sort((a, b) => Math.abs(b.err) - Math.abs(a.err)).slice(0, 3))
</script>

<template>
  <div class="max-w-[1240px] mx-auto px-4 py-6">
    <UButton
      to="/lab"
      icon="i-lucide-arrow-left"
      color="neutral"
      variant="link"
      size="sm"
      class="px-0 mb-2"
    >
      All lab runs
    </UButton>

    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      :title="`Couldn't load ${slug}`"
      :description="error.statusMessage"
    />

    <template v-else-if="d">
      <div class="mb-5">
        <h1 class="font-serif text-2xl text-highlighted break-all">
          {{ d.run }}
        </h1>
        <div class="mt-1.5 flex flex-wrap items-center gap-1.5 text-sm text-muted">
          <UBadge
            v-if="d.fake"
            label="fake run (random play, fake planner)"
            color="warning"
            variant="soft"
            size="sm"
          />
          <span>Base {{ d.config?.base.split('/')[1] }} · {{ d.gens.length }} generations · {{ d.cards.length }} cards</span>
          <span>·</span>
          <span class="tabular-nums">{{ d.gens.reduce((n, g) => n + g.hands, 0).toLocaleString() }} training hands</span>
          <span>·</span>
          <span class="tabular-nums">{{ usd(d.spend.total) }}{{ d.spend.cap ? ` of ${usd(d.spend.cap)}` : '' }} (tables {{ usd(d.spend.tables) }}, planner {{ usd(d.spend.planner) }})</span>
          <UBadge
            :label="d.status"
            :color="statusColor(d.status)"
            variant="soft"
            size="sm"
          />
        </div>
      </div>

      <UCard
        v-if="d.notes"
        class="mb-5"
        data-testid="field-notes"
      >
        <div class="stat-label mb-1">
          Field notes · {{ d.notes.model }}
        </div>
        <p class="font-serif text-lg text-highlighted mb-4 max-w-[80ch]">
          {{ d.notes.headline }}
        </p>
        <div class="grid gap-x-8 gap-y-4 md:grid-cols-2">
          <section
            v-for="s in noteSections"
            :key="s.title"
          >
            <h3 class="text-sm font-medium text-highlighted mb-1">
              {{ s.title }}
            </h3>
            <template
              v-for="(b, i) in blocks(s.text)"
              :key="i"
            >
              <ul
                v-if="b.type === 'ul'"
                class="list-disc pl-5 text-sm text-toned space-y-1 mb-2"
              >
                <li
                  v-for="(it, j) in b.items"
                  :key="j"
                >
                  {{ it }}
                </li>
              </ul>
              <p
                v-else
                class="text-sm text-toned mb-2"
              >
                {{ b.items[0] }}
              </p>
            </template>
          </section>
        </div>
      </UCard>

      <UCard
        class="mb-5"
        :ui="{ header: 'px-4 py-3 sm:px-4', body: 'p-0 sm:p-0' }"
      >
        <template #header>
          <div class="flex flex-wrap items-baseline gap-x-3">
            <h2 class="font-medium text-highlighted">
              Every card, pooled
            </h2>
            <span class="text-xs text-muted">All training matches each card played (as candidate or champion). Lead = card bb/100 − control bb/100 on the same matches; CIs resample whole matches. Control: {{ signed(d.control.bb100.value) }} bb/100 over {{ d.control.hands.toLocaleString() }} hands.</span>
          </div>
        </template>
        <div class="overflow-x-auto">
          <UTable
            :data="d.pooled"
            :columns="pooledCols"
            data-testid="lab-pooled"
          >
            <template #label-cell="{ row }">
              <span class="font-medium text-highlighted whitespace-nowrap">{{ row.original.label }}</span>
              <UBadge
                v-if="champions.includes(row.original.cardId)"
                label="champion"
                color="primary"
                variant="soft"
                size="sm"
                class="ml-2"
              />
            </template>
            <template #lead-cell="{ row }">
              <span class="font-serif text-[15px]">{{ signed(row.original.lead.value) }}</span>
            </template>
            <template #bar-cell="{ row }">
              <CiBar
                :value="row.original.lead.value"
                :lo="row.original.lead.lo"
                :hi="row.original.lead.hi"
                :min="scale.min"
                :max="scale.max"
                color="var(--ui-text-toned)"
                :label="`${row.original.label}: lead ${signed(row.original.lead.value)} (95% CI ${ci(row.original.lead)})`"
              />
            </template>
            <template #bb-cell="{ row }">
              {{ signed(row.original.bb100.value) }}
            </template>
          </UTable>
        </div>
      </UCard>

      <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_420px] mb-5">
        <UCard :ui="{ header: 'px-4 py-3 sm:px-4' }">
          <template #header>
            <div class="flex flex-wrap items-baseline gap-x-3">
              <h2 class="font-medium text-highlighted">
                Lineage
              </h2>
              <span class="text-xs text-muted">Solid: mutation; dashed: crossover; ring: became champion. Fill: pooled lead over the control (blue ahead, rust behind, gray no data).</span>
            </div>
          </template>
          <LineageTree
            :cards="d.cards"
            :leads="leads"
            :champions="champions"
          />
        </UCard>
        <UCard :ui="{ header: 'px-4 py-3 sm:px-4' }">
          <template #header>
            <div class="flex flex-wrap items-baseline gap-x-3">
              <h2 class="font-medium text-highlighted">
                Prior vs result
              </h2>
              <span class="text-xs text-muted">Fable's pre-registered bb/100 vs the measured one at the card's own table; whisker = 95% CI.</span>
            </div>
          </template>
          <PriorScatter :points="d.scatter" />
          <div
            v-if="priorsWrong.length"
            class="mt-3 text-xs text-muted"
          >
            Most wrong:
            <span
              v-for="(p, i) in priorsWrong"
              :key="p.cardId"
            >{{ i ? ' · ' : '' }}{{ p.label.split(' · ').at(-1) }} (predicted {{ signed(p.predicted) }}, got {{ signed(p.actual) }})</span>
          </div>
        </UCard>
      </div>

      <UCard
        v-for="g in d.gens"
        :key="g.gen"
        class="mb-5"
        :ui="{ header: 'px-4 py-3 sm:px-4', body: 'p-0 sm:p-0' }"
        :data-testid="`lab-gen-${g.gen}`"
      >
        <template #header>
          <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 class="font-medium text-highlighted">
              Generation {{ g.gen }}
            </h2>
            <span class="text-xs text-muted tabular-nums">predictions written {{ g.predictionsWrittenAt.slice(11, 19) }} · first hand {{ g.firstHandAt?.slice(11, 19) ?? '—' }} · {{ g.hands.toLocaleString() }} hands</span>
          </div>
          <div class="mt-1 text-xs text-muted">
            <span
              v-for="(r, i) in g.rounds"
              :key="r.round"
            >{{ i ? ' · ' : '' }}{{ roundWords(r, g.rounds[i - 1]) }}</span>
          </div>
          <div class="mt-1 text-xs text-muted">
            Champion seat: <span class="text-toned">{{ g.championInLabel }}</span>, lead over the control at this generation's tables
            <span class="tabular-nums text-toned">{{ signed(g.champion.lead.value) }} (95% CI {{ ci(g.champion.lead) }}, {{ g.champion.matches }} matches)</span><template v-if="g.championOut">
              → next champion <span class="text-toned">{{ cardOf(g.championOut)?.name ?? g.championOut }}</span>
            </template>
          </div>
        </template>
        <div class="overflow-x-auto">
          <UTable
            :data="g.rows"
            :columns="genCols"
          >
            <template #label-cell="{ row }">
              <div class="whitespace-nowrap">
                <span :class="row.original.survived ? 'font-medium text-highlighted' : 'text-muted'">{{ row.original.label.split(' · ').at(-1) }}</span>
                <UBadge
                  :label="row.original.kind"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  class="ml-2"
                />
                <span
                  v-if="!row.original.survived"
                  class="ml-2 text-xs text-dimmed"
                >stopped after round 1</span>
              </div>
            </template>
            <template #lead-cell="{ row }">
              <span class="font-serif text-[15px]">{{ signed(row.original.lead.value) }}</span>
            </template>
            <template #bar-cell="{ row }">
              <CiBar
                :value="row.original.lead.value"
                :lo="row.original.lead.lo"
                :hi="row.original.lead.hi"
                :min="scale.min"
                :max="scale.max"
                color="var(--ui-text-toned)"
                :label="`lead ${signed(row.original.lead.value)} (95% CI ${ci(row.original.lead)})`"
              />
            </template>
            <template #bb-cell="{ row }">
              {{ signed(row.original.bb100.value) }}
            </template>
            <template #pred-cell="{ row }">
              <span class="text-muted">{{ signed(row.original.predicted.vsControl) }} · #{{ row.original.predicted.rank }}</span>
            </template>
            <template #verdict-cell="{ row }">
              <UBadge
                :label="row.original.verdict"
                :color="verdictColor(row.original.verdict)"
                variant="soft"
                size="sm"
              />
            </template>
          </UTable>
        </div>
        <div
          v-if="g.memo"
          class="border-t border-default px-4 py-3"
        >
          <div class="stat-label mb-1">
            Fable's memo on generation {{ g.gen }}
          </div>
          <p class="text-sm text-highlighted mb-2">
            {{ g.memo.headline }}
          </p>
          <div class="grid gap-x-6 gap-y-2 md:grid-cols-2 text-sm">
            <div
              v-for="[t, xs] in ([['Confirmed', g.memo.confirmed], ['Refuted', g.memo.refuted], ['Still noise', g.memo.noise], ['Surprises', g.memo.surprises]] as const)"
              v-show="xs.length"
              :key="t"
            >
              <div class="text-xs font-medium text-muted">
                {{ t }}
              </div>
              <ul class="list-disc pl-5 text-toned space-y-0.5">
                <li
                  v-for="(x, i) in xs"
                  :key="i"
                >
                  {{ x }}
                </li>
              </ul>
            </div>
          </div>
        </div>
      </UCard>

      <UCard
        v-if="d.heldout"
        class="mb-5"
        :ui="{ header: 'px-4 py-3 sm:px-4', body: 'p-0 sm:p-0' }"
        data-testid="lab-heldout"
      >
        <template #header>
          <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 class="font-medium text-highlighted">
              Held-out final
            </h2>
            <UBadge
              :label="d.heldout.seedsUnseen ? `fresh seeds: none of ${d.heldout.trainingSeeds} earlier seeds reused` : 'seed overlap!'"
              :color="d.heldout.seedsUnseen ? 'success' : 'error'"
              variant="soft"
              size="sm"
            />
            <span class="text-xs text-muted">{{ d.heldout.matches }}/{{ d.heldout.planned }} matches · table: {{ d.heldout.players.map(p => p.label).join(', ') }}. "Overfit": the edge is gone (≤ 0) on fresh seeds and a field it never trained against.</span>
          </div>
        </template>
        <div class="overflow-x-auto">
          <UTable
            :data="d.heldout.rows"
            :columns="heldCols"
          >
            <template #label-cell="{ row }">
              <span class="font-medium text-highlighted whitespace-nowrap">{{ row.original.label }}</span>
            </template>
            <template #train-cell="{ row }">
              {{ signed(row.original.training.value) }} <span class="text-dimmed text-xs">({{ ci(row.original.training) }})</span>
            </template>
            <template #held-cell="{ row }">
              <span class="font-serif text-[15px]">{{ signed(row.original.heldout.lead.value) }}</span>
            </template>
            <template #bar-cell="{ row }">
              <CiBar
                :value="row.original.heldout.lead.value"
                :lo="row.original.heldout.lead.lo"
                :hi="row.original.heldout.lead.hi"
                :min="scale.min"
                :max="scale.max"
                color="var(--ui-text-toned)"
                :label="`held-out lead ${signed(row.original.heldout.lead.value)} (95% CI ${ci(row.original.heldout.lead)})`"
              />
            </template>
            <template #verdict-cell="{ row }">
              <UBadge
                :label="row.original.verdict"
                :color="verdictColor(row.original.verdict)"
                variant="soft"
                size="sm"
              />
            </template>
          </UTable>
        </div>
        <div class="border-t border-default px-4 py-2.5 text-xs text-muted tabular-nums">
          Rest of the table (bb/100):
          <span
            v-for="(o, i) in d.heldout.others"
            :key="o.id"
          >{{ i ? ' · ' : '' }}{{ o.label }} {{ signed(o.bb100.value) }} ({{ ci(o.bb100) }})</span>
        </div>
      </UCard>

      <UCard
        class="mb-5"
        :ui="{ header: 'px-4 py-3 sm:px-4' }"
      >
        <template #header>
          <h2 class="font-medium text-highlighted">
            Cards, hypotheses and verdicts
          </h2>
        </template>
        <UAccordion
          type="multiple"
          :items="d.cards.map(c => ({ label: `${c.id} · ${c.name}`, value: c.id, slot: 'card' as const, card: c }))"
          :ui="{ trigger: 'text-sm' }"
        >
          <template #card-body="{ item }">
            <div class="text-sm space-y-2 pb-2">
              <p>
                <span class="text-muted">Hypothesis:</span> {{ item.card.hypothesis }}
                <UBadge
                  :label="d.gens.find(g => g.gen === item.card.gen)?.rows.find(r => r.cardId === item.card.id)?.verdict ?? 'not played'"
                  :color="verdictColor(d.gens.find(g => g.gen === item.card.gen)?.rows.find(r => r.cardId === item.card.id)?.verdict ?? '')"
                  variant="soft"
                  size="sm"
                  class="ml-1"
                />
              </p>
              <p class="text-xs text-muted">
                Gen {{ item.card.gen }} · {{ item.card.kind }}<template v-if="item.card.parentIds.length">
                  of {{ item.card.parentIds.join(' × ') }} ({{ item.card.changed }})
                </template> · predicted {{ signed(item.card.predicted.bb100) }} bb/100, {{ signed(item.card.predicted.vsControl) }} vs control, rank {{ item.card.predicted.rank }}
              </p>
              <p class="text-xs text-muted">
                {{ AXIS_NAMES.map(k => `${k}: ${item.card.axes[k].replace('_', ' ')}`).join(' · ') }}
              </p>
              <blockquote class="border-l-2 border-default pl-3 text-toned whitespace-pre-line">
                {{ item.card.card }}
              </blockquote>
            </div>
          </template>
        </UAccordion>
      </UCard>
    </template>
  </div>
</template>
