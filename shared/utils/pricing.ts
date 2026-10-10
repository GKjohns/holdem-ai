/**
 * USD per 1M tokens, from the gateway's /v1/models pricing (base tier), checked again 2026-10-11.
 * Decision models bill input only. v2: cache reads and writes are priced when a decision logs them
 * (`usage.cacheRead` / `cacheWrite`, both included in `usage.input`); older logs have neither, so
 * they're priced at the plain input rate as before. GPT-6 through the gateway reports every prompt
 * as a cache write and never a read (measured 2026-10-11), which is why v1 metering ran ~1.1× this table.
 */
export const PRICING: Record<string, { input: number, output: number, cacheRead?: number, cacheWrite?: number }> = {
  'openai/gpt-6-sol': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'openai/gpt-6-astra': { input: 10, output: 50 },
  'openai/gpt-6-luna': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'anthropic/claude-opus-5.5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'anthropic/claude-sonnet-5.5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'anthropic/claude-haiku-5.5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'google/gemini-3.1-pro-preview': { input: 2, output: 12, cacheRead: 0.2 },
  'openai/gpt-6-luna-decisions': { input: 0.1, output: 0 },
  'typesafe-ai/jev': { input: 0.042, output: 0 },
  // B4 planner; seated too from v2. Confirmed in the gateway's /v1/models on 2026-10-09 and 2026-10-11.
  'anthropic/claude-fable-5.1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }
}

export function costUsd(modelId: string, usage: { input: number, output: number, cacheRead?: number, cacheWrite?: number }): number {
  const p = PRICING[modelId]
  if (!p) return 0
  const read = usage.cacheRead ?? 0
  const write = usage.cacheWrite ?? 0
  const plain = Math.max(0, usage.input - read - write)
  return (plain * p.input + read * (p.cacheRead ?? p.input) + write * (p.cacheWrite ?? p.input) + usage.output * p.output) / 1_000_000
}
