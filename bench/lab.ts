/**
 * B4 Strategy Lab: Fable designs strategy cards, a bandit loop tests them under duplicate seeds,
 * and Fable reads the results and writes the next generation. Headless; resumable per generation.
 *
 *   caffeinate -ims node --env-file=.env bench/lab.ts --run 20261010_lab_pilot --generations 2 \
 *     --cards 4 --next-cards 4 --hands 25 --r1 1 --r2 1 --topup 0 --heldout-matches 0 --budget 3
 *   ... --dry-run    cost estimate only (measured $/decision × decisions/hand × tournament length)
 *   ... --fake       random deciders and a fake planner, $0 (pipeline and /lab tests)
 *   ... --no-notes   skip the final field-notes call (pilots)
 *
 * Per generation: (1) Fable writes the cards with pre-registered predictions (written to
 * gen<N>/predictions.json BEFORE any hand of the generation); (2) every card plays duplicate matches
 * at its own table against the reference field (control = base model with no card, the current
 * champion, Jev, Luna Decisions): round 1 equal matches, round 2 the top half get more (successive
 * halving), round 3 a Thompson-sampling top-up; (3) the champion is updated; (4) Fable writes the
 * memo on this generation and the next generation (~60% exploit / ~40% explore, enforced in code).
 * Then the top 3 cards + the control replay on fresh seeds (asserted unseen) against a different
 * field, and Fable writes data/lab/<run>/field_notes.md.
 *
 * Everything is cached on disk: tables reuse bench/runner.ts (decision caches), planner calls are
 * stored in planner/*.json, and allocation is deterministic given results, so a rerun costs $0.
 * Layout and line schema: AGENTS.md § Strategy Lab.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { renderPrompt } from '../server/utils/decide.ts'
import { decisiveHands, genOfSlug, HELDOUT_SLUG, labDir, leadOf, loadLab, playerLabel, playerStyles, plannerSpend, seenSeeds, seOf, tableSlug, tableSpend, unitsOf } from '../server/utils/lab.ts'
import type { Allocation, AllocationRound, GenOutcome, HeldoutPlan, LabConfig, LabFiles, Memo, PlannerRecord, Predictions } from '../server/utils/lab.ts'
import { renderHand } from '../server/utils/narrate.ts'
import { callPlanner, fieldNotesPrompt, finalSchema, gen0Prompt, gen0Schema, nextPrompt, nextSchema, plannerInstructions } from '../server/utils/planner.ts'
import type { FieldNotes, LabBrief, PlannedCard, PlannedMemo } from '../server/utils/planner.ts'
import { listItem, runDetail } from '../server/utils/results.ts'
import { matchSeed } from '../shared/utils/duplicate.ts'
import { buildMenu } from '../shared/utils/menu.ts'
import { findModel, PLANNER_MODEL } from '../shared/utils/models.ts'
import { statsLine } from '../shared/utils/narration.ts'
import { costUsd } from '../shared/utils/pricing.ts'
import { seededRng } from '../shared/utils/rng.ts'
import { parseRun } from '../shared/utils/runs.ts'
import type { RunPlayer } from '../shared/utils/runs.ts'
import type { Interval } from '../shared/utils/stats.ts'
import { aliasesFor, AXES, TABLE_ALIASES, AXIS_NAMES, axisDiff, cardMarkdown, CONTROL_ID, exploreQuota, hash32, heldOutVerdict, NO_CHAMPION_ID, thompsonTopUp, validateGeneration, verdict, wordCount } from '../shared/utils/strategy.ts'
import type { Axes, StrategyCard } from '../shared/utils/strategy.ts'
import { newTable, seatView, startHand } from '../shared/utils/table.ts'
import { SNG_TURBO, sngFormat, withLevel } from '../shared/utils/tournament.ts'
import { measuredCostPerDecision, measuredDecisionsPerHand, openRun, runPool } from './runner.ts'
import type { RunHandle, Spend } from './runner.ts'

const { values: args } = parseArgs({
  options: {
    'run': { type: 'string' },
    'generations': { type: 'string', default: '4' },
    'cards': { type: 'string', default: '8' },
    'next-cards': { type: 'string', default: '5' },
    'base': { type: 'string', default: 'openai/gpt-6-luna' },
    'field': { type: 'string', default: 'typesafe-ai/jev,openai/gpt-6-luna-decisions' },
    'heldout-field': { type: 'string', default: 'openai/gpt-6-sol,anthropic/claude-haiku-5.5' },
    'hands': { type: 'string', default: '50' },
    'r1': { type: 'string', default: '2' },
    'r2': { type: 'string', default: '2' },
    'topup': { type: 'string', default: '1' },
    'heldout-matches': { type: 'string', default: '3' },
    'budget': { type: 'string', default: '1' },
    'concurrency': { type: 'string', default: '16' },
    'seed': { type: 'string', default: '20261011' },
    'dry-run': { type: 'boolean', default: false },
    'fake': { type: 'boolean', default: false },
    'decision-watchdog': { type: 'string', default: '45' },
    'hand-watchdog': { type: 'string', default: '300' },
    'fake-delay': { type: 'string', default: '0' },
    'no-notes': { type: 'boolean', default: false }
  }
})

if (!args.run || !/^[\w.-]{3,80}$/.test(args.run)) throw new Error('--run <slug>')
const ROOT = process.cwd()
const DIR = labDir(args.run, ROOT)
const RUNS = join(DIR, 'runs')
const fake = args.fake!
const now = () => new Date().toISOString()

const config: LabConfig = {
  run: args.run,
  base: args.base!,
  generations: Number(args.generations),
  cards: Number(args.cards),
  nextCards: Number(args['next-cards']),
  hands: Number(args.hands),
  r1: Number(args.r1),
  r2: Number(args.r2),
  topup: Number(args.topup),
  heldoutMatches: Number(args['heldout-matches']),
  heldoutField: args['heldout-field']!.split(',').map(s => s.trim()).filter(Boolean),
  field: args.field!.split(',').map(s => s.trim()).filter(Boolean),
  seed: Number(args.seed),
  fake,
  planner: fake ? 'fake' : PLANNER_MODEL.id
}
for (const id of [config.base, ...config.field, ...config.heldoutField]) if (!findModel(id)) throw new Error(`Unknown model ${id}`)
if (findModel(config.base)!.kind !== 'llm') throw new Error('The base model must be a language model (cards are instructions)')
if (config.field.length !== 2) throw new Error('--field: two reference models (the table is card + control + champion + field)')
if (config.heldoutField.length !== 2) throw new Error('--heldout-field: two models (the held-out table is 3 cards + control + 2)')
if (!args['dry-run'] && !fake && !process.env.AI_GATEWAY_API_KEY) throw new Error('AI_GATEWAY_API_KEY missing — run with node --env-file=.env')

const tournament = { ...SNG_TURBO, maxHands: config.hands }
const genSeed = (g: number) => hash32(`${config.seed}|gen|${g}`)
const heldoutSeed = hash32(`${config.seed}|heldout`)
const cardsInGen = (g: number) => g === 0 ? config.cards : config.nextCards
const survivorsOf = (n: number) => Math.max(1, Math.floor(n / 2))
const short = (id: string) => findModel(id)?.label ?? id

// ── config: fixed per run (generations / held-out matches may grow) ────────────────────────

mkdirSync(RUNS, { recursive: true })
for (const d of ['cards', 'planner']) mkdirSync(join(DIR, d), { recursive: true })
const CONFIG_FILE = join(DIR, 'config.json')
if (existsSync(CONFIG_FILE)) {
  const old = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as LabConfig
  const fixed = (c: LabConfig) => JSON.stringify({ ...c, generations: 0, heldoutMatches: 0 })
  if (fixed(old) !== fixed(config)) throw new Error(`${CONFIG_FILE} was started with different settings; use another --run`)
}
const event = (e: object) => appendFileSync(join(DIR, 'lab.jsonl'), `${JSON.stringify({ ts: now(), ...e })}\n`)

// ── estimate ─────────────────────────────────────────────────────────────────────────────────

const measured = measuredCostPerDecision()
const perHandMeasured = measuredDecisionsPerHand()
/** Hands per tournament at this cap, from real 5-seat B3 tournaments (min(length, cap)). */
function handsPerTournament(): number {
  const f = join(ROOT, 'data', 'runs', '20261010_main.jsonl')
  if (!existsSync(f)) return config.hands
  const lens = parseRun(readFileSync(f, 'utf8')).tournaments.map(t => Math.min(t.hands, config.hands))
  return lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : config.hands
}
const HANDS_PER_T = handsPerTournament()
const CARD_TOKENS = 300
function usdPerHand(players: { modelId: string, card?: boolean }[]): number {
  return players.reduce((a, p) => {
    const m = measured[p.modelId]
    const dph = perHandMeasured[p.modelId]?.perHand ?? 1.8
    const usd = (m?.usd ?? 0.0002) + (p.card ? costUsd(p.modelId, { input: CARD_TOKENS, output: 0 }) : 0)
    return a + dph * usd
  }, 0)
}
const labTable = [{ modelId: config.base, card: true }, { modelId: config.base }, { modelId: config.base, card: true }, ...config.field.map(modelId => ({ modelId }))]
const heldTable = [...[0, 1, 2].map(() => ({ modelId: config.base, card: true })), { modelId: config.base }, ...config.heldoutField.map(modelId => ({ modelId }))]
const est = {
  tablePerHand: usdPerHand(labTable),
  cardMatch: usdPerHand(labTable) * HANDS_PER_T * labTable.length,
  heldoutPerHand: usdPerHand(heldTable),
  heldoutMatch: usdPerHand(heldTable) * HANDS_PER_T * heldTable.length,
  // Planner: ≈ 12k input tokens + 9k output (cards + thinking) for gen 0; ≈ 35k + 12k with results and hands.
  planner: { gen0: fake ? 0 : costUsd(PLANNER_MODEL.id, { input: 12_000, output: 9_000 }), next: fake ? 0 : costUsd(PLANNER_MODEL.id, { input: 35_000, output: 12_000 }), final: fake ? 0 : costUsd(PLANNER_MODEL.id, { input: 35_000, output: 10_000 }) }
}
const cardMatchesInGen = (g: number) => {
  const n = cardsInGen(g)
  return n * config.r1 + survivorsOf(n) * config.r2 + config.topup
}
const genCost = (g: number) => cardMatchesInGen(g) * est.cardMatch + (g === 0 ? est.planner.gen0 : est.planner.next)
const finalCost = () => config.heldoutMatches * est.heldoutMatch + (args['no-notes'] ? 0 : est.planner.final)
function printEstimate() {
  console.log(`── Lab ${config.run}${fake ? ' (FAKE)' : ''}: base ${short(config.base)}, field ${config.field.map(short).join(' + ')}, ${config.hands}-hand cap (≈ ${HANDS_PER_T.toFixed(1)} hands/tournament from B3)`)
  console.log(`  table $/hand ≈ $${est.tablePerHand.toFixed(5)} · card-match (5 tournaments) ≈ $${est.cardMatch.toFixed(3)}`)
  let total = 0
  for (let g = 0; g < config.generations; g++) {
    total += genCost(g)
    console.log(`  gen ${g}: ${cardsInGen(g)} cards × ${config.r1} + top ${survivorsOf(cardsInGen(g))} × ${config.r2} + ${config.topup} top-up = ${cardMatchesInGen(g)} card-matches ≈ $${(cardMatchesInGen(g) * est.cardMatch).toFixed(2)} + planner $${(g === 0 ? est.planner.gen0 : est.planner.next).toFixed(2)}`)
  }
  total += finalCost()
  console.log(`  held-out: ${config.heldoutMatches} matches × 6 tournaments ≈ $${(config.heldoutMatches * est.heldoutMatch).toFixed(2)} ($${est.heldoutPerHand.toFixed(5)}/hand) + field notes $${(args['no-notes'] ? 0 : est.planner.final).toFixed(2)}`)
  console.log(`  ≈ $${total.toFixed(2)} total · budget $${args.budget}`)
  return total
}
const estimatedTotal = printEstimate()
if (args['dry-run']) process.exit(0)

