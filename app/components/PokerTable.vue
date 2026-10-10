<script setup lang="ts">
import type { TableState } from '~~/shared/utils/types'
import { potTotal } from '~~/shared/utils/table'

const props = defineProps<{
  state: TableState
  thinking: string | null
  /** Watch mode: every hole card face up. */
  godView?: boolean
}>()

type Pt = [number, number]
// Seat centers in % of the table box, clockwise from the human at bottom-center.
// [desktop 16:10, mobile 4:5]. 5- and 6-handed match the storyboard; smaller tables reuse its slots.
const LAYOUTS: Record<number, { lg: Pt[], sm: Pt[] }> = {
  2: { lg: [[50, 89], [50, 10]], sm: [[50, 90], [50, 10]] },
  3: { lg: [[50, 89], [28, 10], [72, 10]], sm: [[50, 90], [27, 9], [73, 9]] },
  4: { lg: [[50, 89], [9, 50], [50, 9], [91, 50]], sm: [[50, 90], [16, 62], [50, 9], [84, 62]] },
  5: { lg: [[50, 89], [9, 50], [28, 10], [72, 10], [91, 50]], sm: [[50, 90], [16, 67], [27, 9], [73, 9], [84, 67]] },
  6: { lg: [[50, 89], [9, 62], [17, 12], [50, 9], [83, 12], [91, 62]], sm: [[50, 90], [16, 66], [17, 10], [50, 10], [83, 10], [84, 66]] }
}
const CENTER = { lg: [50, 48] as Pt, sm: [50, 42] as Pt }

function toward(p: Pt, c: Pt, t: number): Pt {
  return [p[0] + (c[0] - p[0]) * t, p[1] + (c[1] - p[1]) * t]
}
/** Dealer button: a third of the way in, nudged sideways so it clears the bet pill. */
function dealerSpot(p: Pt, c: Pt): Pt {
  const [x, y] = toward(p, c, 0.32)
  const side = Math.abs(p[0] - 50) < 10 ? [10, 0] : [0, p[1] > c[1] ? -11 : 11]
  return [x + side[0]!, y + side[1]!]
}
/** Narrow felt (storyboard mobile): top seats bet just below the rail, side seats bet inward, clear of the board. */
function mobileBet([x, y]: Pt): Pt {
  if (y < 30) return [x + (50 - x) * 0.25, 23]
  if (y > 80) return [50, 74]
  return [x + (50 - x) * 0.65, y - 1]
}
function vars(lg: Pt, sm: Pt) {
  return { '--x': `${lg[0]}%`, '--y': `${lg[1]}%`, '--sx': `${sm[0]}%`, '--sy': `${sm[1]}%` }
}
const POS = 'absolute -translate-1/2 left-(--sx) top-(--sy) sm:left-(--x) sm:top-(--y)'

const layout = computed(() => LAYOUTS[props.state.seats.length] ?? LAYOUTS[6]!)
const toActId = computed(() => props.state.toAct === null ? null : props.state.seats[props.state.toAct]!.id)
const result = computed(() => props.state.street === 'complete' ? props.state.result : undefined)
const winners = computed(() => new Set(result.value?.pots.flatMap(p => p.winners) ?? []))
const pot = computed(() => result.value ? result.value.pots.reduce((a, p) => a + p.amount, 0) : potTotal(props.state))
const nameOf = (id: string) => props.state.seats.find(s => s.id === id)?.name ?? id

const seats = computed(() => props.state.seats.map((seat, i) => {
  const lg = layout.value.lg[i]!
  const sm = layout.value.sm[i]!
  return {
    seat,
    no: i + 1,
    pos: vars(lg, sm),
    bet: vars(toward(lg, CENTER.lg, 0.45), mobileBet(sm)),
    dealer: vars(dealerSpot(lg, CENTER.lg), dealerSpot(sm, CENTER.sm))
  }
}))

/** One line per pot: "Side pot · Jev wins 340 with two pair, aces and sevens". */
const notes = computed(() => {
  const r = result.value
  if (!r) return []
  return r.pots.map((p, i) => ({ label: potLabel(i, r.pots.length), text: potSentence(p, nameOf) }))
})

