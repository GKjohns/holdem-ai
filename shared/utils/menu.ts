/**
 * The shared action menu every AI picks from. Built from the SeatView alone, so
 * the server can rebuild it from exactly what was sent. Descriptions are plain
 * facts (chip amounts, resulting pot) — never odds or hand strength.
 */
import type { MenuId, MenuOption, PlayerAction, SeatView } from './types.ts'

const PRESETS: { id: MenuId, fraction: number, words: string }[] = [
  { id: 'raise_half_pot', fraction: 0.5, words: 'half the pot' },
  { id: 'raise_pot', fraction: 1, words: 'the size of the pot' },
  { id: 'raise_2x_pot', fraction: 2, words: 'twice the pot' }
]

export function buildMenu(view: SeatView): MenuOption[] {
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
  options.push({
    id: 'all_in',
    action: { type: 'all_in' },
    label: `All-in ${maxRaiseTo}`,
    describe: `Go all-in, ${isBet ? 'betting' : 'raising to'} ${maxRaiseTo} (pot becomes ${pot + me.stack})`
  })
  return options
}

export function menuToAction(menu: MenuOption[], id: string): PlayerAction | undefined {
  return menu.find(o => o.id === id)?.action
}
