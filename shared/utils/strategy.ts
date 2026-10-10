/**
 * B4 Strategy Lab: strategy cards and the rules a generation of them must pass. Pure (relative
 * imports, no Nuxt) so tests, bench/lab.ts and the /lab API all run it.
 *
 * A player = a fixed base model + a card (style guidance appended to its instructions). Cards are
 * written by the planner (Fable) before any hand of their generation is dealt, together with a
 * pre-registered hypothesis and prediction. Everything checkable about a generation (the explore
 * quota, how different cards are, what a card may say) is checked here, in code, not left to Fable.
 */
import { seededRng } from './rng.ts'

/** The named axes every card declares; "differs on two axes" is counted over these. */
export const AXES = {
  looseness: ['tight', 'medium', 'loose'],
  aggression: ['passive', 'balanced', 'aggressive'],
  bluffing: ['rare', 'sometimes', 'frequent'],
  sizing: ['small', 'pot', 'overbet', 'mixed'],
  showdown: ['folds_easily', 'selective', 'sticky'],
  adaptation: ['fixed', 'situational', 'targets_opponents'],
  talk: ['silent', 'friendly', 'needling', 'deceptive']
} as const
export type Axis = keyof typeof AXES
export const AXIS_NAMES = Object.keys(AXES) as Axis[]
export type Axes = { [K in Axis]: (typeof AXES)[K][number] }

export interface Prediction {
  /** The card's own bb/100 at its generation's tables. */
  bb100: number
  /** Rank among its generation's cards, 1 = best. */
  rank: number
  /** Card − control bb/100 on the same matches. Its sign is what the verdict checks. */
  vsControl: number
}

export interface StrategyCard {
  id: string
  gen: number
  /** 'explore': new idea (gen 0 is all explore); 'exploit': mutation (1 parent) or crossover (2). */
  kind: 'explore' | 'exploit'
  parentIds: string[]
  /** Exploit cards: the single thing changed from the parent(s). */
  changed: string
  name: string
  /** The text appended to the base model's instructions. */
  card: string
  axes: Axes
  hypothesis: string
  predicted: Prediction
}

/** The control is the base model with no card; it sits at every lab table. */
export const CONTROL_ID = 'control'
/** Gen 0 has no champion yet: its champion seat is a second plain copy of the base model. */
export const NO_CHAMPION_ID = 'control-2'

/** ~40% explore, enforced: Math.round(0.4 n). Gen 0 is all explore (it has nothing to exploit). */
export function exploreQuota(n: number, gen: number): { explore: number, exploit: number } {
  if (gen === 0) return { explore: n, exploit: 0 }
  const explore = Math.round(n * 0.4)
  return { explore, exploit: n - explore }
}

export function axisDiff(a: Axes, b: Axes): number {
  return AXIS_NAMES.filter(k => a[k] !== b[k]).length
}

export const CARD_MAX_WORDS = 230
export const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length

/**
 * Seated players get only what a human at the table has. A card is fixed style text, so it can't
 * hold anything about the current hand, but it could smuggle in numbers from the god-view data
 * (HUD stats, win rates, odds). Those are rejected.
 */
const BANNED: [RegExp, string][] = [
  [/\d\s*%|\bpercent\b|\bper ?cent\b/i, 'percentages'],
  [/\b(VPIP|PFR|WTSD|W\$SD|AF|aggression factor|bb\/100|win ?rate)\b/i, 'HUD stats or win rates'],
  [/\b(equity|equities)\b.*\d|\d.*\b(equity|equities)\b/i, 'equity numbers'],
  [/\b\d+(\.\d+)?\s*(to|:)\s*1\b/i, 'odds ratios'],
  [/\bodds\b[^.]*\d/i, 'odds numbers']
]
export function bannedContent(text: string): string[] {
  return BANNED.filter(([re]) => re.test(text)).map(([, why]) => why)
}

export interface GenerationContext {
  gen: number
  /** How many cards this generation must have. */
  n: number
  /** Every card already tested in earlier generations. */
  tested: StrategyCard[]
  /** Ids exploit cards may use as parents (the top cards so far). */
  parentPool: string[]
}

