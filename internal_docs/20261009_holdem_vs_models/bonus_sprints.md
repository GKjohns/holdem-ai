# Hold'em AI — Bonus Sprints: Spectator, Narrator, Tournaments, Strategy Lab

**Created:** October 9, 2026
**Status:** B1–B5 complete (2026-10-10) · optional · runs only after Sprints 1–4 of [`implementation_plan.md`](./implementation_plan.md) are done
**Context:** Kyle: "let them just watch the models play against each other… track their performance… an AI narrator… tournaments, a bunch of times, see the trends… then have a really powerful model like Fable plan strategies, personalities, approaches and explore: work the explore-exploit, test a few at the same time, and learn empirically what wins. Don't rely on what you think will win."

**Goal:** four optional sprints that build on each other. Each one is useful on its own, so we can stop after any of them:

| Sprint | Ships | Useful alone? |
|---|---|---|
| B1 Spectator mode | Watch an all-AI table, live reasoning, chip-race chart | Yes: the "fun" version |
| B2 Narrator | Per-hand play-by-play + end-of-session personality report | Yes |
| B3 Tournaments + batch runner | Sit-and-go format, duplicate seeding, `bench/tournament.ts`, trends page | Yes: the benchmark |
| B4 Strategy Lab | Fable designs strategies; a bandit loop tests them and learns what wins | Needs B3 |

Storyboard: frames **6–7** in [`storyboard.html`](./storyboard.html) (Spectator + narrator, Tournament trends / Strategy Lab).

---

## Handoff notes (deltas from the main plan; everything there still applies)

- **No new infra.** Still local-only, no DB. Batch results are **plaintext JSONL** under `data/` (gitignored), matching Kyle's plaintext-over-databases rule. Pages read them through a small `server/api/results.get.ts`.
- **The engine stays pure, and so do the stats.** Every number (VPIP, aggression, bb/100, CIs) is computed in `shared/utils/stats.ts` from `ActionEvent` logs. LLMs (narrator, Fable) only *interpret* numbers they're handed; they never compute them.
- **Information hygiene still holds.** Seated models only ever see `seatView`. The narrator and Fable get god-view hand histories, but **only for completed hands**, and they never sit at the table.
- **Budget is the real constraint.** The `holdem-ai-50` gateway key has a $50/month quota shared with the main plan; allocations and the **pilot-before-scale gate** are in `implementation_plan.md` § Budget (B3 ≤ $15, B4 ≤ $22, B5 follow-up experiments ≤ $3). Every batch command takes `--budget <usd>`, prints a dry-run cost estimate first (from `pricing.ts` × measured avg tokens per decision), and halts cleanly when spend crosses the cap. 
- **Fable's model id:** `anthropic/claude-fable-5.1` (confirmed in gateway `/v1/models` 2026-10-09; $10 / $50 per 1M input/output tokens — the priciest model here, so planner calls only). Add it to `models.ts` as `role: 'planner'` (it's never seated).
- **Table-information rule (Kyle, 2026-10-09) applies to strategy cards too:** a card may hold style/guidance text, but no seat — carded or not — receives computed odds, equity, or hand-strength helpers. `stats.ts` numbers go only to the narrator and Fable, never to seated players.

---

## Sprint B1: Spectator mode `[Complete]`
**Goal:** pick 2–6 models, hit "Watch", and the hand plays itself, readable at human speed.
**Estimated effort:** 3 hours

> **2026-10-09:** B1.1–B1.3 (Play/Watch toggle, zero-human tables with pace + auto-deal, live god view) were pulled into main-plan Sprint 3 at Kyle's request. B1.4 (chip race) also moved, into main-plan Sprint 4 (4.4a, with hand history). B1 is now just B1.5–B1.6 (stats tab, cost meter).

