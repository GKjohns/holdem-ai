/**
 * POST /api/log — append one JSONL line to data/sessions/<sessionId>.jsonl.
 * The client posts a session_start, one `hand` line per completed hand, and a
 * session_end. Line schema: AGENTS.md § Session logs.
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

const card = z.string().regex(/^[2-9TJQKA][shdc]$/)
const chips = z.number().int().nonnegative()
const base = {
  source: z.literal('casual'),
  sessionId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  ts: z.string(),
  mode: z.enum(['play', 'watch'])
}
const seat = z.object({ id: z.string(), name: z.string(), modelId: z.string().nullable() })

const lineSchema = z.discriminatedUnion('type', [
  z.looseObject({
    type: z.literal('session_start'),
    ...base,
    seats: z.array(seat).min(2).max(6),
    config: z.looseObject({ stacks: z.record(z.string(), chips), smallBlind: chips, bigBlind: chips, seed: z.number().int() })
  }),
  z.looseObject({
    type: z.literal('hand'),
    ...base,
    handNo: z.number().int().positive(),
    seed: z.number().int(),
    button: z.number().int().nonnegative(),
    seats: z.array(seat),
    holes: z.record(z.string(), z.array(card).max(2)),
    board: z.array(card).max(5),
    log: z.array(z.looseObject({ seatId: z.string(), street: z.string(), added: chips })),
    decisions: z.array(z.looseObject({ seatId: z.string(), street: z.string(), logIndex: z.number().int(), decision: z.looseObject({ model: z.string() }) })),
    result: z.looseObject({ pots: z.array(z.any()), shown: z.record(z.string(), z.any()), deltas: z.record(z.string(), z.number()) }),
    stacksAfter: z.record(z.string(), chips)
  }),
  z.looseObject({
    type: z.literal('session_end'),
    ...base,
    hands: z.number().int().nonnegative(),
    reason: z.string().nullable(),
    costUsd: z.number().nonnegative(),
    stats: z.array(z.looseObject({ seatId: z.string() }))
  })
])

const DIR = join(process.cwd(), 'data', 'sessions')

export default defineEventHandler(async (event) => {
  const parsed = lineSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Bad log line', data: z.treeifyError(parsed.error) })
  }
  const line = parsed.data
  await mkdir(DIR, { recursive: true })
  await appendFile(join(DIR, `${line.sessionId}.jsonl`), `${JSON.stringify(line)}\n`)
  return { ok: true }
})
