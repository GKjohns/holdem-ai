import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanTableTalk, INSTRUCTIONS, instructionsFor, promptParts, renderPrompt, SNG_INSTRUCTIONS, tableState } from '../server/utils/decide.ts'
import { buildMenu } from '../shared/utils/menu.ts'
import { newTable, recentTalk, seatView, startHand } from '../shared/utils/table.ts'
import { SNG_TURBO, sngFormat, withLevel } from '../shared/utils/tournament.ts'
import type { Card } from '../shared/utils/types.ts'

function viewFor(players: { id: string, name: string, modelId: string | null }[], seatId: string) {
  const s = startHand(newTable({ players, stacks: 1000, smallBlind: 5, bigBlind: 10 }, 7))
  return seatView(s, seatId)
}

test('Play mode: the human seat is "Human player", and seating + positions are spelled out', () => {
  const v = viewFor([
    { id: 'you', name: 'You', modelId: null },
    { id: 'seat-1', name: 'GPT-6 Sol', modelId: 'openai/gpt-6-sol' },
    { id: 'seat-2', name: 'Jev', modelId: 'typesafe-ai/jev' }
  ], 'seat-2')
  const p = renderPrompt(v, buildMenu(v))
  assert.match(p, /Seating, clockwise from the button: Human player \(button\), GPT-6 Sol \(small blind\), Jev \(you, big blind\)\./)
  assert.match(p, /- Human player \(button\): /)
  assert.equal(p.includes('You:'), true, 'own chip line still reads "You:"')
  const json = tableState(v)
  assert.deepEqual(json.seating_clockwise_from_button, ['Human player', 'GPT-6 Sol', 'Jev (me)'])
  assert.equal(json.opponents[0]!.position, 'button')
})

test('Watch mode: no "Human player" anywhere in the prompt', () => {
  const v = viewFor([
    { id: 'seat-1', name: 'GPT-6 Luna', modelId: 'openai/gpt-6-luna' },
    { id: 'seat-2', name: 'Jev', modelId: 'typesafe-ai/jev' },
    { id: 'seat-3', name: 'Claude Haiku 5.5', modelId: 'anthropic/claude-haiku-5.5' }
  ], 'seat-1')
  const p = renderPrompt(v, buildMenu(v))
  assert.equal(/human/i.test(p), false)
  assert.equal(/human/i.test(JSON.stringify(tableState(v))), false)
})

test('prior table talk is listed so the model can avoid repeating it', () => {
  const v = { ...viewFor([
    { id: 'you', name: 'You', modelId: null },
    { id: 'seat-1', name: 'GPT-6 Luna', modelId: 'openai/gpt-6-luna' }
  ], 'seat-1'), priorTableTalk: ['Let\'s see a flop.'] }
  const p = renderPrompt(v, buildMenu(v))
  assert.match(p, /already said this session[^\n]*\n- "Let's see a flop\."/)
  assert.equal(renderPrompt({ ...v, priorTableTalk: [] }, buildMenu(v)).includes('already said'), false)
})

// ── format: cash tables say "cash game", sit-and-gos say the blind level ──────

