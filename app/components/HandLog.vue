<script setup lang="ts">
import type { ActionEvent, Card, Decision, Seat, Street } from '~~/shared/utils/types'
import { findModel } from '~~/shared/utils/models'

const props = withDefaults(defineProps<{
  seats: Pick<Seat, 'id' | 'name' | 'modelId'>[]
  log: ActionEvent[]
  board: Card[]
  actionLabels: string[]
  blindsNote: string
  /** Show reasoning / probabilities inline (Watch mode, or a finished hand). */
  reveal: boolean
  /** AI decisions by log index. Pass an empty map while sealed. */
  decisions: Map<number, Decision>
  order?: 'newest' | 'oldest'
  /** Live-only rows. */
  thinking?: string | null
  humanToCall?: number | null
  pot?: number
}>(), { order: 'newest', thinking: null, humanToCall: null, pot: 0 })

type Item
  = | { kind: 'divider', key: string, street: Street, cards: Card[], note?: string }
    | { kind: 'action', key: string, seatId: string, text: string, talk?: string, decision?: Decision }
    | { kind: 'thinking', key: string, seatId: string }
    | { kind: 'prompt', key: string }

const STREET_LABEL: Record<string, string> = { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River' }

const seatsById = computed(() => new Map(props.seats.map(s => [s.id, s])))
const name = (id: string) => seatsById.value.get(id)?.name ?? id
const color = (id: string) => seatColor(seatsById.value.get(id)?.modelId ?? null)
const modelKind = (id: string) => findModel(seatsById.value.get(id)?.modelId)?.kind

const items = computed<Item[]>(() => {
  const out: Item[] = [{ kind: 'divider', key: 'd-preflop', street: 'preflop', cards: [], note: props.blindsNote }]
  const boards: [Street, number, number][] = [['flop', 0, 3], ['turn', 3, 4], ['river', 4, 5]]
  const pushEvents = (street: Street) => props.log.forEach((e, i) => {
    if (e.street !== street) return
    out.push({ kind: 'action', key: `a-${i}`, seatId: e.seatId, text: props.actionLabels[i] ?? e.action.type, talk: e.tableTalk, decision: props.reveal ? props.decisions.get(i) : undefined })
  })
  pushEvents('preflop')
  for (const [street, from, to] of boards) {
    if (props.board.length < to) break
    out.push({ kind: 'divider', key: `d-${street}`, street, cards: props.board.slice(from, to) })
    pushEvents(street)
  }
  if (props.thinking) out.push({ kind: 'thinking', key: `t-${props.thinking}`, seatId: props.thinking })
  else if (props.humanToCall !== null) out.push({ kind: 'prompt', key: 'prompt' })
  return props.order === 'newest' ? out.reverse() : out
})
</script>

<template>
  <ul>
    <li
      v-for="it in items"
      :key="it.key"
      class="border-b border-muted last:border-b-0"
      :class="[
        it.kind === 'divider' ? 'bg-muted px-4 py-[7px] flex items-center gap-2' : 'px-4 py-2.5',
        it.kind === 'prompt' && 'bg-primary/10'
      ]"
    >
      <template v-if="it.kind === 'divider'">
        <span class="stat-label">{{ STREET_LABEL[it.street] }}</span>
        <PlayingCard
          v-for="c in it.cards"
          :key="c"
          :card="c"
          size="sm"
        />
        <span
          v-if="it.note"
          class="text-xs text-dimmed min-w-0"
        >{{ it.note }}</span>
      </template>

      <div
        v-else-if="it.kind === 'thinking'"
        class="flex items-center gap-1.5 text-[13px]"
      >
        <span
          class="size-2 rounded-full bg-(--c) shrink-0"
          :style="{ '--c': color(it.seatId) }"
        />
        <b class="font-semibold text-highlighted">{{ name(it.seatId) }}</b>
        <span class="text-muted">is thinking…</span>
        <span class="ml-auto size-[7px] rounded-full bg-primary animate-[think-pulse_1.2s_ease-in-out_infinite]" />
      </div>

      <div
        v-else-if="it.kind === 'prompt'"
        class="flex items-center gap-1.5 text-[13px]"
      >
        <span class="size-2 rounded-full bg-primary shrink-0" />
        <b class="font-semibold text-highlighted">Your move</b>
        <span class="text-toned">
          {{ humanToCall ? `${humanToCall.toLocaleString()} to call` : 'check or bet' }} · pot {{ pot.toLocaleString() }}
        </span>
      </div>

      <template v-else>
        <div class="flex items-center gap-1.5 text-[13px]">
          <span
            class="size-2 rounded-full bg-(--c) shrink-0"
            :style="{ '--c': color(it.seatId) }"
          />
          <b class="font-semibold text-highlighted">{{ name(it.seatId) }}</b>
          <span class="text-toned">{{ it.text }}</span>
          <span
            v-if="it.decision"
            class="ml-auto text-[11px] text-dimmed tabular-nums"
          >{{ it.decision.latencyMs.toLocaleString() }} ms</span>
        </div>
        <p
          v-if="it.talk"
          class="mt-1 ml-3.5 text-[13px] italic"
        >
          “{{ it.talk }}”
        </p>
        <DecisionDetail
          v-if="it.decision"
          :decision="it.decision"
        />
        <template v-else-if="reveal" />
        <template v-else-if="modelKind(it.seatId) === 'llm'">
          <div class="mt-1 ml-3.5 inline-flex items-center gap-1 text-[11.5px] text-dimmed">
            <UIcon
              name="i-lucide-lock"
              class="size-3"
            />
            reasoning revealed after the hand
          </div>
        </template>
        <template v-else-if="modelKind(it.seatId) === 'evaluation'">
          <div class="mt-[5px] ml-3.5 h-1.5 w-[140px] rounded-full bg-[repeating-linear-gradient(90deg,var(--ui-bg-accented)_0_6px,var(--ui-bg-elevated)_6px_12px)]" />
          <div class="mt-1 ml-3.5 flex items-center gap-1 text-[11.5px] text-dimmed">
            <UIcon
              name="i-lucide-lock"
              class="size-3"
            />
            probabilities revealed after the hand
          </div>
        </template>
      </template>
    </li>
  </ul>
</template>
