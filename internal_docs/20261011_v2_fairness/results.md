# Hold'em AI v2: results after the fairness fixes

**Date:** 2026-10-10/11 · **Read with:** [`audit.md`](./audit.md) (what was wrong), [`design.md`](./design.md) (design and expected precision, written before spending), `out/*.json` (machine-readable summaries)
**Data:** `data/runs/20261011_v2A_{sol,opus,fable}.jsonl` (Study A, 30 tournaments, 1,224 hands), `data/runs/20261011_v2B_luna.jsonl` (Study B, 30 tournaments, 1,414 hands), `data/runs/20261011_v2_sanity_cheap.jsonl` + `20261011_v2_probe.jsonl` (Phase 3). Numbers come from `bench/v2report.ts` and `bench/v2allin.ts`.

> **Data-quality audit (2026-10-12, [`data_quality.md`](./data_quality.md)):** I checked every v2 decision for truncation, fallbacks, timeouts, billing errors and engine errors. None of them was truncated: the highest output was 1,139 of the 8000-token cap, every reasoning string is complete, and there were 0 fallbacks and 0 timeouts. Fifteen live re-checks all finished with `finishReason: 'stop'`. Chips were conserved in every hand, and the Study A pairing checks out. **No rerun was needed, and every number below stands as written.** From now on, decisions also log `finishReason`, reasoning tokens and dropped table talk.

## What changed between v1 and v2

Seats now get what a human at the table has, and nothing derived:

- the last 6–11 hands (every action and bet, all table talk, every hand shown at showdown, who won), plus their own cards in those hands
- payouts (50/30/20) and field size, and who has busted in what place
- chips in the pot per player, side pots, and who still acts after them
- cards spelled out in words
- a menu from ⅓ pot to 2× pot, plus any amount for language models

Every LLM runs at reasoning `low` (Luna was `none`). Tournaments play to a natural finish: the 50-hand cap is gone, and every v2 tournament ended with one player holding all the chips, in 21–62 hands. The prompt cache now works for Claude models. 0 fallbacks in 23,178 v2 decisions (Study A, Study B and the sanity match).

## Study A: the main tournament

**Design: guest-seat duplicate.** Three 5-max tables, each `[guest, Haiku, Luna, Luna Decisions, Jev]`, with the guest = Sol, Opus or Fable. They share the same deck seeds and seat order, two seeds × 5 rotations, so 10 tournaments per table. In every rotation the three guests hold the same cards in the same seat against the same four opponents, which makes guest-vs-guest comparisons paired. Seed 1 is v1's seed, so the Sol table replays v1's match m01 decks. Why this design, its costs and the expected CI width (stated before spending: a single guest ±110 bb/100 and ±18 prize points per seed) are in `design.md`.

**Headline metric: prize share**, the payout the seats were told they were playing for (50/30/20; the field average is 20%). bb/100 is reported too, but it over-weights the first levels and short tournaments. Intervals are t-intervals (prize) or tournament bootstraps (bb/100) over n = 10 tournaments; with n this small, treat them as rough.

| Seat | Tournaments | Prize share | bb/100 | Avg finish | Wins |
|---|---|---|---|---|---|
| **GPT-6 Sol** (guest) | 10 | **31%** [17, 45] | +63 [−4, +130] | 2.2 | 4 |
| **Claude Opus 5.5** (guest) | 10 | **31%** [15, 47] | +221 [+36, +471] | 2.1 | 5 |
| GPT-6 Luna | 30 | 29% [21, 36] | +50 [−6, +101] | 2.4 | 11 |
| Claude Haiku 5.5 | 30 | 22% [14, 30] | −1 [−106, +83] | 3.1 | 9 |
| GPT-6 Luna Decisions | 30 | 17% [12, 22] | −13 [−56, +29] | 3.0 | 1 |
| **Claude Fable 5.1** (guest) | 10 | **14%** [5, 23] | −48 [−121, +2] | 3.3 | **0** |
| Jev | 30 | 7% [2, 11] | −146 [−204, −103] | 4.0 | 0 |

**Guests head to head (paired by seed and rotation, 10 pairs each):**

| Pair | Prize share difference | bb/100 difference |
|---|---|---|
| Sol − Opus | **0 pts** [−26, +26] | −158 [−348, +6] |
| Opus − Fable | **+17 pts** [+2, +32] | +268 [+113, +490] |
| Sol − Fable | +17 pts [−1, +35] | +110 [+25, +201] |