test('cash view: instructions and prompt say cash game; a view without `game` keeps the old wording', () => {
  const players = [{ id: 'you', name: 'You', modelId: null }, { id: 'seat-1', name: 'GPT-6 Luna', modelId: 'openai/gpt-6-luna' }]
  const s = startHand(newTable({ players, stacks: 1000, smallBlind: 5, bigBlind: 10 }, 7))
  const v = seatView(s, 'seat-1', { type: 'cash' })
  assert.deepEqual(v.game, { type: 'cash' })
  assert.match(promptParts(v, buildMenu(v)).seat, /^Hand #1, preflop\. Cash game, big blind 10\./)
  assert.equal(tableState(v).game, 'No-limit Texas Hold\'em cash game')
  assert.match(instructionsFor('cash'), /cash game/)
  assert.equal(instructionsFor('cash'), INSTRUCTIONS)
  const old = seatView(s, 'seat-1')
  assert.equal('game' in old, false, 'no format unless the caller states one')
  assert.match(promptParts(old, buildMenu(old)).seat, /^Hand #1, preflop\. Big blind 10\./)
})

test('sit-and-go view: tournament wording, blind level and hands until the next level', () => {
  const players = ['seat-1', 'seat-2', 'seat-3'].map(id => ({ id, name: id, modelId: 'openai/gpt-6-luna' }))
  let s = { ...newTable({ players, stacks: 1500, smallBlind: 1, bigBlind: 2 }, 7), handNo: 13 } // next hand is #14 (level 2)
  s = startHand(withLevel(s, SNG_TURBO.levels).state)
  assert.equal(s.handNo, 14)
  const id = s.seats[s.toAct!]!.id
  const v = seatView(s, id, sngFormat(SNG_TURBO.levels, s.handNo))
  assert.deepEqual(v.game, { type: 'sng', level: 2, handsLeftAtLevel: 6, next: { smallBlind: 40, bigBlind: 80 } })
  const p = promptParts(v, buildMenu(v)).seat
  assert.match(p, /^Hand #14, preflop\. Sit-and-go tournament, blind level 2, big blind 40\. 6 more hands at this level after this one, then the blinds go up to 40\/80\./)
  assert.equal(/cash game/i.test(p), false)
  const json = tableState(v)
  assert.equal(json.game, 'No-limit Texas Hold\'em sit-and-go tournament')
  assert.equal(json.blind_level, 2)
  assert.equal(json.next_level_blinds, '40/80')
  assert.equal(instructionsFor('sng'), SNG_INSTRUCTIONS)
  const last = sngFormat(SNG_TURBO.levels, 20)
  assert.deepEqual(last, { type: 'sng', level: 2, handsLeftAtLevel: 0, next: { smallBlind: 40, bigBlind: 80 } })
  assert.match(renderPrompt({ ...v, game: last }, buildMenu(v)), /This is the last hand at this level; the blinds go up to 40\/80 next hand\./)
  const top = sngFormat(SNG_TURBO.levels, 200)
  assert.deepEqual(top, { type: 'sng', level: 8, handsLeftAtLevel: 0 })
  assert.match(renderPrompt({ ...v, game: top }, buildMenu(v)), /This is the top level; the blinds stay here\./)
  assert.match(SNG_INSTRUCTIONS, /sit-and-go tournament/)
  assert.equal(/cash game/i.test(SNG_INSTRUCTIONS), false)
  assert.equal(/cash game/i.test(renderPrompt(v, buildMenu(v), 'Be tight.')), false)
  // Only human-visible facts: no odds, equity or strength words sneak in with the format.
  assert.equal(/odds|equity|strength|probab/i.test(JSON.stringify(v.game) + p.split('\n')[0]), false)
})

// ── table talk: no naming your own cards, in codes or in words ──────────────

test('cleanTableTalk drops lines that name own hole ranks in words, but allows board ranks', () => {
  const kk = { hole: ['Kh', 'Kd'] as Card[], board: [] as Card[] }
  assert.equal(cleanTableTalk('Kings again, folks.', kk), undefined)
  assert.equal(cleanTableTalk('Cowboys ride tonight', kk), undefined)
  assert.equal(cleanTableTalk('I have the Kh', kk), undefined)
  assert.equal(cleanTableTalk('Love a big pair of KK', kk), undefined)
  assert.equal(cleanTableTalk('Let\'s see a flop.', kk), 'Let\'s see a flop.')
  assert.equal(cleanTableTalk('As if you have it.', kk), 'As if you have it.', '"As" is a word, not the ace of spades')
  const jj = { hole: ['Jc', 'Js'] as Card[], board: ['2h', '7d', '9c'] as Card[] }
  assert.equal(cleanTableTalk('Pocket jacks, baby', jj), undefined)
  const fours = { hole: ['4c', '4s'] as Card[], board: ['Kh', '7d', '2c'] as Card[] }
  assert.equal(cleanTableTalk('Set of fours would be nice', fours), undefined)
  assert.equal(cleanTableTalk('Fours full!', fours), undefined)
  assert.equal(cleanTableTalk('Nothing like pocket 4s', fours), undefined)
  assert.equal(cleanTableTalk('Ten-four, good buddy', fours), undefined, 'hyphenated hand in words')
  assert.equal(cleanTableTalk('Nine-seven suited is my favorite', { hole: ['9h', '7h'], board: [] }), undefined)
  assert.equal(cleanTableTalk('Time for a four-bet.', fours), 'Time for a four-bet.', 'counting words pass')
  assert.equal(cleanTableTalk('Two pair beats one, friend.', { hole: ['2c', '9s'], board: [] }), 'Two pair beats one, friend.')
  assert.equal(cleanTableTalk('That king on the flop scares me.', fours), 'That king on the flop scares me.', 'K is on the board')
  assert.equal(cleanTableTalk('45 chips? Sure.', fours), '45 chips? Sure.')
  const ak = { hole: ['Ah', 'Kh'] as Card[], board: ['2h', '7h', '9c'] as Card[] }
  assert.equal(cleanTableTalk('AK suited never misses', ak), undefined)
  assert.equal(cleanTableTalk('Ace-high and proud', ak), undefined)
  assert.equal(cleanTableTalk('Heart flush coming', ak), undefined)
  assert.equal(cleanTableTalk('Chasing the flush in hearts', ak), undefined)
  assert.equal(cleanTableTalk('Two hearts out there, careful.', ak), 'Two hearts out there, careful.', 'suit talk without a flush/draw phrase passes')
  assert.equal(cleanTableTalk('Spade flush? Not me.', ak), 'Spade flush? Not me.', 'no spades in hand')
  const boardFlush = { hole: ['Ah', 'Kc'] as Card[], board: ['2h', '7h', '9h', 'Jh', '3h'] as Card[] }
  assert.equal(cleanTableTalk('Heart flush on board, chop it up', boardFlush), 'Heart flush on board, chop it up', 'the board already shows it')
})

test('recentTalk: a seat\'s own last lines, most recently used last, so habits stay in the window', () => {
  const said = ['Your move.', 'a', 'b', 'c', 'd', 'e', 'f', 'Your move.']
  assert.deepEqual(recentTalk(said), ['c', 'd', 'e', 'f', 'Your move.'])
  assert.deepEqual(recentTalk(['x', 'x', 'x']), ['x'])
  assert.equal(recentTalk(Array.from({ length: 20 }, (_, i) => `line ${i}`)).length, 5)
  assert.deepEqual(recentTalk([]), [])
})
