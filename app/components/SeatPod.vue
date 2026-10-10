<script setup lang="ts">
import type { Card, Seat } from '~~/shared/utils/types'
import { findModel } from '~~/shared/utils/models'

const props = defineProps<{
  seat: Seat
  seatNo: number
  acting: boolean
  thinking: boolean
  /** Hole cards turned up at showdown. */
  shown?: Card[]
  winner?: boolean
  /** Chip change for the finished hand. */
  delta?: number
  /** Showdown hand name, shown in place of the last action. */
  handName?: string
  /** The winning five at showdown: shown cards in it lift, the rest dim. */
  best5?: Set<string> | null
}>()

const model = computed(() => findModel(props.seat.modelId))
const isHuman = computed(() => props.seat.modelId === null)
const color = computed(() => seatColor(props.seat.modelId))
const kind = computed(() => kindLabel(props.seat.modelId))
const out = computed(() => props.seat.busted || props.seat.folded)
</script>

<template>
  <div
    class="w-[108px] sm:w-[150px] px-2 py-[7px] sm:px-2.5 sm:py-[9px] bg-default border border-default rounded-[10px] shadow-xs transition-[opacity,box-shadow] duration-200"
    :class="[
      acting && 'ring-2 ring-primary border-transparent',
      winner && 'ring-2 ring-success border-transparent',
      out && '*:opacity-40'
    ]"
  >
    <!-- PokerTable positions the pod absolutely, which anchors this pill. -->
    <span
      v-if="delta"
      data-testid="seat-delta"
      class="absolute -top-3 left-2.5 num text-[13px] font-semibold px-2 py-px rounded-full"
      :class="delta > 0 ? 'bg-success text-inverted' : 'bg-default text-error ring ring-inset ring-error/40'"
    >{{ delta > 0 ? '+' : '−' }}{{ Math.abs(delta).toLocaleString() }}</span>
    <div class="font-semibold text-xs sm:text-[13px] text-highlighted truncate">
      {{ seat.name }}
    </div>
    <div class="flex flex-wrap gap-1 mt-[5px] mb-1.5">
      <UBadge
        v-if="isHuman"
        :label="`Seat ${seatNo}`"
        color="neutral"
        variant="soft"
        size="sm"
      />
      <template v-else-if="model">
        <UBadge
          :label="shortVendor(model.vendor)"
          size="sm"
          variant="soft"
          color="neutral"
          class="text-(--c) bg-(--c)/12 ring ring-inset ring-(--c)/30"
          :style="{ '--c': color }"
        />
        <UBadge
          :label="kind!"
          size="sm"
          variant="outline"
          color="neutral"
          class="max-sm:hidden"
        />
      </template>
    </div>
    <div class="flex items-center justify-between gap-1.5">
      <span class="num text-base sm:text-lg leading-none font-medium text-highlighted">{{ seat.stack.toLocaleString() }}</span>
      <div
        v-if="shown?.length"
        class="flex gap-0.5"
      >
        <PlayingCard
          v-for="c in shown"
          :key="c"
          :card="c"
          size="sm"
          :emphasis="best5 ? (best5.has(c) ? 'hi' : 'lo') : undefined"
        />
      </div>
      <div
        v-else-if="!isHuman && !out && seat.hole.length"
        class="flex gap-0.5"
      >
        <PlayingCard
          back
          size="sm"
        />
        <PlayingCard
          back
          size="sm"
        />
      </div>
    </div>
    <div class="text-xs text-muted mt-[5px] min-h-[17px] flex items-center gap-1.5 truncate">
      <template v-if="thinking">
        <span class="size-[7px] rounded-full bg-primary shrink-0 animate-[think-pulse_1.2s_ease-in-out_infinite]" />
        <span>thinking…</span>
      </template>
      <span
        v-else-if="isHuman && acting"
        class="text-primary font-medium"
      >your turn</span>
      <span
        v-else-if="handName"
        class="truncate text-highlighted"
      >{{ handName }}</span>
      <UBadge
        v-else-if="seat.busted"
        label="Busted"
        color="error"
        variant="soft"
        size="sm"
        class="opacity-100"
      />
      <UBadge
        v-else-if="seat.allIn && !seat.folded"
        label="All-in"
        color="primary"
        size="sm"
      />
      <span
        v-else
        class="truncate"
      >{{ seat.lastAction ?? '' }}</span>
    </div>
  </div>
</template>
