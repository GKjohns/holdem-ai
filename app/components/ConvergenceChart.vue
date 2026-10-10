<script setup lang="ts">
/** Cumulative bb/100 per model after each finished tournament: does the estimate settle? */
const props = defineProps<{
  models: { id: string, label: string }[]
  series: { tournamentId: string, hands: number, bb100: Record<string, number | null> }[]
}>()

const W = 640
const H = 240
const PAD = { top: 12, bottom: 26, left: 46, right: 10 }

const dashes = computed(() => chartDashes(props.models.map(m => ({ id: m.id, modelId: m.id }))))
const values = computed(() => props.series.flatMap(p => Object.values(p.bb100).filter((v): v is number => v !== null)))
function nice(v: number): number {
  const step = 10 ** Math.floor(Math.log10(Math.max(Math.abs(v), 1)))
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * step >= Math.abs(v)) return m * step
  return 10 * step
}
const yMax = computed(() => nice(Math.max(...values.value, 10)))
const yMin = computed(() => -nice(Math.max(...values.value.map(v => -v), 10)))
/** Ticks at 0, the extremes, and halfway, dropping any that would crowd (< 16 px apart). */
const ticks = computed(() => {
  const out: number[] = []
  for (const t of [0, yMax.value, yMin.value, yMax.value / 2, yMin.value / 2]) {
    if (out.every(o => Math.abs(yOf(o) - yOf(t)) >= 16)) out.push(t)
  }
  return out
})
const xMax = computed(() => props.series.at(-1)?.hands ?? 1)
const xOf = (h: number) => PAD.left + (h / xMax.value) * (W - PAD.left - PAD.right)
const yOf = (v: number) => PAD.top + ((yMax.value - v) / (yMax.value - yMin.value)) * (H - PAD.top - PAD.bottom)
const fmt = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v)}`

const lines = computed(() => props.models.map(m => ({
  ...m,
  color: chartColor(m.id),
  dash: dashes.value[m.id],
  points: props.series
    .filter(p => p.bb100[m.id] !== null && p.bb100[m.id] !== undefined)
    .map(p => `${xOf(p.hands).toFixed(1)},${yOf(p.bb100[m.id]!).toFixed(1)}`).join(' ')
})))

const svg = ref<SVGSVGElement | null>(null)
const hover = ref<number | null>(null)
function onMove(e: PointerEvent) {
  const el = svg.value
  if (!el || props.series.length < 2) return
  const box = el.getBoundingClientRect()
  const h = (((e.clientX - box.left) / box.width) * W - PAD.left) / (W - PAD.left - PAD.right) * xMax.value
  let best = 0
  props.series.forEach((p, i) => {
    if (Math.abs(p.hands - h) < Math.abs(props.series[best]!.hands - h)) best = i
  })
  hover.value = best
}
const tip = computed(() => {
  if (hover.value === null) return null
  const p = props.series[hover.value]!
  const rows = props.models
    .map(m => ({ ...m, v: p.bb100[m.id] ?? null }))
    .sort((a, b) => (b.v ?? -Infinity) - (a.v ?? -Infinity))
  return { label: `${p.hands} hands · after ${p.tournamentId}`, rows, leftPct: (xOf(p.hands) / W) * 100 }
})
</script>

<template>
  <div data-testid="convergence-chart">
    <div
      v-if="series.length < 2"
      class="py-8 text-sm text-dimmed text-center"
    >
      The line needs at least two finished tournaments.
    </div>
    <div
      v-else
      class="relative"
    >
      <svg
        ref="svg"
        :viewBox="`0 0 ${W} ${H}`"
        class="block w-full h-auto touch-none"
        role="img"
        aria-label="Cumulative bb/100 per model over hands"
        @pointermove="onMove"
        @pointerleave="hover = null"
      >
        <g
          v-for="t in ticks"
          :key="t"
        >
          <line
            :x1="PAD.left"
            :x2="W - PAD.right"
            :y1="yOf(t)"
            :y2="yOf(t)"
            :stroke="t === 0 ? 'var(--chart-axis)' : 'var(--chart-grid)'"
            stroke-width="1"
          />
          <text
            :x="PAD.left - 6"
            :y="yOf(t) + 3.5"
            text-anchor="end"
            class="fill-(--ui-text-muted) text-[10px] tabular-nums"
          >{{ fmt(t) }}</text>
        </g>
        <text
          :x="PAD.left"
          :y="H - 6"
          class="fill-(--ui-text-muted) text-[10px]"
        >0 hands</text>
        <text
          :x="W - PAD.right"
          :y="H - 6"
          text-anchor="end"
          class="fill-(--ui-text-muted) text-[10px] tabular-nums"
        >{{ xMax.toLocaleString() }} hands</text>
        <polyline
          v-for="l in lines"
          :key="l.id"
          :points="l.points"
          fill="none"
          :stroke="l.color"
          stroke-width="2"
          stroke-linejoin="round"
          stroke-linecap="round"
          :stroke-dasharray="l.dash"
        />
        <line
          v-if="hover !== null"
          :x1="xOf(series[hover]!.hands)"
          :x2="xOf(series[hover]!.hands)"
          :y1="PAD.top"
          :y2="H - PAD.bottom"
          stroke="var(--ui-text-muted)"
          stroke-width="1"
          stroke-dasharray="2 3"
        />
      </svg>
      <div
        v-if="tip"
        class="absolute top-2 pointer-events-none rounded-md border border-default bg-default/95 px-2.5 py-2 text-xs shadow-sm"
        :style="tip.leftPct > 55 ? { left: '56px' } : { right: '12px' }"
      >
        <div class="font-medium text-highlighted mb-1">
          {{ tip.label }}
        </div>
        <div
          v-for="r in tip.rows"
          :key="r.id"
          class="flex items-center gap-2"
        >
          <svg
            width="16"
            height="6"
            aria-hidden="true"
          ><line
            x1="1"
            x2="15"
            y1="3"
            y2="3"
            :stroke="chartColor(r.id)"
            stroke-width="2"
            :stroke-dasharray="dashes[r.id]"
          /></svg>
          <span class="text-muted grow">{{ r.label }}</span>
          <span class="tabular-nums text-highlighted">{{ r.v === null ? '—' : fmt(r.v) }}</span>
        </div>
      </div>
      <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span
          v-for="l in lines"
          :key="l.id"
          class="inline-flex items-center gap-1.5"
        >
          <svg
            width="18"
            height="6"
            aria-hidden="true"
          ><line
            x1="1"
            x2="17"
            y1="3"
            y2="3"
            :stroke="l.color"
            stroke-width="2"
            :stroke-dasharray="l.dash"
          /></svg>
          {{ l.label }}
        </span>
      </div>
    </div>
  </div>
</template>
