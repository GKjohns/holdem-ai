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

/** Chart series color: like seatColor, but the human gets its own hue (primary collides with OpenAI). */
export function chartColor(modelId: string | null): string {
  return modelId ? seatColor(modelId) : 'var(--series-human)'
}

/** Line dash per seat: the 2nd seat sharing a hue is dashed, the 3rd dotted. */
export function chartDashes(seats: { id: string, modelId: string | null }[]): Record<string, string | undefined> {
  const seen = new Map<string, number>()
  const PATTERNS = [undefined, '5 3', '1.5 3', '8 3 1.5 3']
  return Object.fromEntries(seats.map((s) => {
    const c = chartColor(s.modelId)
    const n = seen.get(c) ?? 0
    seen.set(c, n + 1)
    return [s.id, PATTERNS[n % PATTERNS.length]]
  }))
}
