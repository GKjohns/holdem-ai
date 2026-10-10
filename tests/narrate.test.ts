import { test } from 'node:test'
import assert from 'node:assert/strict'
import { notableHands, renderHand, renderScoutingPrompt } from '../server/utils/narrate.ts'
import { scoutingMarkdown, statsLine, uncitedClaims, type NarrateHand, type NarrateSeat, type ScoutingReport } from '../shared/utils/narration.ts'
import { seatStats } from '../shared/utils/stats.ts'
import type { Decision } from '../shared/utils/types.ts'

const seats: NarrateSeat[] = [
  { id: 'you', name: 'You', modelId: null },
  { id: 'seat-1', name: 'Jev', modelId: 'typesafe-ai/jev' },
  { id: 'seat-2', name: 'GPT-6 Luna', modelId: 'openai/gpt-6-luna' }
]
const dec = (over: Partial<Decision>): Decision => ({ menuId: 'call', action: { type: 'call' }, reasoning: '', fallback: false, model: 'x', latencyMs: 100, usage: { input: 10, output: 0 }, ...over })

function hand(handNo: number, over: Partial<NarrateHand> = {}): NarrateHand {
  return {
    handNo, board: ['Ah', '7d', '2c', 'Ks', '9h'], button: 0, blindsNote: 'Jev posts 5 · GPT-6 Luna posts 10',
    holes: { 'you': ['Qc', 'Qd'], 'seat-1': ['7s', '2s'], 'seat-2': ['Ad', 'Kd'] },
    log: [
      { seatId: 'you', street: 'preflop', action: { type: 'raise', to: 30 }, added: 30, raiseTo: 30 },
      { seatId: 'seat-1', street: 'preflop', action: { type: 'call' }, added: 25 },
      { seatId: 'seat-2', street: 'preflop', action: { type: 'call' }, added: 20, tableTalk: 'Let\'s dance.' },
      { seatId: 'seat-1', street: 'flop', action: { type: 'raise', to: 60 }, added: 60, raiseTo: 60 },
      { seatId: 'seat-2', street: 'flop', action: { type: 'fold' }, added: 0 },
      { seatId: 'you', street: 'flop', action: { type: 'fold' }, added: 0 }
    ],
    actionLabels: ['raises to 30', 'calls 25', 'calls 20', 'bets 60', 'folds', 'folds'],
    decisions: [
      { seatId: 'seat-1', street: 'preflop', logIndex: 1, decision: dec({ model: 'typesafe-ai/jev', probabilities: { call: 0.7, fold: 0.3 } }) },
      { seatId: 'seat-2', street: 'preflop', logIndex: 2, decision: dec({ model: 'openai/gpt-6-luna', reasoning: 'Ace-king suited is too strong to fold.' }) },
      { seatId: 'seat-1', street: 'flop', logIndex: 3, decision: dec({ model: 'typesafe-ai/jev', menuId: 'raise_half_pot', probabilities: { raise_half_pot: 0.55, check: 0.45 } }) },
      { seatId: 'seat-2', street: 'flop', logIndex: 4, decision: dec({ model: 'openai/gpt-6-luna', menuId: 'fold', reasoning: 'Top pair is beat here.' }) }
    ],
    pots: [{ amount: 150, eligible: ['seat-1'], winners: ['seat-1'], handName: 'Uncontested' }],
    shown: {},
    deltas: { 'you': -30, 'seat-1': 60, 'seat-2': -30 },
    stacksAfter: { 'you': 970, 'seat-1': 1060, 'seat-2': 970 },
    ...over
  }
}

test('the narrator gets the god view of a completed hand: every hole card, reasoning, probabilities, result', () => {
  const text = renderHand(hand(3), seats)
  for (const c of ['Q♣ Q♦', '7♠ 2♠', 'A♦ K♦']) assert.ok(text.includes(c), c)
  assert.match(text, /Ace-king suited is too strong to fold/)
  assert.match(text, /probabilities: half-pot 55%, check 45%/)
  assert.match(text, /Flop \(A♥ 7♦ 2♣\):/)
  assert.match(text, /GPT-6 Luna calls 20 and says "Let's dance\."/)
  assert.match(text, /Pot 150: Jev \(Uncontested\)/)
  assert.match(text, /seat-1 Jev \(TypeSafe AI decision model\): holds 7♠ 2♠; best five with the full board: Two pair[^;]*; \+60 this hand, 1060 after/)
})

