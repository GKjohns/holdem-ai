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
