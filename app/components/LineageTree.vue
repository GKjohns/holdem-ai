<script setup lang="ts">
/**
 * Cards by generation (columns) with edges from parents to their mutations and crossovers.
 * Node fill: the card's pooled lead over the control on the diverging pair (gray = no data);
 * a ring marks a card that became champion.
 */
const props = defineProps<{
  cards: { id: string, name: string, gen: number, kind: 'explore' | 'exploit', parentIds: string[] }[]
  leads: Record<string, number | null>
  champions: string[]
}>()

const COL = 210
const ROW = 34
const PAD = 14
const gens = computed(() => [...new Set(props.cards.map(c => c.gen))].sort((a, b) => a - b))
const rows = computed(() => Math.max(1, ...gens.value.map(g => props.cards.filter(c => c.gen === g).length)))
const W = computed(() => PAD * 2 + gens.value.length * COL)
const H = computed(() => PAD * 2 + 18 + rows.value * ROW)
const at = computed(() => {
  const m = new Map<string, { x: number, y: number }>()
  for (const g of gens.value) {
    props.cards.filter(c => c.gen === g).forEach((c, i) => m.set(c.id, { x: PAD + 8 + gens.value.indexOf(g) * COL, y: PAD + 18 + ROW / 2 + i * ROW }))
  }
  return m
})
const edges = computed(() => props.cards.flatMap(c => c.parentIds.map((p) => {
  const a = at.value.get(p)
  const b = at.value.get(c.id)
  if (!a || !b) return null
  const mx = (a.x + b.x) / 2
  return { key: `${p}-${c.id}`, d: `M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`, cross: c.parentIds.length > 1 }
}).filter((e): e is NonNullable<typeof e> => !!e)))
const maxAbs = computed(() => Math.max(1, ...Object.values(props.leads).filter((v): v is number => v !== null).map(Math.abs)))
function fill(id: string) {
  const v = props.leads[id]
  if (v === null || v === undefined) return 'var(--ui-bg-accented)'
  const a = Math.round(25 + (Math.abs(v) / maxAbs.value) * 75)
  return `color-mix(in oklab, var(${v >= 0 ? '--div-pos' : '--div-neg'}) ${a}%, var(--ui-bg))`
}
const fmt = (v: number | null | undefined) => v === null || v === undefined ? 'no data' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v))}`
</script>

<template>
  <div
    class="overflow-x-auto"
    data-testid="lineage-tree"
  >
    <svg
      :viewBox="`0 0 ${W} ${H}`"
      :width="W"
      :height="H"
      class="block"
      role="img"
      aria-label="Card lineage by generation"
    >
      <text
        v-for="(g, i) in gens"
        :key="g"
        :x="PAD + i * COL"
        :y="PAD + 4"
        class="fill-(--ui-text-muted) text-[11px] font-medium"
      >Generation {{ g }}</text>
      <path
        v-for="e in edges"
        :key="e.key"
        :d="e.d"
        fill="none"
        stroke="var(--ui-text-dimmed)"
        :stroke-dasharray="e.cross ? '3 3' : undefined"
        stroke-width="1.5"
      />
      <g
        v-for="c in cards"
        :key="c.id"
      >
        <title>{{ c.name }} ({{ c.id }}, {{ c.kind }}{{ c.parentIds.length ? ` of ${c.parentIds.join(' × ')}` : '' }}): lead over the control {{ fmt(leads[c.id]) }} bb/100</title>
        <circle
          v-if="champions.includes(c.id)"
          :cx="at.get(c.id)!.x"
          :cy="at.get(c.id)!.y"
          r="10"
          fill="none"
          stroke="var(--ui-text-highlighted)"
          stroke-width="1.5"
        />
        <circle
          :cx="at.get(c.id)!.x"
          :cy="at.get(c.id)!.y"
          r="6.5"
          :fill="fill(c.id)"
          stroke="var(--ui-bg)"
          stroke-width="2"
        />
        <text
          :x="at.get(c.id)!.x + 15"
          :y="at.get(c.id)!.y - 1"
          class="fill-(--ui-text) text-[11px]"
        >{{ c.name.length > 22 ? `${c.name.slice(0, 21)}…` : c.name }}</text>
        <text
          :x="at.get(c.id)!.x + 15"
          :y="at.get(c.id)!.y + 11"
          class="fill-(--ui-text-muted) text-[9.5px] tabular-nums"
        >{{ c.id }} · {{ c.kind }} · {{ fmt(leads[c.id]) }}</text>
      </g>
    </svg>
  </div>
</template>
