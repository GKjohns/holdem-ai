/**
 * Information hygiene for the UI. Pure (no Nuxt imports) so tests/reveal.test.ts runs it under bare Node.
 * With a human seated, AI reasoning, probabilities and hole cards stay sealed until the hand is over;
 * an all-AI table (Watch mode) has nobody to leak to, so everything is live.
 */
export function canRevealReasoning(opts: { hasHuman: boolean, street: string }): boolean {
  return !opts.hasHuman || opts.street === 'complete'
}

/** The Booth gets the god view, so it narrates a hand only once it's complete, in every mode. */
export function canNarrate(opts: { street: string }): boolean {
  return opts.street === 'complete'
}

export function canShowHoleCards(opts: { hasHuman: boolean, seatIsHuman: boolean }): boolean {
  return !opts.hasHuman || opts.seatIsHuman
}
