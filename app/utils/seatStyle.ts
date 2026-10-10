import { findModel } from '~~/shared/utils/models'

const SERIES: Record<string, string> = {
  'OpenAI': 'var(--series-openai)',
  'Anthropic': 'var(--series-anthropic)',
  'Google': 'var(--series-google)',
  'TypeSafe AI': 'var(--series-eval)'
}

/** Series color for a seat: hue = vendor; the human is primary. */
export function seatColor(modelId: string | null): string {
  if (!modelId) return 'var(--ui-primary)'
  return SERIES[findModel(modelId)?.vendor ?? ''] ?? 'var(--ui-text-muted)'
}

export function kindLabel(modelId: string | null): string | null {
  const m = findModel(modelId)
  if (!m) return null
  return m.kind === 'llm' ? 'LLM' : 'Decision'
}

export function shortVendor(vendor: string): string {
  return vendor === 'TypeSafe AI' ? 'TypeSafe' : vendor
}
