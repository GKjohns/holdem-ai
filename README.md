# Hold'em AI

Seven AI models play No-Limit Texas Hold'em tournaments on identical cards, and you can watch them think or take a seat yourself.

**Read the write-up:** [AI poker night: what happened when seven AIs played Hold'em](https://www.kylejohnson.ai/blog/ai-poker-night). It has step-through hand replays and a [live table](https://www.kylejohnson.ai/blog/ai-poker-night#sit-in-yourself) you can watch or play at in the browser.

## What it is

A Nuxt 4 app and a set of headless benchmark scripts. Language models (GPT-6 Sol, Claude Opus 5.5, Claude Fable 5.1, GPT-6 Luna, Claude Haiku 5.5 and others) and decision models (GPT-6 Luna Decisions, Jev) sit at a full NLHE engine: blinds, min-raises, short all-ins, side pots, split pots, eliminations. Every model call goes through the [Vercel AI Gateway](https://vercel.com/ai-gateway) on one key, using the AI SDK (`ai@7`).

- **Language models** read the seat as text and answer `{ reasoning, tableTalk, choice }`. Their table talk is said out loud to the other seats.
- **Decision models** get the same facts as JSON and return a probability for every option on the menu, in about 0.3 s, with no prose.

## Headline results (v2)

Three guests (Sol, Opus, Fable) each played 10 tournaments against the same four regulars on the same decks, in the same seat. Prize share is the average slice of a 50/30/20 payout; an average player gets 20%.

| Seat | Tournaments | Prize share [95% CI] | Wins |
|---|---|---|---|
| GPT-6 Sol (guest) | 10 | 31% [17, 45] | 4 |
| Claude Opus 5.5 (guest) | 10 | 31% [15, 47] | 5 |
| GPT-6 Luna | 30 | 29% [21, 36] | 11 |
| Claude Haiku 5.5 | 30 | 22% [14, 30] | 9 |
| GPT-6 Luna Decisions | 30 | 17% [12, 22] | 1 |
| Claude Fable 5.1 (guest) | 10 | 14% [5, 23] | 0 |
| Jev | 30 | 7% [2, 11] | 0 |

- Sol and Opus can't be separated (paired difference 0 points [-26, +26]).
- Opus beat Fable by 17 points [+2, +32] on the same cards. Fable costs about 2.5x Opus per decision.
- Personas ("tight and patient", "loose and aggressive", ...) changed how Luna and Sol played and didn't beat a no-persona control on either model.
- Almost no reasoning weighed what an opponent said at the table.

Full numbers, intervals and caveats: [`internal_docs/20261011_v2_fairness/results.md`](internal_docs/20261011_v2_fairness/results.md).

## How fairness works

**A seat sees what a human in that chair would, and nothing computed.** That's its two cards (also spelled out in words), the board, every stack and bet, chips each player has in the pot, side pots, who still acts after it, the payouts and field size, who has busted, and a memory of the last 6 to 11 hands (every action, all table talk, every hand shown down, who won). The menu has exact chip amounts from 1/3 pot to 2x pot (1/3, 1/2, 3/4, pot, 1.5x, 2x), and language models can also raise to any amount. No odds, equity, hand names or opponent stats, ever. `seatView()` in `shared/utils/table.ts` is the only thing a model receives. Every language model runs at the same reasoning effort, `low`.

**Duplicate seeding cancels the cards.** A match is one deck seed replayed once per seat rotation, so every player plays every seat's cards (`shared/utils/duplicate.ts`). In the main study the three guest tables share seeds and seat order, so in any given tournament Sol, Opus and Fable held exactly the same cards against the same opponents. Guest-vs-guest comparisons are paired, bridge-style.

**Tournament format** (`SNG_V2` in `shared/utils/tournament.ts`): 1,500 chips, blinds 10/20 doubling every 10 hands, payouts 50/30/20, played until one player has every chip. There's a safety cap of 250 hands; no v2 tournament got near it (21 to 62 hands).

## Quick start

You need Node 22 and a Vercel AI Gateway key.

```bash
nvm use 22
npm install
cp .env.example .env   # set AI_GATEWAY_API_KEY
npm run dev            # http://localhost:3000
```

- **Play:** you plus 1 to 5 AIs. Their reasoning and probabilities stay sealed until the hand ends, then a per-seat review opens.
- **Watch:** 2 to 6 AIs and no human, with every card and every thought live. Pause, 1x, 4x or Max.

The header shows what the session has cost and enforces a session cap (default $2). A narrator ("the Booth", Claude Sonnet 5.5) writes a headline and play-by-play after each hand, about $0.01 a hand; you can switch it off.

```bash
npm test            # node --test, no build step
npm run lint
npm run typecheck
```

## Running a tournament or benchmark

Batch runs are headless: the engine plus `decide()` directly, no browser. Each run writes `data/runs/<slug>.jsonl` (gitignored) and shows up at `/results`.

```bash
# Price it first: simulated play x measured $/decision, no gateway calls
node --env-file=.env bench/tournament.ts --dry-run \
  --lineup openai/gpt-6-sol,anthropic/claude-haiku-5.5,openai/gpt-6-luna,openai/gpt-6-luna-decisions,typesafe-ai/jev \
  --matches 2 --slug my_run

# Run it, capped at $10 for the whole run
node --env-file=.env bench/tournament.ts --lineup ... --matches 2 --budget 10 --concurrency 4 --slug my_run
```

| Flag | Default | What |
|---|---|---|
| `--lineup` | four cheap seats | comma-separated model ids, seat order for rotation 0 |
| `--matches` | 1 | duplicate matches; each is one seed played once per rotation |
| `--budget` | 1 | USD cap for the whole run, across resumes; halts cleanly |
| `--concurrency` | 4 | tournaments in flight |
| `--seed` | 20261010 | base seed; the same seed deals the same decks |
| `--slug` | | run name and file name |
| `--dry-run` / `--fake` | | cost estimate only / full run with random deciders at $0 |

Runs are resumable and idempotent: every live decision is cached the moment it lands, so a killed run loses only in-flight calls and a rerun of a finished run costs $0. Run long batches under `caffeinate -ims` on a Mac.

Other scripts in `bench/`: `personas.ts --base openai/gpt-6-luna` (Study B persona table), `v2talk.ts` (table-talk claim test), `v2report.ts` and `v2allin.ts` (analysis), `lab.ts` (the v1 Strategy Lab), `selfplay.ts`, `latency.ts`.

**What things cost** (measured in v2 Study A, reasoning `low`): per seat per tournament, about $1.40 for Fable, $0.70 for Sol or Opus, and $0.01 to $0.04 for Luna, Haiku or the decision models. A 10-tournament guest table (2 matches, one guest plus four cheap seats) cost $6.91 with Opus, $7.82 with Sol and $14.82 with Fable. The 6-seat persona table cost about $0.85 per match on Luna and $14 per match on Sol. The whole v2 study came to about $79 of gateway spend.

> **Use a key with a spend quota.** Batch runs can make thousands of calls. Create a dedicated gateway key with a monthly quota (Vercel dashboard, AI Gateway, API keys) and set `--budget` on every run.

## Repo layout

```
app/              Nuxt UI: setup, /play (Play + Watch), /results, /lab
server/api/       decide, narrate, scouting, log, results, lab endpoints
server/utils/     decide.ts (prompts, both model paths, timeouts, fallbacks), narrate.ts, results.ts, lab.ts
shared/utils/     the pure engine: table.ts (NLHE + seatView), handRank, menu, tournament, duplicate, models, pricing, stats
bench/            headless runners and analysis scripts
tests/            node --test suites for the engine, menu, prompts, reveal gate, stats
internal_docs/    plans, audits and results for each round of work (see internal_docs/README.md)
```

The engine in `shared/utils/` has no Nuxt or Vue imports, so tests and bench scripts run it under bare Node. `AGENTS.md` has the rules and the JSONL schemas.

The kylejohnson.ai post runs a vendored, modified copy of the engine and `decide()` in a separate repo; `bench/blog_export.ts` writes the post's replay and figure data. Changes here don't flow there automatically.

## Environment

| Variable | Required | What |
|---|---|---|
| `AI_GATEWAY_API_KEY` | yes | Vercel AI Gateway key. Without it `/api/decide` returns 503 saying so. |
| `NARRATOR_MODEL` | no | Override the Booth's model (default `anthropic/claude-sonnet-5.5`). |

## License

MIT. See [LICENSE](LICENSE). Built by [Kyle Johnson](https://www.kylejohnson.ai) with Nuxt, Nuxt UI and the Vercel AI SDK.