/** Every rule a generation must pass; an empty list means valid. */
export function validateGeneration(cards: StrategyCard[], ctx: GenerationContext): string[] {
  const errs: string[] = []
  const quota = exploreQuota(ctx.n, ctx.gen)
  if (cards.length !== ctx.n) errs.push(`expected ${ctx.n} cards, got ${cards.length}`)
  const explore = cards.filter(c => c.kind === 'explore')
  const exploit = cards.filter(c => c.kind === 'exploit')
  if (explore.length !== quota.explore || exploit.length !== quota.exploit) {
    errs.push(`explore quota: need exactly ${quota.explore} explore and ${quota.exploit} exploit cards, got ${explore.length} and ${exploit.length}`)
  }
  const names = new Set<string>()
  for (const c of [...ctx.tested, ...cards]) {
    const k = c.name.trim().toLowerCase()
    if (names.has(k)) errs.push(`name "${c.name}" is used twice`)
    names.add(k)
  }
  const ranks = cards.map(c => c.predicted.rank).sort((a, b) => a - b)
  if (ranks.some((r, i) => r !== i + 1)) errs.push(`predicted ranks must be 1..${cards.length}, each once (got ${ranks.join(', ')})`)
  const byId = new Map(ctx.tested.map(c => [c.id, c]))
  for (const c of cards) {
    const who = `"${c.name}"`
    for (const k of AXIS_NAMES) {
      if (!(AXES[k] as readonly string[]).includes(c.axes?.[k])) errs.push(`${who}: axis ${k} must be one of ${AXES[k].join('/')}`)
    }
    const words = wordCount(c.card)
    if (words > CARD_MAX_WORDS) errs.push(`${who}: card is ${words} words (max ${CARD_MAX_WORDS})`)
    if (words < 40) errs.push(`${who}: card is only ${words} words`)
    const banned = bannedContent(c.card)
    if (banned.length) errs.push(`${who}: card contains ${banned.join(', ')}; cards are style guidance only`)
    if (!c.hypothesis.trim()) errs.push(`${who}: hypothesis is empty`)
    for (const v of [c.predicted.bb100, c.predicted.vsControl]) if (!Number.isFinite(v) || Math.abs(v) > 2000) errs.push(`${who}: predictions must be finite bb/100 numbers`)
    if (c.kind === 'explore') {
      if (c.parentIds.length) errs.push(`${who}: explore cards have no parents`)
      for (const t of ctx.tested) {
        if (axisDiff(c.axes, t.axes) < 2) errs.push(`${who}: explore card differs from tested card "${t.name}" on fewer than 2 axes`)
      }
    } else {
      if (c.parentIds.length < 1 || c.parentIds.length > 2) errs.push(`${who}: exploit cards have 1 parent (mutation) or 2 (crossover)`)
      if (!c.changed.trim()) errs.push(`${who}: exploit cards must name the single thing changed`)
      for (const p of c.parentIds) if (!ctx.parentPool.includes(p)) errs.push(`${who}: parent ${p} is not one of the top cards (${ctx.parentPool.join(', ')})`)
      const parents = c.parentIds.map(p => byId.get(p)).filter((p): p is StrategyCard => !!p)
      if (parents.length === 1 && axisDiff(c.axes, parents[0]!.axes) > 1) errs.push(`${who}: a mutation changes one thing, but its axes differ from ${parents[0]!.id} on ${axisDiff(c.axes, parents[0]!.axes)}`)
      if (parents.length === 2) {
        const off = AXIS_NAMES.filter(k => c.axes[k] !== parents[0]!.axes[k] && c.axes[k] !== parents[1]!.axes[k])
        if (off.length) errs.push(`${who}: a crossover takes each axis from a parent; ${off.join(', ')} come from neither`)
      }
    }
  }
  // New ideas must differ from each other too (gen 0: every pair; later: the explore cards).
  for (let i = 0; i < explore.length; i++) {
    for (let j = i + 1; j < explore.length; j++) {
      if (axisDiff(explore[i]!.axes, explore[j]!.axes) < 2) errs.push(`"${explore[i]!.name}" and "${explore[j]!.name}" differ on fewer than 2 axes`)
    }
  }
  return errs
}