/** The best hand at showdown is the main-pot winner's (everyone contests the main pot). */
const best5 = computed(() => {
  const r = result.value
  if (!r || !Object.keys(r.shown).length) return null
  return new Set(r.pots[0]?.winners.flatMap(id => r.shown[id]?.best5 ?? []) ?? [])
})
const emphasis = (c: string | undefined) => !best5.value || !c ? undefined : best5.value.has(c as never) ? 'hi' as const : 'lo' as const
</script>

<template>
  <div class="relative max-sm:mt-4 aspect-4/5 sm:aspect-16/10 sm:min-h-[440px]">
    <div
      class="absolute inset-[16%_13%_18%] sm:inset-[13%_11%_15%] rounded-[140px] sm:rounded-full bg-[radial-gradient(ellipse_at_50%_45%,color-mix(in_srgb,var(--felt-bg)_92%,white)_0%,var(--felt-bg)_70%)] shadow-[inset_0_0_0_6px_var(--felt-border),inset_0_0_0_7px_color-mix(in_srgb,var(--felt-border)_60%,black_8%)]"
    />

    <template
      v-for="s in seats"
      :key="s.seat.id"
    >
      <div
        v-if="s.seat.committed > 0"
        :class="[POS, state.street === 'complete' && 'max-sm:hidden']"
        :style="s.bet"
        class="z-1 inline-flex items-center gap-[5px] bg-default text-highlighted rounded-full py-0.5 pl-[3px] pr-[9px] num text-[13px] font-medium shadow-sm"
      >
        <span class="size-3.5 rounded-full bg-primary shadow-[inset_0_0_0_2.5px_color-mix(in_srgb,var(--ui-primary)_70%,white),inset_0_0_0_4px_var(--ui-primary)]" />
        {{ s.seat.committed.toLocaleString() }}
      </div>
      <div
        v-if="state.button === s.no - 1 && state.handNo > 0"
        :class="POS"
        :style="s.dealer"
        class="z-1 size-[22px] rounded-full bg-(--card-bg) text-(--card-black) text-[11px] font-semibold grid place-items-center shadow-[0_1px_2px_rgba(0,0,0,.2),inset_0_0_0_1px_var(--ui-border-accented)]"
        aria-label="Dealer button"
      >
        D
      </div>
      <SeatPod
        :class="POS"
        :style="s.pos"
        class="z-2"
        :seat="s.seat"
        :seat-no="s.no"
        :acting="toActId === s.seat.id"
        :thinking="thinking === s.seat.id"
        :shown="result?.shown[s.seat.id]?.cards ?? (godView && s.seat.hole.length ? s.seat.hole : undefined)"
        :winner="winners.has(s.seat.id)"
        :delta="result?.deltas[s.seat.id]"
        :hand-name="result?.shown[s.seat.id]?.handName"
        :best5="result?.shown[s.seat.id] ? best5 : null"
      />
    </template>

    <div class="absolute left-1/2 top-[42%] sm:top-[47%] -translate-1/2 text-center text-(--felt-ink)">
      <div class="stat-label text-(--felt-ink-muted)!">
        {{ result ? 'Pot awarded' : 'Pot' }}
      </div>
      <div class="num text-2xl sm:text-[30px] leading-tight font-medium mt-1 mb-2.5">
        {{ pot.toLocaleString() }}
      </div>
      <div class="flex gap-1.5 justify-center">
        <PlayingCard
          v-for="i in 5"
          :key="i"
          :card="state.board[i - 1] ?? null"
          :emphasis="emphasis(state.board[i - 1])"
        />
      </div>
      <ul
        v-if="notes.length"
        data-testid="result-strip"
        class="mt-2.5 mx-auto w-max max-w-[240px] sm:max-w-[420px] px-3 py-1 rounded-xl bg-default/85 text-balance text-highlighted text-xs sm:text-[13px] font-medium shadow-sm"
      >
        <li
          v-for="(n, i) in notes"
          :key="i"
          class="py-px"
        >
          <span
            v-if="n.label"
            class="text-muted font-normal"
          >{{ n.label }} · </span>{{ n.text }}
        </li>
      </ul>
    </div>
  </div>
</template>
