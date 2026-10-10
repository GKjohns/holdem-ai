/**
 * v2 data-quality check (2026-10-12): replays a few real Study A seat views live and prints the
 * finish reason, output and reasoning tokens and the full reasoning, to confirm nothing is cut off.
 * For each model: its highest-output spot in Study A (the hardest case for the output cap) + random ones.
 *   node --env-file=.env bench/v2verify.ts [--per 3]
 */
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { decide } from '../server/utils/decide.ts'
import { costUsd } from '../shared/utils/pricing.ts'
import type { Decision, SeatView } from '../shared/utils/types.ts'

const { values: a } = parseArgs({ options: { per: { type: 'string', default: '3' } } })
const per = Number(a.per)
const MODELS = ['anthropic/claude-opus-5.5', 'anthropic/claude-fable-5.1', 'openai/gpt-6-sol', 'openai/gpt-6-luna', 'anthropic/claude-haiku-5.5']
const FILES = ['sol', 'opus', 'fable'].map(t => `data/runs/20261011_v2A_${t}.jsonl`)

const spots = new Map<string, { view: SeatView, decision: Decision }[]>()
for (const f of FILES) {
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.includes('"type":"hand"')) continue
    const h = JSON.parse(line) as { decisions: { view: SeatView, decision: Decision }[] }
    for (const d of h.decisions) {
      if (!MODELS.includes(d.decision.model)) continue
      const list = spots.get(d.decision.model) ?? []
      list.push(d)
      spots.set(d.decision.model, list)
    }
  }
}

let spent = 0
for (const m of MODELS) {
  const all = spots.get(m) ?? []
  const top = all.reduce((x, y) => (y.decision.usage.output > x.decision.usage.output ? y : x))
  const picks = [top, ...Array.from({ length: per - 1 }, (_, i) => all[Math.floor(((i + 1) * all.length) / per)]!)]
  for (const p of picks) {
    const d = await decide({ modelId: m, view: p.view, timeoutMs: 60_000 })
    const c = costUsd(m, d.usage)
    spent += c
    console.log(JSON.stringify({ model: m, was: p.decision.usage.output, fallback: d.fallback, finishReason: d.finishReason, usage: d.usage, latencyMs: d.latencyMs, costUsd: +c.toFixed(4), choice: d.menuId, reasoning: d.reasoning }))
  }
}
console.log(`spent ≈ $${spent.toFixed(3)} (price table)`)
