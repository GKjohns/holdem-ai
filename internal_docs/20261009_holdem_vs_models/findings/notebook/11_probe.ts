/**
 * B5 follow-up experiments on FIXED seat views taken from the B3 main run (no new tournaments).
 * Every call goes through the app's own decide() (same prompt, same timeouts) and runPool() from
 * bench/runner.ts. Results are cached per call in cache/probe.jsonl, so a rerun costs $0.
 *
 *   replay   120 recorded views (40 preflop, 40 flop/turn, 40 river), each asked of all 5 models;
 *            a second pass on 60 of them measures each model's agreement with itself.
 *   ladder   36 turn/river spots where the seat faces one bet heads-up; the bet is rewritten to
 *            33%, 75% and 150% of the pot (stacks, pot, menu rebuilt) with no table talk.
 *   talk     the same 36 spots at 75% pot, with the bettor saying a strength claim or a weakness claim.
 *
 *   caffeinate -i node --env-file=.env internal_docs/.../notebook/11_probe.ts --budget 1.8 [--dry]
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { decide } from '../../../../server/utils/decide.ts'
import { runPool } from '../../../../bench/runner.ts'
import { findModel } from '../../../../shared/utils/models.ts'
import { costUsd } from '../../../../shared/utils/pricing.ts'
import type { RunDecisionRecord } from '../../../../shared/utils/runs.ts'
import type { SeatView } from '../../../../shared/utils/types.ts'
import { CACHE, ROOT, cardInt, equity, readRun, reseed } from './lib.ts'

const { values: args } = parseArgs({ options: { budget: { type: 'string', default: '0' }, dry: { type: 'boolean', default: false }, only: { type: 'string' }, concurrency: { type: 'string', default: '6' } } })
const MODELS = ['openai/gpt-6-sol', 'openai/gpt-6-luna', 'openai/gpt-6-luna-decisions', 'anthropic/claude-haiku-5.5', 'typesafe-ai/jev']
// measured $/decision in the B3 main run (03_breadth.py ops)
const EST: Record<string, number> = { 'openai/gpt-6-sol': 0.00316, 'openai/gpt-6-luna': 0.000104, 'openai/gpt-6-luna-decisions': 0.0000745, 'anthropic/claude-haiku-5.5': 0.00029, 'typesafe-ai/jev': 0.0000043 }
const CACHE_FILE = join(CACHE, 'probe.jsonl')

const run = readRun(join(ROOT, 'data/runs/20261010_main.jsonl'))
const recs: (RunDecisionRecord & { tid: string })[] = run.hands.flatMap(h => h.decisions.map(d => ({ ...d, tid: h.tournamentId })))

// deterministic sampler
let s = 20261010
const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
const pick = <T>(xs: T[], n: number): T[] => {
  const a = xs.slice()
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!] }
  return a.slice(0, n)
}
const idOf = (r: { tid: string, handNo: number, logIndex: number }) => `${r.tid}#${r.handNo}#${r.logIndex}`
const clean = (v: SeatView, model: string): SeatView => ({ ...v, me: { ...v.me, name: findModel(model)?.label ?? v.me.name }, priorTableTalk: [] })

interface Job { exp: string, spot: string, variant: string, model: string, rep: number, view: SeatView, meta: Record<string, unknown> }
const jobs: Job[] = []

// ── replay ─────────────────────────────────────────────────────────────────────────────────
const nontrivial = (r: RunDecisionRecord) => r.view.toCall > 0 || r.view.street !== 'preflop'
const preR = pick(recs.filter(r => r.street === 'preflop' && r.view.toCall > 0 && r.view.toCall < r.view.me.stack), 40)
const midR = pick(recs.filter(r => (r.street === 'flop' || r.street === 'turn') && nontrivial(r)), 40)
const rivR = pick(recs.filter(r => r.street === 'river'), 40)
const replay = [...preR, ...midR, ...rivR]
replay.forEach((r, i) => {
  for (const m of MODELS) {
    for (let rep = 0; rep < (i % 2 === 0 ? 2 : 1); rep++) {
      jobs.push({ exp: 'replay', spot: idOf(r), variant: 'orig', model: m, rep, view: clean(r.view, m), meta: { street: r.street, origModel: r.decision.model, origChoice: r.decision.menuId } })
    }
  }
})

// ── ladder + talk ──────────────────────────────────────────────────────────────────────────
// spots: turn/river, heads-up, seat faces exactly one bet this street, has nothing in yet
const ladderCand = recs.filter((r) => {
  const v = r.view
  if (!(v.street === 'turn' || v.street === 'river') || v.toCall <= 0 || v.me.committed !== 0) return false
  const live = v.opponents.filter(o => !o.folded && v.seatOrder.includes(o.id))
  if (live.length !== 1 || live[0]!.allIn) return false
  const st = v.log.filter(e => e.street === v.street)
  const bets = st.filter(e => e.raiseTo !== undefined || e.action.type === 'all_in')
  if (bets.length !== 1 || bets[0]!.action.type !== 'raise' || bets[0]!.seatId !== live[0]!.id) return false
  if (st.at(-1) !== bets[0]) return false
  const potBefore = v.pot - v.toCall
  return potBefore > 0 && v.me.stack > 1.6 * potBefore && live[0]!.stack + v.toCall > 1.6 * potBefore
})
// stratify by hand strength vs one random hand (what the seat could know)
const withEq = ladderCand.map((r) => {
  reseed(r.handNo * 7 + r.logIndex)
  return { r, eq: equity(r.view.hole.map(cardInt), r.view.board.map(cardInt), [], 1, 400) }
})
const ladder = [
  ...pick(withEq.filter(x => x.eq < 0.4), 12),
  ...pick(withEq.filter(x => x.eq >= 0.4 && x.eq < 0.7), 12),
  ...pick(withEq.filter(x => x.eq >= 0.7), 12)
]
function resize(v: SeatView, frac: number, talk: string | null): SeatView {
  const potBefore = v.pot - v.toCall
  const B = Math.max(v.bigBlind, Math.round(frac * potBefore))
  const st = v.log.findLastIndex(e => e.street === v.street && e.raiseTo !== undefined)
  const ev = v.log[st]!
  const old = ev.added
  const log = v.log.map((e, i) => {
    if (i !== st) return e
    const { tableTalk: _t, ...rest } = e
    return { ...rest, action: { type: 'raise' as const, to: B }, added: B, raiseTo: B, ...(talk ? { tableTalk: talk } : {}) }
  })
  const opponents = v.opponents.map(o => o.id === ev.seatId ? { ...o, committed: B, stack: o.stack + old - B } : o)
  return { ...v, log, opponents, pot: potBefore + B, toCall: B, minRaiseTo: 2 * B, maxRaiseTo: v.me.stack + v.me.committed, canRaise: true }
}
const TALK = { strong: 'I\'ve got the nuts here. Just fold.', weak: 'Honestly, I\'ve got nothing. Call me.' }
for (const { r, eq } of ladder) {
  for (const m of MODELS) {
    for (const f of [0.33, 0.75, 1.5]) {
      jobs.push({ exp: 'ladder', spot: idOf(r), variant: `size_${f}`, model: m, rep: 0, view: clean(resize(r.view, f, null), m), meta: { eqRandom: eq, street: r.street } })
    }
    for (const [k, t] of Object.entries(TALK)) {
      jobs.push({ exp: 'talk', spot: idOf(r), variant: `talk_${k}`, model: m, rep: 0, view: clean(resize(r.view, 0.75, t), m), meta: { eqRandom: eq, street: r.street } })
    }
  }
}

// ── run ────────────────────────────────────────────────────────────────────────────────────
const done = new Set<string>()
if (existsSync(CACHE_FILE)) for (const l of readFileSync(CACHE_FILE, 'utf8').split('\n')) if (l.trim()) done.add(JSON.parse(l).key)
const keyOf = (j: Job) => `${j.exp}|${j.spot}|${j.variant}|${j.model}|${j.rep}`
const todo = jobs.filter(j => (!args.only || j.exp === args.only) && !done.has(keyOf(j)))
const est = todo.reduce((a, j) => a + EST[j.model]!, 0)
console.log(`jobs ${jobs.length} (replay ${jobs.filter(j => j.exp === 'replay').length}, ladder ${jobs.filter(j => j.exp === 'ladder').length}, talk ${jobs.filter(j => j.exp === 'talk').length}); cached ${done.size}; to run ${todo.length}; estimate $${est.toFixed(3)}; ladder spots ${ladder.length} of ${ladderCand.length}`)
if (args.dry) process.exit(0)
const cap = Number(args.budget)
if (!(cap > 0)) { console.log('pass --budget <usd>'); process.exit(1) }
let spent = 0, n = 0, fallbacks = 0
await runPool(todo.map(j => ({
  label: keyOf(j),
  run: async () => {
    if (spent >= cap) return
    const d = await decide({ modelId: j.model, view: j.view })
    const c = costUsd(j.model, d.usage)
    spent += c
    n++
    if (d.fallback) fallbacks++
    appendFileSync(CACHE_FILE, JSON.stringify({ key: keyOf(j), exp: j.exp, spot: j.spot, variant: j.variant, model: j.model, rep: j.rep, meta: j.meta,
      view: { street: j.view.street, hole: j.view.hole, board: j.view.board, pot: j.view.pot, toCall: j.view.toCall },
      menuId: d.menuId, probabilities: d.probabilities ?? null, reasoning: d.reasoning, tableTalk: d.tableTalk ?? '', fallback: d.fallback, latencyMs: d.latencyMs, usage: d.usage, costUsd: c }) + '\n')
    if (n % 50 === 0) console.log(`${n}/${todo.length} $${spent.toFixed(3)} fallbacks ${fallbacks}`)
  }
})), Number(args.concurrency), () => spent >= cap)
console.log(`done ${n} calls, $${spent.toFixed(4)} by pricing.ts, fallbacks ${fallbacks}${spent >= cap ? ' (budget reached)' : ''}`)
