/**
 * v2 Phase 3 probe: replays real v2 views (from a run file) to a model, as if it sat in that seat,
 * to read its answers and measure latency, tokens, cache hits and cost before any big run.
 *
 *   node --env-file=.env bench/v2probe.ts --run data/runs/<slug>.jsonl --tournament m01-r2 --seat seat-3 \
 *     --hands 14-17 --model anthropic/claude-opus-5.5 [--out file.jsonl]
 *
 * The seat is renamed to the model's label everywhere it appears (the view and the remembered hands),
 * so the model plays "itself". Sequential calls, so consecutive decisions can hit the prompt cache.
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { decide, renderPrompt } from '../server/utils/decide.ts'
import { buildMenu } from '../shared/utils/menu.ts'
import { findModel } from '../shared/utils/models.ts'
import { costUsd } from '../shared/utils/pricing.ts'
import { memoryWindow } from '../shared/utils/table.ts'
import type { RunHandLine } from '../shared/utils/runs.ts'
import type { SeatView } from '../shared/utils/types.ts'

const { values: a } = parseArgs({ options: { run: { type: 'string' }, tournament: { type: 'string' }, seat: { type: 'string' }, hands: { type: 'string' }, model: { type: 'string' }, out: { type: 'string' }, print: { type: 'boolean', default: false } } })
const model = findModel(a.model)
if (!model) throw new Error(`Unknown model ${a.model}`)
const [lo, hi] = a.hands!.split('-').map(Number)
const hands = readFileSync(a.run!, 'utf8').split('\n').filter(l => l.includes('"type":"hand"')).map(l => JSON.parse(l) as RunHandLine)
  .filter(h => h.tournamentId === a.tournament && h.handNo >= lo! && h.handNo <= (hi ?? lo)!)
let total = 0
for (const h of hands) {
  for (const d of h.decisions.filter(x => x.seatId === a.seat)) {
    const rename = <T extends { id: string, name: string }>(p: T): T => p.id === a.seat ? { ...p, name: model.label } : p
    // Re-window with the current memory rule (the run may predate it).
    const history = memoryWindow(d.view.history ?? [], d.view.handNo).map(ph => ({ ...ph, players: ph.players.map(rename) }))
    const keep = new Set(history.map(x => x.handNo))
    const view: SeatView = { ...d.view, me: { ...d.view.me, name: model.label }, history, myCards: (d.view.myCards ?? []).filter(m => keep.has(m.handNo)) }
    if (a.print) console.log(`\n======== ${h.tournamentId} #${h.handNo} ${d.street}\n${renderPrompt(view, buildMenu(view, { custom: model.kind === 'llm' }))}`)
    const dec = await decide({ modelId: model.id, view, timeoutMs: 60_000 })
    const usd = costUsd(model.id, dec.usage)
    total += usd
    console.log(`${h.tournamentId} #${h.handNo} ${d.street.padEnd(7)} ${dec.menuId.padEnd(14)} ${JSON.stringify(dec.action).padEnd(28)} ${String(dec.latencyMs).padStart(6)}ms in=${dec.usage.input} read=${dec.usage.cacheRead ?? 0} write=${dec.usage.cacheWrite ?? 0} out=${dec.usage.output} $${usd.toFixed(4)}${dec.fallback ? ' FALLBACK' : ''}${dec.requested ? ` requested=${dec.requested}` : ''}`)
    console.log(`    reasoning: ${dec.reasoning}${dec.tableTalk ? `\n    says: "${dec.tableTalk}"` : ''}   [original ${d.decision.model}: ${d.decision.menuId}]`)
    if (a.out) appendFileSync(a.out, `${JSON.stringify({ tournamentId: h.tournamentId, handNo: h.handNo, seatId: a.seat, view, decision: dec, costUsd: usd })}\n`)
  }
}
console.log(`total $${total.toFixed(4)}`)
