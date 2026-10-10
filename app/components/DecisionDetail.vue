<script setup lang="ts">
import type { Decision, MenuId } from '~~/shared/utils/types'

const props = defineProps<{
  decision: Decision
  /** Hand review: one bar per menu option instead of the compact fold / call / raise strip. */
  detailed?: boolean
}>()

type Group = 'fold' | 'check' | 'call' | 'raise'
const GROUP: Record<MenuId, Group> = {
  fold: 'fold', check: 'check', call: 'call',
  raise_min: 'raise', raise_half_pot: 'raise', raise_pot: 'raise', raise_2x_pot: 'raise', all_in: 'raise'
}
const COLOR: Record<Group, string> = { fold: 'bg-(--ui-text-dimmed)', check: 'bg-(--ui-text-toned)', call: 'bg-(--ui-text-toned)', raise: 'bg-primary' }
const OPTION: Record<MenuId, string> = {
  fold: 'Fold', check: 'Check', call: 'Call',
  raise_min: 'Min raise', raise_half_pot: '½ pot', raise_pot: 'Pot', raise_2x_pot: '2× pot', all_in: 'All-in'
}
const ORDER_IDS = Object.keys(OPTION) as MenuId[]

const probs = computed(() => {
  const p = props.decision.probabilities
  return p && Object.keys(p).length ? p : null
})

/** Decision-model probabilities folded into fold / check-or-call / raise, largest first. */
const groups = computed(() => {
  const p = probs.value
  if (!p) return null
  const sums = new Map<Group, number>()
  for (const [id, v] of Object.entries(p)) {
    const g = GROUP[id as MenuId]
    if (g) sums.set(g, (sums.get(g) ?? 0) + (v ?? 0))
  }
  const total = [...sums.values()].reduce((a, b) => a + b, 0) || 1
  return [...sums.entries()]
    .map(([g, v]) => ({ g, pct: Math.round((v / total) * 100) }))
    .sort((a, b) => b.pct - a.pct)
})
const ORDER: Group[] = ['fold', 'check', 'call', 'raise']
/** Bar segments in a fixed order so bars compare down the log; the legend stays largest-first. */
const bar = computed(() => groups.value?.slice().sort((a, b) => ORDER.indexOf(a.g) - ORDER.indexOf(b.g)) ?? [])
const chosen = computed(() => GROUP[props.decision.menuId])

/** Every legal option in menu order, for the hand review. */
const options = computed(() => {
  const p = probs.value
  if (!p) return []
  const total = Object.values(p).reduce((a, b) => a + (b ?? 0), 0) || 1
  // Options under 1% are noise; they'd add a row each without telling you anything.
  return ORDER_IDS
    .filter(id => id in p)
    .map(id => ({ id, label: OPTION[id], pct: Math.round(((p[id] ?? 0) / total) * 100) }))
    .filter(o => o.pct >= 1 || o.id === props.decision.menuId)
})
</script>

<template>
  <div class="mt-1 ml-3.5">
    <div
      v-if="probs && detailed"
      data-testid="probabilities"
      class="grid grid-cols-[64px_minmax(0,1fr)_34px] items-center gap-x-2 gap-y-1 text-[11.5px]"
    >
      <template
        v-for="o in options"
        :key="o.id"
      >
        <span :class="o.id === decision.menuId ? 'text-highlighted font-semibold' : 'text-muted'">{{ o.label }}</span>
        <UProgress
          :model-value="o.pct"
          size="xs"
          :color="o.id === decision.menuId ? 'primary' : 'neutral'"
          :aria-label="`${o.label} ${o.pct}%`"
        />
        <span
          class="text-right tabular-nums"
          :class="o.id === decision.menuId ? 'text-highlighted font-semibold' : 'text-muted'"
        >{{ o.pct }}%</span>
      </template>
    </div>
    <div
      v-else-if="groups"
      data-testid="probabilities"
    >
      <div class="flex h-1.5 rounded-full overflow-hidden bg-accented">
        <span
          v-for="x in bar"
          :key="x.g"
          :class="COLOR[x.g]"
          :style="{ width: `${x.pct}%` }"
        />
      </div>
      <div class="flex flex-wrap gap-x-2.5 mt-1 text-[11.5px] text-muted">
        <span
          v-for="x in groups"
          :key="x.g"
          :class="x.g === chosen && 'text-highlighted font-semibold'"
        >{{ x.g }} {{ x.pct }}%</span>
      </div>
    </div>
    <p
      v-else
      data-testid="reasoning"
      class="text-[12.5px] text-toned leading-relaxed"
    >
      {{ decision.reasoning }}
    </p>
    <div
      v-if="decision.fallback || decision.retried"
      class="flex gap-1 mt-1"
    >
      <UBadge
        v-if="decision.fallback"
        label="fallback"
        color="warning"
        variant="soft"
        size="sm"
      />
      <UBadge
        v-if="decision.retried"
        label="refused once, asked again"
        color="neutral"
        variant="soft"
        size="sm"
      />
    </div>
  </div>
</template>
