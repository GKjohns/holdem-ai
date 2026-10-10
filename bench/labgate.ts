/**
 * The pilot-before-scale gate for a Strategy Lab run (implementation_plan.md § Budget, B4 additions).
 *
 *   node bench/labgate.ts --run 20261010_lab_pilot
 *
 * Checks over every table of the run: (1) zero engine errors and chips conserved, (2) fallback
 * rate < 5% per player, (3) no degenerate card (folds > 90% of its decisions, or never raises),
 * (4) measured cost within 2× of the lab's own dry-run estimate (per table hand, and in total incl.
 * the planner), (5) every generation's predictions file was written before its first hand,
 * (6) the explore quota holds in every generation (validateGeneration), (7) every field B5 needs is
 * on every hand, card seats carry their card. (/lab rendering is checked in the browser.)
 * Exits 1 on a failed gate.
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { genOfSlug, isTraining, labDir, loadLab, plannerSpend } from '../server/utils/lab.ts'
import { costUsd } from '../shared/utils/pricing.ts'
import { playerOf } from '../shared/utils/runs.ts'
import { exploreQuota, validateGeneration } from '../shared/utils/strategy.ts'

const { values: args } = parseArgs({ options: { run: { type: 'string' } } })
if (!args.run) throw new Error('--run <slug>')
const dir = labDir(args.run)
const f = loadLab(dir)
if (!f.config) throw new Error(`no lab at ${dir}`)
const results: { check: string, pass: boolean, detail: string }[] = []
const hands = f.tables.flatMap(t => [...t.run.hands, ...t.run.partialHands].map(h => ({ ...h, slug: t.slug, stack: t.run.start!.tournament.stack })))

// 1. engine + chips
const engineErrors = f.tables.reduce((n, t) => n + t.run.tournaments.reduce((a, x) => a + x.engineErrors, 0), 0) + hands.reduce((n, h) => n + (h.engineErrors ?? 0), 0)
const leaks = hands.filter(h => Object.values(h.stacksAfter).reduce((a, b) => a + b, 0) !== h.stack * h.seats.length)
results.push({ check: '1 engine errors / chips', pass: engineErrors === 0 && leaks.length === 0 && f.tables.every(t => t.run.tournaments.every(x => x.chipsConserved)), detail: `${engineErrors} engine errors · ${leaks.length} hands with chips not conserved · ${hands.length} hands at ${f.tables.length} tables` })

// 2 + 3. per player (cards are players: base model + card)
const perPlayer = new Map<string, { n: number, fb: number, folds: number, raises: number, timeouts: number, cost: number }>()
for (const h of hands) {
  for (const d of h.decisions) {
    const seat = h.seats.find(s => s.id === d.seatId)!
    const p = perPlayer.get(playerOf(seat)) ?? { n: 0, fb: 0, folds: 0, raises: 0, timeouts: 0, cost: 0 }
    p.n++
    if (d.decision.fallback) p.fb++
    if (d.decision.fallback && /Timed out|Watchdog/.test(d.decision.reasoning)) p.timeouts++
    if (d.decision.menuId === 'fold') p.folds++
    if (d.decision.action.type === 'raise' || d.decision.action.type === 'all_in') p.raises++
    p.cost += costUsd(d.decision.model, d.decision.usage)
    perPlayer.set(playerOf(seat), p)
  }
}
const rows = [...perPlayer.entries()].sort((a, b) => a[0].localeCompare(b[0]))
for (const [id, p] of rows) console.log(`  ${id.padEnd(30)} n=${String(p.n).padStart(5)} fallback ${(100 * p.fb / p.n).toFixed(1)}% (${p.fb}; ${p.timeouts} timeouts) · fold ${(100 * p.folds / p.n).toFixed(0)}% · raises ${p.raises} · $${p.cost.toFixed(4)}`)
results.push({ check: '2 fallback < 5% per player', pass: rows.every(([, p]) => p.fb / p.n < 0.05), detail: `worst ${rows.map(([id, p]) => ({ id, r: p.fb / p.n })).sort((a, b) => b.r - a.r).slice(0, 3).map(x => `${x.id} ${(x.r * 100).toFixed(1)}%`).join(', ')}` })
const degenerate = rows.filter(([, p]) => p.folds / p.n > 0.9 || p.raises === 0)
results.push({ check: '3 no degenerate card', pass: degenerate.length === 0, detail: degenerate.length ? degenerate.map(([id]) => id).join(', ') : `fold rates ${Math.min(...rows.map(([, p]) => 100 * p.folds / p.n)).toFixed(0)}–${Math.max(...rows.map(([, p]) => 100 * p.folds / p.n)).toFixed(0)}%, every player raises` })

// 4. cost vs the lab's own estimate (first lab_start of the run)
const start = f.events.find(e => e.type === 'lab_start') as { estimate?: { tablePerHand: number, heldoutPerHand: number } } | undefined
const trainHands = hands.filter(h => isTraining(h.slug))
const trainCost = trainHands.reduce((a, h) => a + h.decisions.reduce((b, d) => b + costUsd(d.decision.model, d.decision.usage), 0), 0)
const perHand = trainCost / Math.max(trainHands.length, 1)
const estHand = start?.estimate?.tablePerHand ?? 0
const planner = plannerSpend(f.planner)
const plannerCalls = f.planner.reduce((n, r) => n + r.attempts.length, 0)
results.push({ check: '4 cost within 2× of estimate', pass: estHand > 0 && perHand <= 2 * estHand && perHand >= estHand / 2, detail: `tables $${perHand.toFixed(5)}/hand vs estimate $${estHand.toFixed(5)} (${(perHand / estHand).toFixed(2)}×) over ${trainHands.length} hands ($${trainCost.toFixed(3)}); planner $${planner.toFixed(3)} over ${plannerCalls} calls` })

// 5. pre-registration: predictions written (file and timestamp) before the generation's first hand
const pre = f.predictions.map((p) => {
  const first = hands.filter(h => isTraining(h.slug) && genOfSlug(h.slug) === p.gen).map(h => h.ts).sort()[0] ?? null
  const mtime = statSync(join(dir, `gen${p.gen}`, 'predictions.json')).mtime.toISOString()
  return { gen: p.gen, writtenAt: p.writtenAt, mtime, first, ok: !!first && p.writtenAt < first && mtime < first }
})
results.push({ check: '5 predictions before first hand', pass: pre.length > 0 && pre.every(p => p.ok), detail: pre.map(p => `gen ${p.gen}: written ${p.writtenAt.slice(11, 19)} (file ${p.mtime.slice(11, 19)}) < first hand ${p.first?.slice(11, 19) ?? 'none'}`).join(' · ') })

// 6. explore quota and every other generation rule, re-checked on the stored cards
const quota = f.predictions.map((p) => {
  const tested = f.cards.filter(c => c.gen < p.gen)
  const q = exploreQuota(p.cards.length, p.gen)
  const parentPool = [...new Set(p.cards.flatMap(c => c.parentIds))]
  const errs = validateGeneration(p.cards, { gen: p.gen, n: p.cards.length, tested, parentPool })
  const ex = p.cards.filter(c => c.kind === 'explore').length
  return { gen: p.gen, ok: !errs.length && ex === q.explore, detail: `gen ${p.gen}: ${ex} explore / ${p.cards.length - ex} exploit (quota ${q.explore}/${q.exploit})${errs.length ? ` ✗ ${errs.join('; ')}` : ''}` }
})
results.push({ check: '6 explore quota enforced', pass: quota.every(q => q.ok), detail: quota.map(q => q.detail).join(' · ') })

// 7. fields for B5
const missing = new Set<string>()
for (const t of f.tables) {
  const s = t.run.start
  if (!s?.lab) missing.add(`${t.slug}: run_start.lab`)
  if (!s?.players?.length) missing.add(`${t.slug}: run_start.players`)
  for (const p of s?.players ?? []) if (p.cardId && !p.card) missing.add(`${t.slug}: card text for ${p.id}`)
}
for (const h of hands) {
  for (const k of ['holes', 'board', 'log', 'actionLabels', 'result', 'stacksBefore', 'stacksAfter', 'matchId', 'tournamentId', 'seed', 'rotation', 'level', 'bigBlind', 'busts'] as const) if (h[k] === undefined) missing.add(`hand.${k}`)
  if (Object.entries(h.holes).some(([id, c]) => (h.stacksBefore[id] ?? 0) > 0 && c.length !== 2)) missing.add('hand.holes (all live seats)')
  if (h.seats.some(s => s.modelId === f.config!.base && !s.playerId)) missing.add('seat.playerId on base-model seats')
  for (const d of h.decisions) {
    if (!d.view?.hole?.length) missing.add('decision.view')
    for (const k of ['reasoning', 'latencyMs', 'usage', 'fallback', 'model'] as const) if (d.decision[k] === undefined) missing.add(`decision.${k}`)
    if (d.view && d.view.opponents.some(o => 'hole' in o)) missing.add('VIEW LEAKS OPPONENT CARDS')
    if (d.view && JSON.stringify(d.view).includes('"card"')) missing.add('VIEW CARRIES A CARD')
  }
}
results.push({ check: '7 fields for B5', pass: missing.size === 0, detail: missing.size ? [...missing].slice(0, 8).join(', ') : `all present on ${hands.length} hands; cards in run_start.players` })

console.log()
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.check}: ${r.detail}`)
const ok = results.every(r => r.pass)
console.log(ok ? '\nGATE PASSED' : '\nGATE FAILED')
process.exit(ok ? 0 : 1)
