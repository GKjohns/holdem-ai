# Agent notes

- Nuxt 4 app at the repo root (no `src/`, no DB, no auth). Nuxt UI v4, Tailwind v4, `ai@7` through the Vercel AI Gateway on `AI_GATEWAY_API_KEY`. Node 22.
- Commands: `npm run dev`, `npm test` (`node --test tests/*.test.ts`), `npm run lint`, `npm run typecheck`.

## Rules

- **The engine is pure.** `shared/utils/*.ts` and `app/utils/reveal.ts` / `app/utils/session.ts` have no Nuxt or Vue imports and import each other by relative path with the `.ts` extension, so `node --test` and `bench/*.ts` run them under bare Node. `server/utils/decide.ts` follows the same rule.
- **Models see only `seatView()`.** It strips other seats' hole cards. Never send a model odds, equity or hand strength. New fields on `SeatView` must be things a human in the seat could see; add them to `shared/utils/types.ts`, `seatView()` in `shared/utils/table.ts`, the zod schema in `server/api/decide.post.ts`, the prompt and JSON in `server/utils/decide.ts`, and `tests/` together.
- **Information hygiene in the UI.** With a human seated, reasoning, probabilities and AI hole cards stay out of the DOM until `street === 'complete'`. `app/utils/reveal.ts` is the gate; `tests/reveal.test.ts` covers it.
- **Model calls** (all in `server/utils/decide.ts`): 30 s abort timeout and `maxRetries: 1` on every call; never send `temperature`; `maxOutputTokens: 4000` for language models; set `reasoning` explicitly for OpenAI models (GPT-6 has no `'minimal'`, use `'none'`); `providerOptions.gateway.caching: 'auto'`. Errors and timeouts return a fallback `Decision`, never throw. Add models in `shared/utils/models.ts` and their prices in `shared/utils/pricing.ts`.
- **The key.** `.env` holds a dedicated gateway key with a spend quota. Never print, copy or commit it, and don't swap in another project's key.
- Visual language: warm paper, sage felt, vendor series colors (`--series-*` in `app/assets/css/main.css`), Fraunces for numerals, Geist for UI. Nuxt UI primitives first; the felt, seats and cards are the only custom markup.

## Session logs (`data/sessions/<sessionId>.jsonl`)

Every table writes one JSONL file through `POST /api/log` (`server/api/log.post.ts`, zod-validated, append-only). `data/` is gitignored. The client posts fire-and-forget with one retry (`app/utils/persist.ts`), so a line can be missing but never blocks play. Read these files in B3/B5; don't add a database.

Every line has `type`, `source: 'casual'` (spectator/play sessions, not duplicate-seeded; exclude from CIs), `sessionId`, `ts` (ISO), `mode` (`'play' | 'watch'`).

- **`session_start`**: `seats: { id, name, modelId | null }[]` (the human is `id: 'you'`, `modelId: null`), `config: { stacks: Record<seatId, number>, smallBlind, bigBlind, seed }`.
- **`hand`** (one per completed hand, posted the moment it completes): `handNo`, `seed` (session seed; the deck is `seed ^ handNo·φ`), `button` (seat index), `seats`, `holes: Record<seatId, Card[]>` (god view, every seat; `[]` = sat out busted), `board`, `blinds` (text, blinds aren't log events), `log: ActionEvent[]`, `actionLabels: string[]` (engine text per log index), `decisions: { handNo, seatId, street, logIndex, decision: Decision }[]` (full `Decision`: `menuId`, `action`, `reasoning`, `tableTalk`, `probabilities`, `fallback`, `requested`, `retried`, `model`, `latencyMs`, `usage`), `result: { pots, shown, deltas }`, `stacksAfter: Record<seatId, number>`.
- **`session_end`**: `hands`, `reason` (`null` = left the table; `'busted' | 'cleaned' | 'finished'`), `costUsd`, `stacks`, `stats: SeatStats[]` (`shared/utils/stats.ts`). Leaving and then sitting back down writes another `session_end`; take the last one. JSON has no `Infinity`, so an `af` of `null` can mean "aggressive, never called"; use `stats[].counts` (or recompute).

To run `seatStats()` over a file, spread `result` into each hand line: `hands.map(l => ({ ...l, ...l.result }))`. Decisions that say `Client fallback: …` were network failures on the client, not model choices.

## Resume after reload

`/play` is client-only (`routeRules` in `nuxt.config.ts`) and restores a localStorage snapshot (`holdem-ai:table`: session id, lineup, `TableState`, history, decisions, pace, cap) written after every action. A reload or HMR resumes silently and re-requests an AI turn that was in flight (`beforeunload` aborts it first so it isn't logged as a fallback). Setup ("Deal me in" / "Start the table") and the session summary (Leave, bust, cap, finish) clear it. A debug URL resumes only a snapshot with the same mode and seats.
