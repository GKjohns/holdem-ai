/**
 * v2 seat information (2026-10-11): memory of earlier hands, side pots, acting order, chips in
 * the pot, the structure sheet with payouts, knocked-out players, cards in words. All of it is
 * what a human at the table knows; none of it is derived (no odds, no hand names, no stats).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockLanguageModelV4 } from 'ai/test'
import { cardsInWords, decide, pastHandText, promptParts, renderPrompt, tableState } from '../server/utils/decide.ts'
import { buildMenu } from '../shared/utils/menu.ts'
import { applyAction, currentPots, memoryWindow, newTable, pastHand, seatView, startHand, withMemory } from '../shared/utils/table.ts'
import { payoutFor, SNG_V2, sngFormat, withLevel } from '../shared/utils/tournament.ts'
import { costUsd } from '../shared/utils/pricing.ts'
import type { Card, PastHand, TableState } from '../shared/utils/types.ts'

const players = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, name: ['GPT-6 Sol', 'Jev', 'Claude Opus 5.5', 'GPT-6 Luna'][i]!, modelId: null }))

/** Plays `n` hands where the first actor raises to 3 bb and everyone else folds (or calls when told). */
function playHands(n: number, stacks: number[] = [1500, 1500, 1500, 1500]) {
  let s: TableState = newTable({ players, stacks, smallBlind: 10, bigBlind: 20 }, 99)
  const past: PastHand[] = []
  const holes = new Map<number, Record<string, Card[]>>()
  for (let k = 0; k < n; k++) {
    s = startHand(s)
    let first = true
    while (s.street !== 'complete') {
      const id = s.seats[s.toAct!]!.id
      s = applyAction(s, id, first ? { type: 'raise', to: 60 } : { type: 'fold' })
      first = false
    }
    past.push(pastHand(s))
    holes.set(s.handNo, Object.fromEntries(s.seats.map(x => [x.id, x.hole.slice()])))
  }
  return { s, past, holes }
}

