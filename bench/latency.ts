/**
 * Latency per reasoning setting for one LLM, on the same N seat views.
 *   node --env-file=.env bench/latency.ts --model anthropic/claude-haiku-5.5 --n 5 --settings unset,low
 * Views come from a seeded table played with random legal actions (no gateway calls).
 */
import { parseArgs } from 'node:util'
import { decide } from '../server/utils/decide.ts'
import { buildMenu } from '../shared/utils/menu.ts'
import type { Reasoning } from '../shared/utils/models.ts'
import { costUsd } from '../shared/utils/pricing.ts'
import { seededRng } from '../shared/utils/rng.ts'
import { applyAction, newTable, seatView, startHand } from '../shared/utils/table.ts'
import type { SeatView, TableState } from '../shared/utils/types.ts'

const { values: args } = parseArgs({
  options: {
    model: { type: 'string', default: 'anthropic/claude-haiku-5.5' },
    n: { type: 'string', default: '5' },
    settings: { type: 'string', default: 'unset,low' },
    seed: { type: 'string', default: '3' }
  }
})
const n = Math.min(Number(args.n), 10)
const rng = seededRng(Number(args.seed))

// Sample views spread over hands and streets.
const views: SeatView[] = []
let state: TableState = newTable({
  players: ['a', 'b', 'c', 'd'].map(id => ({ id, name: `Player ${id.toUpperCase()}`, modelId: 'x' })),
  stacks: 1000,
  smallBlind: 5,
  bigBlind: 10
}, Number(args.seed))
while (views.length < n) {
  state = startHand(state)
  let step = 0
  while (state.street !== 'complete' && state.toAct !== null) {
    const seat = state.seats[state.toAct]!
    const view = seatView(state, seat.id)
    if (step++ % 3 === 0 && views.length < n) views.push(view)
    const menu = buildMenu(view)
    const passive = menu.find(o => o.id === 'check' || o.id === 'call')!
    state = applyAction(state, seat.id, rng() < 0.8 ? passive.action : menu[Math.floor(rng() * menu.length)]!.action)
  }
  for (const s of state.seats) if (s.stack <= 0) s.stack = 1000
}

for (const setting of args.settings!.split(',') as (Reasoning | 'unset')[]) {
  const ms: number[] = []
  let cost = 0
  let fallbacks = 0
  let outTokens = 0
  for (const view of views) {
    const d = await decide({ modelId: args.model!, view, reasoning: setting })
    if (d.fallback) fallbacks++
    else ms.push(d.latencyMs)
    cost += costUsd(args.model!, d.usage)
    outTokens += d.usage.output
    console.log(`  ${setting.padEnd(6)} ${view.street.padEnd(7)} ${d.menuId.padEnd(14)} ${d.latencyMs}ms out=${d.usage.output}${d.fallback ? ' [FALLBACK]' : ''}`)
  }
  const sorted = [...ms].sort((a, b) => a - b)
  const avg = ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0
  console.log(`${args.model} reasoning=${setting}: avg ${avg}ms · median ${sorted[Math.floor(sorted.length / 2)] ?? 0}ms · avg out ${Math.round(outTokens / views.length)} tok · fallbacks ${fallbacks}/${views.length} · $${cost.toFixed(5)}`)
}
