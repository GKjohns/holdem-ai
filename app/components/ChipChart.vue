<script setup lang="ts">
import type { Seat } from '~~/shared/utils/types'
import type { HandRecord } from '~/composables/useTable'

const props = defineProps<{
  seats: Pick<Seat, 'id' | 'name' | 'modelId' | 'stack'>[]
  hands: HandRecord[]
  startingStacks: Record<string, number>
}>()

// Plot geometry in viewBox units; the SVG scales to the panel width.
const W = 328
const H = 184
const PAD = { top: 10, bottom: 22, left: 34 }
const LABEL_W = 70

const ids = computed(() => props.seats.map(s => s.id))
const series = computed(() => stackSeries(ids.value, props.startingStacks, props.hands))
const dashes = computed(() => chartDashes(props.seats))
const color = (id: string) => chartColor(props.seats.find(s => s.id === id)?.modelId ?? null)

function niceMax(v: number): number {
  const step = 10 ** Math.floor(Math.log10(Math.max(v, 1)))
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * step >= v) return m * step
  return 10 * step
}
const compact = (v: number) => v >= 1000 ? `${+(v / 1000).toFixed(1)}K` : String(v)

const yMax = computed(() => niceMax(Math.max(...series.value.flatMap(p => Object.values(p.stacks)), 1)))
const lastHand = computed(() => series.value.at(-1)!.handNo)

/** Direct end labels only when there are few lines and their ends don't crowd each other. */
const endLabels = computed(() => {
  if (props.seats.length > 4 || series.value.length < 2) return null
  const end = series.value.at(-1)!.stacks
  const ys = ids.value.map(id => ({ id, y: yOf(end[id] ?? 0) })).sort((a, b) => a.y - b.y)
  for (let i = 1; i < ys.length; i++) if (ys[i]!.y - ys[i - 1]!.y < 11) return null
  return ys
})
const right = computed(() => W - 6 - (endLabels.value ? LABEL_W : 0))

function xOf(i: number): number {
  const n = Math.max(series.value.length - 1, 1)
  return PAD.left + (i / n) * (right.value - PAD.left)
}
function yOf(v: number): number {
  return PAD.top + (1 - v / yMax.value) * (H - PAD.top - PAD.bottom)
}

const yTicks = computed(() => [0, yMax.value / 2, yMax.value])
const lines = computed(() => ids.value.map(id => ({
  id,
  color: color(id),
  dash: dashes.value[id],
  points: series.value.map((p, i) => `${xOf(i).toFixed(1)},${yOf(p.stacks[id] ?? 0).toFixed(1)}`).join(' '),
  end: { x: xOf(series.value.length - 1), y: yOf(series.value.at(-1)!.stacks[id] ?? 0) }
})))

// Hover: a crosshair snaps to the nearest hand; the tooltip lists every seat at that hand.
const svg = ref<SVGSVGElement | null>(null)
const hover = ref<number | null>(null)
function onMove(e: PointerEvent) {
  const el = svg.value
  if (!el || series.value.length < 2) return
  const box = el.getBoundingClientRect()
  const x = ((e.clientX - box.left) / box.width) * W
  const n = series.value.length - 1
  const i = Math.round(((x - PAD.left) / (right.value - PAD.left)) * n)
  hover.value = Math.min(n, Math.max(0, i))
}
const tip = computed(() => {
  if (hover.value === null) return null
  const p = series.value[hover.value]!
  const rows = props.seats
    .map(s => ({ id: s.id, name: s.name, v: p.stacks[s.id] ?? 0 }))
    .sort((a, b) => b.v - a.v)
  // The tooltip sits in the half of the plot away from the crosshair, so it never covers the hovered hand.
  const leftPct = (xOf(hover.value) / W) * 100
  return { label: p.handNo === 0 ? 'Start' : `After hand #${p.handNo}`, rows, leftPct }
})

/** Current stacks, biggest first, with net since the session started. */
const bars = computed(() => {
  const max = Math.max(...props.seats.map(s => s.stack), 1)
  return props.seats
    .map(s => ({ ...s, net: s.stack - (props.startingStacks[s.id] ?? 0), pct: (s.stack / max) * 100 }))
    .sort((a, b) => b.stack - a.stack)
})
</script>

