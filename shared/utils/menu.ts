/**
 * The shared action menu every AI picks from. Built from the SeatView alone, so
 * the server can rebuild it from exactly what was sent. Descriptions are plain
 * facts (chip amounts, resulting pot) — never odds or hand strength.
 */
import type { MenuId, MenuOption, PlayerAction, SeatView } from './types.ts'

/** v2 added ⅓, ¾ and 1½×: the v1 menu (½, pot, 2×) had no ordinary c-bet sizes and no overbet short of 2×. */
const PRESETS: { id: MenuId, fraction: number, words: string }[] = [
  { id: 'raise_third_pot', fraction: 1 / 3, words: 'a third of the pot' },
  { id: 'raise_half_pot', fraction: 0.5, words: 'half the pot' },
  { id: 'raise_3q_pot', fraction: 0.75, words: 'three quarters of the pot' },
  { id: 'raise_pot', fraction: 1, words: 'the size of the pot' },
  { id: 'raise_1_5x_pot', fraction: 1.5, words: 'one and a half times the pot' },
  { id: 'raise_2x_pot', fraction: 2, words: 'twice the pot' }
]

/**
 * `custom` (language models): adds `raise_to`, a raise to any amount the model names in its answer.
 * Decision models answer a choice question, so they get the presets only.
 */
export function buildMenu(view: SeatView, opts: { custom?: boolean } = {}): MenuOption[] {
  const { pot, toCall, minRaiseTo, maxRaiseTo, me } = view
  const options: MenuOption[] = []

  if (toCall === 0) {
    options.push({ id: 'check', action: { type: 'check' }, label: 'Check', describe: `Check (pot stays ${pot})` })
  } else {
    options.push({ id: 'fold', action: { type: 'fold' }, label: 'Fold', describe: 'Fold and give up this hand' })
    const allIn = toCall >= me.stack
    options.push({
      id: 'call',
      action: { type: 'call' },
      label: allIn ? `Call ${toCall} (all-in)` : `Call ${toCall}`,
      describe: `Call ${toCall}${allIn ? ', all-in' : ''} (pot becomes ${pot + toCall})`
    })
  }

  if (!view.canRaise) return options

  const currentBet = me.committed + toCall
  const isBet = currentBet === 0
  const verb = isBet ? 'Bet' : 'Raise to'
  const raiseOption = (id: MenuId, to: number, sizeWords?: string): MenuOption => ({
    id,
    action: { type: 'raise', to },
    label: `${verb} ${to}`,
    describe: `${verb} ${to}${sizeWords ? `, ${sizeWords}` : ''} (pot becomes ${pot + to - me.committed})`
  })

  const seen = new Set<number>()
  if (minRaiseTo < maxRaiseTo) {
    options.push(raiseOption('raise_min', minRaiseTo, isBet ? 'the minimum bet' : 'the minimum raise'))
    seen.add(minRaiseTo)
  }
  // Preset size = currentBet + fraction × (pot after calling).
  for (const p of PRESETS) {
    const to = Math.round(currentBet + p.fraction * (pot + toCall))
    if (to < minRaiseTo || to >= maxRaiseTo || seen.has(to)) continue
    seen.add(to)
    options.push(raiseOption(p.id, to, `${isBet ? 'betting' : 'raising by'} ${p.words}`))
  }
  if (opts.custom && minRaiseTo < maxRaiseTo) {
    options.push({
      id: 'raise_to',
      action: { type: 'raise', to: minRaiseTo },
      label: `${verb} any amount`,
      describe: `${isBet ? 'Bet' : 'Raise to'} any total you choose from ${minRaiseTo} to ${maxRaiseTo} (${maxRaiseTo} is all-in); give the total in "amount"`
    })
  }
  options.push({
    id: 'all_in',
    action: { type: 'all_in' },
    label: `All-in ${maxRaiseTo}`,
    describe: `Go all-in, ${isBet ? 'betting' : 'raising to'} ${maxRaiseTo} (pot becomes ${pot + me.stack})`
  })
  return options
}

/**
 * The action for a `raise_to` answer: the amount clamped into the legal range, as a dealer would
 * (a bet below the minimum is made the minimum; more than the stack is all-in).
 */
export function raiseToAction(view: SeatView, amount: number): { action: PlayerAction, clamped: boolean } {
  const to = Math.min(view.maxRaiseTo, Math.max(view.minRaiseTo, Math.round(Number.isFinite(amount) ? amount : 0)))
  return { action: to >= view.maxRaiseTo ? { type: 'all_in' } : { type: 'raise', to }, clamped: to !== amount }
}

export function menuToAction(menu: MenuOption[], id: string): PlayerAction | undefined {
  return menu.find(o => o.id === id)?.action
}