// ── state ─────────────────────────────────────────────────────────────────────────────────────

const budget = Number(args.budget)
const spend: Spend = { spent: tableSpend(DIR) + plannerSpend(loadLab(DIR).planner), cap: budget, halted: false, live: 0, replayed: 0 }
const spentBefore = spend.spent
writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`)
event({ type: 'lab_start', budget, spentBefore, config, estimate: { ...est, handsPerTournament: HANDS_PER_T, total: estimatedTotal } })
console.log(`\n── run: $${spentBefore.toFixed(3)} spent by earlier invocations, budget $${budget} for the whole lab, concurrency ${args.concurrency}`)

let interrupted = false
process.on('SIGINT', () => {
  if (interrupted) process.exit(130)
  interrupted = true
  spend.halted = true
  console.log('\ninterrupt: finishing in-flight calls, then stopping (Ctrl-C again to quit now)')
})
const inFlight = new Map<string, number>()
const heartbeat = setInterval(() => {
  console.log(`  … lab spend $${spend.spent.toFixed(3)} of $${budget} · ${spend.live} live / ${spend.replayed} replayed decisions · ${inFlight.size} tournaments in flight`)
}, 60_000)

const files = () => loadLab(DIR)
const allCards = (): StrategyCard[] => files().cards
const label = (id: string) => playerLabel(id, allCards(), config.base)

// ── planner (Fable, or a deterministic fake) ─────────────────────────────────────────────────

let briefMemo: LabBrief | null = null
function brief(): LabBrief {
  if (briefMemo) return briefMemo
  const b3 = join(ROOT, 'data', 'runs', '20261010_main.jsonl')
  let priorEvidence = '(no earlier benchmark on disk)'
  let baseStyle = 'unknown'
  if (existsSync(b3)) {
    const run = parseRun(readFileSync(b3, 'utf8'))
    const d = runDetail('20261010_main', run, '')
    const iv = (x: Interval) => `${fmt(x.value)} [${fmt(x.lo)}, ${fmt(x.hi)}]`
    const lines = d.leaderboard.slice().sort((a, b) => (b.bb100.value ?? 0) - (a.bb100.value ?? 0)).map((r) => {
      const st = d.style.find(s => s.modelId === r.modelId)!
      return `- ${short(r.modelId)}: ${iv(r.bb100)} bb/100 over ${r.hands} hands · ${statsLine(st)}`
    })
    const base = d.style.find(s => s.modelId === config.base)
    if (base) baseStyle = statsLine(base)
    const scouting = join(ROOT, 'data', 'runs', '20261010_main_scouting.md')
    priorEvidence = [`Leaderboard (bb/100 with 95% CI; ${listItem('20261010_main', run, '').matchesComplete} matches):`, ...lines, '', 'Scouting report (written by a narrator model from those numbers):', existsSync(scouting) ? readFileSync(scouting, 'utf8').replace(/^# .*\n/, '') : '(none)'].join('\n')
  }
  // One real seat prompt: a lab table as the card seat sees it on hand 1.
  const aliases = aliasesFor(3, 1)
  const names = [...aliases, ...config.field.map(short)]
  const state = startHand(withLevel(newTable({ players: names.map((name, i) => ({ id: `seat-${i + 1}`, name, modelId: null })), stacks: 1500, smallBlind: 1, bigBlind: 2 }, 424242), tournament.levels).state)
  const toAct = state.seats[state.toAct!]!.id
  const view = seatView(state, toAct, sngFormat(tournament.levels, state.handNo))
  briefMemo = {
    baseLabel: short(config.base),
    baseStyle,
    field: config.field.map(id => ({ name: short(id), kind: findModel(id)!.kind === 'evaluation' ? 'a decision model: it answers each decision with a probability per option, never talks' : 'a language model' })),
    aliases: TABLE_ALIASES,
    hands: config.hands,
    levels: `${tournament.levels[0]!.sb}/${tournament.levels[0]!.bb}`,
    priorEvidence,
    examplePrompt: renderPrompt(view, buildMenu(view))
  }
  return briefMemo
}

const fmt = (v: number | null, d = 0) => v === null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`
const ivText = (x: Interval) => `${fmt(x.value)} [${fmt(x.lo)}, ${fmt(x.hi)}]`

