<script setup lang="ts">
import type { Pace } from '~/composables/useTable'

defineProps<{
  handNo: number
  handCap: number
  seatCount: number
  /** Why the table stopped, once it has. */
  finished: string | null
  /** Session spend cap, USD. */
  cap: number
  capped: boolean
}>()

const pace = defineModel<Pace>('pace', { required: true })

const PACES: { value: Pace, label: string }[] = [
  { value: 'pause', label: 'Pause' },
  { value: '1x', label: '1×' },
  { value: '4x', label: '4×' },
  { value: 'max', label: 'Max' }
]
</script>

<template>
  <UCard
    class="mt-4"
    :ui="{ body: 'p-3.5 sm:p-4 flex flex-wrap items-center gap-x-5 gap-y-3' }"
  >
    <div class="flex-1 min-w-[200px]">
      <div class="stat-label">
        {{ finished ? 'Table finished' : 'Watching' }}
      </div>
      <div class="mt-1.5 font-semibold text-highlighted">
        Hand <span class="num">{{ handNo }}</span> of {{ handCap }} · {{ seatCount }} models, no human seat
      </div>
      <div class="text-[12.5px] text-muted">
        {{ finished ?? 'Every hole card is visible to you; each model still sees only its own.' }}
      </div>
    </div>
    <span
      class="text-[12.5px]"
      :class="capped ? 'text-warning font-medium' : 'text-muted'"
    >{{ capped ? `Paused at the $${cap.toFixed(2)} cap` : `Session cap $${cap.toFixed(2)}` }}</span>
    <UFieldGroup
      size="sm"
      aria-label="Pace"
    >
      <UButton
        v-for="p in PACES"
        :key="p.value"
        :label="p.label"
        :icon="p.value === 'pause' ? 'i-lucide-pause' : undefined"
        color="neutral"
        :variant="pace === p.value ? 'soft' : 'outline'"
        :aria-pressed="pace === p.value"
        :disabled="!!finished"
        @click="pace = p.value"
      />
    </UFieldGroup>
  </UCard>
</template>
