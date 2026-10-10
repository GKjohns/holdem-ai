<script setup lang="ts">
/** One row's estimate and 95% CI on a scale shared by the whole column, with a zero line. */
const props = defineProps<{
  value: number | null
  lo: number | null
  hi: number | null
  min: number
  max: number
  color: string
  /** Tooltip text. */
  label: string
}>()

const W = 200
const H = 22
const x = (v: number) => 6 + ((v - props.min) / Math.max(props.max - props.min, 1e-9)) * (W - 12)
</script>

<template>
  <UTooltip :text="label">
    <svg
      :viewBox="`0 0 ${W} ${H}`"
      class="block w-full h-[22px] min-w-[120px]"
      role="img"
      :aria-label="label"
    >
      <line
        v-if="min < 0 && max > 0"
        :x1="x(0)"
        :x2="x(0)"
        y1="2"
        :y2="H - 2"
        stroke="var(--chart-axis)"
        stroke-width="1"
      />
      <line
        v-if="lo !== null && hi !== null"
        :x1="x(lo)"
        :x2="x(hi)"
        :y1="H / 2"
        :y2="H / 2"
        :stroke="color"
        stroke-opacity="0.55"
        stroke-width="4"
        stroke-linecap="round"
      />
      <circle
        v-if="value !== null"
        :cx="x(value)"
        :cy="H / 2"
        r="4.5"
        :fill="color"
        stroke="var(--ui-bg)"
        stroke-width="2"
      />
    </svg>
  </UTooltip>
</template>
