<script setup lang="ts">
import type { Card, Decision, Seat } from '~~/shared/utils/types'
import type { HandRecord } from '~/composables/useTable'
import type { Narration } from '~~/shared/utils/narration'

const props = defineProps<{
  hands: HandRecord[]
  seats: Pick<Seat, 'id' | 'name' | 'modelId'>[]
  hasHuman: boolean
  narrations?: Record<number, Narration>
}>()

const SUIT: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' }
const seatsById = computed(() => new Map(props.seats.map(s => [s.id, s])))
const name = (id: string) => seatsById.value.get(id)?.name ?? id

/** "two pair" from "Two pair, aces and sevens". */
const shortHand = (h: string) => h === 'Uncontested' ? 'no showdown' : h.split(',')[0]!.toLowerCase()

/** "Jev won 340 (two pair)" — one clause per winner, summed across their pots. */
function headline(h: HandRecord): string {
  const won = new Map<string, { amount: number, hand: string, split: boolean }>()
  for (const p of h.pots) {
    for (const w of p.winners) {
      const cur = won.get(w)
      const share = Math.floor(p.amount / p.winners.length)
      won.set(w, { amount: (cur?.amount ?? 0) + share, hand: cur?.hand ?? p.handName, split: (cur?.split ?? false) || p.winners.length > 1 })
    }
  }
  return [...won.entries()]
    .map(([id, x]) => `${name(id)} ${x.split ? 'split for' : 'won'} ${x.amount.toLocaleString()} (${shortHand(x.hand)})`)
    .join(' · ')
}

function deltas(h: HandRecord) {
  return Object.entries(h.deltas)
    .filter(([, d]) => d !== 0)
    .map(([id, d]) => ({ id, d }))
    .sort((a, b) => (a.id === 'you' ? -1 : b.id === 'you' ? 1 : b.d - a.d))
}

/** Hole cards this view may show: showdown cards (and your own) with a human seated; everything in Watch mode. */
function held(h: HandRecord): Record<string, Card[]> {
  const out: Record<string, Card[]> = {}
  for (const s of props.seats) {
    const cards = h.shown[s.id]?.cards
      ?? (canShowHoleCards({ hasHuman: props.hasHuman, seatIsHuman: s.modelId === null }) ? h.holes[s.id] : undefined)
    if (cards?.length) out[s.id] = cards
  }
  return out
}

const decisionMap = (h: HandRecord) => new Map<number, Decision>(h.decisions.map(d => [d.logIndex, d.decision]))

const items = computed(() => props.hands.slice().reverse().map(h => ({ value: String(h.handNo), hand: h })))
const open = ref<string | undefined>(undefined)
</script>

<template>
  <UAccordion
    v-if="items.length"
    v-model="open"
    :items="items"
    :ui="{ item: 'border-b border-muted last:border-b-0', trigger: 'px-4 py-2.5 items-start', body: 'p-0' }"
    data-testid="hand-history"
  >
    <template #default="{ item }">
      <span class="block min-w-0 text-left">
        <span class="flex items-baseline gap-1.5 text-[13px]">
          <span class="num text-muted shrink-0">#{{ item.hand.handNo }}</span>
          <span class="font-semibold text-highlighted">{{ headline(item.hand) }}</span>
        </span>
        <span
          v-if="narrations?.[item.hand.handNo]"
          class="block mt-0.5 text-xs italic text-muted"
        >{{ narrations[item.hand.handNo]!.headline }}</span>
        <span class="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1">
          <span
            v-if="item.hand.board.length"
            class="inline-flex gap-1 text-xs font-medium tabular-nums"
            :aria-label="`Board ${item.hand.board.join(' ')}`"
          >
            <span
              v-for="c in item.hand.board"
              :key="c"
              :class="c[1] === 'h' || c[1] === 'd' ? 'text-(--card-red)' : 'text-highlighted'"
            >{{ c[0] === 'T' ? '10' : c[0] }}{{ SUIT[c[1]!] }}</span>
          </span>
          <span
            v-else
            class="text-xs text-dimmed"
          >no flop</span>
          <span
            v-for="x in deltas(item.hand)"
            :key="x.id"
            class="inline-flex items-center gap-1 rounded-full bg-elevated px-1.5 py-px text-[11px]"
          >
            <span
              class="size-1.5 rounded-full bg-(--c)"
              :style="{ '--c': chartColor(seatsById.get(x.id)?.modelId ?? null) }"
            />
            <span class="text-toned max-w-[90px] truncate">{{ name(x.id) }}</span>
            <span
              class="num font-semibold"
              :class="x.d > 0 ? 'text-success' : 'text-error'"
            >{{ x.d > 0 ? '+' : '−' }}{{ Math.abs(x.d).toLocaleString() }}</span>
          </span>
        </span>
      </span>
    </template>
    <template #body="{ item }">
      <BoothEntry
        v-if="narrations?.[item.hand.handNo]"
        :hand-no="item.hand.handNo"
        :narration="narrations[item.hand.handNo]"
        :seats="seats"
        compact
      />
      <div class="px-4 py-2 bg-muted/60 border-y border-muted flex flex-wrap gap-x-3 gap-y-1.5 text-xs text-muted">
        <span
          v-for="(cards, id) in held(item.hand)"
          :key="id"
          class="inline-flex items-center gap-1"
        >
          {{ name(id as string) }}
          <PlayingCard
            v-for="c in cards"
            :key="c"
            :card="c"
            size="sm"
          />
          <span
            v-if="item.hand.shown[id]"
            class="text-dimmed"
          >{{ shortHand(item.hand.shown[id]!.handName) }}</span>
        </span>
      </div>
      <HandLog
        :seats="seats"
        :log="item.hand.log"
        :board="item.hand.board"
        :action-labels="item.hand.actionLabels"
        :blinds-note="item.hand.blindsNote"
        :decisions="decisionMap(item.hand)"
        reveal
        order="oldest"
      />
    </template>
  </UAccordion>
  <p
    v-else
    class="px-4 py-8 text-sm text-dimmed text-center"
  >
    Finished hands land here: who won, the board, and every seat's chip swing.
  </p>
</template>
