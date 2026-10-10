/**
 * The pilot-before-scale data-quality gate (implementation_plan.md § Budget) over a run file.
 *
 *   node bench/gate.ts --run 20261010_pilot --estimate 0.0112
 *
 * Checks: (1) zero engine errors and chips conserved, (2) fallback rate < 5% per model,
 * (3) no degenerate model (folds > 90% of decisions or never raises), (4) measured cost per hand
 * within 2× of --estimate, (5) every field B5 needs is present on every hand. (The /results render
 * is checked in the browser.) Exits 1 on a failed gate.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { costUsd } from '../shared/utils/pricing.ts'
import { parseRun } from '../shared/utils/runs.ts'

const { values: args } = parseArgs({ options: { run: { type: 'string' }, estimate: { type: 'string' } } })
if (!args.run) throw new Error('--run <slug>')
const run = parseRun(readFileSync(join(process.cwd(), 'data', 'runs', `${args.run}.jsonl`), 'utf8'))
const hands = [...run.hands, ...run.partialHands]
const lineup = run.start?.lineup ?? []
const results: { check: string, pass: boolean, detail: string }[] = []

// 1. engine + chips
const engineErrors = run.tournaments.reduce((n, t) => n + t.engineErrors, 0) + run.partialHands.reduce((n, h) => n + (h.engineErrors ?? 0), 0)
const stack = run.start?.tournament.stack ?? 0
const leaks = hands.filter(h => Object.values(h.stacksAfter).reduce((a, b) => a + b, 0) !== stack * h.seats.length && run.start?.format === 'sng')
results.push({ check: '1 engine errors / chips', pass: engineErrors === 0 && leaks.length === 0 && run.tournaments.every(t => t.chipsConserved), detail: `${engineErrors} engine errors · ${leaks.length} hands with chips not conserved · ${hands.length} hands checked` })

// 2 + 3. per model
const perModel = lineup.map((m) => {
  const ds = hands.flatMap(h => h.decisions.filter(d => d.decision.model === m).map(d => d.decision))
  const n = ds.length || 1
  const fb = ds.filter(d => d.fallback).length
  const folds = ds.filter(d => d.menuId === 'fold').length
  const raises = ds.filter(d => d.action.type === 'raise' || d.action.type === 'all_in').length
  return {
    m, n: ds.length, fb, folds, raises,
    retried: ds.filter(d => d.retried).length,
    offTop: ds.filter(d => d.choiceNotTop).length,
    timeouts: ds.filter(d => d.fallback && /Timed out|Watchdog/.test(d.reasoning)).length,
    cost: ds.reduce((a, d) => a + costUsd(d.model, d.usage), 0),
    rate: fb / n, foldRate: folds / n
  }
})
for (const p of perModel) {
  console.log(`  ${p.m.padEnd(32)} n=${String(p.n).padStart(4)} fallback ${(p.rate * 100).toFixed(1)}% (${p.fb}; ${p.timeouts} timeouts) · fold ${(p.foldRate * 100).toFixed(0)}% · raise ${p.raises} · refusal-retried ${p.retried} · choice≠top ${p.offTop} · $${p.cost.toFixed(4)}`)
}
results.push({ check: '2 fallback < 5% per model', pass: perModel.every(p => p.rate < 0.05), detail: perModel.map(p => `${p.m.split('/')[1]} ${(p.rate * 100).toFixed(1)}%`).join(', ') })
results.push({ check: '3 no degenerate model', pass: perModel.every(p => p.foldRate <= 0.9 && p.raises > 0), detail: perModel.map(p => `${p.m.split('/')[1]} fold ${(p.foldRate * 100).toFixed(0)}% raise ${p.raises}`).join(', ') })

// 4. cost per hand
const spent = perModel.reduce((a, p) => a + p.cost, 0)
const perHand = spent / Math.max(hands.length, 1)
const est = Number(args.estimate)
results.push({ check: '4 cost/hand within 2× of estimate', pass: est > 0 ? perHand <= 2 * est && perHand >= est / 2 : false, detail: `measured $${perHand.toFixed(5)}/hand over ${hands.length} hands ($${spent.toFixed(3)}) vs estimate $${est}` })

// 5. fields B5 needs
const missing = new Set<string>()
for (const h of hands) {
  for (const k of ['holes', 'board', 'log', 'actionLabels', 'result', 'stacksBefore', 'stacksAfter', 'matchId', 'tournamentId', 'seed', 'rotation', 'level', 'bigBlind', 'busts'] as const) if (h[k] === undefined) missing.add(`hand.${k}`)
  // God view: two cards for every seat that started the hand with chips ([] = sat out busted).
  if (Object.entries(h.holes).some(([id, c]) => (h.stacksBefore[id] ?? 0) > 0 && c.length !== 2)) missing.add('hand.holes (all live seats)')
  for (const d of h.decisions) {
    if (!d.view?.hole?.length) missing.add('decision.view')
    for (const k of ['reasoning', 'latencyMs', 'usage', 'fallback', 'model'] as const) if (d.decision[k] === undefined) missing.add(`decision.${k}`)
    if (d.decision.model.includes('jev') || d.decision.model.includes('decisions')) {
      if (!d.decision.fallback && !d.decision.probabilities) missing.add('decision.probabilities')
    } else if (!d.decision.fallback && d.decision.tableTalk === undefined && !h.log[d.logIndex]) missing.add('log entry')
    if (d.view && JSON.stringify(d.view).includes('"holes"')) missing.add('VIEW LEAKS GOD VIEW')
    if (d.view && d.view.opponents.some(o => 'hole' in o)) missing.add('VIEW LEAKS OPPONENT CARDS')
  }
}
for (const t of run.tournaments) if (!t.finish?.length || t.finish.length !== lineup.length) missing.add(`tournament ${t.tournamentId} finish order`)
results.push({ check: '5 fields for B5', pass: missing.size === 0, detail: missing.size ? [...missing].join(', ') : `all present on ${hands.length} hands, ${run.tournaments.length} tournaments` })

console.log()
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.check}: ${r.detail}`)
const ok = results.every(r => r.pass)
console.log(ok ? '\nGATE PASSED' : '\nGATE FAILED')
process.exit(ok ? 0 : 1)
