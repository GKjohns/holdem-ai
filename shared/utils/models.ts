/**
 * Models that can take a seat. Bare `provider/model` strings resolve through
 * the Vercel AI Gateway when `AI_GATEWAY_API_KEY` is set.
 */
export type Reasoning = 'none' | 'low' | 'medium' | 'high'

export interface ModelOption {
  id: string
  label: string
  vendor: string
  /**
   * `llm`: chat model asked for structured `{ reasoning, tableTalk, choice }`.
   * `evaluation`: decision model (Luna Decisions, Jev) asked one typed choice
   * question over the action menu; answers with probabilities, no prose.
   */
  kind: 'llm' | 'evaluation'
  /**
   * ai@7 top-level reasoning effort. v2 policy (2026-10-11): **'low' for every
   * language model**. v1 ran Luna at 'none' (flat ~57 output tokens, i.e. no
   * thinking) while Sol, Haiku, Opus and Gemini ran 'low'; unequal effort is an
   * artifact. 'low' is the lowest level all of them support, what Sol won v1
   * with, and keeps Opus/Fable affordable. GPT-6 has no 'minimal'. Evaluation
   * models take no `reasoning`; Luna Decisions rejects
   * `providerOptions.openai.reasoningEffort` as unsupported, so it runs at its
   * default effort.
   */
  reasoning?: Reasoning
}

export const MODELS: ModelOption[] = [
  { id: 'openai/gpt-6-sol', label: 'GPT-6 Sol', vendor: 'OpenAI', kind: 'llm', reasoning: 'low' },
  { id: 'openai/gpt-6-astra', label: 'GPT-6 Astra', vendor: 'OpenAI', kind: 'llm', reasoning: 'low' },
  { id: 'openai/gpt-6-luna', label: 'GPT-6 Luna', vendor: 'OpenAI', kind: 'llm', reasoning: 'low' },
  { id: 'anthropic/claude-fable-5.1', label: 'Claude Fable 5.1', vendor: 'Anthropic', kind: 'llm', reasoning: 'low' },
  { id: 'anthropic/claude-opus-5.5', label: 'Claude Opus 5.5', vendor: 'Anthropic', kind: 'llm', reasoning: 'low' },
  { id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5', vendor: 'Anthropic', kind: 'llm', reasoning: 'low' },
  { id: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5', vendor: 'Anthropic', kind: 'llm', reasoning: 'low' },
  { id: 'google/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', vendor: 'Google', kind: 'llm', reasoning: 'low' },
  { id: 'openai/gpt-6-luna-decisions', label: 'GPT-6 Luna Decisions', vendor: 'OpenAI', kind: 'evaluation' },
  { id: 'typesafe-ai/jev', label: 'Jev', vendor: 'TypeSafe AI', kind: 'evaluation' }
]

/** Sol, Opus 5.5, Luna Decisions, Jev — 5-handed with the human. */
export const DEFAULT_LINEUP: string[] = [
  'openai/gpt-6-sol',
  'anthropic/claude-opus-5.5',
  'openai/gpt-6-luna-decisions',
  'typesafe-ai/jev'
]

export function findModel(value: unknown): ModelOption | undefined {
  return typeof value === 'string' ? MODELS.find(m => m.id === value) : undefined
}

/**
 * B4 Strategy Lab's researcher: writes strategy cards and memos from completed hands. In B4 it never
 * sat; v2 (2026-10-11) also seats it (it's in MODELS) so it gets a fair shake as a player.
 */
export const PLANNER_MODEL = { id: 'anthropic/claude-fable-5.1', label: 'Claude Fable 5.1', vendor: 'Anthropic', role: 'planner' as const }