#### Tasks
- B1.1 Setup card: a "Your seat" switch (`USwitch`), **Play** or **Watch**. In Watch mode, seat rows go from 1–5 to 2–6 and the button reads "Start the table".
- B1.2 `useTable.ts`: allow zero human seats. Add a `pace` setting (`UFieldGroup`: Pause · 1× · 4× · Max). 1× keeps a ~1.5 s floor per action so it reads like a broadcast; Max drops the floor. Auto-deal the next hand after a 2 s beat unless paused. Stop when one seat has all the chips or at a hand cap (default 100).
- B1.3 God view: every hole card is face up on the seats (dimmed slightly for folded hands), and **reasoning and probabilities show live** in Table talk. Nothing can leak because no human is playing. The only extra code is reusing Sprint 4's unlocked rendering mid-hand.
- B1.4 `ChipRace.vue`: a stack-over-hands line chart per seat, colored by vendor series (follow the `dataviz` skill; reuse 2048-ai's chart approach). Spectator side panel gets tabs: Table talk · Chip race · Stats.
- B1.5 Live stats tab: `shared/utils/stats.ts` → per seat: hands, VPIP, PFR, aggression factor, went-to-showdown %, won-at-showdown %, avg decision ms, cost so far. `UTable`.
- B1.6 Cost meter in the header ("$0.42 this session") with a session cap input (default $2); pause automatically at the cap.

- B1.7 **Durability (Kyle, 2026-10-10, added mid-sprint after an HMR reload wiped a session):** on-disk JSONL log per session + resume after reload. See Notes.

#### Verification (Playwright, main loop)
- [x] Watch mode with 4 cheap seats (Jev, Luna Decisions, Luna, Haiku) played 13 hands unattended at Max, across one full reload and one HMR; 4,000 chips after every hand (snapshot and JSONL); no console errors after the toast fix below — `b1_stats_tab_watch.webp`
- [x] Stats tab numbers recomputed by `seatStats()` from the on-disk JSONL match the UI exactly (VPIP/PFR/AF/WTSD/W$SD); avg ms differs by a few ms because the UI includes the hand in progress
- [x] Pause / 1× / Max unchanged (Sprint 3); the session cap pauses Watch at $0.010 of $0.01 with a toast, and "Raise cap to $1.02 and resume" goes back to Max — `b1_cap_paused.webp`, `b1_cost_meter_cap.webp`
- [x] Play 3 hands, deal hand 4, reload mid-AI-turn: same session id, hand 4, Hands (3) / Chips / cost meter rebuilt, the in-flight AI turn re-requested (25 → 27 decisions), no AI hole cards shown in Play — `b1_resume_after_reload.webp`. `data/sessions/<id>.jsonl` had 4 lines (start + 3 hands), then a 5th `session_end` on Leave, and the snapshot was cleared
- [x] Every seat's hole cards visible in Watch; Play mode still sealed (`tests/reveal.test.ts`, unchanged code path)
- [x] `npm test` (42, +3 stats), `npm run typecheck`, `npm run lint` green

#### Notes & deviations (2026-10-10)
- **Stats (B1.5):** `shared/utils/stats.ts` (`seatStats`, `sessionCost`) is pure and tested on a hand-built 4-hand fixture (`tests/stats.test.ts`), covering limps, a 3-bet pot, a short all-in call, a split and a busted seat. Definitions: VPIP counts any voluntary preflop chips (blinds aren't log events, so a BB check doesn't count); PFR = a preflop event with `raiseTo`; AF = postflop (bets + raises) / calls, `∞` when never calling and `—` with no postflop action; WTSD = showdowns / hands that saw the flop; W$SD = showdowns where the seat won any pot. Counts are only over finished hands. Avg ms and cost include the hand in play, matching the header meter; latency is public at a real table, and nothing about reasoning is shown. `SeatStatsTable.vue` is a `UTable` with the storyboard's short labels; hands per seat sit under the name so 8 columns fit 360 px; abbreviations are defined under the table. Stats are never passed to `/api/decide`.
- **Cost meter (B1.6):** header button "$0.017 this session" (three decimals, since cheap seats cost fractions of a cent); clicking it opens a `UPopover` with the cap `UInputNumber` (default $2, min $0.01, no step snapping). The cap also shows in the Watch bar ("Session cap $2.00", or "Paused at the $X cap" in warning). The gate runs before every AI decision in `useTable.runAI`. Watch sets pace to Pause; Play stops the loop before the AI turn. Both show a persistent toast with "Raise cap to $N and resume" (+$1). Raising the cap in the popover also resumes. Spend can overshoot by one decision, because the check runs before a call, not during it.
- **Toast gotcha:** `toast.remove(id)` + `toast.add({ id })` with the same id loses the new toast, because Nuxt UI removes by id after a delay. Each cap hit uses a fresh id. `duration: Infinity` needs `progress: false`, or `UProgress` logs a NaN prop error.
- **B1.7 durability (scope addition):**
  - `server/api/log.post.ts` appends zod-validated lines to `data/sessions/<sessionId>.jsonl` (`data/` gitignored). Posts are `session_start`, then one `hand` line the moment each hand completes, then `session_end` when the summary opens.
  - Every line is tagged `source: 'casual'`. The line schema is documented in `AGENTS.md` § Session logs.
  - `app/utils/persist.ts` wraps localStorage (every access in try/catch) and posts fire-and-forget with one retry.
  - **`/play` is now client-only** (`routeRules: { '/play': { ssr: false } }`): SSR can't read the snapshot, and on a reload the in-memory lineup is gone, so SSR used to redirect to `/`. This `nuxt.config` change restarted Nuxt inside Kyle's dev server once.
  - Setup clears the snapshot before a new table. A debug URL resumes only a snapshot with the same mode and seats.
  - `beforeunload` aborts the in-flight `/api/decide`. Before this fix, a reload mid-turn recorded a "Client fallback: Failed to fetch" fold, which is visible once in session `783c392d…` hand 6.
  - The cap is saved in the snapshot.
- **Known gaps:** a reload in the instant between a hand completing and its log post landing can drop that one line, though the snapshot keeps it in the UI. A session that is never left (tab closed) has no `session_end`. HMR of `useTable.ts` still remounts the page, but now resumes instead of resetting.
- **Spend:** about $0.06 metered across my sessions (four cheap-seat tables, about 35 hands total). The key went from $0.71 to $2.01 during the sprint, but most of that came from a concurrent Watch table in another tab (Astra, Opus 5.5, Gemini 3.1 Pro, Jev; session `6ebfa552…` logged $0.65 in 13 hands after the reload, plus whatever it spent before it).

---

## Sprint B2: Narrator `[Complete]`
**Goal:** a commentator who explains what just happened and, at the end, what each model is *like*.
**Estimated effort:** 2–3 hours

#### Tasks
- B2.1 `server/api/narrate.post.ts` + `server/utils/narrate.ts`: after each **completed** hand, send the god-view hand history (all hole cards, every action, every Decision's reasoning or probabilities, result) to a narrator model (default `anthropic/claude-sonnet-5.5`, configurable). `generateText + Output.object({ headline, playByPlay (2–4 sentences), keyMoment: { seatId, street, why } })`, following `~/claude-ops/conventions/ai_sdk_usage.md`. It's async and never blocks the next deal; if it's late, it just appears late.
- B2.2 Narration in the UI: a "Booth" entry pinned at the top of Table talk per hand (headline + play-by-play). In Play mode, narration runs only after the hand completes, the same rule as reasoning.
- B2.3 End-of-session **scouting report** (in the summary modal, plus a `Copy as Markdown` button): the narrator gets `stats.ts` output + 3–5 notable hands per seat and writes a profile for each seat: style label (e.g. "loose-passive caller"), tendencies backed by the numbers, a signature hand, how to beat it, and one line on its table-talk voice. Prompt rule: every claim must cite a stat or a hand number.
- B2.4 Cost: narration is one call per hand. Show it as its own row ("Narrator") in the cost table. Add a toggle to turn it off.

#### Verification (Playwright, main loop)
- [x] 10-hand Watch session (Jev, Luna Decisions, Luna, Haiku at Max): 10/10 hands got a headline. `db7f125b….jsonl` has 10 `hand` + 10 `narration` lines, then `session_end` and `scouting_report`, plus `db7f125b…_scouting.md`. — `b2_booth_watch.webp`, `b2_hands_tab.webp`, `b2_summary.webp`
- [x] Spot-check of 3 scouting claims against `seatStats()` re-run on the JSONL. All 3 match: Haiku VPIP 80% (8/10) / PFR 50% (5/10) / 17 bets/raises and 0 calls; Jev AF 0.1 (1/9), WTSD 57% (4/7), W$SD 50% (2/4); Haiku won 8 of 10 pots. One narrative slip: #5 says Luna "check-called three streets" after it check-raised the flop. Every tendency line cites a number.
- [x] Play mode: on hand 1 there was no Booth entry, no narrate request and 0 reasoning nodes until `complete`. Mid-hand 2 the Booth shows hand #1. The network order is hand-1 `log` → `narrate` → `log` → hand-2 `decide`s. — `b2_play_midhand.webp`
- [x] Toggle off: hand 2 finished with no narrate call. Leave offered a "Write the scouting report" button instead of calling. — `b2_narrator_off.webp`
- [x] Reload keeps narrations (10/10 back from the snapshot, no re-request). A pre-B2 (B1) snapshot still resumes, and its last 2 hands got narrated.
- [x] Copy as Markdown copies the same markdown as the `.md` file (verified with a stubbed clipboard; Playwright's real clipboard read hangs on a permission prompt)
- [x] `npm test` (49: +6 `tests/narrate.test.ts`, +1 reveal gate), `npm run typecheck`, `npm run lint` green

#### Notes & deviations (2026-10-10)
- **Files:** `shared/utils/narration.ts` (types, `NARRATOR_MODEL`, `statsLine`, `scoutingMarkdown`, `narratorCost`, `uncitedClaims`), `server/utils/narrate.ts` (`renderHand`, `notableHands`, `renderScoutingPrompt`, `narrateHand`, `scoutingReport`), `server/utils/narrateSchema.ts`, `server/api/narrate.post.ts`, `server/api/scouting.post.ts`, `app/components/BoothEntry.vue`. Edited: `useTable` (narrate on `recordIfComplete`, scouting, cost, snapshot), `TableTalk` (pinned Booth + switch), `HandHistory` (headline + Booth), `SessionSummary` (Narrator row, scouting report), `log.post.ts` (2 new line types + `.md`), `reveal.ts` (`canNarrate`), `persist.ts`, `useLineup` (`narratorOn` state). No `nuxt.config` change.
- **Model calls:** `generateText + Output.object`, `reasoning: 'low'`, `maxRetries: 1`, `maxOutputTokens: 4000`, no temperature, gateway caching, a 45 s timeout per hand and 60 s for the report (client timeouts 50 s / 65 s). Errors come back as 502, and the Booth shows "missed this hand". The model can be changed with `modelId` in the body or the `NARRATOR_MODEL` env var; it must be an `llm` in `models.ts`.
- **The narrator gets engine hand names.** The first live narration misread 4♠7♥ on J-7-4-6-5 as a straight. `renderHand` now adds each seat's `rankHand()` best five on the full board, and the re-run was correct. The narrator isn't seated, so the table-information rule holds.
- **Stats** are recomputed server-side from the hands sent to `/api/scouting` (`seatStats`), so client numbers aren't trusted. The prompt hands them over as `statsLine` text ("VPIP 42% (5/12)"), and the report shows the same line under each seat. `statsLine` derives AF from `counts`, because JSON turns ∞ into null.
- **Cost and cap:** narration counts in the header meter and against the cap. At or over the cap, no narration and no auto-report (the summary's button still works). Measured: about $0.007–0.012 per hand (about 2–3k input tokens, 300 output), about $0.03–0.04 per report. At a cheap table the narrator costs more than all the seats: $0.123 vs $0.017 over 10 hands.
- **Persistence:** `narration` and `scouting_report` JSONL lines (schema in `AGENTS.md`); `<id>_scouting.md` (latest wins); the snapshot gains optional `narrations` / `narratorOn` (still `v: 1`, so older snapshots load). A reload re-asks for up to the last 2 hands that weren't narrated.
- **Play-mode reveal:** narration is god view after the hand, so it can name a folded AI's cards, which the Hands tab hides. This is the same post-hand rule as the reasoning reveal.
- **Seen, not B2:** the dev server restarted on its own once during verification. One GPT-6 Luna decision (`db7f125b` hand 3) took 901 s and fell back to a fold, which shows a stalled server process can outlive the 30 s abort. B3's runner calls `decide()` directly, so it isn't affected the same way, but it should keep a wall-clock watchdog.
- **Spend:** about $0.24 on the key ($2.127 → $2.368): 13 hands narrated in the app, 2 curl probes, 2 scouting reports, plus the cheap seats' own decisions. The cap was $2.

**For B3:** the scouting report takes any `{ seats, hands }`, so `/results` can reuse `scoutingReport()` per run. Feed it the JSONL `hand` lines (spread `result`). Expect about $0.04 per report.

---

## Sprint B3: Tournaments + batch runner + trends `[Complete]`
**Goal:** run many tournaments headless and see who *actually* wins, with error bars.
**Estimated effort:** 4–5 hours

#### Tasks
- B3.1 Engine: blind schedule (`levels: {sb, bb, hands}[]`) and elimination order. Sit-and-go preset: 6-max, 1,500 chips, blinds double every 10 hands (turbo; keeps LLM cost per tournament bounded). Tests: blinds step up on schedule, finish order is correct with simultaneous busts (bigger starting stack places higher).
- B3.2 **Duplicate seeding** (the variance killer): a "match" = the same deck seed replayed once per seat rotation, so every model plays every set of cards from every seat. Without this, 20 tournaments is mostly luck. `shared/utils/duplicate.ts` builds the rotation schedule.
- B3.3 `bench/tournament.ts --lineup jev,openai/gpt-6-luna-decisions,… --matches 10 --format sng|cash --hands 200 --budget 5 --concurrency 4`: dry-run estimate first, then runs and appends one JSON line per hand and one per tournament to `data/runs/<date>_<slug>.jsonl`. Resumable: rerunning skips completed `(seed, rotation)` pairs. A rerun costs nothing (see the idempotent-bulk-processing feedback memory).
- B3.4 `shared/utils/stats.ts` additions: bb/100 per model with **bootstrap 95% CIs** resampled at the match level; tournament finish distribution; head-to-head chip flow matrix; a rating from finish orders (Plackett–Luce fit or plain average finish; pick the simpler one if they agree).
- B3.5 `/results` page: runs list (`UTable`) → run detail: leaderboard with CI bars, finish-position distribution, bb/100 over cumulative hands (does it converge?), and the B2 scouting reports for that run. "Run this lineup again" copies the CLI command (spending stays a terminal action, not a button).

#### Verification
- [x] **Step 0 (must-fix):** the B2 "901 s" Luna fold was not a code path missing the signal. `pmset -g log` shows a clamshell sleep at 00:57:42 EDT, a 900 s maintenance sleep, and a DarkWake at 01:13:33. The decision landed at 05:13:36Z, 3 s after wake. Node's (and Chrome's) timers are monotonic and stop while the Mac sleeps. Both SDK paths do pass the signal (`decide()` → `retry` → `doDecide`, `generateText` → fetch). Hardened anyway: `bounded()` races one hard deadline over the whole attempt (SDK retry + refusal re-ask), a timeout whose wall time beats awake time by > 5 s is asked once more, and the runner adds a 45 s wall-clock watchdog per decision and 5 min per hand, and runs under `caffeinate -ims`. `tests/decide.test.ts` (6 tests): an LLM that never settles and ignores the signal, error-then-hang through the SDK retry, refusal-then-hang on the reworded retry, caller abort, and the healthy path.
- [x] **Pilot** `20261010_pilot` (6 seats incl. Gemini 3.1 Pro, 1 match, 15-hand cap): $1.34, 90 hands. `bench/gate.ts` passed all 5 checks: 0 engine errors, chips conserved on every hand, fallbacks ≤ 1.4% per model (Jev 2/138, both the off-argmax case fixed below; Gemini 1 timeout), no degenerate model (folds 13–49%, all raise), $0.0149/hand vs a $0.0112 estimate (1.33×), every B5 field present. `/results/20261010_pilot` renders from the file — `b3_pilot_results.webp`
- [x] **Main run** `20261010_main`: Sol, Haiku 5.5, Luna, Luna Decisions, Jev; 8 matches × 5 rotations = 40 sit-and-gos, 1,913 hands, 15,913 decisions, $12.29 (pricing.ts). Gate passed on the whole run: 0 engine errors, chips conserved on all 1,913 hands, **0 fallbacks** in 15,913 decisions, $0.0064/hand vs the $0.0077 estimate — `b3_results_main.webp`, `b3_runs_list.webp`, `b3_results_dark.webp`
- [x] **Resumable and idempotent:** SIGKILLed twice mid-run (272 and 282 partial hand lines). Each rerun compacted them away and replayed 2,628–2,704 cached decisions at $0 before going live. A rerun of the finished run took 0.8 s, $0, 0 calls. A `--fake` run killed with `-9` and resumed was byte-identical in hands, deltas, actions and finish orders to an uninterrupted one. Raising `--matches` 7 → 8 on the same slug extended the run.
- [x] **CIs vs matches** — `b3_ci_3_matches.webp` vs `b3_ci_8_matches.webp`. Honest result: they did **not** narrow from 3 to 8 matches (Sol ±11 → ±34). With 3 clusters a percentile bootstrap has 10 distinct resamples and understates the spread; the 3-match intervals were too narrow, not the 8-match ones too wide. Separating pairs went 8/10 (3 matches) → 7/10 (5) → 7/10 (8). Treat CIs from < 5 matches as optimistic.
- [x] Chip conservation per hand across the whole run (checked by the runner after every hand and again by `bench/gate.ts`); 390 px has no horizontal scroll; no console warnings
- [x] `npm test` (62: +6 decide, +7 tournament/duplicate/run stats), `npm run typecheck`, `npm run lint` green

#### Results (8 matches, 95% match-bootstrap CIs)

| Model | bb/100 | 95% CI | Avg finish (1 = best) | 1st | $/100 hands |
|---|---|---|---|---|---|
| GPT-6 Sol | **+81** | +44 to +111 | 2.20 (1.68–2.70) | 23/40 | $0.67 |
| GPT-6 Luna | +2 | −25 to +26 | 2.67 (2.20–3.10) | 5/40 | $0.03 |
| GPT-6 Luna Decisions | −4 | −27 to +13 | 2.73 (2.50–2.95) | 3/40 | $0.01 |
| Claude Haiku 5.5 | −46 | −96 to −4 | 3.77 (3.40–4.13) | 7/40 | $0.08 |
| Jev | −62 | −104 to −30 | 3.63 (3.40–3.83) | 2/40 | $0.01 |

Pairs whose difference CI excludes 0 (7 of 10): Sol beats every other seat (+79 to +143); Luna beats Jev (+64, +24 to +109); Luna Decisions beats Jev (+57) and Haiku (+41, +1 to +92). Not separated: Luna vs Luna Decisions, Luna vs Haiku, Haiku vs Jev. Avg finish and Plackett–Luce agree on the top (Sol), the bottom two (Haiku, Jev) and swap Luna/Luna Decisions (within noise), so the page leads with avg finish and shows PL as a column. Styles (stats.ts): Sol loose-aggressive (VPIP 55%, PFR 36%, AF 2.9); Haiku loosest (VPIP 67%) and loses at showdown (W$SD 36%); Luna Decisions tightest (VPIP 31%, PFR 6%); Jev a calling station (AF 0.4, WTSD 68%). Scouting report: `data/runs/20261010_main_scouting.md` ($0.065; stats over all 1,913 hands, hand numbers from sample `m02-r0`).

#### Notes & deviations (2026-10-10)
- **Lineup:** Gemini 3.1 Pro was in the pilot but dropped from the main run for budget. With 6 seats a match measured ≈ $4.5 (Gemini + Sol ≈ 2/3 of the spend), so $13 bought ~3 matches, too few for CIs; 5 seats gave 8. Gemini's 90 pilot hands stay in `20261010_pilot.jsonl` (5.2 s average decision, 1 timeout in 145 decisions, $0.67 of the $1.34).
- **Hand cap 50** (plan preset is 1,500 chips, blinds doubling every 10 hands, uncapped): 20 of 40 tournaments reached it and the survivors were placed by stack. bb/100 is unaffected; finish order at the cap is a chip-count finish. `SNG_TURBO.maxHands` defaults to 120.
- **New: SDK rejects off-argmax decision answers.** ai 7.0.137 throws `InvalidResponseDataError` ("did not select a highest-probability option") when a decision model's `choice` isn't its own top probability. That was a fallback fold in the pilot (Jev 2×). `decide()` now recovers the answer from `err.data`, keeps the model's choice (as the app always has), and flags it `choiceNotTop: true` (7 in the main run, all Jev; first noted as 6, corrected after the B5 findings report). Those calls log 0 tokens (≈ $0.00005 each). This is B5's "does the choice diverge from its own top probability" hunch, now countable.
- **Budget bug found by the kill test:** `--budget` first counted only the current invocation, so a resume would have restarted at $0. It now caps the run's total, seeded from the decision cache (every cache line is one paid call); `run_end` has `spentUsd` (this invocation) and `totalSpentUsd`. A shell watcher on the key's metered spend (`vercel ai-gateway budgets list`) was the hard backstop at $17.20.
- **Estimator:** the random-play simulation undercounts decisions (random seats bust fast): it said $0.0025/hand for the main lineup. It now uses measured decisions per seated hand and tournament length from real run files, plus measured $/decision from every log on disk; that predicted $0.0077 vs the $0.0064 measured.
- **Convergence chart** starts a model's line once it has 50 hands; the first tournament alone put Haiku at −8,000 bb/100 and flattened everyone else.
- **Files:** `shared/utils/tournament.ts` (levels, `withLevel`, `bustsThisHand`, `survivorsPlaced`), `shared/utils/duplicate.ts`, `shared/utils/runs.ts` (line types, `parseRun`), `shared/utils/stats.ts` (+ `matchAggregates`, `leaderboard` with pair-difference CIs, `finishDistribution`, `chipFlow`, `bb100Series`, `plackettLuce`), `server/utils/results.ts`, `server/api/results.get.ts`, `app/pages/results/{index,[run]}.vue`, `CiBar.vue`, `ConvergenceChart.vue`, `bench/tournament.ts`, `bench/gate.ts`; `decide.ts` and `narrate.ts` (`statsHands`) edited; `--div-pos/--div-neg` tokens (validated light and dark) for the chip-flow matrix. Schema: `AGENTS.md` § Batch runs.
- **Spend:** key $2.37 → $16.85 = **$14.48** (cap $15): pilot $1.34, main $12.29, scouting $0.065 by pricing.ts; the remaining ≈ $0.78 is calls in flight during the two kills plus metering vs pricing.ts.

**For B4/B5:** the data is `data/runs/20261010_main.jsonl` (31 MB; 40 `tournament` lines, 1,913 `hand` lines with god view + every SeatView and Decision) and `data/runs/20261010_pilot.jsonl`. Read with `parseRun()`; `runDetail()` in `server/utils/results.ts` gives every /results number. B4's base-model pick: Luna ($0.03/100 hands, 0 fallbacks in 3,225+ decisions, 2.0 s) is cheaper than Haiku ($0.08) and broke even here.

---

## Sprint B4: Strategy Lab (explore / exploit, run by Fable) `[Complete]`
**Goal:** learn **empirically** which strategies and personalities win, instead of trusting anyone's priors, Fable's included.
**Estimated effort:** 5–6 hours of build, then lab runs gated on budget

### Design
- **Separate the strategy from the model.** A *player* = a fixed, cheap **base model** (default `openai/gpt-6-luna` with reasoning `none`, or Haiku 5.5; pick the cheaper one from B3 data with a fallback rate under 2%) + a **strategy card**: a ~200-word system-prompt block covering the style, hand-selection guidance, sizing rules, bluff frequency, how to adapt to opponents, and a table-talk persona. Holding the base model fixed means a score difference comes from the *strategy*, not the model's IQ. (A later run can cross the top cards with other base models.)
- **Fable is the researcher, not a player.** Once per generation it reads the results and writes the next generation's cards. It never sits at the table, so its cost is small.
- **Fixed reference field** so scores compare across generations: Jev + Luna Decisions (cheap, deterministic-ish), the base model with **no card** (the control), and the current champion. Every candidate plays duplicate matches against this field. bb/100 vs the field is the score.
- **Pre-registered predictions.** Before any hands are played, Fable writes, for every card, a hypothesis ("overbetting rivers exploits the decision models' high fold rate"), a predicted bb/100, and a predicted rank. The report then scores **prior vs result**, so we see where intuition was wrong. That is the direct answer to "don't rely on what you think will win."

### Loop (per generation)
1. **Generate.** Gen 0: Fable writes 8 cards chosen to *span* the space, deliberately including styles it expects to lose (nit, maniac, calling station, GTO-ish balanced, exploit-the-bots, trappy slow-player, talkative bluffer, adaptive). The prompt bans converging on one "best" idea, and each card must differ from the others on at least two named axes.
2. **Allocate (bandit).** Successive halving with a Thompson-sampling top-up: every card gets a small equal budget (e.g. 3 duplicate matches); the bottom half stops; survivors get double. This runs a few strategies **at the same time** under the same seeds.
3. **Reflect.** Fable gets the leaderboard with CIs, `stats.ts` style profiles, B2 scouting reports, and 5 decisive hands per card. It writes a generation memo: what's confirmed, refuted, or still noise.
4. **Next generation:** a fixed split, **~60% exploit** (mutations or crossovers of the top cards, each naming the single thing changed) and **~40% explore** (new ideas unlike anything tested yet). The explore quota is enforced in code, not left to Fable's discretion. All new cards get new pre-registered predictions.
5. Stop at N generations (default 4) or when the budget runs out.
6. **Held-out final:** the top 3 cards plus the control replay on **fresh seeds** against a **different field** (adds Sol, Opus 5.5, or Gemini 3.1 Pro seats). A strategy that only beats the reference field is flagged as overfit.

### Tasks
- B4.1 `shared/utils/strategy.ts`: `StrategyCard { id, gen, parentIds, name, card (text), axes: Record<string, string>, hypothesis, predicted: { bb100, rank } }`. Cards are stored as plain `.md` files under `data/lab/<run>/cards/`.
- B4.2 `server/utils/decide.ts`: optional `strategyCard` appended to the LLM instructions (a seat = base model + card). Seat labels show the card name ("Luna · River Bully").
- B4.3 `bench/lab.ts --run <slug> --generations 4 --budget <usd> --base openai/gpt-6-luna`: drives generate → allocate → reflect → next generation through `bench/tournament.ts`'s runner. Resumable per generation. Fable calls use `generateText + Output.object` (cards array / memo schema) with a long timeout (planner, not interactive).
- B4.4 `/lab` page: generation-by-generation leaderboard with CI bars, lineage tree (card → mutations), each card's hypothesis next to its verdict (confirmed / refuted / inconclusive), and a **prior-vs-result scatter** (predicted vs actual bb/100). Final "Field notes" memo from Fable at the top.
- B4.5 Report: when a lab run finishes, write `data/lab/<run>/field_notes.md`: what wins, what loses, where the priors were wrong, what still looks like noise, and what to test next.

### Verification
- [x] **Pilot** `20261010_lab_pilot` (2 generations × 4 cards, 20-hand cap, r1 1 / r2 1, no held-out, no field notes): 60 tournaments, 1,200 hands, 13,380 decisions. **$2.71 by pricing.ts** (tables $1.48, Fable $1.23 over 2 calls); **the key moved $3.03** ($16.85 → $19.88; metering runs ~1.1× pricing.ts, as in B3), so the pilot is $0.03 over its $3 line on the key. `bench/labgate.ts` passed all 7 checks: 0 engine errors and chips conserved on 1,200 hands; 0 fallbacks for every player; no degenerate card (fold rates 13–73%, every player raises); $0.00124/hand vs the $0.00120 estimate (1.03×); predictions written before the first hand (gen 0 07:39:16 < 07:39:24, gen 1 07:52:00 < 07:52:05, file mtimes too); explore quota 4/0 then 2/2; every B5 field present. `/lab/20261010_lab_pilot` renders (2 generations, 8 scatter points, lineage with 2 champion rings, 0 console warnings) — `b4_pilot_lab.webp`
- [x] The pilot's own finding already showed the lab's central problem: Patient Caller led the control by +83 [+1, +161] over its 2 matches, then came in at −82 pooled over 8 once it sat in the champion seat
- [x] **Full run** `20261010_lab`: 2 generations (8 cards, then 3 exploit + 2 explore), 13 cards, 153 tournaments, 7,573 hands (6,675 training + 898 held-out), 61,477 decisions, **$13.23 by pricing.ts** (training tables $5.52, held-out $4.90, Fable $2.82 over 3 calls). Gate passed on the whole run: 0 engine errors, chips conserved on all 7,573 hands, **0 fallbacks**, fold rates 5–66%, $0.00083/hand vs $0.00134 estimated (0.62×), predictions before first hand in both generations, quota 8/0 and 2/3 — `b4_lab_full.webp`, `b4_lab_dark.webp`, `b4_lab_mobile.webp`, `b4_lab_list.webp`
- [x] The control (and a champion seat) is at every table; the champion's lead over the control is reported with a CI per generation: gen 0's champion seat (a second card-less Luna) −9 [−32, +10] over 17 matches, gen 1's (Balanced Solid) +9 [−12, +25] over 10
- [x] Held-out final on 3 fresh matches; `heldout.json` records 0 overlap against 2,060 seeds (every run on disk + every planned training seed), and the code refuses to run otherwise. Tested once for real: a fake lab with the same `--seed` as an earlier one was refused ("held-out seeds overlap training seeds") — `b4_lab_heldout.webp`
- [x] `/lab` renders lineage, verdicts, the prior-vs-result scatter, Fable's memos and field notes — `b4_lab_lineage_scatter.webp`, `b4_lab_card.webp`
- [x] **Resumable and idempotent:** a fake lab killed with `-9` twice (mid-gen 0 round 2 and mid-gen 1 round 1) and resumed matched an uninterrupted run exactly (hand fingerprint, allocations, champions, held-out picks). Reruns of the finished pilot (1.3 s) and full run (5.5 s) made 0 calls with `--budget` pinned at what was spent. The full run was interrupted once on purpose (SIGINT during the held-out, to raise it from 2 to 3 matches); the resume replayed 176 cached decisions and dropped 15 partial hand lines
- [x] B3 compatibility after extracting the runner: a rerun of `20261010_main` is $0, and the B3 pilot replayed from its cache alone (hand lines stripped) gave identical hands and finish orders on all 90 hands
- [x] `npm test` (70: +8 `tests/strategy.test.ts`), `npm run typecheck`, `npm run lint` green

#### Results (`20261010_lab`; lead = card − control bb/100 on the same matches, 95% match-bootstrap CI)

| Card (gen, kind) | Matches | Own-table lead | Pooled lead | Predicted lead | Held-out lead (3 matches) | Verdict |
|---|---|---|---|---|---|---|
| Bot Hunter (0, explore) | 4 | +24 [+1, +55] | +24 [+1, +55] | +60 | **−24 [−59, +10]** | confirmed in training · **overfit** held-out |
| Balanced Solid (0, explore; champion both gens) | 3 own / 13 pooled | +27 [+20, +35] | +13 [−3, +26] | +42 | **−1 [−45, +23]** | confirmed in training · **overfit** held-out |
| Silver Tongue (0, explore) | 3 | +7 [−2, +21] | +7 [−2, +21] | −40 | +10 [−16, +36] | inconclusive · inconclusive |
| Solid Hunter (1, crossover of the two above) | 4 | +2 [−22, +26] | +2 | +30 | — | inconclusive |
| Sticky Hunter (1, mutation of Bot Hunter) | 3 | −20 [−61, +28] | −20 | +24 | — | inconclusive |
| Blitz Maniac (0, explore) | 3 | −49 [−116, +30] | −49 | −65 | — | inconclusive |
| 7 more cards (1 match each, cut by halving) | 1 | −110 to +11 | | | — | no CI |

The control played +10 [+2, +22] bb/100 over 27 matches (6,065 hands) at these tables. On the held-out table Sol won 7 of the 18 tournaments at +58 [+18, +79] bb/100 (its B3 rate was +81), Haiku lost −59 [−86, −42], the control −1 [−6, +3]; Silver Tongue won 5, Balanced Solid 1, Bot Hunter 0.

**Bottom line:** no card beat the card-less base model by a margin that survived. The noise floor, measured directly by two identical card-less Lunas in gen 0, is −9 [−32, +10] over 17 matches, as wide as most effects. Medium-tight, raise-first, rare-bluff cards were the only ones positive in absolute bb/100 with a CI above 0 (Balanced Solid +18 [+6, +31] over 2,925 hands). Their *lead over the control* is unproven everywhere, and Bot Hunter's named-opponent exploits flipped sign on a field without Jev and Luna Decisions. Exploit children (gen 1) all landed below their parents: the parents' gen-0 leads were partly luck (Balanced Solid +27 → +9 as champion, unchanged card).

**Where Fable's priors were most wrong** (predicted vs measured bb/100 at the card's own table): Silver Tongue, the "talkative bluffer" it expected to lose (−45 → +11; Luna tempered the bluffing instructions: WTSD 42%, 15 calls vs 171 bets); Silver Value −38; Granite Rock and Table Reader −35 each. The errors were systematic: all 7 cards Fable predicted positive came in 19–38 below, and the 4 it predicted to lose by 15+ came in 25–56 above (shrinkage toward the control; Quiet Trapper, predicted −5, was the near-miss at −12). Rank order was right only at the top of gen 0 (Bot Hunter and Balanced Solid, predicted 1–2, finished 1–2). The pilot (Fable never saw it) had the same shape: its "Bot Hunter" was predicted +60 and posted −51.

#### Notes & deviations (2026-10-10)
- **Base model: GPT-6 Luna (reasoning `none`).** From B3: $0.03/100 hands (Haiku $0.08), 0 fallbacks in 3,676 decisions, 2.0 s, and +2 [−25, +26] bb/100, a mid-strength player with room to move either way. Haiku lost −46 [−96, −4] with a wider CI, so card effects would have been harder to see. Cross-model transfer (Open Question 2) stays untested.
- **Runner extracted:** `bench/runner.ts` holds B3's runner as a module (one shared pool and budget across many tables; a lineup entry is a player = model + optional card); `bench/tournament.ts` is a thin CLI over it. Run files gained `players`, `lab`, `playerId`, `cardId` (all optional, AGENTS.md § Batch runs); stats group by `playerOf(seat)`. A card seat's cache hash covers the card text.
- **Table names:** base-model seats get neutral aliases (Ash, Birch, Cedar, Elm, Hazel, Rowan, seeded per table) so opponents never see a card name or role. Jev, Luna Decisions, Sol and Haiku keep their labels, so a card *can* name them, which is guidance a human could have (and what the held-out field tests).
- **Card hygiene in code:** `bannedContent()` rejects percentages, HUD stats, win rates, equity/odds numbers; cards are 40–230 words; `validateGeneration()` checks the explore quota (`Math.round(0.4 n)`, gen 0 all explore), ≥ 2 axis differences between new ideas and from every tested card, mutations change ≤ 1 axis, crossovers take each axis from a parent, parents come from the top 3 by pooled lead, ranks are a permutation. A failed generation gets one re-ask with the errors; none was needed (5/5 Fable calls valid first try).
- **Fable calls:** `generateText + Output.object`, reasoning `medium`, `maxOutputTokens` 20,000, 300 s timeout, `maxRetries: 1`. Reflection and the next generation are one call (memo + cards), and the last memo rides with the field notes, which saves re-sending ~40k tokens of results. Measured: gen 0 $0.32–0.50 (7k in / 5–9k out), later generations $0.92–1.48 (37–68k in / 11–16k out), field notes $0.84. Fable reads `stats.ts` profiles, predictions vs results, and 3–4 god-view decisive hands per card with every seat's reasoning or probabilities; **B2 scouting reports per card were dropped** (≈ $0.4/generation for a narrator's reading of the same data); the B3 scouting report is in the prior evidence instead.
- **Allocation:** round 1 one match per card, the top half by own-table lead get +2 (successive halving), then one Thompson top-up match (seeded batch draws from N(lead, se²)). Each round ranks on exactly the matches allocated before it, and crowning uses only generations ≤ g. **Bug found by the fake-run idempotency test:** the first version ranked on everything on disk, so a rerun saw later rounds and could re-allocate; fixed with `unitsOf(..., upTo)` and a test.
- **Champion seat:** the best pooled lead among the generation's survivors and the sitting champion; gen 0's champion seat is a second card-less Luna (`control-2`), which turned out to be the most useful seat in the lab: a direct measure of the noise floor.
- **Scale cut by budget:** 2 generations instead of the default 4. The budget guard (`spent + next generation + held-out + notes > cap`) stopped before gen 2 at $7.50. Round 1 is 1 match per card, so 7 of 13 cards have no CI. The held-out was planned at 2 matches and raised to 3 mid-run once tables proved cheaper than estimated ($0.00083/hand vs $0.00134; the estimator assumed B3's tournament length, and cards bust each other faster).
- **Held-out field:** the top 3 cards + control vs GPT-6 Sol + Claude Haiku 5.5 at one 6-seat table (no seat from the reference field except the control). Verdicts: `holds` if the held-out lead CI is above 0, `overfit` if the point estimate is ≤ 0, otherwise `inconclusive`. With ±35 CIs after 3 matches, "overfit" here means "did not reproduce", not "proven worse".
- **Verdicts on pre-registrations** are mechanical: the predicted sign of the lead vs the lead's CI (`verdict()` in `strategy.ts`). Fable's own reading is in its memos.
- **Spend:** key $16.85 → $34.38 = **$17.53** for B4 (cap $22): pilot $2.71 + full run $13.23 by pricing.ts ($15.94), the rest metering (~1.1×). A shell watcher on the key's metered spend was the hard backstop (stop at $38.70); it never fired.

**For B5:** everything is under `data/lab/20261010_lab/` (and the pilot under `data/lab/20261010_lab_pilot/`): `field_notes.md`, `gen<N>/{predictions,allocation,outcome,memo}.json`, `cards/*.md`, `planner/*.json` (Fable's full prompts and outputs), `runs/g<N>-<card>.jsonl` (14 table files, same hand schema as B3 with `playerId`/`cardId` and the card text in `run_start.players`), `runs/heldout.jsonl`, `heldout.json`, `lab.jsonl`. Read with `labDetail(loadLab(labDir('20261010_lab')))` from `server/utils/lab.ts` under bare Node; schema in AGENTS.md § Strategy Lab. Hunches worth chasing: Luna follows aggression/sizing text literally but softens bluff frequency; literal rule-following creates leaks (Table Reader folding to bets, Solid Hunter folding jacks to 4-bets); one duplicate-seeded hand moved three cards' one-match leads by 34–75 bb; Jev's shoves are often weak (ace-high, one pair).

---

## Sprint B5: Findings report `[Complete]`
**Goal (Kyle, 2026-10-10):** a written report that tells the story of what happened: how each model plays, who wins and why, what surprised us. Breadth first, then follow hunches down rabbit holes.
**Runs after B4.** Done by a dedicated analyst subagent with fresh eyes (not the agent that built B3/B4).

**Data it needs (so B3/B4 must log it):** every hand's god-view history (all hole cards, board, every action with the seat view the model saw), every `Decision` (reasoning, table talk, probabilities, latency, usage, fallback/retried), tournament results, lab cards/predictions/memos. Plaintext JSONL under `data/`.

**Shape of the analysis:**
- **Breadth:** leaderboard with CIs, style profiles (VPIP/PFR/AF/WTSD), cost vs performance (bb/100 per dollar), latency, fallback/refusal rates, LLMs vs decision models.
- **Depth (pick 3–5 hunches, chase each to a conclusion):** examples — do decision models get exploited by overbets? Do LLMs' stated reasoning and their actual actions disagree? Does Luna Decisions' choice diverge from its own top probability, and when? Do models play differently against named opponents? Does table talk leak hand strength? Which leaks did the winning strategy cards exploit? Where were Fable's priors most wrong?
- Small targeted follow-up experiments are allowed to settle a hunch (≤ $3, pilot rule applies).
- Every claim cites a number or a hand number; charts follow the `dataviz` skill; uncertainty stated honestly (noise is a finding too).

**Deliverable:** `internal_docs/20261009_holdem_vs_models/findings/report.html` (self-contained, charts inline SVG, notable hands rendered as small hand histories) + `findings/notebook/` with the scripts that produced every number. Published as a private Artifact for Kyle to read/share.

**Budget:** report follow-ups ≤ $3, taken from B4 (B4 cap becomes $22).

### Results (2026-10-10)

- **Deliverable:** [`findings/report.html`](./findings/report.html) (single file; inline-SVG charts; only externals are Google Fonts). Notebook: `findings/notebook/` — run `node 01_extract.ts` (flattens every run file into `cache/`, gitignored, idempotent), `node 02_official.ts` (re-runs `runDetail`/`labDetail`), `node 04_allin_ev.ts`, then `python3 -I 03_breadth.py`, `05`–`10`, `12`, `13`, `14_probe_analysis.py`, and `15_build_report.py` (writes the report from `out/*.json`). `00_check_eval.ts` validates the notebook's fast evaluator against `rankHand` (0 mismatches in 200k pairs).
- **Experiments** (`11_probe.ts`, fixed views from the B3 run through the app's own `decide()`, cached in `cache/probe.jsonl`): replay of 120 views × 5 models (+60 re-asks), a bet-size ladder (36 spots × ⅓/¾/1½ pot), and a table-talk probe (same spots with a strength or weakness claim). 1,800 calls, 1 fallback, $1.46 by pricing.ts; key $34.38 → $35.85 (**$1.47**, cap $3).
- **Headlines:** Sol +81 survives every check (all-in-adjusted +77, positive vs all four opponents, +58 held-out); only Sol shoves short stacks (33% vs 0–3%) in a game every prompt calls a "cash game"; Haiku names its own hole cards in 204 talk lines and 38 of its 64 "set" claims were wrong; Luna folded the winner in 25 of 50 heads-up river folds; one line of talk moves Jev's fold rate 33% → 86% / 8%; Sol's talk is a strength tell (AUC 0.73) nobody reads; decision models are deterministic on re-ask (100% / 97%) vs LLMs 80–92%; the lab's card-lead spread (SD 37) is below the noise-only spread (43), so Fable's one-directional miss is regression to a near-zero true spread.
- **Found while doing it:** `cleanTableTalk()` only catches card codes, not rank words; the B3 notes' 6 `choiceNotTop` are 7 in the file, all 1-point rounding ties; the seat prompt's "cash game" framing; bb/100 under doubling blinds over-weights levels 1–2 (Haiku ranks above Luna Decisions by chips).

### Changed after the findings report (2026-10-10)

**The B3, B4 and B5 numbers above predate these fixes.** Every seat in those runs was told it was in a "cash game", Haiku's word leaks were live, and the repeat-guard dropped habitual lines. Nothing was rerun (it would change the benchmark and cost money); old run files still parse and render on `/results` and `/lab`, and their cached decisions won't replay into a rerun because the new views hash differently.

- **Format in the prompt.** `SeatView.game` (optional, so old views parse): `{ type: 'cash' }` on /play, Watch and selfplay; `{ type: 'sng', level, handsLeftAtLevel, next? }` from `sngFormat()` on batch and lab tables. `instructionsFor(card, game.type)` swaps the opener ("sit-and-go tournament … players finish in the order they bust … play to finish as high as you can") and the first prompt line gives the level, the big blind, the hands left at it and the next blinds. Decision models get the same in `tableState()`. Only things the floor would announce: no odds, equity or strength.
- **Hole cards in words.** `namesOwnCards()` (in `decide.ts`) drops a line that names a hole rank not on the board ("Kings again", "pocket jacks", "set of fours", "AK", "nine-seven", "pocket 9s") or a held suit in a flush/draw phrase ("heart flush"), unless the board alone shows that flush. Counting words pass ("four-bet", "two pair", "45 chips"). Over the B3 run files (main + pilot) it would have dropped 289 of 5,200 lines (288 Haiku, 1 Luna).
- **Repeated lines.** `priorTableTalk` is the seat's own last 5 distinct lines by most recent use (`recentTalk()`), not the first-said 6, so a line it keeps saying stays in the window.
- **Off-top count.** The B3 notes said 6 `choiceNotTop` decisions; the run file has 7 (all Jev). Corrected above.
- Smoke test: 3 live decisions (Luna and Haiku on an SNG view through `/api/decide`, Luna on a /play table), about $0.0005 by pricing.ts.



## Open Questions (for Kyle)
1. ~~Budget for B4~~ **Resolved 2026-10-10:** $50 total key quota; B4 ≤ $22 (B5 gets $3). Pilot first (2 generations × 4 cards, ≤ $3). Kyle said "go all the way through" (2026-10-10): scale after a passing pilot without stopping to ask, within caps.
2. ~~Base model for strategy cards~~ **Resolved 2026-10-10:** one base model, GPT-6 Luna (reasoning `none`). Whether cards transfer to other base models is untested.
3. ~~Should B1 spectator sessions feed B3's results?~~ **Resolved 2026-10-10:** casual sessions are stored (`data/sessions/`), tagged `source: 'casual'`, and excluded from CIs.

## Out of scope even for bonus
- Real-money or human-vs-human anything.
- Fine-tuning any model: the lab only changes prompts (strategy cards).
- Public leaderboards / deploy (same gate as the main plan).
