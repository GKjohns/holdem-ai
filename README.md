# Hold'em AI

No-limit Texas Hold'em against a table of AI models. Sit down with one to five opponents, play hands, and once each hand is over see how every model reasoned: language models explain themselves in prose, decision models show the probability they put on each option. Or skip the seat and watch an all-AI table play itself.

Built with Nuxt 4, Nuxt UI v4 and the Vercel AI SDK (`ai@7`), routed through the Vercel AI Gateway on one key. Local dev only for now.

## The roster

| Seat | Model id | Kind | Reasoning effort |
|---|---|---|---|
| GPT-6 Sol | `openai/gpt-6-sol` | language model | low |
| GPT-6 Astra | `openai/gpt-6-astra` | language model | low |
| GPT-6 Luna | `openai/gpt-6-luna` | language model | none |
| Claude Opus 5.5 | `anthropic/claude-opus-5.5` | language model | low |
| Claude Sonnet 5.5 | `anthropic/claude-sonnet-5.5` | language model | low |
| Claude Haiku 5.5 | `anthropic/claude-haiku-5.5` | language model | low |
| Gemini 3.1 Pro | `google/gemini-3.1-pro-preview` | language model | low |
| GPT-6 Luna Decisions | `openai/gpt-6-luna-decisions` | decision model | default |
| Jev | `typesafe-ai/jev` | decision model | — |

The list lives in `shared/utils/models.ts`; prices per token in `shared/utils/pricing.ts`.

## How the two kinds of model decide

Every seat sees only what a human in that chair would: its own two cards, the board, every stack and bet, who sits where (seat order and positions), the action so far, and a menu of legal options with exact chip amounts ("Raise to 250, raising by the size of the pot (pot becomes 400)"). Nobody gets odds, equity or hand strength. Working that out is the model's job.

- **Language models** get the seat rendered as text and answer with structured output: `{ reasoning, tableTalk, choice }`. The reasoning is shown after the hand; table talk is said out loud at the table (trimmed to 80 characters, and dropped if it names the speaker's cards).
- **Decision models** (Luna Decisions, Jev) get the same facts as JSON and answer one typed choice question over the menu through `experimental_decide`. They return a choice plus a probability per option, in about 300 ms, with no prose.

A model error, timeout (30 s) or illegal pick falls back to check-if-free-else-fold and is flagged in the UI.

## In the app

- **Play**: you plus 1–5 AIs. Reasoning and probabilities stay sealed until the hand ends, then a per-seat hand review opens.
- **Watch**: 2–6 AIs and no human, so every card and every thought is live. Pace: Pause, 1×, 4×, Max.
- The side panel has three tabs: **Table talk** (live log, or the hand review), **Hands** (every finished hand: winner, board, chip swings, and the full log with reasoning), and **Chips** (stack-over-hands chart and current stacks).
- **Leave table**, or busting, opens a session summary: net chips, hands won, average decision time and gateway cost per seat.
- Debug URLs: `/play?stacks=100,500,1000,1000,1000` sets starting stacks, `?seats=jev,gpt-6-luna` picks opponents by id or id suffix, `?mode=watch` skips straight to an all-AI table.

## Code map

- `shared/utils/table.ts` — the pure NLHE engine: blinds, min-raise, short all-ins, side pots, run-outs, `seatView()` (the only thing sent to a model).
- `shared/utils/handRank.ts`, `cards.ts`, `menu.ts`, `types.ts`, `models.ts`, `pricing.ts`, `rng.ts` — hand ranking, deck, the shared action menu, contracts, roster, prices, seeded RNG.
- `server/utils/decide.ts` — both decider paths, prompts, timeouts, fallbacks. `server/api/decide.post.ts` validates the request and calls it.
- `app/composables/useTable.ts` — the client game loop, decision log and hand history. `app/pages/play.vue` and `app/components/` are the table UI.
- `app/utils/reveal.ts` — the one gate for what the UI may show mid-hand. `app/utils/session.ts` — summary and chart numbers.
- `bench/selfplay.ts` — all-AI self-play through the engine and `decide()` directly; `bench/latency.ts` — latency probe.
- `tests/` — engine, menu, prompt, reveal and session tests.

## Setup

```bash
nvm use 22
npm install
cp .env.example .env   # add AI_GATEWAY_API_KEY
npm run dev            # http://localhost:3000
```

```bash
npm test               # node --test, no build step
npm run lint
npm run typecheck
node --env-file=.env bench/selfplay.ts --hands 20   # cheap seats by default; prints cost
```

| Variable | Required | What |
|---|---|---|
| `AI_GATEWAY_API_KEY` | yes | Vercel AI Gateway key. Without it `/api/decide` returns 503 with a message saying so. |
