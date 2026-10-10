/**
 * USD per 1M tokens, from the gateway's /v1/models pricing on 2026-10-09
 * (base tier; cache discounts ignored, so costs here are a ceiling).
 * Decision models bill input only.
 */
export const PRICING: Record<string, { input: number, output: number }> = {
  'openai/gpt-6-sol': { input: 2, output: 10 },
  'openai/gpt-6-astra': { input: 10, output: 50 },
  'openai/gpt-6-luna': { input: 0.1, output: 0.5 },
  'anthropic/claude-opus-5.5': { input: 4, output: 20 },
  'anthropic/claude-sonnet-5.5': { input: 2, output: 10 },
  'anthropic/claude-haiku-5.5': { input: 0.1, output: 0.5 },
  'google/gemini-3.1-pro-preview': { input: 2, output: 12 },
  'openai/gpt-6-luna-decisions': { input: 0.1, output: 0 },
  'typesafe-ai/jev': { input: 0.042, output: 0 }
}

export function costUsd(modelId: string, usage: { input: number, output: number }): number {
  const p = PRICING[modelId]
  if (!p) return 0
  return (usage.input * p.input + usage.output * p.output) / 1_000_000
}