function plannerFile(key: string) {
  return join(DIR, 'planner', `${key}.json`)
}

/**
 * One planner step with validation: at most two paid attempts (the second gets the first's
 * errors). Every attempt is saved before anything else happens, so a crash never re-pays.
 */
async function plannerStep<T>(key: string, kind: PlannerRecord['kind'], gen: number, prompt: string, schema: Parameters<typeof callPlanner<T>>[0]['schema'], validate: (o: T) => string[], fakeOut: () => T): Promise<T> {
  const file = plannerFile(key)
  let rec: PlannerRecord & { valid?: boolean } = existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8'))
    : { key, kind, gen, model: config.planner, writtenAt: now(), attempts: [], prompt, output: null }
  if (rec.valid) return rec.output as T
  while (rec.attempts.length < 2) {
    const last = rec.attempts.at(-1)
    const fullPrompt = last ? `${prompt}\n\nYOUR PREVIOUS ANSWER WAS REJECTED by the lab's checks:\n${last.errors.map(e => `- ${e}`).join('\n')}\nFix every point and answer again in full.` : prompt
    let output: T
    let usage = { input: 0, output: 0 }
    let latencyMs = 0
    if (fake) {
      output = fakeOut()
    } else {
      const need = kind === 'gen0' ? est.planner.gen0 : kind === 'next' ? est.planner.next : est.planner.final
      if (spend.spent + need > spend.cap) {
        spend.halted = true
        throw new Error(`budget: planner call ${key} (≈ $${need.toFixed(2)}) would cross $${spend.cap}`)
      }
      console.log(`  planner ${key}: asking ${config.planner}${last ? ' again (previous answer rejected)' : ''}…`)
      const r = await callPlanner({ instructions: plannerInstructions(brief()), prompt: fullPrompt, schema })
      output = r.output
      usage = r.usage
      latencyMs = r.latencyMs
      spend.spent += costUsd(PLANNER_MODEL.id, usage)
      console.log(`  planner ${key}: ${usage.input} in / ${usage.output} out tokens, ${(latencyMs / 1000).toFixed(0)} s, $${costUsd(PLANNER_MODEL.id, usage).toFixed(3)}`)
    }
    const errors = validate(output)
    rec = { ...rec, prompt, output, attempts: [...rec.attempts, { usage, latencyMs, errors }], valid: errors.length === 0, writtenAt: now() }
    writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`)
    event({ type: 'planner', key, kind, gen, attempt: rec.attempts.length, usage, latencyMs, errors, costUsd: costUsd(PLANNER_MODEL.id, usage) })
    if (!errors.length) return output
    console.warn(`  planner ${key}: rejected (${errors.length} problems): ${errors.slice(0, 4).join(' | ')}`)
  }
  throw new Error(`planner ${key}: two answers failed validation; see ${file}`)
}

/** Fake cards that satisfy every rule, so the pipeline runs for $0. */
function fakeCards(g: number, n: number, tested: StrategyCard[], parentPool: string[]): PlannedCard[] {
  const rng = seededRng(hash32(`${config.seed}|fake|${g}`))
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rng() * xs.length)]!
  const q = exploreQuota(n, g)
  const out: PlannedCard[] = []
  const randomAxes = () => Object.fromEntries(AXIS_NAMES.map(k => [k, pick(AXES[k])])) as Axes
  const byId = new Map(tested.map(c => [c.id, c]))
  for (let i = 0; i < q.exploit; i++) {
    const parent = byId.get(parentPool[i % parentPool.length]!)!
    const axes = { ...parent.axes }
    const k = AXIS_NAMES[i % AXIS_NAMES.length]!
    axes[k] = (AXES[k] as readonly string[]).find(v => v !== parent.axes[k]) as never
    out.push({ name: `Fake mutant ${g}-${i + 1}`, kind: 'exploit', parentIds: [parent.id], changed: `${k} set to ${axes[k]}`, axes, card: fakeText(axes), hypothesis: 'Fake run: no hypothesis.', predicted: { bb100: 0, rank: 0, vsControl: 0 } })
  }
  const explore: Axes[] = []
  for (let tries = 0; explore.length < q.explore && tries < 100_000; tries++) {
    const a = randomAxes()
    if ([...tested.map(t => t.axes), ...explore].every(b => axisDiff(a, b) >= 2)) explore.push(a)
  }
  explore.forEach((axes, i) => out.push({ name: `Fake idea ${g}-${i + 1}`, kind: 'explore', parentIds: [], changed: '', axes, card: fakeText(axes), hypothesis: 'Fake run: no hypothesis.', predicted: { bb100: Math.round((rng() - 0.5) * 200), rank: 0, vsControl: Math.round((rng() - 0.5) * 100) } }))
  return out.map((c, i) => ({ ...c, predicted: { ...c.predicted, rank: i + 1 } }))
}
function fakeText(a: Axes): string {
  return `Fake card for pipeline tests. Play a ${a.looseness} range with a ${a.aggression} style. Bluff ${a.bluffing === 'rare' ? 'rarely' : a.bluffing === 'sometimes' ? 'sometimes' : 'often'} and size bets ${a.sizing}. At showdown you are ${a.showdown.replace('_', ' ')}. Adapt: ${a.adaptation.replace('_', ' ')}. Table talk: ${a.talk}. Keep the menu in mind and pick the option that fits this style best on every street, from every position, against every opponent at the table.`
}
const fakeMemo = (g: number): PlannedMemo => ({ headline: `Fake memo for generation ${g}.`, confirmed: [], refuted: [], noise: ['Everything (fake run).'], surprises: [] })

function toCards(g: number, planned: PlannedCard[]): StrategyCard[] {
  return planned.map((p, i) => ({
    id: `g${g}c${String(i + 1).padStart(2, '0')}`, gen: g, kind: p.kind, parentIds: p.parentIds, changed: p.changed.trim(),
    name: p.name.trim(), card: p.card.trim(), axes: p.axes as Axes, hypothesis: p.hypothesis.trim(),
    predicted: { bb100: p.predicted.bb100, rank: p.predicted.rank, vsControl: p.predicted.vsControl }
  }))
}

function writeMemo(gen: number, m: PlannedMemo) {
  const memo: Memo = { gen, ...m }
  writeFileSync(join(DIR, `gen${gen}`, 'memo.json'), `${JSON.stringify(memo, null, 2)}\n`)
  const sec = (t: string, xs: string[]) => xs.length ? [`## ${t}`, '', ...xs.map(x => `- ${x}`), ''] : []
  writeFileSync(join(DIR, `gen${gen}`, 'memo.md'), [`# Generation ${gen} memo`, '', m.headline, '', ...sec('Confirmed', m.confirmed), ...sec('Refuted', m.refuted), ...sec('Still noise', m.noise), ...sec('Surprises', m.surprises)].join('\n'))
}

// ── prompt data from the results ───────────────────────────────────────────────────────────

function pooledText(f: LabFiles): string {
  const units = unitsOf(f.tables.filter(t => t.slug !== HELDOUT_SLUG))
  const rows = f.cards.map(c => ({ c, l: leadOf(units, c.id) })).filter(r => r.l.matches).sort((a, b) => (b.l.lead.value ?? -1e9) - (a.l.lead.value ?? -1e9))
  return rows.map(({ c, l }) => `- [${c.id}] "${c.name}": ${l.matches} matches, ${l.hands} hands · bb/100 ${ivText(l.bb100)} · lead vs control ${ivText(l.lead)}`).join('\n') || '(none)'
}

function genResultsText(f: LabFiles, g: number): string {
  const gen = f.predictions.find(p => p.gen === g)!
  const tables = f.tables.filter(t => t.slug.startsWith(`g${g}-`))
  const genUnits = unitsOf(tables)
  const alloc = f.allocations.find(a => a.gen === g)
  const lines: string[] = []
  for (const c of gen.cards) {
    const own = tables.filter(t => t.slug === tableSlug(g, c.id))
    const l = leadOf(unitsOf(own), c.id)
    const st = playerStyles(own, [c.id])[0]!
    lines.push(`- [${c.id}] "${c.name}" (${c.kind}): ${l.matches} matches, ${l.hands} hands · bb/100 ${ivText(l.bb100)} · lead vs control ${ivText(l.lead)} · predicted bb/100 ${fmt(c.predicted.bb100)}, lead ${fmt(c.predicted.vsControl)}, rank ${c.predicted.rank} · verdict ${verdict(c.predicted.vsControl, l.lead)}${alloc ? ` · matches by round ${alloc.rounds.map(r => r.matches[c.id] ?? 0).join('→')}` : ''}\n    style at its table: ${statsLine(st)}`)
  }
  const champ = f.outcomes.find(o => o.gen === g)?.championIn ?? (g === 0 ? NO_CHAMPION_ID : f.outcomes.find(o => o.gen === g - 1)?.championOut ?? NO_CHAMPION_ID)
  const cl = leadOf(genUnits, champ)
  lines.push(`- Champion seat (${label(champ)}) across all generation-${g} tables: ${cl.matches} matches · bb/100 ${ivText(cl.bb100)} · lead vs control ${ivText(cl.lead)}`)
  const others = [CONTROL_ID, ...config.field]
  const styles = playerStyles(tables, others)
  for (const s of styles) lines.push(`- ${label(s.seatId)} across all generation-${g} tables: ${statsLine(s)}`)
  return lines.join('\n')
}

function handsText(f: LabFiles, g: number, perCard: number): string {
  const gen = f.predictions.find(p => p.gen === g)!
  const out: string[] = []
  for (const c of gen.cards) {
    const own = f.tables.filter(t => t.slug === tableSlug(g, c.id))
    for (const d of decisiveHands(own, c.id, f.cards, config.base, perCard)) {
      out.push(`### ${d.slug} ${d.tournamentId} #${d.hand.handNo} — [${c.id}] "${c.name}" ${d.bb > 0 ? '+' : ''}${d.bb.toFixed(1)} bb`, renderHand(d.hand, d.seats, { reasoningMax: 220 }), '')
    }
  }
  return out.join('\n')
}

function memosText(f: LabFiles, beforeGen: number): string {
  return f.memos.filter(m => m.gen < beforeGen).map(m => [`Gen ${m.gen}: ${m.headline}`, ...m.confirmed.map(x => `  confirmed: ${x}`), ...m.refuted.map(x => `  refuted: ${x}`), ...m.noise.map(x => `  noise: ${x}`)].join('\n')).join('\n')
}

/** Training tables of generations ≤ g. */
function trainingUpTo(f: LabFiles, g: number) {
  return f.tables.filter(t => t.slug !== HELDOUT_SLUG && genOfSlug(t.slug) <= g)
}
/** A table's final match count from its generation's allocation. */
function allocatedMatches(f: LabFiles, slug: string): number {
  const g = genOfSlug(slug)
  const card = slug.slice(slug.indexOf('-') + 1)
  return f.allocations.find(a => a.gen === g)?.rounds.at(-1)?.matches[card] ?? 0
}

/** Top cards by pooled lead over the control after generation g (exploit parents; held-out picks). */
function topCards(f: LabFiles, k: number, g: number, minMatches = 1): string[] {
  const units = unitsOf(trainingUpTo(f, g), slug => allocatedMatches(f, slug))
  return f.cards.map(c => ({ id: c.id, l: leadOf(units, c.id) }))
    .filter(r => r.l.matches >= minMatches && r.l.lead.value !== null)
    .sort((a, b) => b.l.lead.value! - a.l.lead.value! || a.id.localeCompare(b.id))
    .slice(0, k).map(r => r.id)
}

// ── generations ─────────────────────────────────────────────────────────────────────────────

async function planGeneration(g: number): Promise<StrategyCard[]> {
  const predFile = join(DIR, `gen${g}`, 'predictions.json')
  if (existsSync(predFile)) return (JSON.parse(readFileSync(predFile, 'utf8')) as Predictions).cards
  mkdirSync(join(DIR, `gen${g}`), { recursive: true })
  const f = files()
  const n = cardsInGen(g)
  const tested = f.cards
  const parentPool = g === 0 ? [] : topCards(f, Math.max(3, exploreQuota(n, g).exploit), g - 1)
  const ctx = { gen: g, n, tested, parentPool }
  let cards: StrategyCard[]
  if (g === 0) {
    const out = await plannerStep(`gen0`, 'gen0', 0, gen0Prompt(n), gen0Schema, o => validateGeneration(toCards(0, o.cards), ctx), () => ({ cards: fakeCards(0, n, [], []) }))
    cards = toCards(0, out.cards)
  } else {
    const prompt = nextPrompt({ gen: g, n, results: genResultsText(f, g - 1), hands: handsText(f, g - 1, 4), pooled: pooledText(f), memos: memosText(f, g - 1), tested, parentPool })
    const out = await plannerStep(`gen${g}`, 'next', g, prompt, nextSchema, o => validateGeneration(toCards(g, o.cards), ctx), () => ({ memo: fakeMemo(g - 1), cards: fakeCards(g, n, tested, parentPool) }))
    writeMemo(g - 1, out.memo)
    cards = toCards(g, out.cards)
  }
  for (const c of cards) writeFileSync(join(DIR, 'cards', `${c.id}.md`), cardMarkdown(c))
  // Pre-registration: this file exists before any hand of the generation is dealt.
  const pred: Predictions = { gen: g, writtenAt: now(), cards }
  writeFileSync(predFile, `${JSON.stringify(pred, null, 2)}\n`)
  event({ type: 'generation', gen: g, cards: cards.map(c => ({ id: c.id, name: c.name, kind: c.kind, parentIds: c.parentIds, words: wordCount(c.card) })), predictionsWrittenAt: pred.writtenAt })
  console.log(`\n── gen ${g}: ${cards.map(c => `${c.id} "${c.name}" (${c.kind})`).join(', ')}`)
  return cards
}

function basePlayer(id: string, name: string): RunPlayer {
  return { id, modelId: config.base, name }
}
function cardPlayer(c: StrategyCard, name: string): RunPlayer {
  return { id: c.id, modelId: config.base, name, cardId: c.id, card: c.card }
}

function tablePlayers(g: number, c: StrategyCard, championIn: string): RunPlayer[] {
  const [a, b, d] = aliasesFor(3, hash32(tableSlug(g, c.id)))
  const champCard = allCards().find(x => x.id === championIn)
  return [
    cardPlayer(c, a!),
    basePlayer(CONTROL_ID, b!),
    champCard ? cardPlayer(champCard, d!) : basePlayer(NO_CHAMPION_ID, d!),
    ...config.field.map(id => ({ id, modelId: id, name: short(id) }))
  ]
}

/** Plays every table to its match count in one shared pool; false if the round didn't finish. */
async function playTables(specs: { slug: string, players: RunPlayer[], matches: number, baseSeed: number, gen: number | 'heldout', table: string }[]): Promise<boolean> {
  const handles: RunHandle[] = specs.map(s => openRun({
    dir: RUNS, slug: s.slug, players: s.players, matches: s.matches, baseSeed: s.baseSeed, format: 'sng', tournament, fake,
    lab: { run: config.run, gen: s.gen, table: s.table },
    decisionWatchdogMs: Number(args['decision-watchdog']) * 1000, handWatchdogMs: Number(args['hand-watchdog']) * 1000, fakeDelayMs: Number(args['fake-delay'])
  }))
  // Interleave tables so every card advances at the same pace (and a budget halt hits them evenly).
  const tasks: { label: string, run: () => Promise<void> }[] = []
  const maxPending = Math.max(0, ...handles.map(h => h.pending.length))
  for (let i = 0; i < maxPending; i++) for (const h of handles) if (h.pending[i]) tasks.push({ label: `${h.slug} ${h.pending[i]!.tournamentId}`, run: () => h.play(h.pending[i]!, spend, inFlight) })
  if (tasks.length) console.log(`  playing ${tasks.length} tournaments across ${handles.filter(h => h.pending.length).length} tables (concurrency ${args.concurrency})`)
  const { failures } = await runPool(tasks, Number(args.concurrency), () => spend.halted)
  let complete = true
  for (const h of handles) {
    const status = interrupted ? 'interrupted' : spend.halted ? 'budget' : failures ? 'errors' : 'complete'
    if (h.pending.length) h.end(status)
    const done = parseRun(readFileSync(h.file, 'utf8')).tournaments.length
    if (done < h.plan.length) complete = false
  }
  return complete && !spend.halted && !interrupted
}

async function playGeneration(g: number, cards: StrategyCard[], championIn: string): Promise<boolean> {
  const allocFile = join(DIR, `gen${g}`, 'allocation.json')
  const rounds: AllocationRound[] = []
  const save = () => writeFileSync(allocFile, `${JSON.stringify({ gen: g, rounds } satisfies Allocation, null, 2)}\n`)
  const specs = (matches: Record<string, number>) => cards.filter(c => matches[c.id]).map(c => ({ slug: tableSlug(g, c.id), players: tablePlayers(g, c, championIn), matches: matches[c.id]!, baseSeed: genSeed(g), gen: g, table: c.id }))
  // Each round ranks on exactly the matches the previous round allocated, so a rerun (with later
  // rounds already on disk) makes the same calls.
  const ranking = (upTo: Record<string, number>) => {
    const f = files()
    return cards.map((c) => {
      const l = leadOf(unitsOf(f.tables.filter(t => t.slug === tableSlug(g, c.id)), () => upTo[c.id] ?? 0), c.id)
      return { cardId: c.id, lead: l.lead.value, se: l.lead.value === null ? null : seOf(l.lead) }
    }).sort((a, b) => (b.lead ?? -Infinity) - (a.lead ?? -Infinity) || a.cardId.localeCompare(b.cardId))
  }

  // Round 1: every card the same small budget, on the same seeds.
  const m1 = Object.fromEntries(cards.map(c => [c.id, config.r1]))
  rounds.push({ round: 1, kind: 'equal', matches: m1 })
  save()
  console.log(`  gen ${g} round 1: ${cards.length} cards × ${config.r1} matches`)
  if (!await playTables(specs(m1))) return false

  // Round 2: successive halving, the top half get r2 more.
  const r1rank = ranking(m1)
  const survivors = r1rank.slice(0, survivorsOf(cards.length)).map(r => r.cardId)
  const m2 = Object.fromEntries(cards.map(c => [c.id, config.r1 + (survivors.includes(c.id) ? config.r2 : 0)]))
  rounds.push({ round: 2, kind: 'halving', matches: m2, ranking: r1rank })
  save()
  if (config.r2 > 0) {
    console.log(`  gen ${g} round 2 (halving): ${survivors.join(', ')} get +${config.r2}`)
    if (!await playTables(specs(m2))) return false
  }

  // Round 3: Thompson-sampling top-up among the survivors.
  if (config.topup > 0) {
    const r2rank = ranking(m2).filter(r => survivors.includes(r.cardId))
    const extra = thompsonTopUp(r2rank.map(r => ({ id: r.cardId, mean: r.lead ?? 0, se: r.se ?? 80 })), config.topup, hash32(`${config.seed}|ts|${g}`))
    const m3 = Object.fromEntries(cards.map(c => [c.id, m2[c.id]! + (extra[c.id] ?? 0)]))
    rounds.push({ round: 3, kind: 'thompson', matches: m3, ranking: r2rank })
    save()
    console.log(`  gen ${g} round 3 (Thompson top-up): ${Object.entries(extra).map(([id, k]) => `${id} +${k}`).join(', ')}`)
    if (!await playTables(specs(m3))) return false
  }
  return true
}

/** The next champion: the best pooled lead among this generation's survivors and the sitting champion. */
function crown(g: number, championIn: string): GenOutcome {
  const outFile = join(DIR, `gen${g}`, 'outcome.json')
  if (existsSync(outFile)) return JSON.parse(readFileSync(outFile, 'utf8')) as GenOutcome
  const f = files()
  // Only generations ≤ g, each table at its allocated matches: what existed when gen g ended.
  const units = unitsOf(trainingUpTo(f, g), slug => allocatedMatches(f, slug))
  const alloc = f.allocations.find(a => a.gen === g)!
  const halving = alloc.rounds.find(r => r.kind === 'halving')!
  const survivors = Object.entries(halving.matches).filter(([id, m]) => m > (alloc.rounds[0]!.matches[id] ?? 0) || config.r2 === 0).map(([id]) => id)
  const pool = [...new Set([...survivors, ...(championIn === NO_CHAMPION_ID ? [] : [championIn])])]
  const scored = pool.map(id => ({ id, l: leadOf(units, id) })).sort((a, b) => (b.l.lead.value ?? -Infinity) - (a.l.lead.value ?? -Infinity) || a.id.localeCompare(b.id))
  const best = scored[0]!
  const why = scored.map(s => `${s.id} ${fmt(s.l.lead.value)} over ${s.l.matches} matches`).join(' · ')
  const out: GenOutcome = { gen: g, championIn, championOut: best.id, why: `best pooled lead over the control: ${why}`, writtenAt: now() }
  writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`)
  return out
}

// ── held-out final ─────────────────────────────────────────────────────────────────────────

async function heldout(): Promise<boolean> {
  const planFile = join(DIR, 'heldout.json')
  const heldFile = join(RUNS, `${HELDOUT_SLUG}.jsonl`)
  let plan: HeldoutPlan
  if (existsSync(planFile) && (JSON.parse(readFileSync(planFile, 'utf8')) as HeldoutPlan).matches === config.heldoutMatches) {
    plan = JSON.parse(readFileSync(planFile, 'utf8'))
  } else {
    const f = files()
    const prev = existsSync(planFile) ? (JSON.parse(readFileSync(planFile, 'utf8')) as HeldoutPlan).cardIds : null
    // Candidates need more than round 1's matches (a halving survivor or a champion seat).
    const top = prev ?? topCards(f, 3, lastGen, config.r2 > 0 ? config.r1 + 1 : config.r1)
    const aliases = aliasesFor(4, hash32(`${config.seed}|heldout`))
    const cards = top.map(id => f.cards.find(c => c.id === id)!)
    const players: RunPlayer[] = [...cards.map((c, i) => cardPlayer(c, aliases[i]!)), basePlayer(CONTROL_ID, aliases[3]!), ...config.heldoutField.map(id => ({ id, modelId: id, name: short(id) }))]
    plan = { writtenAt: now(), cardIds: top, players, baseSeed: heldoutSeed, matches: config.heldoutMatches, trainingSeeds: 0, overlap: 0 }
    // Fresh seeds, asserted: none of the held-out decks was dealt in any run on disk (every lab
    // table, B3) or planned for any training generation of this lab.
    const seen = seenSeeds(ROOT, heldFile)
    for (let g = 0; g < 64; g++) for (let k = 0; k < 32; k++) seen.add(matchSeed(genSeed(g), k))
    const fresh = Array.from({ length: plan.matches }, (_, k) => matchSeed(plan.baseSeed, k))
    plan.trainingSeeds = seen.size
    plan.overlap = fresh.filter(s => seen.has(s)).length
    if (plan.overlap) throw new Error(`held-out seeds overlap training seeds (${plan.overlap}); refusing to run`)
    writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`)
    event({ type: 'heldout', cardIds: top, players: players.map(p => p.id), baseSeed: plan.baseSeed, matches: plan.matches, trainingSeeds: plan.trainingSeeds, overlap: 0 })
  }
  console.log(`\n── held-out: ${plan.cardIds.join(', ')} + control vs ${config.heldoutField.map(short).join(' + ')}, ${plan.matches} matches on fresh seeds`)
  return playTables([{ slug: HELDOUT_SLUG, players: plan.players, matches: plan.matches, baseSeed: plan.baseSeed, gen: 'heldout', table: 'heldout' }])
}

