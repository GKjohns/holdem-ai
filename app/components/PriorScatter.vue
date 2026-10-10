<script setup lang="ts">
/**
 * Pre-registered vs measured bb/100, one dot per card at its own generation's table, with the
 * measured 95% CI as a vertical whisker. On the dashed diagonal, the prior was right.
 */
const props = defineProps<{
  points: { cardId: string, label: string, gen: number, predicted: number, actual: number | null, lo: number | null, hi: number | null }[]
}>()

const S = 360
const PAD = { top: 12, right: 12, bottom: 34, left: 48 }
const inner = S - PAD.left - PAD.right
const shown = computed(() => props.points.filter(p => p.actual !== null))
function nice(v: number): number {
  const step = 10 ** Math.floor(Math.log10(Math.max(Math.abs(v), 1)))
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * step >= Math.abs(v)) return m * step
  return 10 * step
}
// One scale for both axes, so the diagonal means "prediction = result". Whiskers are clipped.
const ext = computed(() => {
  const vs = shown.value.flatMap(p => [p.predicted, p.actual!])
  return nice(Math.max(50, ...vs.map(Math.abs)) * 1.1)
})
const pos = (v: number) => Math.max(-ext.value, Math.min(ext.value, v))
const xOf = (v: number) => PAD.left + ((pos(v) + ext.value) / (2 * ext.value)) * inner
const yOf = (v: number) => PAD.top + ((ext.value - pos(v)) / (2 * ext.value)) * inner
const ticks = computed(() => [-ext.value, -ext.value / 2, 0, ext.value / 2, ext.value])
const fmt = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v))}`

const hover = ref<string | null>(null)
const tip = computed(() => shown.value.find(p => p.cardId === hover.value) ?? null)
</script>

<template>
  <div
    class="relative max-w-[420px]"
    data-testid="prior-scatter"
  >
    <svg
      :viewBox="`0 0 ${S} ${S}`"
      class="w-full h-auto"
      role="img"
      aria-label="Predicted versus measured bb/100 per card"
      @pointerleave="hover = null"
    >
      <g
        v-for="t in ticks"
        :key="t"
      >
        <line
          :x1="PAD.left"
          :x2="S - PAD.right"
          :y1="yOf(t)"
          :y2="yOf(t)"
          :stroke="t === 0 ? 'var(--chart-axis)' : 'var(--chart-grid)'"
        />
        <line
          :y1="PAD.top"
          :y2="PAD.top + inner"
          :x1="xOf(t)"
          :x2="xOf(t)"
          :stroke="t === 0 ? 'var(--chart-axis)' : 'var(--chart-grid)'"
        />
        <text
          :x="PAD.left - 6"
          :y="yOf(t) + 3.5"
          text-anchor="end"
          class="fill-(--ui-text-muted) text-[10px] tabular-nums"
        >{{ fmt(t) }}</text>
        <text
          :x="xOf(t)"
          :y="PAD.top + inner + 14"
          text-anchor="middle"
          class="fill-(--ui-text-muted) text-[10px] tabular-nums"
        >{{ fmt(t) }}</text>
      </g>
      <line
        :x1="xOf(-ext)"
        :y1="yOf(-ext)"
        :x2="xOf(ext)"
        :y2="yOf(ext)"
        stroke="var(--ui-text-dimmed)"
        stroke-dasharray="4 4"
      />
      <text
        :x="S - PAD.right"
        :y="S - 4"
        text-anchor="end"
        class="fill-(--ui-text-muted) text-[10px]"
      >predicted bb/100 →</text>
      <text
        :x="12"
        :y="PAD.top + inner / 2"
        text-anchor="middle"
        :transform="`rotate(-90 12 ${PAD.top + inner / 2})`"
        class="fill-(--ui-text-muted) text-[10px]"
      >measured bb/100 →</text>
      <g
        v-for="p in shown"
        :key="p.cardId"
        class="cursor-default"
        @pointerenter="hover = p.cardId"
      >
        <line
          v-if="p.lo !== null && p.hi !== null"
          :x1="xOf(p.predicted)"
          :x2="xOf(p.predicted)"
          :y1="yOf(p.lo)"
          :y2="yOf(p.hi)"
          stroke="var(--ui-text-toned)"
          stroke-opacity="0.45"
          stroke-width="2"
          stroke-linecap="round"
        />
        <circle
          :cx="xOf(p.predicted)"
          :cy="yOf(p.actual!)"
          :r="hover === p.cardId ? 6 : 4.5"
          fill="var(--ui-text-toned)"
          stroke="var(--ui-bg)"
          stroke-width="2"
        />
        <circle
          :cx="xOf(p.predicted)"
          :cy="yOf(p.actual!)"
          r="12"
          fill="transparent"
        />
      </g>
    </svg>
    <div
      v-if="tip"
      class="absolute top-2 right-2 rounded-md border border-default bg-default/95 px-2.5 py-1.5 text-xs shadow-sm pointer-events-none"
    >
      <div class="font-medium text-highlighted">
        {{ tip.label }} <span class="text-muted">gen {{ tip.gen }}</span>
      </div>
      <div class="tabular-nums text-muted">
        predicted {{ fmt(tip.predicted) }} · measured {{ fmt(tip.actual!) }}<template v-if="tip.lo !== null">
          [{{ fmt(tip.lo) }}, {{ fmt(tip.hi!) }}]
        </template>
      </div>
    </div>
  </div>
</template>
