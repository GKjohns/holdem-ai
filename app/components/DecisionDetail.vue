<script setup lang="ts">
import type { Decision, MenuId } from '~~/shared/utils/types'

const props = defineProps<{ decision: Decision }>()

type Group = 'fold' | 'check' | 'call' | 'raise'
const GROUP: Record<MenuId, Group> = {
  fold: 'fold', check: 'check', call: 'call',
  raise_min: 'raise', raise_half_pot: 'raise', raise_pot: 'raise', raise_2x_pot: 'raise', all_in: 'raise'
}
const COLOR: Record<Group, string> = { fold: 'bg-(--ui-text-dimmed)', check: 'bg-(--ui-text-toned)', call: 'bg-(--ui-text-toned)', raise: 'bg-primary' }

/** Decision-model probabilities folded into fold / check-or-call / raise, largest first. */
const groups = computed(() => {
  const p = props.decision.probabilities
  if (!p || !Object.keys(p).length) return null
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
</script>

<template>
  <div class="mt-1 ml-3.5">
    <div
      v-if="groups"
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
    <UBadge
      v-if="decision.fallback"
      label="fallback"
      color="warning"
      variant="soft"
      size="sm"
      class="mt-1"
    />
  </div>
</template>