// ── field notes ──────────────────────────────────────────────────────────────────────────────

async function fieldNotes(lastGen: number) {
  const f = files()
  const units = unitsOf(f.tables.filter(t => t.slug !== HELDOUT_SLUG))
  const ht = f.tables.find(t => t.slug === HELDOUT_SLUG)
  const hu = ht ? unitsOf([ht]) : new Map()
  const priorRows = f.predictions.flatMap(p => p.cards.map((c) => {
    const l = leadOf(unitsOf(f.tables.filter(t => t.slug === tableSlug(p.gen, c.id))), c.id)
    return { c, l, err: l.bb100.value === null ? null : l.bb100.value - c.predicted.bb100 }
  }))
  const actualRank = new Map<string, number>()
  for (const p of f.predictions) {
    priorRows.filter(r => r.c.gen === p.gen).slice().sort((a, b) => (b.l.bb100.value ?? -1e9) - (a.l.bb100.value ?? -1e9)).forEach((r, i) => actualRank.set(r.c.id, i + 1))
  }
  const priors = priorRows.map(({ c, l, err }) => `- [${c.id}] "${c.name}": predicted bb/100 ${fmt(c.predicted.bb100)} vs actual ${ivText(l.bb100)} (error ${fmt(err)}) · predicted lead ${fmt(c.predicted.vsControl)} vs actual ${ivText(l.lead)} · rank predicted ${c.predicted.rank}, actual ${actualRank.get(c.id)} · verdict ${verdict(c.predicted.vsControl, l.lead)}`).join('\n')
  const gens = f.predictions.map((p) => {
    const o = f.outcomes.find(x => x.gen === p.gen)
    return `- Gen ${p.gen}: ${p.cards.length} cards; champion in ${o ? label(o.championIn) : '?'}, out ${o ? label(o.championOut) : '?'}`
  }).join('\n')
  const plan = f.heldout
  const heldText = plan && hu.size
    ? [`${hu.size} matches × 6 tournaments; table: ${plan.players.map(p => label(p.id)).join(', ')}; seeds asserted unseen (${plan.trainingSeeds} training/benchmark seeds checked)`,
        ...plan.cardIds.map((id) => {
          const h = leadOf(hu, id)
          return `- ${label(id)}: held-out bb/100 ${ivText(h.bb100)}, lead vs control ${ivText(h.lead)} · training lead ${ivText(leadOf(units, id).lead)} · ${heldOutVerdict(h.lead)}`
        })].join('\n')
    : '(not run)'
  const prompt = fieldNotesPrompt({ lastGen, tested: f.cards, pooled: pooledText(f), gens, results: genResultsText(f, lastGen), hands: handsText(f, lastGen, 3), priors, heldout: heldText, memos: memosText(f, lastGen) })
  const out = await plannerStep('field_notes', 'field_notes', lastGen, prompt, finalSchema, () => [], () => ({ memo: fakeMemo(lastGen), notes: { headline: 'Fake run: nothing learned.', whatWins: '—', whatLoses: '—', priorsWrong: '—', noise: '—', nextTests: '—' } }))
  writeMemo(lastGen, out.memo)
  writeFieldNotes(out.notes, priors, heldText)
}

