import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderPrompt, tableState } from '../server/utils/decide.ts'
import { buildMenu } from '../shared/utils/menu.ts'
import { newTable, seatView, startHand } from '../shared/utils/table.ts'

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