test('a busted seat is shown as sitting out', () => {
  const h = hand(4, { holes: { 'you': ['Qc', 'Qd'], 'seat-1': [], 'seat-2': ['Ad', 'Kd'] } })
  assert.match(renderHand(h, seats), /seat-1 Jev: sat out \(busted\)/)
})

test('notable hands: the seat\'s showdowns first, then its biggest swings, returned in hand order', () => {
  const hands = [
    hand(1, { deltas: { 'seat-1': 10 } }),
    hand(2, { deltas: { 'seat-1': -400 } }),
    hand(3, { deltas: { 'seat-1': 5 }, shown: { 'seat-1': { cards: ['7s', '2s'], best5: [], handName: 'Pair' } } }),
    hand(4, { deltas: { 'seat-1': 90 } }),
    hand(5, { deltas: { 'seat-1': 0 }, holes: { 'seat-1': [] } })
  ]
  assert.deepEqual(notableHands('seat-1', hands, 2), [2, 3])
  assert.deepEqual(notableHands('seat-1', hands, 9), [1, 2, 3, 4])
})

test('the scouting prompt carries stats.ts numbers verbatim and scouts only the AI seats', () => {
  const hands = [hand(1), hand(2)]
  const { prompt, stats } = renderScoutingPrompt(seats, hands, { 1: 'Jev steals it' })
  const expected = seatStats(seats.map(s => s.id), hands, hands.flatMap(h => h.decisions))
  assert.deepEqual(stats, expected)
  for (const st of expected) assert.ok(prompt.includes(statsLine(st)), st.seatId)
  assert.match(prompt, /Seats to scout \(seatId = name\): seat-1 = Jev .*, seat-2 = GPT-6 Luna/)
  assert.match(prompt, /not to be scouted: You \(human\)/)
  assert.match(prompt, /#1: Jev won 150 .* · Booth: "Jev steals it"/)
  assert.match(prompt, /GPT-6 Luna: #1 "Let's dance\."/)
})

test('statsLine shows ∞ AF from the counts even after JSON turned Infinity into null', () => {
  const [st] = seatStats(['seat-1'], [hand(1)], [])
  assert.equal(st!.af, Infinity)
  const roundTripped = JSON.parse(JSON.stringify(st))
  assert.equal(roundTripped.af, null)
  assert.equal(statsLine(roundTripped), statsLine(st!))
  assert.match(statsLine(st!), /VPIP 100% \(1\/1\) · PFR 0% \(0\/1\) · AF ∞ \(1 bets\/raises, 0 calls\)/)
})

test('scouting markdown has every seat, its numbers, and flags uncited claims', () => {
  const stats = seatStats(['seat-1'], [hand(1)], [])
  const report: ScoutingReport = {
    hands: 1, overview: 'One hand, one steal.', model: 'anthropic/claude-sonnet-5.5', latencyMs: 1, usage: { input: 1, output: 1 }, stats,
    seats: [{ seatId: 'seat-1', styleLabel: 'aggressive', tendencies: ['Bets when checked to (AF ∞).', 'Loves a steal.'], signatureHand: { handNo: 1, why: 'Took it down on the flop.' }, howToBeat: 'Check-raise it.', voice: 'Silent.' }]
  }
  const md = scoutingMarkdown(report, id => seats.find(s => s.id === id)!.name)
  assert.match(md, /^# Scouting report\n/)
  assert.match(md, /## Jev: aggressive/)
  assert.ok(md.includes(statsLine(stats[0]!)))
  assert.match(md, /\*\*Signature hand #1:\*\* Took it down/)
  assert.deepEqual(uncitedClaims(report), ['Loves a steal.'])
})
