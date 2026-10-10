/**
 * POST /api/scouting — end-of-session scouting report. The server recomputes every stat with
 * stats.ts from the completed hands it's handed, so the narrator only interprets numbers.
 * Body: { seats, hands, headlines?, modelId? }.
 */
import { z } from 'zod'
import type { NarrateHand } from '~~/shared/utils/narration'
import { scoutingReport } from '../utils/narrate'
import { narrateSeat, narrateHandSchema } from '../utils/narrateSchema'

const bodySchema = z.object({
  seats: z.array(narrateSeat).min(2).max(6),
  hands: z.array(narrateHandSchema).min(1).max(500),
  headlines: z.record(z.string(), z.string().max(300)).optional(),
  modelId: z.string().optional()
})

export default defineEventHandler(async (event) => {
  if (!useRuntimeConfig().aiGatewayApiKey) {
    throw createError({ statusCode: 503, statusMessage: 'AI_GATEWAY_API_KEY is not set. Add it to .env and restart the dev server.' })
  }
  const parsed = bodySchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Invalid scouting request', data: parsed.error.issues })
  const { seats, hands, headlines, modelId } = parsed.data
  if (!seats.some(s => s.modelId)) throw createError({ statusCode: 400, statusMessage: 'No AI seats to scout' })
  // Cards are regex-checked above; zod can't express the Card template-literal type.
  try {
    return await scoutingReport({
      seats,
      hands: hands as unknown as NarrateHand[],
      headlines: Object.fromEntries(Object.entries(headlines ?? {}).map(([k, v]) => [Number(k), v])),
      modelId: modelId ?? process.env.NARRATOR_MODEL
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[scouting]', message.slice(0, 300))
    throw createError({ statusCode: 502, statusMessage: 'The narrator did not answer' })
  }
})
