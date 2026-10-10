<script setup lang="ts">
import type { Card, LegalActions, MenuId, MenuOption, PlayerAction } from '~~/shared/utils/types'

const props = defineProps<{
  hole: Card[]
  stack: number
  /** Set only when it's the human's turn. */
  legal: LegalActions | null
  menu: MenuOption[]
  /** Name of the seat being waited on, mid-hand. */
  waitingOn: string | null
  complete: boolean
  /** One line about the finished hand. */
  summary?: string
  canDeal: boolean
  /** Why no next hand can be dealt. */
  finished: string | null
  bigBlind: number
}>()

const emit = defineEmits<{
  act: [action: PlayerAction]
  deal: []
}>()

const PRESETS: { id: MenuId, label: string }[] = [
  { id: 'raise_min', label: 'Min' },
  { id: 'raise_half_pot', label: '½ pot' },
  { id: 'raise_pot', label: 'Pot' },
  { id: 'all_in', label: 'All-in' }
]

const live = computed(() => !!props.legal)
const amount = ref(props.bigBlind * 2)

// Each new decision point starts the raise amount at the minimum.
watch(() => props.legal, (l) => {
  if (l) amount.value = l.minRaiseTo
}, { immediate: true })

// The number field has no min/max of its own (it resets out-of-range input to the min);
// clamp here so a typed 99999 becomes all-in and a typed 5 becomes the min raise.
watch(amount, (v) => {
  const l = props.legal
  if (!l) return
  const c = Math.min(l.maxRaiseTo, Math.max(l.minRaiseTo, Math.round(Number.isFinite(v) ? v : l.minRaiseTo)))
  if (c !== v) amount.value = c
})

const presets = computed(() => {
  const l = props.legal
  if (!l) return PRESETS.map(p => ({ ...p, to: null as number | null }))
  return PRESETS.map((p) => {
    const opt = props.menu.find(o => o.id === p.id)
    const to = !opt ? null : opt.action.type === 'raise' ? opt.action.to : opt.action.type === 'all_in' ? l.maxRaiseTo : null
    return { ...p, to }
  })
})

const canRaise = computed(() => props.legal?.canRaise ?? true)
const isBet = computed(() => props.menu.some(o => o.label.startsWith('Bet')))
const clamped = computed(() => {
  const l = props.legal
  if (!l) return amount.value
  return Math.min(l.maxRaiseTo, Math.max(l.minRaiseTo, Math.round(amount.value || 0)))
})
const callLabel = computed(() => {
  const l = props.legal
  if (!l) return 'Check'
  if (l.canCheck) return 'Check'
  return l.toCall >= props.stack ? `Call ${l.toCall.toLocaleString()} (all-in)` : `Call ${l.toCall.toLocaleString()}`
})
const raiseLabel = computed(() => {
  const l = props.legal
  if (l && clamped.value >= l.maxRaiseTo) return `All-in ${l.maxRaiseTo.toLocaleString()}`
  return `${isBet.value ? 'Bet' : 'Raise to'} ${clamped.value.toLocaleString()}`
})

function fold() {
  emit('act', { type: 'fold' })
}
function checkOrCall() {
  emit('act', { type: props.legal?.canCheck ? 'check' : 'call' })
}
function raise() {
  const l = props.legal
  if (!l?.canRaise) return
  const to = clamped.value
  emit('act', to >= l.maxRaiseTo ? { type: 'all_in' } : { type: 'raise', to })
}
</script>

<template>
  <UCard
    class="mt-4"
    :ui="{ body: 'p-3.5 sm:p-4 flex flex-wrap items-center gap-x-5 gap-y-4' }"
  >
    <div class="flex items-center gap-1.5">
      <template v-if="hole.length">
        <PlayingCard
          v-for="c in hole"
          :key="c"
          :card="c"
          size="lg"
        />
      </template>
      <template v-else>
        <PlayingCard size="lg" />
        <PlayingCard size="lg" />
      </template>
      <div class="ml-1.5">
        <div class="stat-label">
          Your stack
        </div>
        <div class="num text-xl text-highlighted mt-1">
          {{ stack.toLocaleString() }}
        </div>
      </div>
    </div>

    <div
      v-if="complete"
      class="flex-1 min-w-[220px] flex flex-wrap items-center gap-3"
    >
      <div class="flex-1 min-w-[200px]">
        <div class="font-semibold text-highlighted">
          {{ summary }}
        </div>
        <div
          v-if="finished"
          class="text-sm text-muted"
        >
          {{ finished }}
        </div>
      </div>
      <UButton
        label="Next hand"
        size="lg"
        :disabled="!canDeal"
        @click="emit('deal')"
      />
    </div>

    <div
      v-else
      class="flex-1 min-w-[280px] flex flex-col gap-2.5"
    >
      <div
        v-if="waitingOn"
        class="flex items-center gap-2 text-sm font-medium text-toned"
      >
        <span class="size-[7px] rounded-full bg-primary animate-[think-pulse_1.2s_ease-in-out_infinite]" />
        Waiting on {{ waitingOn }}…
      </div>
      <div
        class="flex flex-col gap-2.5 transition-opacity"
        :class="!live && 'opacity-50'"
      >
        <div class="flex flex-wrap items-center gap-2">
          <UButton
            label="Fold"
            color="neutral"
            variant="outline"
            :disabled="!live"
            @click="fold"
          />
          <UButton
            :label="callLabel"
            color="neutral"
            :disabled="!live"
            @click="checkOrCall"
          />
          <UFieldGroup
            v-if="canRaise"
            size="xs"
            class="ml-auto"
          >
            <UButton
              v-for="p in presets"
              :key="p.id"
              :label="p.label"
              color="neutral"
              :variant="p.to !== null && p.to === clamped && live ? 'soft' : 'outline'"
              :disabled="!live || p.to === null"
              @click="p.to !== null && (amount = p.to)"
            />
          </UFieldGroup>
        </div>
        <div
          v-if="canRaise"
          class="flex flex-wrap items-center gap-2"
        >
          <USlider
            v-model="amount"
            :min="legal?.minRaiseTo ?? 0"
            :max="legal?.maxRaiseTo ?? 100"
            :step="1"
            :disabled="!live || legal!.minRaiseTo >= legal!.maxRaiseTo"
            class="flex-1 min-w-[120px]"
            aria-label="Raise amount"
          />
          <UInputNumber
            v-model="amount"
            :disabled="!live"
            orientation="vertical"
            class="w-28"
            :ui="{ base: 'num text-[15px] font-medium text-right' }"
            aria-label="Raise to"
          />
          <UButton
            :label="raiseLabel"
            :disabled="!live"
            @click="raise"
          />
        </div>
      </div>
    </div>
  </UCard>
</template>
