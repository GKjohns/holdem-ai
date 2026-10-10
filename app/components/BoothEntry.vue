<script setup lang="ts">
import type { Narration } from '~~/shared/utils/narration'
import { findModel } from '~~/shared/utils/models'
import type { Seat } from '~~/shared/utils/types'

const props = defineProps<{
  handNo: number
  narration?: Narration
  pending?: boolean
  failed?: boolean
  seats: Pick<Seat, 'id' | 'name' | 'modelId'>[]
  /** Tighter variant inside a Hands-tab entry. */
  compact?: boolean
}>()

const STREET: Record<string, string> = { preflop: 'preflop', flop: 'the flop', turn: 'the turn', river: 'the river', showdown: 'showdown' }
const seat = computed(() => props.seats.find(s => s.id === props.narration?.keyMoment.seatId))
const narratorLabel = computed(() => props.narration ? (findModel(props.narration.model)?.label ?? props.narration.model).replace(/^Claude /, '') : '')
</script>

<template>
  <div
    class="bg-muted/70 border-b border-muted"
    :class="compact ? 'px-4 py-2.5' : 'px-4 py-3'"
    data-testid="booth-entry"
  >
    <div class="flex items-center gap-1.5">
      <UIcon
        name="i-lucide-mic"
        class="size-[13px] text-muted shrink-0"
      />
      <span class="stat-label">Booth · hand #{{ handNo }}</span>
      <UBadge
        v-if="narration"
        :label="narratorLabel"
        size="sm"
        variant="outline"
        color="neutral"
        class="ml-auto"
      />
      <span
        v-if="$slots.actions"
        :class="!narration && 'ml-auto'"
      ><slot name="actions" /></span>
    </div>
    <template v-if="narration">
      <div class="mt-1.5 font-semibold text-highlighted text-[14px] leading-snug">
        {{ narration.headline }}
      </div>
      <p class="mt-1 text-[13px] leading-relaxed text-toned">
        {{ narration.playByPlay }}
      </p>
      <p class="mt-1.5 text-[12.5px] text-muted">
        <span class="font-medium text-toned">Key moment:</span>
        <span
          class="inline-block size-1.5 rounded-full bg-(--c) mx-1 align-middle"
          :style="{ '--c': seatColor(seat?.modelId ?? null) }"
        />{{ seat?.name ?? narration.keyMoment.seatId }} on {{ STREET[narration.keyMoment.street] ?? narration.keyMoment.street }}. {{ narration.keyMoment.why }}
      </p>
    </template>
    <div
      v-else-if="pending"
      class="mt-1.5 flex items-center gap-1.5 text-[13px] text-muted"
    >
      The Booth is writing this one up…
      <span class="size-[7px] rounded-full bg-primary animate-[think-pulse_1.2s_ease-in-out_infinite]" />
    </div>
    <p
      v-else-if="failed"
      class="mt-1.5 text-[13px] text-dimmed"
    >
      The Booth missed this hand (the narrator didn't answer in time).
    </p>
  </div>
</template>
