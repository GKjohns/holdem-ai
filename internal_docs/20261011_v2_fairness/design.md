# v2 experiment design (written before the Study A spend)

**Budget:** $40 of key spend for Phases 3–4, starting from $35.86 on the key, so the hard stop is $75.86. Phase 3 (probes + a cheap sanity match) used $1.85.

## What a decision costs in v2 (measured in Phase 3, `bench/v2probe.ts` + `data/runs/20261011_v2_sanity_cheap.jsonl`)

| Model | $/decision | Latency (mean) | Notes |
|---|---|---|---|
| Claude Fable 5.1 | ≈ $0.018 cached, $0.05–0.075 when a memory block is rewritten; ≈ $0.023 blended | 3–5 s | ~5,000 prompt tokens (Anthropic tokenizer), ~4,000 of them read from cache at 2.5% of input |
| Claude Opus 5.5 | ≈ $0.007 cached; ≈ $0.009 blended | ~3 s | same layout, cache reads at 5% |
| GPT-6 Sol | ≈ $0.007–0.011 | 1.6–3.2 s | ~3,700 tokens. GPT-6 never reads its cache through the gateway, so every token is billed as a cache write |
| GPT-6 Luna / Claude Haiku 5.5 | ≈ $0.0005 | 2.5–3.3 s | |
| Luna Decisions / Jev | ≈ $0.0003 / $0.0002 | 0.3 s | |

A seat makes ≈ 100 decisions per tournament, whatever the table size. In the sanity match, 4-handed tournaments ran 35–57 hands to a natural finish with ≈ 100 decisions per seat. So the price of a design is set by **how many expensive-seat tournaments it buys**. Fable is ≈ $2.5 per seat-tournament, Opus and Sol ≈ $1.0 each, and the cheap seats ≈ $0.05.

## Options priced

| Design | $/match | Matches in ~$25 | What it answers |
|---|---|---|---|
| One 6-max table with Sol, Opus, Fable + 3 cheap (one entrant sits out) | ≈ $28 | <1 | everything, but less than one complete match |
| 3-max heavyweight table (Sol, Opus, Fable) | ≈ $13 | ~2 | heavyweights vs each other only, 3-handed (a different game), no cheap field |
| Lower effort for everyone | — | — | doesn't help: output is already ~100 tokens at `low`, and input dominates |
| **Guest-seat duplicate (chosen)** | Sol ≈ $6, Opus ≈ $6, Fable ≈ $13.5 | 1 each | each frontier model against the identical field on identical cards |

## Chosen: guest-seat duplicate, one seed

Three 5-max tables share **one deck seed and one seat order**. Each table is `[guest, Claude Haiku 5.5, GPT-6 Luna, GPT-6 Luna Decisions, Jev]`, and the guest is GPT-6 Sol, Claude Opus 5.5 or Claude Fable 5.1. Each table plays one full duplicate match: 5 rotations, so every seat plays every seat's cards. Because the guest has the same lineup index on every table, in rotation *r* each guest sits in the same seat, holds the same cards and faces the same four opponents in the same seats. Comparing guests across tables is duplicate in the bridge sense: card luck and opponent mix both cancel, and what's left is how each guest plays (plus how the field reacts to it).

- **Why this and not one big table:** it's the only design where Opus and Fable each get a complete duplicate match for the money, under conditions identical to Sol's. The Sol table is exactly the v1 B3 lineup and seat order, and it uses v1's base seed (20261010). So m01 deals the **same decks** v1 dealt, and v1 → v2 can be compared on identical cards. The cheap field plays 15 tournaments, enough to recheck the v1 findings about Haiku, Luna and Jev.
- **What it gives up:** the three frontier models never sit together, so there's no direct head-to-head chip flow between them. A 3-max table would have bought ~2 matches of that, 3-handed and with no field.
- **Structure:** `SNG_V2`: 1,500 chips, 10/20, doubling every 10 hands, no hand limit (safety cap 250), payouts 50/30/20. Every LLM at reasoning `low`, 60 s per call (watchdog 75 s), v2 seat information.

## Expected precision (stated before spending)

From v1 B3, a model's bb/100 has a per-tournament SD of 100–500 and a per-match SD (5 duplicate rotations) of 40–60. With **one match per guest**:

- A guest's bb/100: 95% CI ≈ **±110** (rotation bootstrap, which is wide and slightly optimistic with n = 5).
- Guest vs guest (paired by rotation, same cards): ≈ **±100–130**. Only gaps above ~100 bb/100 will separate. v1's Sol-vs-field gaps were 80–140, so a Sol-sized edge is detectable and a 30-point gap isn't.
- Prize share (the stated objective, 50/30/20, field average 20%): ≈ **±18 points** per guest.
- The cheap seats pool 15 tournaments over 3 tables: ≈ ±50–60 bb/100.

Because the expensive models can't be separated tightly at this budget, the report gives each number with its interval and says plainly when it is noise.

## Study B (persona tournament): planned

A persona table needs ≥ 3 complete matches of 6 seats (18 tournaments) to say anything. That's 108 seat-tournaments: about $270 on Fable, $110 on Opus or Sol, and about $5 on Luna or Haiku. So unless Study A finds a cheap model clearly strongest, B's base model is **the stronger of the two cheap LLMs in Study A**, chosen with that cost justification. It plays 5 personas + 1 no-persona control, with duplicate rotation.

## Gate (as in B3)

Pilot: the Sol table's match, run with `--budget 4`. It halts cleanly at $4, and anything it finished counts toward the full run (resumable from cache). Pass = 0 fallbacks, chips conserved in every hand, metered cost within 1.3× of the estimate above, and prompts read sane (memory, eliminations and payouts present; no derived info).
