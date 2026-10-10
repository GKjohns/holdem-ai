# v2 data-quality audit

**Date:** 2026-10-12 · **Scope:** every v2 decision: Study A (`20261011_v2A_{sol,opus,fable}`), Study B (`20261011_v2B_luna`), the cheap sanity match (`20261011_v2_sanity_cheap`) and the Phase 3 probe (`20261011_v2_probe`). That's 23,227 decisions, 17,919 of them from language models. · **Reproduce:** `python3 internal_docs/20261011_v2_fairness/data_quality_audit.py` (zero cost), plus `node --env-file=.env bench/v2verify.ts` for the live check (≈ $0.30).

## Verdict

**There was no truncation and nothing that needs a rerun.** No v2 decision came close to the output cap. None fell back, timed out, retried or failed to parse, and every reasoning string is a complete sentence. The headline results in `results.md` stand as written. The one real gap was in logging: the run files didn't record `finishReason`, reasoning tokens, or whether the talk filter dropped a line. That is fixed going forward (see the last section).

## 1. Truncation

**The cap was 8000, not 4000.** The 4000 cap belonged to v1 and still applies to `narrate.ts`. Commit `e7c968b` raised seated models to `maxOutputTokens: 8000` before any v2 run started.

The run files have no `finishReason`, so truncation was inferred from four signals:

| Signal | Result |
|---|---|
| Output tokens at or near the cap | Highest of any v2 decision: **1,139** (Haiku), i.e. 14% of the cap. 0 decisions at ≥ 2,000 and 0 at ≥ 4,000. |
| Reasoning text cut off mid-sentence | 0 of 17,919 LLM decisions, except 2 Luna strings in Study B that end in a complete sentence followed by a stray Cyrillic token (`…might continue.ч`). That's a sampling glitch, not truncation. 0 empty reasoning strings. |
| JSON that failed to parse, or needed a retry or repair | An unparseable answer throws `NoObjectGeneratedError` and becomes a fallback. There were **0 fallbacks** in all of v2. |
| Hidden thinking eating the cap | Hidden tokens are estimated as output tokens minus the visible JSON. **Opus 5.5:** median ≈ 23, p90 ≈ 39, 6% of decisions above 100, max 860 total. **Fable 5.1:** median 24, p90 35, max 953. **Haiku 5.5:** median 40, p90 ≈ 400, max 1,139. **Sol:** median 27, p90 107, max 350. **Luna:** median 80, p90 ≈ 200, max 775. At `low`, the Claude models use adaptive thinking and mostly don't think, and none of them gets near the cap. |

Per-model maximum output tokens over the cap of 8000:

| Model | Study A max | Study B / sanity max | p99 |
|---|---|---|---|
| Opus 5.5 | 860 | — | 449 |
| Fable 5.1 | 953 | — | 598 |
| Sol | 350 | — | 277 |
| Luna | 578 | 775 / 404 | 419–464 |
| Haiku 5.5 | 1,139 | 906 | 778–907 |

**Live re-verification.** 15 calls, ≈ $0.30, run through `bench/v2verify.ts`. Each of Opus, Fable, Sol, Luna and Haiku replayed **its own highest-output Study A spot** plus two others. All 15 returned `finishReason: 'stop'` with the full reasoning. The provider now reports reasoning tokens separately: Opus thought for 662 of 767 output tokens on its hardest spot, Haiku 711 of 823, Luna 170 of 224 and Sol 141 of 212. Fable didn't think at all on its hardest spot (147 tokens). The largest call used 10% of the cap.

**v1, for completeness:** v1 ran with a 4000 cap. B3 main had a maximum of 1,235 output tokens (Haiku) and 0 fallbacks. The pilot had a maximum of 2,102 (Haiku); its 3 fallbacks (2 Jev model errors and 1 Gemini timeout) were not truncation.

## 2. Fallbacks, retries, timeouts, latency

| | Study A | Study B | Sanity | Probe |
|---|---|---|---|---|
| Decisions | 11,118 | 10,460 | 1,600 | 49 |
| Fallbacks | 0 | 0 | 0 | 0 |
| Decision-model refusal retries | 0 | — | 0 | — |
| Retried after sleep | 0 | 0 | 0 | 0 |
| Engine errors | 0 | 0 | 0 | — |
| Run-log errors or warnings | none | none | none | — |

Batch runs used a **60 s** per-call limit with a 75 s watchdog (`tournament.ts`, `personas.ts`), so the 25–30 s interactive timeout never applied. Latency tails by model:

| Model | p50 | p95 | p99 | max | > 25 s |
|---|---|---|---|---|---|
| Fable 5.1 | 4.7 s | 6.9 s | 12.6 s | 20.5 s | 0 |
| Opus 5.5 | 3.3 s | 6.4 s | 9.1 s | 13.4 s | 0 |
| Sol | 2.9 s | 4.6 s | 5.8 s | 6.9 s | 0 |
| Luna (A) | 3.6 s | 6.2–6.7 s | 7.5–9.0 s | 17.8 s | 0 |
| Luna (B) | 3.3 s | 5.9 s | 7.8 s | 36.2 s | 4 |
| Haiku 5.5 | 1.9 s | 5.0 s | 6.5–8.3 s | 25.2 s | 1 |

Even at the interactive 30 s limit, Fable and Opus would have had 0 timeouts. Only the 4 Luna calls in Study B (out of 10,460) would have timed out, and Study B ran at 60 s, so none did. Slow models were not penalized. One gap remains: the SDK's internal retry (`maxRetries: 1`) isn't logged, so a retried call shows up only as extra latency. The 36 s Luna call is probably one of these.

## 3. Decision-model oddities

- `choiceNotTop` (we keep the model's choice, logged at 0 tokens): Jev 5 times in 2,589 decisions (3 Fable table, 1 Opus table, 1 sanity), Luna Decisions 0. That's too few to matter.
- `requested` (a `raise_to` amount clamped to the legal range): 3 in total (Opus 1, Haiku 2).
- Illegal choices: 0.

## 4. Cost and billing

- The run-computed costs match the price table: the Fable table $14.82, Opus $6.91, Sol $7.82 and Luna B $4.21, all reproduced from `usage`.
- Claude prompt cache: **99% of Opus and Fable decisions read the cache** (7 of 697 and 7 of 626 did not). About 6% wrote a large block (> 1,000 tokens), which is expected when a new memory block starts. The v1 bug that billed every Claude call as a 1.25× cache write did not recur in v2.
- GPT-6 bills every prompt as a cache write (2.5 vs 2.0 for Sol) and never reads. The price table already accounts for this. Metered spend over the v2 work was 1.06× the run-computed spend ($36.72 vs $34.6), within the usual range.
- No decision was mispriced, and no decision with zero usage was billed, apart from the 5 `choiceNotTop` Jev answers (about $0.00005 each).

## 5. Table talk

`cleanTableTalk()` drops a line that names the speaker's own cards, and v2 didn't record when it did. **From these files, a dropped line can't be told apart from silence.** Talk rates were: Fable 95%, Opus 89%, Haiku 82–88%, Luna 15–27% and Sol 9%. Even a high drop rate couldn't move a result, because the line is said after the action is chosen, and v2 found models almost never read talk (0.1–0.8% of reasoning mentions it). Dropped lines are now logged (`tableTalkDropped`).

## 6. Engine, pairing, structure

- **Chips:** conserved in every one of the 2,818 hands (Study A, B and sanity). Per-hand deltas sum to 0, the stacks before and after balance, and every `tournament` line has `chipsConserved: true`.
- **Tournaments:** all 64 finished naturally (`reason: 'finished'`), with 0 hitting the 250-hand safety cap.
- **Study A pairing:** across the three tables, all 10 tournaments have the same deck seed, the same guest seat and the same guest hole cards on hand 1. The guest-vs-guest comparison really is paired.
- **Resumes:** the Sol table's pilot halted at its $4 budget and resumed. Unfinished tournaments replayed from a cache keyed by the exact view hash, so replayed decisions are the original live answers. The final `run_end` shows 0 replayed in the last invocation and 1,975 live.

## 7. What could still be an artifact of the code (not data quality)

- **Effort `low` with adaptive thinking means Claude models rarely think** (Opus/Fable thought on ~2–6% of decisions, Haiku ~20%, Luna ~40%). That's the stated v2 policy (equal *setting*, not equal *thinking*). It's a design choice, not a bug, but "Fable plays worse" is "Fable at `low` plays worse".
- **The answer schema asks for "one or two sentences" of visible reasoning.** Short visible reasoning is by design, not a sign of truncation.

## Changes made (logging only; play is unchanged)

- `Decision.finishReason` is logged for every language-model decision.
- `usage.reasoning` records reasoning tokens when the provider reports them, which both Anthropic and OpenAI now do.
- An answer that fails to parse is now a labeled fallback with its finish reason and usage. A truncated answer reads `Truncated at the output cap — …` instead of a generic `Model error`.
- `Decision.tableTalkDropped` is set when the talk filter removes a line.
- These are covered by 3 new tests in `tests/decide.test.ts`. `bench/v2verify.ts` does the live check.