test('pastHand: public events only — no hole cards unless shown, starting stacks, busts', () => {
  const { past } = playHands(2)
  const h = past[0]!
  assert.equal(h.handNo, 1)
  assert.deepEqual(h.shown, {}, 'nobody shows on a fold')
  assert.equal(h.players[0]!.id, 'a', 'button first')
  assert.deepEqual(h.players.map(p => p.stack), [1500, 1500, 1500, 1500])
  assert.equal(JSON.stringify(h).includes('hole'), false)
  const text = pastHandText(h)
  assert.match(text, /^Hand #1 \(blinds 10\/20; button GPT-6 Sol, small blind Jev, big blind Claude Opus 5\.5\)/)
  assert.match(text, /preflop: GPT-6 Luna raises to 60; GPT-6 Sol, Jev and Claude Opus 5\.5 fold/)
  assert.match(text, /GPT-6 Luna won the pot \(50\), no showdown\./)
})

test('pastHand at showdown lists shown cards and pot winners, never a hand name', () => {
  let s = newTable({ players: players.slice(0, 2), stacks: [100, 1000], smallBlind: 10, bigBlind: 20 }, 5)
  s = startHand(s)
  s = applyAction(s, s.seats[s.toAct!]!.id, { type: 'all_in' })
  s = applyAction(s, s.seats[s.toAct!]!.id, { type: 'call' })
  const h = pastHand(s)
  assert.equal(Object.keys(h.shown).length, 2)
  const text = pastHandText(h)
  assert.match(text, /- the board ran out: (\w\w ){4}\w\w/)
  assert.match(text, /- showdown: GPT-6 Sol showed \w\w \w\w; Jev showed \w\w \w\w/)
  assert.doesNotMatch(text, /pair|flush|straight|full house|kind|high card|set\b/i)
  if (h.busted.length) assert.match(text, /ran out of chips/)
})

test('memoryWindow: this block of 6 hands plus the previous one (one to two orbits), growing by appending', () => {
  const hands = Array.from({ length: 40 }, (_, i) => ({ handNo: i + 1 }) as PastHand)
  const nos = (n: number) => memoryWindow(hands, n).map(h => h.handNo)
  assert.deepEqual(nos(1), [])
  assert.deepEqual(nos(5), [1, 2, 3, 4])
  assert.deepEqual(nos(7), [1, 2, 3, 4, 5, 6])
  assert.deepEqual(nos(13), [7, 8, 9, 10, 11, 12])
  assert.deepEqual(nos(18), Array.from({ length: 11 }, (_, i) => i + 7))
  // Within a block the earlier window is a prefix of the later one.
  assert.deepEqual(nos(23).slice(0, nos(22).length), nos(22))
})

test('withMemory: the seat sees remembered hands and only its own past hole cards', () => {
  const { s, past, holes } = playHands(3)
  const next = startHand(s)
  const id = next.seats[next.toAct!]!.id
  const v = withMemory(seatView(next, id), past, holes)
  assert.equal(v.history!.length, 3)
  assert.deepEqual(v.myCards!.map(m => m.handNo), [1, 2, 3])
  for (const m of v.myCards!) assert.deepEqual(m.cards, holes.get(m.handNo)![id])
  const others = next.seats.filter(x => x.id !== id).flatMap(x => [...holes.values()].flatMap(h => h[x.id]!))
  const json = JSON.stringify(v)
  for (const c of others) assert.equal(json.includes(`"${c}"`) && !v.myCards!.some(m => m.cards.includes(c)) && !v.hole.includes(c) && !v.board.includes(c), false, `${c} leaked`)
})

test('the shared prompt part is identical for every seat (so it caches), the seat part differs', () => {
  const { s, past, holes } = playHands(4)
  const next = startHand(s)
  const game = sngFormat(SNG_V2.levels, next.handNo, { entrants: 4, startingStack: 1500, payouts: [50, 30, 20] })
  const views = next.seats.map(x => withMemory(seatView(next, x.id, game), past, holes))
  const parts = views.map(v => promptParts(v, buildMenu(v, { custom: true })))
  for (const p of parts) assert.deepEqual(p.shared, parts[0]!.shared)
  assert.notEqual(parts[0]!.seat, parts[1]!.seat)
  assert.equal(parts[0]!.shared.length, 1 + 4, 'table details + one part per remembered hand')
  assert.match(parts[0]!.shared[0]!, /a sit-and-go for 4 players, 1500 chips each\. The blinds double every 10 hands\. No hand limit/)
  assert.match(parts[0]!.shared[0]!, /Payouts: 1st 50%, 2nd 30%, 3rd 20% of the prize pool; 4th gets nothing\./)
  assert.doesNotMatch(parts[0]!.shared.join('\n'), /\(you\)/)
  assert.match(parts[0]!.seat, /^Your own cards in those hands: #1 \w\w \w\w; #2/)
})

test('seat part: cards in words, chips in the pot, who acts after you, players left and who is out', () => {
  let s = newTable({ players, stacks: 1500, smallBlind: 10, bigBlind: 20 }, 3)
  s = startHand(s)
  const id = s.seats[s.toAct!]!.id // under the gun (left of the big blind)
  const v = { ...seatView(s, id, sngFormat(SNG_V2.levels, 1, { entrants: 6, startingStack: 1500, payouts: [50, 30, 20] })), eliminated: [{ id: 'x', name: 'Claude Haiku 5.5', place: 6, handNo: 1 }, { id: 'y', name: 'Jev 2', place: 5, handNo: 1 }] }
  const p = promptParts(v, buildMenu(v, { custom: true })).seat
  assert.match(p, new RegExp(`Your cards: ${v.hole[0]} ${v.hole[1]} \\(\\w+ of \\w+, \\w+ of \\w+\\)`))
  assert.match(p, /Players left: 4 of 6\. Out so far: Claude Haiku 5\.5 \(6th, hand 1\), Jev 2 \(5th, hand 1\)\./)
  assert.match(p, /Still to act after you this round: GPT-6 Sol, Jev, Claude Opus 5\.5\./)
  assert.match(p, /- Claude Opus 5\.5 \(big blind\): 1480 behind, 20 in front this street, 20 in the pot this hand/)
  assert.match(p, /- raise_to — Raise to any total you choose from 40 to 1500/)
  assert.equal(cardsInWords(['Th', 'As']), 'Th As (ten of hearts, ace of spades)')
  const json = tableState(v)
  assert.deepEqual(json.acting_after_me, ['GPT-6 Sol', 'Jev', 'Claude Opus 5.5'])
  assert.equal(json.players_left, 4)
})

test('side pots: main pot + side pot with who can win each, mid-hand', () => {
  let s = newTable({ players: players.slice(0, 3), stacks: [100, 1000, 1000], smallBlind: 10, bigBlind: 20 }, 11)
  s = startHand(s) // button a (100), sb b, bb c; a acts first
  s = applyAction(s, 'a', { type: 'all_in' })
  s = applyAction(s, 'b', { type: 'raise', to: 300 })
  assert.deepEqual(currentPots(s), [{ amount: 220, eligible: ['a', 'b', 'c'] }, { amount: 200, eligible: ['b', 'c'] }])
  const v = seatView(s, 'c')
  assert.match(renderPrompt(v, buildMenu(v)), /Split as: main pot 220 \(GPT-6 Sol, Jev, Claude Opus 5\.5 \(you\)\); side pot 1 200 \(Jev, Claude Opus 5\.5 \(you\)\)\./)
})

test('acting order after the flop starts left of the button; the button acts last', () => {
  let s = newTable({ players: players.slice(0, 3), stacks: 1000, smallBlind: 10, bigBlind: 20 }, 4)
  s = startHand(s)
  s = applyAction(s, 'a', { type: 'call' })
  s = applyAction(s, 'b', { type: 'call' })
  s = applyAction(s, 'c', { type: 'check' })
  assert.equal(s.street, 'flop')
  assert.deepEqual(seatView(s, 'b').actingAfter, ['c', 'a'])
  assert.deepEqual(seatView(s, 'a').actingAfter, [])
  s = applyAction(s, 'b', { type: 'check' })
  s = applyAction(s, 'c', { type: 'check' })
  assert.match(renderPrompt(seatView(s, 'a'), buildMenu(seatView(s, 'a'))), /Nobody acts after you this round unless you bet or raise\./)
})

test('v2 structure: tournaments finish (blinds keep doubling), payouts 50/30/20, the sheet reaches the view', () => {
  assert.equal(SNG_V2.levels.at(-1)!.bb, 20480)
  assert.deepEqual([1, 2, 3, 4].map(p => payoutFor(SNG_V2.payouts, p)), [50, 30, 20, 0])
  let s = newTable({ players, stacks: 1500, smallBlind: 1, bigBlind: 2 }, 1)
  s = { ...s, handNo: 70 }
  s = startHand(withLevel(s, SNG_V2.levels).state)
  assert.equal(s.bigBlind, 2560)
  const g = sngFormat(SNG_V2.levels, 71, { entrants: 6, startingStack: 1500, payouts: [50, 30, 20] })
  assert.equal(g.type === 'sng' && g.handsPerLevel, 10)
})

test('cache tokens are priced at the cache rates when logged; older usage prices as plain input', () => {
  const plain = costUsd('anthropic/claude-fable-5.1', { input: 1000, output: 100 })
  assert.equal(plain, (1000 * 10 + 100 * 50) / 1e6)
  const cached = costUsd('anthropic/claude-fable-5.1', { input: 1000, output: 100, cacheRead: 800, cacheWrite: 100 })
  assert.equal(cached.toFixed(8), ((100 * 10 + 800 * 0.25 + 100 * 12.5 + 100 * 50) / 1e6).toFixed(8))
})

test('decide(): shared part ends in a cache breakpoint, raise_to amounts are applied and clamped', async () => {
  const { s, past, holes } = playHands(2)
  const next = startHand(s)
  const id = next.seats[next.toAct!]!.id
  const view = withMemory(seatView(next, id), past, holes)
  let prompt: unknown
  const answer = (amount: number) => new MockLanguageModelV4({
    doGenerate: async (opts) => {
      prompt = opts.prompt
      return { content: [{ type: 'text', text: JSON.stringify({ reasoning: 'r', tableTalk: '', choice: 'raise_to', amount }) }], finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 900, noCache: 100, cacheRead: 700, cacheWrite: 100 }, outputTokens: { total: 5, text: 5, reasoning: 0 } }, warnings: [] }
    }
  })
  const d = await decide({ modelId: 'anthropic/claude-opus-5.5', view, model: answer(77) })
  assert.equal(d.fallback, false)
  assert.equal(d.menuId, 'raise_to')
  assert.deepEqual(d.action, { type: 'raise', to: 77 })
  assert.deepEqual(d.usage, { input: 900, output: 5, cacheRead: 700, cacheWrite: 100 })
  const user = (prompt as { role: string, content: { type: string, text: string, providerOptions?: unknown }[] }[]).find(m => m.role === 'user')!
  assert.equal(user.content.length, 1 + 2 + 1, 'table details, 2 remembered hands, the seat part')
  assert.deepEqual(user.content[2]!.providerOptions, { anthropic: { cacheControl: { type: 'ephemeral' } } })
  assert.deepEqual(user.content[0]!.providerOptions, { anthropic: { cacheControl: { type: 'ephemeral' } } })
  assert.equal(user.content[1]!.providerOptions, undefined)
  assert.equal(user.content[3]!.providerOptions, undefined)
  const low = await decide({ modelId: 'anthropic/claude-opus-5.5', view, model: answer(1) })
  assert.deepEqual(low.action, { type: 'raise', to: view.minRaiseTo })
  assert.equal(low.requested, 'raise_to 1')
})
