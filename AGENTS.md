# Agent notes

- Nuxt 4 app at the repo root (no `src/`, no DB, no auth). Nuxt UI v4, Tailwind v4, `ai@7` through the Vercel AI Gateway on `AI_GATEWAY_API_KEY`. Node 22.
- Commands: `npm run dev`, `npm test` (`node --test tests/*.test.ts`), `npm run lint`, `npm run typecheck`.

## Rules

- **The engine is pure.** `shared/utils/*.ts` and `app/utils/reveal.ts` / `app/utils/session.ts` have no Nuxt or Vue imports and import each other by relative path with the `.ts` extension, so `node --test` and `bench/*.ts` run them under bare Node. `server/utils/decide.ts` follows the same rule.
- **Models see only `seatView()`.** It strips other seats' hole cards. Never send a model odds, equity or hand strength. New fields on `SeatView` must be things a human in the seat could see; add them to `shared/utils/types.ts`, `seatView()` in `shared/utils/table.ts`, the zod schema in `server/api/decide.post.ts`, the prompt and JSON in `server/utils/decide.ts`, and `tests/` together.
- **Information hygiene in the UI.** With a human seated, reasoning, probabilities and AI hole cards stay out of the DOM until `street === 'complete'`. `app/utils/reveal.ts` is the gate; `tests/reveal.test.ts` covers it.
- **The narrator** (`server/utils/narrate.ts`, same purity rule) gets god-view hand histories, `stats.ts` numbers and engine hand names, but only for **completed** hands (`canNarrate()` in `app/utils/reveal.ts`), and it never sits at the table. Stats are recomputed server-side from the hands; the model only interprets them. None of this ever reaches `/api/decide`.
- **Model calls** (`server/utils/decide.ts`, and `narrate.ts` with 45 s / 60 s timeouts and reasoning `'low'`): 30 s abort timeout and `maxRetries: 1` on every call. In `decide()` one `bounded()` deadline covers the whole attempt (SDK retry and the refusal re-ask included) and races the promise, so a path that ignores the signal still returns; `tests/decide.test.ts` proves it with hanging mock models. Timers are monotonic and pause while the Mac sleeps, so a timeout whose wall time exceeds its awake time by > 5 s is asked once more (`retriedAfterSleep`). A decision model whose `choice` isn't its own top probability (the SDK rejects these) keeps its choice with `choiceNotTop: true`, at 0 logged tokens; never send `temperature`; `maxOutputTokens: 4000` for language models; set `reasoning` explicitly for OpenAI models (GPT-6 has no `'minimal'`, use `'none'`); `providerOptions.gateway.caching: 'auto'`. Errors and timeouts return a fallback `Decision`, never throw. Add models in `shared/utils/models.ts` and their prices in `shared/utils/pricing.ts`.
- **The key.** `.env` holds a dedicated gateway key with a spend quota. Never print, copy or commit it, and don't swap in another project's key.
- Visual language: warm paper, sage felt, vendor series colors (`--series-*` in `app/assets/css/main.css`), Fraunces for numerals, Geist for UI. Nuxt UI primitives first; the felt, seats and cards are the only custom markup.

## Session logs (`data/sessions/<sessionId>.jsonl`)

Every table writes one JSONL file through `POST /api/log` (`server/api/log.post.ts`, zod-validated, append-only). `data/` is gitignored. The client posts fire-and-forget with one retry (`app/utils/persist.ts`), so a line can be missing but never blocks play. Read these files in B3/B5; don't add a database.

Every line has `type`, `source: 'casual'` (spectator/play sessions, not duplicate-seeded; exclude from CIs), `sessionId`, `ts` (ISO), `mode` (`'play' | 'watch'`).

