/**
 * POST /api/narrate — the Booth's take on one COMPLETED hand (god view). The client calls it
 * only once a hand is over, so in Play mode nothing reaches the narrator mid-hand.
 * Body: { seats, hand, modelId? }. A model error or timeout is a 502; the client shows
 * "the Booth missed this one" and play goes on.
 */
import { z } from 'zod'
import type { NarrateHand } from '~~/shared/utils/narration'
import { narrateHand } from '../utils/narrate'
import { narrateSeat, narrateHandSchema } from '../utils/narrateSchema'

const bodySchema = z.object({
  seats: z.array(narrateSeat).min(2).max(6),
  hand: narrateHandSchema,
  modelId: z.string().optional()
})

export default defineEventHandler(async (event) => {
  if (!useRuntimeConfig().aiGatewayApiKey) {
    throw createError({ statusCode: 503, statusMessage: 'AI_GATEWAY_API_KEY is not set. Add it to .env and restart the dev server.' })
  }
  const parsed = bodySchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Invalid narrate request', data: parsed.error.issues })
  const { seats, hand, modelId } = parsed.data
  // Cards are regex-checked above; zod can't express the Card template-literal type.
  try {
    return await narrateHand({ seats, hand: hand as unknown as NarrateHand, modelId: modelId ?? process.env.NARRATOR_MODEL })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[narrate] hand', hand.handNo, message.slice(0, 300))
    throw createError({ statusCode: 502, statusMessage: 'The narrator did not answer' })
  }
})
