<script setup lang="ts">
import type { SelectMenuItem } from '@nuxt/ui'
import { DEFAULT_LINEUP, MODELS, findModel } from '~~/shared/utils/models'
import type { TableMode } from '~/composables/useLineup'

const lineup = useLineup()

const mode = ref<TableMode>(lineup.value?.mode ?? 'play')

const seats = ref<string[]>(lineup.value?.seats.slice() ?? DEFAULT_LINEUP.slice())
const stack = ref(lineup.value?.stack ?? 1000)
const blinds = ref(lineup.value ? `${lineup.value.smallBlind}/${lineup.value.bigBlind}` : '5/10')

const modelItems: SelectMenuItem[][] = [
  [{ type: 'label' as const, label: 'Language models' }, ...MODELS.filter(m => m.kind === 'llm').map(toItem)],
  [{ type: 'label' as const, label: 'Decision models' }, ...MODELS.filter(m => m.kind === 'evaluation').map(toItem)]
]
function toItem(m: (typeof MODELS)[number]) {
  return { label: m.label, value: m.id, vendor: shortVendor(m.vendor) }
}
const stackItems = [500, 1000, 2000].map(v => ({ label: v.toLocaleString(), value: v }))
const blindItems = ['5/10', '10/20']

const watching = computed(() => mode.value === 'watch')
/** Play: you + 1–5 AIs. Watch: 2–6 AIs. */
const minAI = computed(() => watching.value ? 2 : 1)
const maxAI = computed(() => watching.value ? 6 : 5)
const players = computed(() => seats.value.length + (watching.value ? 0 : 1))

watch(mode, () => {
  while (seats.value.length < minAI.value) addSeat()
  if (seats.value.length > maxAI.value) seats.value = seats.value.slice(0, maxAI.value)
})

const bb = computed(() => Number(blinds.value.split('/')[1]))
const depth = computed(() => Math.round(stack.value / bb.value))

function addSeat() {
  if (seats.value.length >= maxAI.value) return
  const unused = MODELS.find(m => !seats.value.includes(m.id))
  seats.value.push(unused?.id ?? MODELS[0]!.id)
}

function deal() {
  const [sb, big] = blinds.value.split('/').map(Number)
  lineup.value = { mode: mode.value, seats: seats.value.slice(), stack: stack.value, smallBlind: sb!, bigBlind: big! }
  // A new table from setup replaces any session /play would otherwise resume.
  clearSnapshot()
  navigateTo('/play')
}
</script>

<template>
  <div class="max-w-[600px] mx-auto px-4 py-6">
    <UCard :ui="{ header: 'px-4 py-3.5 sm:px-4', body: 'p-4 sm:p-4', footer: 'px-4 py-3 sm:px-4' }">
      <template #header>
        <div class="flex items-center gap-2">
          <h1 class="flex-1 text-[15px] font-semibold text-highlighted">
            Pick your table
          </h1>
          <UBadge
            :label="`${players} / 6 seats`"
            color="neutral"
            variant="soft"
          />
        </div>
      </template>

      <p class="text-[13.5px] text-muted">
        <template v-if="watching">
          No-limit hold'em between 2–6 models while you watch. Every card, every bit of reasoning and every probability is shown live.
        </template>
        <template v-else>
          No-limit hold'em, you against 1–5 models. Language models explain themselves; decision models return probabilities. Everything is revealed after each hand.
        </template>
      </p>

      <div class="flex items-center gap-3 mt-4">
        <span class="text-[13px] font-medium text-highlighted">Your seat</span>
        <UFieldGroup
          size="sm"
          aria-label="Your seat"
        >
          <UButton
            v-for="m in (['play', 'watch'] as const)"
            :key="m"
            :label="m === 'play' ? 'Play' : 'Watch'"
            :icon="m === 'play' ? 'i-lucide-user' : 'i-lucide-eye'"
            color="neutral"
            :variant="mode === m ? 'soft' : 'outline'"
            :aria-pressed="mode === m"
            @click="mode = m"
          />
        </UFieldGroup>
      </div>

      <div class="grid grid-cols-[56px_minmax(0,1fr)_32px] gap-2 items-center mt-3">
        <template v-if="!watching">
          <span class="stat-label whitespace-nowrap">Seat 1</span>
          <div class="flex items-center gap-2 h-8 px-2.5 rounded-md bg-muted text-muted text-[13.5px]">
            <span class="size-2 rounded-full bg-primary" />You
          </div>
          <span />
        </template>

        <template
          v-for="(id, i) in seats"
          :key="i"
        >
          <span class="stat-label whitespace-nowrap">Seat {{ i + (watching ? 1 : 2) }}</span>
          <USelectMenu
            v-model="seats[i]"
            :items="modelItems"
            value-key="value"
            :search-input="false"
            class="w-full"
            :aria-label="`Seat ${i + (watching ? 1 : 2)} model`"
          >
            <template #leading>
              <span
                class="size-2 rounded-full bg-(--c)"
                :style="{ '--c': seatColor(id) }"
              />
            </template>
            <template #trailing>
              <UBadge
                :label="kindLabel(id) ?? ''"
                color="neutral"
                variant="outline"
                size="sm"
              />
              <UIcon
                name="i-lucide-chevron-down"
                class="size-4 text-dimmed"
              />
            </template>
            <template #item-leading="{ item }">
              <span
                v-if="item && typeof item === 'object' && item.value"
                class="size-2 rounded-full bg-(--c) self-center"
                :style="{ '--c': seatColor(String(item?.value)) }"
              />
            </template>
            <template #item-trailing="{ item }">
              <span
                v-if="item && typeof item === 'object' && item.vendor"
                class="text-xs text-dimmed"
              >{{ item.vendor }}</span>
            </template>
          </USelectMenu>
          <UButton
            icon="i-lucide-x"
            color="neutral"
            variant="ghost"
            size="sm"
            square
            :aria-label="`Remove ${findModel(id)?.label ?? 'seat'}`"
            :disabled="seats.length <= minAI"
            @click="seats.splice(i, 1)"
          />
        </template>
      </div>

      <div class="mt-2.5 ml-16 flex items-center gap-2.5">
        <UButton
          label="Add seat"
          icon="i-lucide-plus"
          color="neutral"
          variant="outline"
          size="sm"
          :disabled="seats.length >= maxAI"
          @click="addSeat"
        />
        <span
          v-if="seats.length >= maxAI"
          class="text-xs text-dimmed"
        >Table is full</span>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-5">
        <UFormField label="Starting stack">
          <USelectMenu
            v-model="stack"
            :items="stackItems"
            value-key="value"
            :search-input="false"
            class="w-full"
          />
        </UFormField>
        <UFormField label="Blinds">
          <USelectMenu
            v-model="blinds"
            :items="blindItems"
            :search-input="false"
            class="w-full"
          />
        </UFormField>
      </div>

      <template #footer>
        <div class="flex items-center gap-2.5">
          <span class="text-[13px] text-muted mr-auto">{{ players }} {{ watching ? 'models' : 'players' }} · {{ depth }} big blinds deep</span>
          <UButton
            :label="watching ? 'Start the table' : 'Deal me in'"
            size="lg"
            @click="deal"
          />
        </div>
      </template>
    </UCard>
  </div>
</template>