- **`session_start`**: `seats: { id, name, modelId | null }[]` (the human is `id: 'you'`, `modelId: null`), `config: { stacks: Record<seatId, number>, smallBlind, bigBlind, seed }`.
- **`hand`** (one per completed hand, posted the moment it completes): `handNo`, `seed` (session seed; the deck is `seed ^ handNo·φ`), `button` (seat index), `seats`, `holes: Record<seatId, Card[]>` (god view, every seat; `[]` = sat out busted), `board`, `blinds` (text, blinds aren't log events), `log: ActionEvent[]`, `actionLabels: string[]` (engine text per log index), `decisions: { handNo, seatId, street, logIndex, decision: Decision }[]` (full `Decision`: `menuId`, `action`, `reasoning`, `tableTalk`, `probabilities`, `fallback`, `requested`, `retried`, `model`, `latencyMs`, `usage`), `result: { pots, shown, deltas }`, `stacksAfter: Record<seatId, number>`.
- **`session_end`**: `hands`, `reason` (`null` = left the table; `'busted' | 'cleaned' | 'finished'`), `costUsd`, `stacks`, `stats: SeatStats[]` (`shared/utils/stats.ts`). Leaving and then sitting back down writes another `session_end`; take the last one. JSON has no `Infinity`, so an `af` of `null` can mean "aggressive, never called"; use `stats[].counts` (or recompute).

- **`narration`** (one per narrated hand, whenever it lands): `handNo`, `narration: { handNo, headline, playByPlay, keyMoment: { seatId, street, why }, model, latencyMs, usage }`. These lines can land after later `hand` lines. Narrator cost = `pricing.ts` × `usage`.
- **`scouting_report`** (after `session_end`, when the report is written): `hands`, `report: { overview, seats: { seatId, styleLabel, tendencies[], signatureHand: { handNo, why }, howToBeat, voice }[], stats: SeatStats[], model, latencyMs, usage }`, `markdown`. The server also writes `data/sessions/<sessionId>_scouting.md` (the latest report wins). `session_end` gains `narratorCostUsd` (included in `costUsd`).

To run `seatStats()` over a file, spread `result` into each hand line: `hands.map(l => ({ ...l, ...l.result }))`. Decisions that say `Client fallback: …` were network failures on the client, not model choices.

## Resume after reload

`/play` is client-only (`routeRules` in `nuxt.config.ts`) and restores a localStorage snapshot (`holdem-ai:table`: session id, lineup, `TableState`, history, decisions, pace, cap, and optional `narrations` / `narratorOn`) written after every action. A reload or HMR resumes silently and re-requests an AI turn that was in flight (`beforeunload` aborts it first so it isn't logged as a fallback). Setup ("Deal me in" / "Start the table") and the session summary (Leave, bust, cap, finish) clear it. A debug URL resumes only a snapshot with the same mode and seats.

## Batch runs (`data/runs/<slug>.jsonl`, B3)

`bench/tournament.ts` plays duplicate-seeded sit-and-gos headless (engine + `decide()` directly, narrator off) and writes one JSONL per run; `shared/utils/runs.ts` has the types and `parseRun()`, and `server/utils/results.ts` turns a run into the `/results` numbers (also usable from a B5 notebook under bare Node). Every line has `type`, `source: 'batch'`, `runId` (= slug), `ts`.

- **`run_start`** (once): `lineup` (model ids, rotation 0 seat order), `format: 'sng' | 'cash'`, `tournament: { stack, levels: {sb, bb, hands}[], maxHands }`, `baseSeed`, `fake`, `narrator: false`.
- **`hand`**: the session `hand` line (same `handNo`, `seed`, `button`, `seats` (now with `modelId` per seat), `holes` (god view), `board`, `blinds`, `log`, `actionLabels`, `result`, `stacksAfter`) plus `sessionId` = `tournamentId`, `mode: 'batch'`, `matchId` (`m01`…), `tournamentId` (`m01-r0`…), `rotation`, `level` (0-based), `smallBlind`, `bigBlind`, `stacksBefore`, `busts` (`{ seatId, place, bustHand, stack }[]`, seats that went to 0 this hand), optional `engineErrors`. **`decisions[]` entries also carry `view`: the exact `SeatView` sent to the model** (including `priorTableTalk`), next to the full `Decision`.
- **`tournament`** (when one ends): `matchId`, `tournamentId`, `rotation`, `seed`, `seats`, `hands`, `reason: 'finished' | 'hand_cap'`, `finish` (best first: `{ seatId, modelId, name, place, bustHand, stack }`; simultaneous busts place the bigger starting stack higher, equal stacks share the place; survivors at the cap are placed by stack), `costUsd`, `decisions`, `fallbacks`, `retried`, `engineErrors`, `chipsConserved`, `wallMs`.
- **`run_end`** (one per invocation; take the last): `status: 'complete' | 'budget' | 'interrupted' | 'errors'`, `spentUsd` (live calls this invocation), `liveDecisions`, `replayedDecisions`, `tournamentsDone`, `tournamentsPlanned`.
- **`scouting_report`** (with `--scout`): `sampleTournamentId`, `report` (a B2 `ScoutingReport`; seat ids are the sample tournament's, stats span every hand of the run), `markdown`; also `data/runs/<slug>_scouting.md`.

Rules for readers: hands of a tournament with no `tournament` line are in progress; CIs use only **complete matches** (all rotations of a seed). A rotation puts `lineup[(i + r) % n]` in seat `i`; the deck for hand k depends only on `(seed, k)`. bb/100 divides each hand's chip delta by that hand's big blind. `<slug>.cache.jsonl` is the decision cache that makes reruns free (`{ key: 'tournamentId|handNo|logIndex', viewHash, decision }`); don't analyze it, the run file has everything. A rerun with the same slug compacts away unfinished tournaments' hand lines and replays them from the cache.
