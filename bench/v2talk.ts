/**
 * v2 table-talk claim test (for the kylejohnson.ai post). Fixed seat views from the v2 Study A
 * runs, no new tournaments. Each model is asked only in spots from its OWN recorded decisions, so
 * the view (name, memory of earlier hands, payouts) is exactly what that seat saw. A spot is a
 * turn or river decision, heads-up, facing exactly one bet with nothing put in yet this street.
 * The bet is rewritten to 3/4 of the pot and asked three ways: the bettor says nothing, says
 * "I've got the nuts here. Just fold.", or says "Honestly, I've got nothing. Call me."
 *
 * Calls go through the app's own decide() (v2 prompt, reasoning 'low'), cached per call in
 * data/runs/20261011_v2_talk.cache.jsonl, so a rerun costs $0. Summary -> internal_docs/20261011_v2_fairness/out/talk.json
 *
 *   node --env-file=.env bench/v2talk.ts --budget 1.3 [--dry] [--spots 36]
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { decide } from '../server/utils/decide.ts'
import { runPool } from './runner.ts'
import { costUsd } from '../shared/utils/pricing.ts'
import type { RunDecisionRecord } from '../shared/utils/runs.ts'
import type { SeatView } from '../shared/utils/types.ts'
import { ROOT, cardInt, equity, readRun, reseed } from '../internal_docs/20261009_holdem_vs_models/findings/notebook/lib.ts'

const { values: args } = parseArgs({ options: { budget: { type: 'string', default: '0' }, dry: { type: 'boolean', default: false }, spots: { type: 'string', default: '36' }, concurrency: { type: 'string', default: '6' } } })
const MODELS = ['openai/gpt-6-sol', 'anthropic/claude-opus-5.5', 'openai/gpt-6-luna', 'openai/gpt-6-luna-decisions', 'anthropic/claude-haiku-5.5', 'typesafe-ai/jev']
// measured $/decision in v2 Study A (results.md, "Cost and speed")
const EST: Record<string, number> = { 'openai/gpt-6-sol': 0.0088, 'anthropic/claude-opus-5.5': 0.0089, 'openai/gpt-6-luna': 0.00048, 'openai/gpt-6-luna-decisions': 0.00024, 'anthropic/claude-haiku-5.5': 0.00029, 'typesafe-ai/jev': 0.00013 }
const CACHE_FILE = join(ROOT, 'data/runs/20261011_v2_talk.cache.jsonl')
const OUT_FILE = join(ROOT, 'internal_docs/20261011_v2_fairness/out/talk.json')
const TALK = { silent: null, nuts: 'I\'ve got the nuts here. Just fold.', nothing: 'Honestly, I\'ve got nothing. Call me.' } as const

const recs: (RunDecisionRecord & { tid: string, table: string })[] = []
for (const t of ['sol', 'opus', 'fable']) {
  const run = readRun(join(ROOT, `data/runs/20261011_v2A_${t}.jsonl`))
  for (const h of run.hands) for (const d of h.decisions) recs.push({ ...d, tid: h.tournamentId, table: t })
}

let s = 20261011
const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
const shuffle = <T>(xs: T[]): T[] => {
  const a = xs.slice()
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!] }
  return a
}
const idOf = (r: { table: string, tid: string, handNo: number, logIndex: number }) => `${r.table}:${r.tid}#${r.handNo}#${r.logIndex}`

function isSpot(v: SeatView): boolean {
  if (!(v.street === 'turn' || v.street === 'river') || v.toCall <= 0 || v.me.committed !== 0) return false
  const live = v.opponents.filter(o => !o.folded && v.seatOrder.includes(o.id))
  if (live.length !== 1 || live[0]!.allIn) return false
  const st = v.log.filter(e => e.street === v.street)
  const bets = st.filter(e => e.raiseTo !== undefined || e.action.type === 'all_in')
  if (bets.length !== 1 || bets[0]!.action.type !== 'raise' || bets[0]!.seatId !== live[0]!.id || st.at(-1) !== bets[0]) return false
  const potBefore = v.pot - v.toCall
  return potBefore > 0 && v.me.stack > 1.6 * potBefore && live[0]!.stack + v.toCall > 1.6 * potBefore
}

/** The bettor's bet becomes 3/4 pot with `talk` said alongside it (or no talk). Stacks, pot, side pots and limits follow. */
function rewrite(v: SeatView, talk: string | null): SeatView {
  const potBefore = v.pot - v.toCall
  const B = Math.max(v.bigBlind, Math.round(0.75 * potBefore))
  const at = v.log.findLastIndex(e => e.street === v.street && e.raiseTo !== undefined)
  const ev = v.log[at]!
  const old = ev.added
  const log = v.log.map((e, i) => {
    if (i !== at) return e
    const { tableTalk: _t, ...rest } = e
    return { ...rest, action: { type: 'raise' as const, to: B }, added: B, raiseTo: B, ...(talk ? { tableTalk: talk } : {}) }
  })
  const opponents = v.opponents.map(o => o.id === ev.seatId ? { ...o, committed: B, stack: o.stack + old - B, ...(o.inPot !== undefined ? { inPot: o.inPot - old + B } : {}) } : o)
  const pot = potBefore + B
  const pots = v.pots && v.pots.length === 1 ? [{ ...v.pots[0]!, amount: pot }] : v.pots
  return { ...v, log, opponents, pot, ...(pots ? { pots } : {}), toCall: B, minRaiseTo: 2 * B, maxRaiseTo: v.me.stack + v.me.committed, canRaise: true }
}

