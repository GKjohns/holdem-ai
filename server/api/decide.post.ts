/**
 * POST /api/decide — ask a seated model for its action. The menu is rebuilt
 * server-side from the view, and the decision logic lives in
 * `server/utils/decide.ts` so the self-play harness shares it. Model errors
 * and timeouts come back as 200 with `fallback: true`.
 */
import { z } from 'zod'
import type { SeatView } from '~~/shared/utils/types'
import { decide } from '../utils/decide'

const card = z.string().regex(/^[2-9TJQKA][shdc]$/)
const street = z.enum(['preflop', 'flop', 'turn', 'river', 'showdown', 'complete'])
const chips = z.number().int().nonnegative()
const action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('fold') }),
  z.object({ type: z.literal('check') }),
  z.object({ type: z.literal('call') }),
  z.object({ type: z.literal('raise'), to: chips }),
  z.object({ type: z.literal('all_in') })
])

const logEvent = z.object({
  seatId: z.string(),
  street,
  action,
  added: chips,
  raiseTo: chips.optional(),
  tableTalk: z.string().max(200).optional()
})

/** v2: a remembered hand (public events only). */
const pastHand = z.object({
  handNo: z.number().int().positive(),
  smallBlind: chips,
  bigBlind: chips,
  players: z.array(z.object({ id: z.string(), name: z.string(), stack: chips })).min(2).max(9),
  log: z.array(logEvent).max(200),
  board: z.array(card).max(5),
  shown: z.record(z.string(), z.array(card).length(2)),
  pots: z.array(z.object({ amount: chips, winners: z.array(z.string()) })).max(9),
  busted: z.array(z.string()).max(8)
})

const viewSchema = z.object({
  handNo: z.number().int().positive(),
  street,
  board: z.array(card).max(5),
  hole: z.array(card).length(2),
  me: z.object({ id: z.string(), name: z.string(), stack: chips, committed: chips, inPot: chips.optional() }),
  pot: chips,
  toCall: chips,
  minRaiseTo: chips,
  maxRaiseTo: chips,
  canRaise: z.boolean(),
  bigBlind: z.number().int().positive(),
  position: z.string(),
  opponents: z.array(z.object({
    id: z.string(),
    name: z.string(),
    stack: chips,
    committed: chips,
    folded: z.boolean(),
    allIn: z.boolean(),
    position: z.string().max(40).optional(),
    inPot: chips.optional()
  })).min(1).max(8),
  seatOrder: z.array(z.string()).max(9).optional(),
  priorTableTalk: z.array(z.string().max(200)).max(10).optional(),
  game: z.discriminatedUnion('type', [
    z.object({ type: z.literal('cash') }),
    z.object({
      type: z.literal('sng'),
      level: z.number().int().positive(),
      handsLeftAtLevel: chips,
      next: z.object({ smallBlind: z.number().int().positive(), bigBlind: z.number().int().positive() }).optional(),
      entrants: z.number().int().min(2).max(9).optional(),
      startingStack: chips.optional(),
      handsPerLevel: z.number().int().positive().optional(),
      payouts: z.array(z.number().nonnegative()).max(9).optional()
    })
  ]).optional(),
  log: z.array(logEvent).max(200),
  actingAfter: z.array(z.string()).max(8).optional(),
  pots: z.array(z.object({ amount: chips, eligible: z.array(z.string()).max(9) })).max(9).optional(),
  eliminated: z.array(z.object({ id: z.string(), name: z.string(), place: z.number().int().positive(), handNo: chips })).max(8).optional(),
  history: z.array(pastHand).max(20).optional(),
  myCards: z.array(z.object({ handNo: z.number().int().positive(), cards: z.array(card).length(2) })).max(20).optional()
})

const bodySchema = z.object({ modelId: z.string().min(1), view: viewSchema })

export default defineEventHandler(async (event) => {
  if (!useRuntimeConfig().aiGatewayApiKey) {
    throw createError({ statusCode: 503, statusMessage: 'AI_GATEWAY_API_KEY is not set. Add it to .env and restart the dev server.' })
  }
  const parsed = bodySchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid decide request', data: parsed.error.issues })
  }
  // Cards are regex-checked above; the schema just can't express the template-literal type.
  return decide({ modelId: parsed.data.modelId, view: parsed.data.view as SeatView })
})
