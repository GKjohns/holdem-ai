/**
 * v2 Study B: one base model in every seat, each seat with a different persona (an overall approach
 * to the game), plus one seat with no persona (the control). Duplicate-seeded sit-and-gos on the
 * v2 structure with v2 seat information, so cards and position cancel as the personas rotate seats.
 *
 *   node --env-file=.env bench/personas.ts --base openai/gpt-6-luna --matches 3 --budget 8 --slug 20261011_v2B_luna
 *   ... --fake   seeded random deciders, $0
 *
 * Personas are short style text, no numbers or odds (bannedContent()). They ride in the seat part of
 * the prompt (after the shared history), and every seat plays under a neutral alias, so opponents
 * never see a persona name. Output: data/runs/<slug>.jsonl (batch-run schema, `players` + `playerId`).
 */
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { findModel } from '../shared/utils/models.ts'
import type { RunPlayer } from '../shared/utils/runs.ts'
import { bannedContent, wordCount } from '../shared/utils/strategy.ts'
import { SNG_V2 } from '../shared/utils/tournament.ts'
import { openRun, runPool } from './runner.ts'
import type { Spend } from './runner.ts'

export const PERSONAS: { id: string, label: string, card: string }[] = [
  {
    id: 'tight',
    label: 'Tight and patient',
    card: 'You play a tight, patient game. Fold most hands before the flop and enter pots mainly with strong starting hands, more of them in late position. When you do play, bet and raise with conviction rather than limping. Avoid marginal spots and big bluffs; let impatient players make mistakes against you. As the blinds rise and your stack gets short, still pick your spots, but don\'t blind away: move in with your better hands rather than waiting for perfect ones.'
  },
  {
    id: 'aggressive',
    label: 'Loose and aggressive',
    card: 'You play loose and aggressive. Open many hands, especially in position, and prefer raising to calling. Keep the pressure on with continuation bets and second barrels when the board fits your story, and attack players who check or fold too often. Pick on short stacks and passive players; ease off against players who keep fighting back. Size your bets to make others uncomfortable, including big bets when you think they will fold.'
  },
  {
    id: 'talker',
    label: 'Deceptive talker',
    card: 'Table talk is your weapon. Use your line at the table to mislead: sound weak when you are strong, confident when you are bluffing, and mix it up so nobody can find a pattern. Watch which opponents seem to react to what is said and lean on them. Otherwise play a solid, fairly standard game; the talk does the extra work.'
  },
  {
    id: 'reader',
    label: 'Opponent reader',
    card: 'Your edge is reading opponents. Before every decision, look back through the hands you remember: who raises light, who bets only with strong hands, who folds to pressure, who calls everything, what people showed at showdown, and whether their table talk matched their cards. Then exploit it: bluff the players who fold too much, value-bet the ones who call too much, and give credit to players who rarely bet without a hand. Say in your reasoning what you are using.'
  },
  {
    id: 'math',
    label: 'Math-first',
    card: 'You decide by the numbers you can work out yourself. Each time you face a bet, compare the price of calling with the pot you can win and an honest estimate of how often your hand is best or will improve, and call only when the price is right. Give every bet of your own a clear purpose, value or making better hands fold. Before the flop, choose hands by position and by your stack measured in big blinds. Stay calm and consistent; don\'t let the last hand change the next decision.'
  }
]

export const ALIASES = ['Ash', 'Birch', 'Cedar', 'Elm', 'Hazel', 'Rowan']

export function personaPlayers(base: string): RunPlayer[] {
  for (const p of PERSONAS) {
    const banned = bannedContent(p.card)
    if (banned.length) throw new Error(`${p.id}: ${banned.join(', ')}`)
    if (wordCount(p.card) > 120) throw new Error(`${p.id}: too long`)
  }
  return [
    ...PERSONAS.map((p, i) => ({ id: p.id, modelId: base, name: ALIASES[i]!, cardId: p.id, card: p.card })),
    { id: 'control', modelId: base, name: ALIASES[PERSONAS.length]! }
  ]
}

if (import.meta.main) {
  const { values: a } = parseArgs({
    options: {
      base: { type: 'string', default: 'openai/gpt-6-luna' },
      matches: { type: 'string', default: '1' },
      budget: { type: 'string', default: '1' },
      concurrency: { type: 'string', default: '6' },
      slug: { type: 'string' },
      seed: { type: 'string', default: '20261111' },
      fake: { type: 'boolean', default: false }
    }
  })
  const base = findModel(a.base)
  if (!base || base.kind !== 'llm') throw new Error(`${a.base} is not a language model in MODELS`)
  if (!a.fake && !process.env.AI_GATEWAY_API_KEY) throw new Error('AI_GATEWAY_API_KEY missing — run with node --env-file=.env')
  const slug = a.slug ?? `v2B_${base.id.split('/')[1]}`
  const run = openRun({
    dir: join(process.cwd(), 'data', 'runs'), slug, players: personaPlayers(base.id), matches: Number(a.matches), baseSeed: Number(a.seed),
    format: 'sng', tournament: SNG_V2, fake: a.fake!, memory: true, decisionTimeoutMs: 60_000, decisionWatchdogMs: 75_000, handWatchdogMs: 600_000
  })
  const spend: Spend = { spent: run.priorSpend, cap: Number(a.budget), halted: false, live: 0, replayed: 0 }
  console.log(`── personas ${slug}: base ${base.label}, ${run.plan.length - run.pending.length}/${run.plan.length} done, $${run.priorSpend.toFixed(3)} spent before, budget $${spend.cap}`)
  let interrupted = false
  const stop = () => {
    if (interrupted) process.exit(130)
    interrupted = true
    spend.halted = true
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  const beat = setInterval(() => console.log(`  … $${spend.spent.toFixed(3)} run total · ${spend.live} live / ${spend.replayed} replayed`), 60_000)
  const { failures } = await runPool(run.pending.map(t => ({ label: t.tournamentId, run: () => run.play(t, spend) })), Number(a.concurrency), () => spend.halted)
  clearInterval(beat)
  const status = interrupted ? 'interrupted' : spend.halted ? 'budget' : failures ? 'errors' : 'complete'
  const end = run.end(status)
  console.log(`══ ${status}: ${end.tournamentsDone}/${run.plan.length} tournaments · $${end.totalSpentUsd.toFixed(4)} run total`)
}