function writeFieldNotes(n: FieldNotes, priors: string, heldText: string) {
  const f = files()
  const hands = f.tables.reduce((a, t) => a + t.run.hands.length, 0)
  const total = tableSpend(DIR) + plannerSpend(f.planner)
  const md = [
    `# Field notes: ${config.run}`,
    '',
    `*${now().slice(0, 10)} · ${f.predictions.length} generations · ${f.cards.length} cards · ${hands} hands · $${total.toFixed(2)} (pricing.ts) · base ${short(config.base)} · written by ${config.planner} from stats.ts numbers*`,
    '',
    n.headline,
    '',
    '## What wins', '', n.whatWins, '',
    '## What loses', '', n.whatLoses, '',
    '## Where the priors were wrong', '', n.priorsWrong, '',
    '## Still noise', '', n.noise, '',
    '## What to test next', '', n.nextTests, '',
    '---',
    '',
    '## The numbers (computed by stats.ts, not written by the planner)',
    '',
    '### Pooled leaderboard (training tables; lead = card − control, paired, 95% match-bootstrap CI)',
    '',
    pooledText(f),
    '',
    '### Predicted vs actual',
    '',
    priors,
    '',
    '### Held-out final',
    '',
    heldText,
    ''
  ].join('\n')
  writeFileSync(join(DIR, 'field_notes.md'), md)
  writeFileSync(join(DIR, 'field_notes.json'), `${JSON.stringify({ ...n, model: config.planner }, null, 2)}\n`)
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────

let status: 'complete' | 'budget' | 'interrupted' | 'errors' = 'complete'
let lastGen = -1
try {
  for (let g = 0; g < config.generations; g++) {
    const planned = existsSync(join(DIR, `gen${g}`, 'predictions.json'))
    if (!planned && g > 0 && !fake && spend.spent + genCost(g) + finalCost() > budget) {
      console.log(`\n── stopping after gen ${g - 1}: gen ${g} (≈ $${genCost(g).toFixed(2)}) + held-out and notes (≈ $${finalCost().toFixed(2)}) would cross $${budget} (spent $${spend.spent.toFixed(2)})`)
      event({ type: 'stop_generations', gen: g, spent: spend.spent, needed: genCost(g) + finalCost() })
      break
    }
    const cards = await planGeneration(g)
    const championIn = g === 0 ? NO_CHAMPION_ID : files().outcomes.find(o => o.gen === g - 1)!.championOut
    console.log(`  champion seat: ${label(championIn)}`)
    if (!await playGeneration(g, cards, championIn)) {
      status = interrupted ? 'interrupted' : spend.halted ? 'budget' : 'errors'
      break
    }
    const o = crown(g, championIn)
    lastGen = g
    console.log(`  gen ${g} done · champion → ${label(o.championOut)} (${o.why}) · lab spend $${spend.spent.toFixed(3)}`)
  }
  if (status === 'complete' && lastGen >= 0) {
    if (config.heldoutMatches > 0 && !await heldout()) status = interrupted ? 'interrupted' : spend.halted ? 'budget' : 'errors'
    if (status === 'complete' && !args['no-notes']) await fieldNotes(lastGen)
  }
} catch (err) {
  console.error(`✗ ${(err as Error).message}`)
  status = spend.halted ? 'budget' : interrupted ? 'interrupted' : 'errors'
}
clearInterval(heartbeat)
event({ type: 'lab_end', status, spentUsd: spend.spent - spentBefore, totalSpentUsd: spend.spent, liveDecisions: spend.live, replayedDecisions: spend.replayed, generations: lastGen + 1 })
console.log(`\n══ ${status}: ${lastGen + 1} generations · lab spend this invocation $${(spend.spent - spentBefore).toFixed(4)} (total $${spend.spent.toFixed(4)}) · ${spend.live} live / ${spend.replayed} replayed decisions → data/lab/${config.run}/`)
process.exit(status === 'complete' ? 0 : 1)
