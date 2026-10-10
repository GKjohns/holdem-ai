/**
 * All-AI self-play: runs a table through the engine + decide() directly and
 * prints every action, final stacks, fallback rate, action mix, and cost.
 *
 *   node --env-file=.env bench/selfplay.ts --hands 20 --models typesafe-ai/jev,openai/gpt-6-luna-decisions,openai/gpt-6-luna
 *   node bench/selfplay.ts --hands 20 --dry-run     # random legal play, token/cost estimate, no gateway calls
 *
 * Busted seats rebuy to the starting stack between hands so the table keeps
 * running; chip conservation is checked against starting chips + rebuys.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { decide, INSTRUCTIONS, renderPrompt, tableState } from '../server/utils/decide.ts'
import { buildMenu } from '../shared/utils/menu.ts'
import { findModel } from '../shared/utils/models.ts'
import { costUsd } from '../shared/utils/pricing.ts'
import { seededRng } from '../shared/utils/rng.ts'
import { applyAction, newTable, seatView, startHand, withTableTalk } from '../shared/utils/table.ts'
import type { Decision, MenuId, TableState } from '../shared/utils/types.ts'

const { values: args } = parseArgs({
  options: {
    'hands': { type: 'string', default: '20' },
    'models': { type: 'string', default: 'typesafe-ai/jev,openai/gpt-6-luna-decisions,openai/gpt-6-luna' },
    'seed': { type: 'string', default: '7' },
    'stack': { type: 'string', default: '1000' },
    'blinds': { type: 'string', default: '5/10' },
    'dry-run': { type: 'boolean', default: false },
    'quiet': { type: 'boolean', default: false },
    'out': { type: 'string' }
  }
})

const hands = Number(args.hands)
const modelIds = args.models!.split(',').map(s => s.trim()).filter(Boolean)
const seed = Number(args.seed)
const stack = Number(args.stack)
const [smallBlind, bigBlind] = args.blinds!.split('/').map(Number) as [number, number]
const dryRun = args['dry-run']
for (const id of modelIds) if (!findModel(id)) throw new Error(`Unknown model ${id}`)
if (modelIds.length < 2 || modelIds.length > 6) throw new Error('2–6 models')
if (!dryRun && !process.env.AI_GATEWAY_API_KEY) throw new Error('AI_GATEWAY_API_KEY missing — run with node --env-file=.env')

const log = (s: string) => {
  if (!args.quiet) console.log(s)
}

// Dry run: passive-leaning random play (real tables check/call far more than they raise)
// with chars/4 token estimates scaled by measured/estimated input tokens on the fixture
// request (2026-10-09): JSON state tokenizes worse, and decision models add scaffolding.
const TOKEN_SCALE: Record<string, number> = { 'llm': 1.3, 'openai/gpt-6-luna-decisions': 1.9, 'typesafe-ai/jev': 3.1 }
const rng = seededRng(seed ^ 0x5eed)
async function dryDecide(modelId: string, view: ReturnType<typeof seatView>): Promise<Decision> {
  const menu = buildMenu(view)
  const kind = findModel(modelId)!.kind
  const passive = menu.find(o => o.id === 'check') ?? menu.find(o => o.id === 'call')!
  const raises = menu.filter(o => o.action.type === 'raise' || o.action.type === 'all_in')
  const r = rng()
  const pick = r < 0.6 || !raises.length
    ? (r < 0.45 || !menu.some(o => o.id === 'fold') ? passive : menu.find(o => o.id === 'fold')!)
    : raises[Math.floor(rng() * raises.length)]!
  const chars = kind === 'llm'
    ? INSTRUCTIONS.length + renderPrompt(view, menu).length
    : JSON.stringify(tableState(view)).length + JSON.stringify(menu.map(o => o.describe)).length
  const input = Math.ceil(chars / 4 * (TOKEN_SCALE[kind === 'llm' ? 'llm' : modelId] ?? 1))
  return { menuId: pick.id, action: pick.action, reasoning: 'dry run', fallback: false, model: modelId, latencyMs: 0, usage: { input, output: kind === 'llm' ? 120 : 0 } }
}

interface Row { hand: number, seat: string, model: string, street: string, decision: Decision }
const rows: Row[] = []
let engineErrors = 0
let rebuys = 0
let handsPlayed = 0
let spent = 0

let state: TableState = newTable({
  players: modelIds.map((id, i) => ({ id: `seat-${i + 1}`, name: findModel(id)!.label, modelId: id })),
  stacks: stack,
  smallBlind,
  bigBlind
}, seed)

const started = Date.now()
for (let h = 0; h < hands; h++) {
  for (const s of state.seats) {
    if (s.stack <= 0) {
      s.stack = stack
      rebuys++
    }
  }
  state = startHand(state)
  log(`\n── Hand ${state.handNo} · button ${state.seats[state.button]!.name}`)
  log(`   ${state.seats.map(s => `${s.name} ${s.hole.join('')}`).join(' · ')}`)
  let guard = 0
  while (state.toAct !== null && state.street !== 'complete') {
    if (++guard > 200) {
      engineErrors++
      console.error('   ! hand did not terminate')
      break
    }
    const seat = state.seats[state.toAct]!
    const view = seatView(state, seat.id)
    const decision = dryRun ? await dryDecide(seat.modelId!, view) : await decide({ modelId: seat.modelId!, view })
    rows.push({ hand: state.handNo, seat: seat.id, model: seat.modelId!, street: state.street, decision })
    spent += costUsd(seat.modelId!, decision.usage)
    try {
      state = applyAction(state, seat.id, decision.action)
      if (decision.tableTalk) state = withTableTalk(state, seat.id, decision.tableTalk)
    } catch (err) {
      engineErrors++
      console.error(`   ! engine rejected ${seat.name} ${JSON.stringify(decision.action)}: ${(err as Error).message}`)
      const menu = buildMenu(view)
      const safe = menu.find(o => o.id === 'check') ?? menu.find(o => o.id === 'fold')!
      state = applyAction(state, seat.id, safe.action)
    }
    const flag = decision.fallback ? ' [FALLBACK]' : ''
    const talk = decision.tableTalk ? ` "${decision.tableTalk}"` : ''
    log(`   ${view.street.padEnd(7)} ${seat.name.padEnd(20)} ${decision.menuId.padEnd(14)} ${String(decision.latencyMs).padStart(5)}ms${flag}${talk}`)
    log(`           ↳ ${decision.reasoning.slice(0, 160)}`)
  }
  handsPlayed++
  if (state.result) {
    log(`   board ${state.board.join(' ') || '—'} · ${state.result.pots.map(p => `${p.amount} → ${p.winners.map(w => state.seats.find(s => s.id === w)!.name).join(' & ')} (${p.handName})`).join('; ')}`)
  }
  const total = state.seats.reduce((n, s) => n + s.stack, 0)
  if (total !== stack * modelIds.length + rebuys * stack) {
    engineErrors++
    console.error(`   ! chips not conserved: ${total}`)
  }
}

// ── summary ────────────────────────────────────────────────────────────────
const buckets = (id: MenuId) => id.startsWith('raise_') ? 'raise' : id
const perModel = modelIds.map((id) => {
  const ds = rows.filter(r => r.model === id).map(r => r.decision)
  const mix: Record<string, number> = { fold: 0, check: 0, call: 0, raise: 0, all_in: 0 }
  for (const d of ds) mix[buckets(d.menuId)]!++
  const fallbacks = ds.filter(d => d.fallback).length
  const live = ds.filter(d => !d.fallback)
  const usage = ds.reduce((u, d) => ({ input: u.input + d.usage.input, output: u.output + d.usage.output }), { input: 0, output: 0 })
  const seat = state.seats.find(s => s.modelId === id)!
  return {
    model: id,
    decisions: ds.length,
    fallbacks,
    fallbackRate: ds.length ? fallbacks / ds.length : 0,
    mix,
    foldRate: ds.length ? mix.fold! / ds.length : 0,
    avgLatencyMs: live.length ? Math.round(live.reduce((n, d) => n + d.latencyMs, 0) / live.length) : 0,
    usage,
    costUsd: costUsd(id, usage),
    finalStack: seat.stack
  }
})
const totalChips = state.seats.reduce((n, s) => n + s.stack, 0)
const summary = {
  dryRun,
  hands: handsPlayed,
  seed,
  blinds: `${smallBlind}/${bigBlind}`,
  startingStack: stack,
  rebuys,
  engineErrors,
  chipsConserved: totalChips === stack * modelIds.length + rebuys * stack,
  totalCostUsd: spent,
  costPerHandUsd: handsPlayed ? spent / handsPlayed : 0,
  wallClockSec: Math.round((Date.now() - started) / 1000),
  perModel
}

console.log('\n══ Summary')
console.log(`hands ${summary.hands} · engine errors ${engineErrors} · chips conserved ${summary.chipsConserved} · rebuys ${rebuys} · ${summary.wallClockSec}s`)
for (const m of perModel) {
  const mix = Object.entries(m.mix).map(([k, v]) => `${k} ${v}`).join(' ')
  console.log(`${m.model.padEnd(30)} n=${String(m.decisions).padStart(3)} fallback ${(m.fallbackRate * 100).toFixed(1)}% · ${mix} · avg ${m.avgLatencyMs}ms · $${m.costUsd.toFixed(5)} · stack ${m.finalStack}`)
}
console.log(`${dryRun ? 'estimated' : 'measured'} cost $${spent.toFixed(5)} total · $${summary.costPerHandUsd.toFixed(5)}/hand`)

if (args.out) {
  mkdirSync(dirname(args.out), { recursive: true })
  writeFileSync(args.out, JSON.stringify({ summary, decisions: rows }, null, 2))
  console.log(`wrote ${args.out}`)
}