What the numbers support:

- **Sol and Opus are tied on what counts.** Same prize share (31%), and Opus wins one more tournament. Opus's huge bb/100 comes from a few fast wins: it won two seed-2 tournaments in 21 hands, when the blinds were still small, so its chips are worth more big blinds. The prize difference is 0 ± 26, so this budget can't separate them.
- **Fable finished last of the three guests, and it isn't luck.** It won 0 of 10 against the same cards and the same field on which Sol won 4 and Opus 5. Replacing every all-in runout with equity moves Fable by 0.6 bb/100 (Opus −19, Sol −12). Fable lost most of its chips to Haiku (−165 bb net), with Luna next. It often reached the 40/80+ levels short-stacked and then shoved marginal hands. Its individual plays read as sound: QQ shoved into AK, K7s shoved at 9 bb. The Opus-vs-Fable prize gap clears zero (+17 [+2, +32]); Sol-vs-Fable just misses (+17 [−1, +35]). With 10 tournaments that's suggestive, not settled. **The fair-shake answer:** given identical conditions, cards and memory, Opus plays as well as Sol and Fable plays worse. Fable also costs 2.5× as much per decision.
- **Jev is still last everywhere.** That's the one robust ranking (−146 [−204, −103] bb/100, 0 wins in 30).

## v1 → v2: which findings survived

Same definitions on both runs (`bench/v2report.ts`). v1 = B3 main (40 tournaments). v2 = Study A (30 tournaments).

| v1 finding | v2 | Verdict |
|---|---|---|
| **Sol wins, and not by luck** (+81 bb/100, the only CI clear of zero) | Sol ties Opus for first on prize share (31%); +63 bb/100 [−4, +130]; −12 bb/100 after the all-in adjustment | **Partly.** Sol is still top-tier, but no longer alone. Opus matches it, and Luna (29%) is close. |
| **Only Sol plays the format** (short-stack shove 32% vs 0–3%) | Sol 33%, Opus 37%, Fable 24%, **Luna 15%** (was 0.7%), Luna Decisions 5.5%, Jev 5.6%, Haiku 0% | **Mostly an artifact.** Told the payouts and given effort `low`, Luna and the Claude frontier models shove short. Haiku still never does (0 of 99). |
| **Luna folds winners on the river** (23 of 50 heads-up river folds) | 5 of 13; fold-to-river-bet 74% → 48% | **Largely an artifact of effort `none`.** At `low`, Luna is the best cheap seat (11 wins in 30). |
| **Haiku misreads its own hand** (49 of 77 set claims wrong, our regex) | **40 of 50 wrong**, e.g. "set of queens" with QQ on A-2-J (`opus m02-r3 #12`) | **Survived.** Spelling cards out in words didn't fix it. |
| **Haiku says its cards out loud** (204 lines) | Can't happen now: the B5 filter drops lines that name its cards in words | Fixed by the filter, not by Haiku |
| **Nobody reads table talk** (1 of 15,913 reasoning texts) | 0.1–0.8% of reasoning mentions talk, even with every line of the last 6–11 hands visible | **Survived.** Talk is still ignored. But models now use **history**: Fable cites past play in 14% of decisions, Haiku 16%, Opus 4% ("Luna Decisions folded to my 3-bet earlier"). Sol and Luna under 1%. |
| **Nobody overbets** (2× pot picked 26 times) | With ⅓, ¾, 1½× and any-amount sizes available, **zero** postflop overbets in Study A. Bets cluster at ⅓–½ pot | **Real, not the menu.** The models simply don't overbet. |
| **Jev pays everyone** | Last everywhere, −146 bb/100 | **Survived.** |
| **Half the tournaments ended at the cap** | 0 of 30 (plus 0 of 34 elsewhere in v2) | Fixed |

**On the same decks:** the Sol table's seed 1 replays v1's match m01. In v1, Sol won 3 of those 5 tournaments (+90 bb/100) and Haiku won 1 (−142). In v2, on the same five decks, Sol won 1 (+47) and Haiku won 3 (+34). Five tournaments is anecdote, but it shows how much of a single match's outcome depends on how the rest of the table plays, and the rest of the table changed.

## Cost and speed (Study A, measured)