<template>
  <div
    class="px-4 py-3.5"
    data-testid="chip-chart"
  >
    <div class="flex items-baseline gap-2 mb-2">
      <h4 class="text-[13px] font-semibold text-highlighted">
        Stacks over the session
      </h4>
      <span class="text-xs text-dimmed">{{ hands.length ? `${hands.length} ${hands.length === 1 ? 'hand' : 'hands'}` : 'no hands yet' }}</span>
    </div>

    <div
      v-if="hands.length"
      class="relative"
    >
      <svg
        ref="svg"
        :viewBox="`0 0 ${W} ${H}`"
        width="100%"
        role="img"
        :aria-label="`Chip stacks over ${hands.length} hands`"
        class="block touch-none overflow-visible"
        @pointermove="onMove"
        @pointerleave="hover = null"
      >
        <g>
          <template
            v-for="t in yTicks"
            :key="t"
          >
            <line
              :x1="PAD.left"
              :x2="right"
              :y1="yOf(t)"
              :y2="yOf(t)"
              :stroke="t === 0 ? 'var(--chart-axis)' : 'var(--chart-grid)'"
              stroke-width="1"
              vector-effect="non-scaling-stroke"
            />
            <text
              :x="PAD.left - 6"
              :y="yOf(t) + 3.5"
              text-anchor="end"
              font-size="10"
              class="fill-(--ui-text-dimmed) tabular-nums"
            >{{ compact(t) }}</text>
          </template>
          <text
            :x="PAD.left"
            :y="H - 6"
            font-size="10"
            class="fill-(--ui-text-dimmed)"
          >start</text>
          <text
            :x="right"
            :y="H - 6"
            font-size="10"
            text-anchor="end"
            class="fill-(--ui-text-dimmed)"
          >hand {{ lastHand }}</text>
        </g>

        <line
          v-if="hover !== null"
          :x1="xOf(hover)"
          :x2="xOf(hover)"
          :y1="PAD.top"
          :y2="H - PAD.bottom"
          stroke="var(--ui-border-accented)"
          stroke-width="1"
          vector-effect="non-scaling-stroke"
        />

        <polyline
          v-for="l in lines"
          :key="l.id"
          fill="none"
          :stroke="l.color"
          stroke-width="2"
          stroke-linejoin="round"
          stroke-linecap="round"
          :stroke-dasharray="l.dash"
          vector-effect="non-scaling-stroke"
          :points="l.points"
          :data-seat="l.id"
        />
        <circle
          v-for="l in lines"
          :key="`end-${l.id}`"
          :cx="l.end.x"
          :cy="l.end.y"
          r="4"
          :fill="l.color"
          stroke="var(--ui-bg)"
          stroke-width="2"
        />
        <template v-if="hover !== null">
          <circle
            v-for="l in lines"
            :key="`h-${l.id}`"
            :cx="xOf(hover)"
            :cy="yOf(series[hover]!.stacks[l.id] ?? 0)"
            r="4"
            :fill="l.color"
            stroke="var(--ui-bg)"
            stroke-width="2"
          />
        </template>
        <template v-if="endLabels">
          <text
            v-for="e in endLabels"
            :key="`lbl-${e.id}`"
            :x="right + 9"
            :y="e.y + 3.5"
            font-size="10.5"
            class="fill-(--ui-text-toned)"
          >{{ (seats.find(s => s.id === e.id)?.name ?? e.id).slice(0, 12) }}</text>
        </template>
      </svg>

      <div
        v-if="tip"
        class="pointer-events-none absolute top-1 z-10 min-w-[150px] rounded-md border border-default bg-default/95 px-2.5 py-2 text-[11.5px] shadow-md"
        :class="tip.leftPct > 50 ? 'left-9' : 'right-0'"
      >
        <div class="stat-label mb-1.5">
          {{ tip.label }}
        </div>
        <div
          v-for="r in tip.rows"
          :key="r.id"
          class="flex items-center gap-1.5 py-px"
        >
          <svg
            width="14"
            height="6"
            aria-hidden="true"
          ><line
            x1="1"
            x2="13"
            y1="3"
            y2="3"
            :stroke="color(r.id)"
            stroke-width="2"
            stroke-linecap="round"
            :stroke-dasharray="dashes[r.id] ? '3 2' : undefined"
          /></svg>
          <span class="text-toned truncate max-w-[110px]">{{ r.name }}</span>
          <span class="ml-auto num text-highlighted tabular-nums">{{ r.v.toLocaleString() }}</span>
        </div>
      </div>

      <ul class="flex flex-wrap gap-x-3.5 gap-y-1 mt-2 text-xs text-toned">
        <li
          v-for="s in seats"
          :key="s.id"
          class="inline-flex items-center gap-1.5"
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
            :stroke="color(s.id)"
            stroke-width="2"
            stroke-linecap="round"
            :stroke-dasharray="dashes[s.id] ? '3 2' : undefined"
          /></svg>
          {{ s.name }}
        </li>
      </ul>
    </div>
    <p
      v-else
      class="py-6 text-sm text-dimmed text-center"
    >
      The chart starts after the first hand.
    </p>

    <h4 class="mt-5 mb-2 text-[13px] font-semibold text-highlighted">
      Stacks now
    </h4>
    <ul
      class="flex flex-col gap-2"
      data-testid="stack-bars"
    >
      <li
        v-for="b in bars"
        :key="b.id"
        class="grid grid-cols-[minmax(0,108px)_minmax(0,1fr)_auto_52px] items-center gap-2 text-[12.5px]"
      >
        <span class="inline-flex items-center gap-1.5 min-w-0">
          <span
            class="size-2 rounded-full bg-(--c) shrink-0"
            :style="{ '--c': color(b.id) }"
          />
          <span
            class="truncate"
            :class="b.stack ? 'text-highlighted' : 'text-dimmed line-through'"
          >{{ b.name }}</span>
        </span>
        <span
          class="h-2 rounded-r-[4px] bg-(--c) min-w-px"
          :style="{ '--c': color(b.id), 'width': `${b.pct}%` }"
        />
        <span class="num text-highlighted tabular-nums text-right">{{ b.stack.toLocaleString() }}</span>
        <span
          class="num tabular-nums text-right text-xs font-semibold"
          :class="b.net > 0 ? 'text-success' : b.net < 0 ? 'text-error' : 'text-muted'"
        >{{ b.net > 0 ? '+' : b.net < 0 ? '−' : '±' }}{{ Math.abs(b.net).toLocaleString() }}</span>
      </li>
    </ul>
  </div>
</template>
