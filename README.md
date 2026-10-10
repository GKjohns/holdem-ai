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
- The side panel has four tabs: **Table talk** (live log, or the hand review), **Hands** (every finished hand: winner, board, chip swings, and the full log with reasoning), **Chips** (stack-over-hands chart and current stacks), and **Stats** (per seat: VPIP, PFR, aggression factor, went-to-showdown and won-at-showdown %, average decision time, cost). Stats are for you to read; no seated model ever sees them.
- The header shows what the session has cost so far ("$0.042 this session", from `pricing.ts` × tokens). Click it to set a session cap (default $2). At the cap, Watch pauses and Play holds AI turns, with a toast to raise the cap and resume.
- A reload resumes the table where it was. Every finished hand is also appended to `data/sessions/<sessionId>.jsonl` (gitignored; schema in `AGENTS.md`).
- **The Booth** (narrator, default Claude Sonnet 5.5): after each hand ends, a headline, a short play-by-play and the key moment are pinned at the top of Table talk and shown in the Hands tab. It gets the god view, but only of finished hands, so in Play mode nothing reaches it mid-hand. A switch in the Booth row turns it off. It costs about $0.01 a hand and counts toward the session cap.
- **Leave table**, or busting, opens a session summary: net chips, hands won, average decision time and gateway cost per seat, a "Narrator" cost row, and a **scouting report** on each model (style, tendencies that each cite a stat or hand number, signature hand, how to beat it, table-talk voice) with Copy as Markdown. It's saved as `data/sessions/<id>_scouting.md`.
- Debug URLs: `/play?stacks=100,500,1000,1000,1000` sets starting stacks, `?seats=jev,gpt-6-luna` picks opponents by id or id suffix, `?mode=watch` skips straight to an all-AI table.

## Code map

- `shared/utils/table.ts` — the pure NLHE engine: blinds, min-raise, short all-ins, side pots, run-outs, `seatView()` (the only thing sent to a model).
- `shared/utils/handRank.ts`, `cards.ts`, `menu.ts`, `types.ts`, `models.ts`, `pricing.ts`, `rng.ts` — hand ranking, deck, the shared action menu, contracts, roster, prices, seeded RNG.
- `server/utils/decide.ts` — both decider paths, prompts, timeouts, fallbacks. `server/api/decide.post.ts` validates the request and calls it.
- `app/composables/useTable.ts` — the client game loop, decision log and hand history. `app/pages/play.vue` and `app/components/` are the table UI.
- `app/utils/reveal.ts` — the one gate for what the UI may show mid-hand. `app/utils/session.ts` — summary and chart numbers. `app/utils/persist.ts` — the resume snapshot and session log posts.
- `shared/utils/stats.ts` — per-seat VPIP, PFR, AF, WTSD, W$SD, latency and cost from hand history.
- `server/api/log.post.ts` — appends session log lines to `data/sessions/`.
- `server/utils/narrate.ts` — the Booth: hand narration and the scouting report (prompts, god-view hand rendering, notable-hand picker). `server/api/narrate.post.ts` and `server/api/scouting.post.ts` call it; `shared/utils/narration.ts` has the shared types, stat wording and markdown.
- `bench/selfplay.ts` — all-AI self-play through the engine and `decide()` directly; `bench/latency.ts` — latency probe.
- `tests/` — engine, menu, prompt, narrator, reveal, session and stats tests.

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