| Model | Decisions | $/decision | Mean latency | p95 | Prompt tokens (cache reads) |
|---|---|---|---|---|---|
| Claude Fable 5.1 | 626 | **$0.0222** | 4.8 s | 6.9 s | 5,240 (3,808 read) |
| Claude Opus 5.5 | 697 | $0.0089 | 3.6 s | 6.4 s | 5,040 (3,683 read) |
| GPT-6 Sol | 783 | $0.0088 | 2.9 s | 4.6 s | 3,129 (no reads, all billed as cache writes) |
| GPT-6 Luna | 2,249 | $0.00048 | 3.8 s | 6.5 s | 3,168 |
| Claude Haiku 5.5 | 2,301 | $0.00029 | 2.4 s | 5.0 s | 5,157 (3,800 read) |
| Luna Decisions / Jev | 2,362 / 2,100 | $0.00024 / $0.00013 | 0.3 s | 0.5 s | 2,405 / 3,015 |

Without the cache fix, Fable would cost ≈ $0.06 and Opus ≈ $0.026 per decision. Fable cost $14.82 for its 10-tournament table, Opus $6.91 and Sol $7.82. 0 fallbacks and 0 timeouts at the 60 s limit; the slowest decision took 20.5 s (Fable).

## Study B: persona tournament

**Base model: GPT-6 Luna at reasoning `low`.** It was the best cheap seat in Study A (29% prize share, 11 of 30 wins). Opus or Sol were the stronger choice on paper, but a persona table needs several complete 6-seat matches, and that's ~$5 per tournament on Opus or Sol against ~$0.14 on Luna. Opus or Sol would have bought 2 tournaments, which can't rank 6 players. Luna bought **5 complete duplicate matches (30 tournaments, 1,414 hands)** for $4.21. Because Study A couldn't separate Sol from Opus anyway, cost decided it.

**Design:** 6-max, five personas plus one no-persona control, all GPT-6 Luna, under neutral aliases (Ash, Birch, Cedar, Elm, Hazel, Rowan), so nobody sees a persona name. Duplicate rotation means every persona plays every seat's cards. Personas (`bench/personas.ts`) are 70–90 words of style text each, with no numbers or odds, and ride in the seat part of the prompt.

| Persona | Prize share | vs control (prize pts) | bb/100 | vs control (bb/100) | Wins | VPIP / PFR | Talks | Cites history |
|---|---|---|---|---|---|---|---|---|
| No persona (control) | 18.7% [12, 25] | — | +1 [−15, +17] | — | 4 | 37 / 23 | 17% | 0.7% |
| Opponent reader | 17.3% [12, 23] | −1.3 [−9, +7] | +15 [−3, +32] | +13 [−25, +51] | 4 | 38 / 25 | 22% | **69%** |
| Loose and aggressive | 17.0% [10, 24] | −1.7 [−9, +6] | +10 [−17, +36] | +8 [−36, +53] | **8** | **50 / 40** | 35% | 0.7% |
| Deceptive talker | 17.0% [14, 20] | −1.7 [−10, +7] | +1 [−21, +26] | 0 [−59, +60] | 5 | 36 / 23 | **64%** | 0.8% |
| Tight and patient | 15.7% [1, 30] | −3.0 [−22, +16] | −13 [−36, +7] | −16 [−45, +13] | 5 | **25** / 18 | 10% | 0.2% |
| Math-first | 14.3% [10, 18] | −4.3 [−12, +3] | −14 [−34, +5] | −16 [−69, +37] | 4 | 33 / 22 | 12% | 0.3% |

Intervals are over the 5 complete matches (t for prize, bootstrap for bb/100). Leads vs the control are paired by match.

**What it says:** the personas changed how Luna played, and none of them changed how well it did. Tight played 25% of hands and aggressive 50%; the talker spoke on 64% of decisions and the reader cited history in 69%. But **no persona beat the no-persona control**: every lead interval spans zero, and the point estimates all sit within a few prize points of the 16.7% fair share. The loose-aggressive seat won the most tournaments (8 of 30) at the same average prize share, i.e. more volatile, not better. The all-in adjustment shuffles the bb/100 order (math-first ran +123 bb above its equity, the control −109), which is more evidence that what's left is noise.

**Did a stronger model change B4's answer?** B4 (Luna at effort `none`, no memory) found strategy cards indistinguishable from the control. v2 Luna is stronger (effort `low`, memory, payouts) and the answer is the same: within one model, an "approach" written as style guidance moves the style a lot and the result not at all, at least at 30 tournaments. The one persona built to use the new information, the reader, led on bb/100 (+13 vs the control) but not on prize share. This is consistent with Study A, where the history the models cited didn't translate into a measurable edge either. Whether a frontier model responds differently was tested on Sol afterwards (next section): it doesn't, at 3 matches.

