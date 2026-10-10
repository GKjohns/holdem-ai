/** zod shapes for a completed hand as the client sends it to the Booth (loose: extra fields pass). */
import { z } from 'zod'

const card = z.string().regex(/^[2-9TJQKA][shdc]$/)
const chips = z.number().int().nonnegative()

export const narrateSeat = z.object({ id: z.string().max(40), name: z.string().max(80), modelId: z.string().nullable() })

export const narrateHandSchema = z.looseObject({
  handNo: z.number().int().positive(),
  board: z.array(card).max(5),
  button: z.number().int().nonnegative(),
  pots: z.array(z.looseObject({ amount: chips, eligible: z.array(z.string()), winners: z.array(z.string()), handName: z.string() })),
  shown: z.record(z.string(), z.looseObject({ cards: z.array(card), handName: z.string() })),
  deltas: z.record(z.string(), z.number()),
  stacksAfter: z.record(z.string(), chips),
  holes: z.record(z.string(), z.array(card).max(2)),
  log: z.array(z.looseObject({ seatId: z.string(), street: z.string(), added: chips })).max(300),
  actionLabels: z.array(z.string()),
  blindsNote: z.string(),
  decisions: z.array(z.looseObject({
    seatId: z.string(),
    street: z.string(),
    logIndex: z.number().int(),
    decision: z.looseObject({ model: z.string(), reasoning: z.string(), fallback: z.boolean() })
  }))
})
