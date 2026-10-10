<script setup lang="ts">
import type { Card } from '~~/shared/utils/types'

const props = withDefaults(defineProps<{
  /** Omit for an empty board slot. */
  card?: Card | null
  back?: boolean
  size?: 'sm' | 'md' | 'lg'
  /** Showdown emphasis: lifted + ringed, or dimmed. */
  emphasis?: 'hi' | 'lo'
}>(), { card: null, size: 'md', emphasis: undefined })

const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' } as const

const rank = computed(() => props.card ? (props.card[0] === 'T' ? '10' : props.card[0]) : '')
const suit = computed(() => props.card ? SUIT[props.card[1] as keyof typeof SUIT] : '')
const red = computed(() => props.card?.[1] === 'h' || props.card?.[1] === 'd')
const label = computed(() => props.back ? 'Face-down card' : props.card ? `${rank.value}${suit.value}` : 'Empty slot')

const sizes = {
  sm: 'w-[22px] h-[30px] rounded-[4px] px-[3px] py-[2px]',
  md: 'w-9 h-[52px] sm:w-11 sm:h-[62px] rounded-md px-1.5 py-1',
  lg: 'w-[58px] h-[82px] rounded-lg px-[7px] py-1.5'
}
const rankSize = { sm: 'text-[11px]', md: 'text-[15px] sm:text-[17px]', lg: 'text-[22px]' }
const suitSize = { sm: 'text-[10px]', md: 'text-[13px] sm:text-[15px] mt-0.5', lg: 'text-[19px] mt-0.5' }
</script>

<template>
  <div
    role="img"
    :aria-label="label"
    class="relative flex flex-col items-start shrink-0 leading-none transition-[opacity,transform] duration-200"
    :class="[
      sizes[size],
      back
        ? 'bg-[repeating-linear-gradient(45deg,var(--back-a)_0_4px,var(--back-b)_4px_8px)] shadow-[inset_0_0_0_3px_var(--card-bg),0_1px_2px_rgba(0,0,0,.18)]'
        : card
          ? ['bg-(--card-bg) shadow-[0_1px_2px_rgba(0,0,0,.18),inset_0_0_0_1px_rgba(0,0,0,.06)]', red ? 'text-(--card-red)' : 'text-(--card-black)']
          : 'shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--felt-ink)_22%,transparent)]',
      emphasis === 'hi' && '-translate-y-[3px] ring-2 ring-success',
      emphasis === 'lo' && 'opacity-45'
    ]"
  >
    <template v-if="card && !back">
      <span
        class="font-semibold tracking-tight"
        :class="rankSize[size]"
      >{{ rank }}</span>
      <span :class="suitSize[size]">{{ suit }}</span>
      <span
        v-if="size === 'lg'"
        class="absolute right-[5px] bottom-[3px] text-[28px] opacity-90"
      >{{ suit }}</span>
      <span
        v-else-if="size === 'md'"
        class="absolute right-[5px] bottom-[3px] text-xl opacity-90 max-sm:hidden"
      >{{ suit }}</span>
    </template>
  </div>
</template>