interface Job { spot: string, variant: keyof typeof TALK, model: string, view: SeatView, eq: number }
const jobs: Job[] = []
const per = Number(args.spots)
const available: Record<string, number> = {}
for (const m of MODELS) {
  const cand = recs.filter(r => r.decision.model === m && isSpot(r.view)).map((r) => {
    reseed(r.handNo * 7 + r.logIndex)
    return { r, eq: equity(r.view.hole.map(cardInt), r.view.board.map(cardInt), [], 1, 400) }
  })
  available[m] = cand.length
  // stratify by strength vs one random hand: a third weak, a third middling, a third strong, topped up
  const buckets = [cand.filter(x => x.eq < 0.4), cand.filter(x => x.eq >= 0.4 && x.eq < 0.7), cand.filter(x => x.eq >= 0.7)].map(shuffle)
  const chosen = buckets.flatMap(b => b.slice(0, Math.floor(per / 3)))
  const rest = shuffle(buckets.flatMap(b => b.slice(Math.floor(per / 3))))
  chosen.push(...rest.slice(0, Math.max(0, per - chosen.length)))
  for (const { r, eq } of chosen) {
    for (const k of Object.keys(TALK) as (keyof typeof TALK)[]) jobs.push({ spot: idOf(r), variant: k, model: m, view: rewrite(r.view, TALK[k]), eq })
  }
}

const done = new Map<string, any>() // eslint-disable-line @typescript-eslint/no-explicit-any
if (existsSync(CACHE_FILE)) for (const l of readFileSync(CACHE_FILE, 'utf8').split('\n')) if (l.trim()) { const x = JSON.parse(l); done.set(x.key, x) }
const keyOf = (j: Job) => `${j.spot}|${j.variant}|${j.model}`
const todo = jobs.filter(j => !done.has(keyOf(j)))
const est = todo.reduce((a, j) => a + EST[j.model]!, 0)
console.log(`spots available ${JSON.stringify(available)}; jobs ${jobs.length}; cached ${done.size}; to run ${todo.length}; estimate $${est.toFixed(3)}`)
if (args.dry) process.exit(0)
const cap = Number(args.budget)
if (todo.length && !(cap > 0)) { console.log('pass --budget <usd>'); process.exit(1) }

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
    const rec = { key: keyOf(j), spot: j.spot, variant: j.variant, model: j.model, eq: j.eq, menuId: d.menuId, probabilities: d.probabilities ?? null, reasoning: d.reasoning ?? '', fallback: d.fallback, usage: d.usage, costUsd: c }
    appendFileSync(CACHE_FILE, JSON.stringify(rec) + '\n')
    done.set(rec.key, rec)
    if (n % 50 === 0) console.log(`${n}/${todo.length} $${spent.toFixed(3)} fallbacks ${fallbacks}`)
  }
})), Number(args.concurrency), () => spent >= cap)
if (n) console.log(`done ${n} calls, $${spent.toFixed(4)} by pricing.ts, fallbacks ${fallbacks}${spent >= cap ? ' (budget reached)' : ''}`)

// ---------- summary: fold rate per variant, only spots where all three variants answered ----------
const MENTION = /\bnuts\b|\bsays\b|\bsaid\b|\bclaim|\btalk|\bnothing\b|\btable\b|\bstatement|\bannounce/i
const summary: Record<string, unknown> = {}
for (const m of MODELS) {
  const spots = [...new Set(jobs.filter(j => j.model === m).map(j => j.spot))]
  const full = spots.filter(sp => (Object.keys(TALK) as string[]).every(v => { const x = done.get(`${sp}|${v}|${m}`); return x && !x.fallback }))
  const fold = (v: string) => full.filter(sp => done.get(`${sp}|${v}|${m}`).menuId === 'fold').length
  const changed = (v: string) => full.filter(sp => done.get(`${sp}|${v}|${m}`).menuId !== done.get(`${sp}|silent|${m}`).menuId).length
  const mentions = full.flatMap(sp => ['nuts', 'nothing'].map(v => done.get(`${sp}|${v}|${m}`))).filter(x => MENTION.test(x.reasoning))
  summary[m] = {
    spots: full.length,
    available: available[m],
    foldPct: { silent: 100 * fold('silent') / full.length, nuts: 100 * fold('nuts') / full.length, nothing: 100 * fold('nothing') / full.length },
    changedVsSilent: { nuts: changed('nuts'), nothing: changed('nothing') },
    reasoningMentionsTalk: mentions.length,
    examples: mentions.slice(0, 4).map(x => ({ spot: x.spot, variant: x.variant, menuId: x.menuId, reasoning: String(x.reasoning).slice(0, 240) }))
  }
}
const all = [...done.values()].filter(x => jobs.some(j => keyOf(j) === x.key))
writeFileSync(OUT_FILE, JSON.stringify({
  generated: new Date().toISOString(),
  design: 'v2 Study A seat views, each model in its own recorded spots (turn/river, heads-up, facing one bet, nothing in yet); bet rewritten to 3/4 pot; silent vs "I\'ve got the nuts here. Just fold." vs "Honestly, I\'ve got nothing. Call me."; v2 prompt, reasoning low',
  lines: { nuts: TALK.nuts, nothing: TALK.nothing },
  costUsd: all.reduce((a, x) => a + x.costUsd, 0),
  calls: all.length,
  models: summary
}, null, 1) + '\n')
console.log(JSON.stringify(Object.fromEntries(Object.entries(summary).map(([k, v]: [string, any]) => [k, { n: v.spots, fold: v.foldPct, changed: v.changedVsSilent, mentions: v.reasoningMentionsTalk }])))) // eslint-disable-line @typescript-eslint/no-explicit-any