/** The card as a plain .md file (data/lab/<run>/cards/<id>.md). */
export function cardMarkdown(c: StrategyCard): string {
  const sign = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v)}`
  return [
    `# ${c.name} (${c.id})`,
    '',
    `- Generation ${c.gen} · ${c.kind}${c.parentIds.length ? ` of ${c.parentIds.join(' × ')}` : ''}${c.changed ? ` · changed: ${c.changed}` : ''}`,
    `- Axes: ${AXIS_NAMES.map(k => `${k} ${c.axes[k]}`).join(' · ')}`,
    `- Hypothesis: ${c.hypothesis}`,
    `- Predicted: ${sign(c.predicted.bb100)} bb/100 · rank ${c.predicted.rank} · ${sign(c.predicted.vsControl)} vs the control`,
    '',
    '## Card',
    '',
    c.card.trim(),
    ''
  ].join('\n')
}

export type Verdict = 'confirmed' | 'refuted' | 'inconclusive'

/**
 * The pre-registered call checked against the measured lead over the control: a predicted edge
 * (or deficit) is confirmed when the CI excludes 0 on that side, refuted when it excludes 0 on the
 * other side, otherwise inconclusive. A predicted 0 is confirmed by a CI that spans 0.
 */
export function verdict(predictedVsControl: number, lead: { value: number | null, lo: number | null, hi: number | null }): Verdict {
  if (lead.lo === null || lead.hi === null) return 'inconclusive'
  const above = lead.lo > 0
  const below = lead.hi < 0
  if (predictedVsControl > 0) return above ? 'confirmed' : below ? 'refuted' : 'inconclusive'
  if (predictedVsControl < 0) return below ? 'confirmed' : above ? 'refuted' : 'inconclusive'
  return above || below ? 'refuted' : 'confirmed'
}

/**
 * Held-out check: 'holds' when the fresh-field lead over the control excludes 0 on the upside,
 * 'overfit' when the point estimate is ≤ 0 (the edge is gone on new seeds and a new field),
 * otherwise 'inconclusive'.
 */
export function heldOutVerdict(lead: { value: number | null, lo: number | null }): 'holds' | 'overfit' | 'inconclusive' {
  if (lead.value === null) return 'inconclusive'
  if (lead.value <= 0) return 'overfit'
  return lead.lo !== null && lead.lo > 0 ? 'holds' : 'inconclusive'
}

/** Neutral table names for base-model seats, so a card's name or role never reaches an opponent. */
export const TABLE_ALIASES = ['Ash', 'Birch', 'Cedar', 'Elm', 'Hazel', 'Rowan']

/** A seeded shuffle of the aliases (per table), so the candidate isn't always "Ash". */
export function aliasesFor(n: number, seed: number): string[] {
  const rng = seededRng(seed)
  const a = TABLE_ALIASES.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a.slice(0, n)
}

/** Small stable 32-bit hash for seeds derived from strings. */
export function hash32(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/**
 * Batch Thompson sampling: `k` draws from N(mean, se²) per arm, each giving one extra match to the
 * arm with the highest draw. Seeded, so a rerun allocates the same way.
 */
export function thompsonTopUp(arms: { id: string, mean: number, se: number }[], k: number, seed: number): Record<string, number> {
  const rng = seededRng(seed)
  const normal = () => {
    const u = Math.max(rng(), 1e-12)
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
  }
  const out: Record<string, number> = {}
  for (let i = 0; i < k && arms.length; i++) {
    let best = arms[0]!
    let bestDraw = -Infinity
    for (const a of arms) {
      const d = a.mean + a.se * normal()
      if (d > bestDraw) {
        bestDraw = d
        best = a
      }
    }
    out[best.id] = (out[best.id] ?? 0) + 1
  }
  return out
}