## Study B with Sol (2026-10-12): personas on the best model

Kyle asked for the persona tournament to run on "the best model". Study A had Sol tied with Opus at the top, and Sol is the cheaper of the two, so this is the same persona table with **GPT-6 Sol at reasoning `low`**. It uses the same personas, aliases, structure and deck seeds as the Luna table, which makes m01–m03 the same decks Luna played. That's **3 complete duplicate matches: 18 tournaments, 822 hands and 5,830 decisions, for $42.3**. Data: `data/runs/20261012_v2B_sol.jsonl`, `out/personas_sol.json` and `out/personas_sol_raw.json`. Quality: 0 fallbacks, every decision finished with `finishReason: 'stop'`, the highest output was 533 tokens (reasoning p99 238), 0 lines of talk were dropped, and chips were conserved.

| Persona | Prize share | vs control (prize pts) | bb/100 | vs control (bb/100) | Wins | VPIP / PFR | Talks | Cites history |
|---|---|---|---|---|---|---|---|---|
| Loose and aggressive | **22.2%** [14, 31] | +1.1 [−26, +28] | +26 [+7, +58] | +15 [−7, +36] | 5 | **50 / 39** | 33% | 2.6% |
| No persona (control) | 21.1% [3, 40] | — | +12 [−3, +35] | — | **6** | 35 / 24 | 12% | 1.5% |
| Tight and patient | 15.6% [−4, 35] | −5.6 [−42, +31] | −17 [−50, 0] | −30 [−149, +89] | 1 | **23** / 17 | 8% | 0.9% |
| Math-first | 14.4% [3, 26] | −6.7 [−18, +4] | −16 [−20, −11] | −27 [−83, +28] | 1 | 33 / 21 | 5% | 0.5% |
| Deceptive talker | 13.9% [2, 26] | −7.2 [−37, +22] | +8 [−20, +30] | −4 [−116, +109] | 3 | 32 / 21 | **89%** | 1.3% |
| Opponent reader | 12.8% [−2, 27] | −8.3 [−27, +11] | −14 [−20, −2] | −25 [−88, +39] | 2 | 31 / 21 | 16% | **64%** |

The intervals are t-intervals over 3 matches (t = 4.30 at 2 degrees of freedom), so they're very wide. **This is underpowered:** it can detect only a persona effect bigger than about 25 prize points, and the Luna table's 5 matches were tighter.

**What it says:** the stronger model gives the same answer as Luna. **No persona beat the no-persona control on prize share.** Every lead interval spans zero, and four of the five point estimates sit *below* the control. The personas clearly changed Sol's style: tight played 23% of hands and aggressive 50%, the talker spoke on 89% of decisions, and the reader cited past hands in 64%. Sol followed the style text about as faithfully as Luna did. Loose-aggressive comes out on top on both tables (Luna won 8 of 30 with it, Sol leads on prize share and bb/100 here), but neither table separates it from the control. Taken together, these results support the B4/v2 conclusion, which now holds for a frontier model too: style guidance moves the style a lot, and the result not detectably. Opus is still untested.

## Spend

Key `holdem-ai-50`: **$35.86 → $72.57**, so this work spent **$36.72** of the $40 cap (metered; the runs' own price table says ~$34.6, ≈1.06×).

| Item | Run-computed | Notes |
|---|---|---|
| Phase 3 probes + cheap sanity match | ≈ $1.85 (metered) | caching experiments, Opus/Fable/Sol replays, 4-seat cheap match |
| Study A, Sol table (2 seeds) | $7.82 | pilot ($4.01) counts toward it |
| Study A, Opus table (2 seeds) | $6.91 | |
| Study A, Fable table (2 seeds) | $14.82 | |
| Study B, Luna personas (5 matches) | $4.21 | |

**Follow-up (2026-10-12):** key **$73.62 → $116.17 = $42.55** metered. That's the live check (`bench/v2verify.ts`, ≈ $0.33) plus the Sol persona table ($42.32 run-computed; the metered-to-run ratio was ≈ 1.0 this time). An interrupted match-3 start replayed free from the cache.

Not done for budget: a third seed for Study A (≈ $31) and Gemini 3.1 Pro (optional).
