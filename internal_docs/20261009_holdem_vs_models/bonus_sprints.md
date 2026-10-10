# Hold'em AI — Bonus Sprints: Spectator, Narrator, Tournaments, Strategy Lab

**Created:** October 9, 2026
**Status:** Not Started · optional · runs only after Sprints 1–4 of [`implementation_plan.md`](./implementation_plan.md) are done
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
- **Budget is the real constraint.** The `holdem-ai-50` gateway key has a $50/month quota shared with the main plan; allocations and the **pilot-before-scale gate** are in `implementation_plan.md` § Budget (B3 ≤ $15, B4 ≤ $25). Every batch command takes `--budget <usd>`, prints a dry-run cost estimate first (from `pricing.ts` × measured avg tokens per decision), and halts cleanly when spend crosses the cap. 
- **Fable's model id:** `anthropic/claude-fable-5.1` (confirmed in gateway `/v1/models` 2026-10-09; $10 / $50 per 1M input/output tokens — the priciest model here, so planner calls only). Add it to `models.ts` as `role: 'planner'` (it's never seated).
- **Table-information rule (Kyle, 2026-10-09) applies to strategy cards too:** a card may hold style/guidance text, but no seat — carded or not — receives computed odds, equity, or hand-strength helpers. `stats.ts` numbers go only to the narrator and Fable, never to seated players.

---

## Sprint B1: Spectator mode `[Not Started]`
**Goal:** pick 2–6 models, hit "Watch", and the hand plays itself, readable at human speed.
**Estimated effort:** 3 hours

#### Tasks
- B1.1 Setup card: a "Your seat" switch (`USwitch`), **Play** or **Watch**. In Watch mode, seat rows go from 1–5 to 2–6 and the button reads "Start the table".
- B1.2 `useTable.ts`: allow zero human seats. Add a `pace` setting (`UFieldGroup`: Pause · 1× · 4× · Max). 1× keeps a ~1.5 s floor per action so it reads like a broadcast; Max drops the floor. Auto-deal the next hand after a 2 s beat unless paused. Stop when one seat has all the chips or at a hand cap (default 100).
- B1.3 God view: every hole card is face up on the seats (dimmed slightly for folded hands), and **reasoning and probabilities show live** in Table talk. Nothing can leak because no human is playing. The only extra code is reusing Sprint 4's unlocked rendering mid-hand.
- B1.4 `ChipRace.vue`: a stack-over-hands line chart per seat, colored by vendor series (follow the `dataviz` skill; reuse 2048-ai's chart approach). Spectator side panel gets tabs: Table talk · Chip race · Stats.
- B1.5 Live stats tab: `shared/utils/stats.ts` → per seat: hands, VPIP, PFR, aggression factor, went-to-showdown %, won-at-showdown %, avg decision ms, cost so far. `UTable`.
- B1.6 Cost meter in the header ("$0.42 this session") with a session cap input (default $2); pause automatically at the cap.

#### Verification (Playwright via subagent)
- [ ] Watch mode with 4 cheap seats (Jev, Luna Decisions, Luna, Haiku) plays 10 hands unattended; chips conserved; no console errors
- [ ] Pause / 1× / Max change pacing; the session cap pauses the table
- [ ] Every seat's hole cards are visible; reasoning shows mid-hand in Watch mode and stays locked in Play mode (regression check)

---

## Sprint B2: Narrator `[Not Started]`
**Goal:** a commentator who explains what just happened and, at the end, what each model is *like*.
**Estimated effort:** 2–3 hours

#### Tasks
- B2.1 `server/api/narrate.post.ts` + `server/utils/narrate.ts`: after each **completed** hand, send the god-view hand history (all hole cards, every action, every Decision's reasoning or probabilities, result) to a narrator model (default `anthropic/claude-sonnet-5.5`, configurable). `generateText + Output.object({ headline, playByPlay (2–4 sentences), keyMoment: { seatId, street, why } })`, following `~/claude-ops/conventions/ai_sdk_usage.md`. It's async and never blocks the next deal; if it's late, it just appears late.
- B2.2 Narration in the UI: a "Booth" entry pinned at the top of Table talk per hand (headline + play-by-play). In Play mode, narration runs only after the hand completes, the same rule as reasoning.
- B2.3 End-of-session **scouting report** (in the summary modal, plus a `Copy as Markdown` button): the narrator gets `stats.ts` output + 3–5 notable hands per seat and writes a profile for each seat: style label (e.g. "loose-passive caller"), tendencies backed by the numbers, a signature hand, how to beat it, and one line on its table-talk voice. Prompt rule: every claim must cite a stat or a hand number.
- B2.4 Cost: narration is one call per hand. Show it as its own row ("Narrator") in the cost table. Add a toggle to turn it off.

#### Verification
- [ ] 10-hand Watch session: every hand gets a headline; the scouting report cites real stats (spot-check 3 claims against `stats.ts` output)
- [ ] In Play mode, no narration appears until the hand completes

---

## Sprint B3: Tournaments + batch runner + trends `[Not Started]`
**Goal:** run many tournaments headless and see who *actually* wins, with error bars.
**Estimated effort:** 4–5 hours

#### Tasks
- B3.1 Engine: blind schedule (`levels: {sb, bb, hands}[]`) and elimination order. Sit-and-go preset: 6-max, 1,500 chips, blinds double every 10 hands (turbo; keeps LLM cost per tournament bounded). Tests: blinds step up on schedule, finish order is correct with simultaneous busts (bigger starting stack places higher).
- B3.2 **Duplicate seeding** (the variance killer): a "match" = the same deck seed replayed once per seat rotation, so every model plays every set of cards from every seat. Without this, 20 tournaments is mostly luck. `shared/utils/duplicate.ts` builds the rotation schedule.
- B3.3 `bench/tournament.ts --lineup jev,openai/gpt-6-luna-decisions,… --matches 10 --format sng|cash --hands 200 --budget 5 --concurrency 4`: dry-run estimate first, then runs and appends one JSON line per hand and one per tournament to `data/runs/<date>_<slug>.jsonl`. Resumable: rerunning skips completed `(seed, rotation)` pairs. A rerun costs nothing (see the idempotent-bulk-processing feedback memory).
- B3.4 `shared/utils/stats.ts` additions: bb/100 per model with **bootstrap 95% CIs** resampled at the match level; tournament finish distribution; head-to-head chip flow matrix; a rating from finish orders (Plackett–Luce fit or plain average finish; pick the simpler one if they agree).
- B3.5 `/results` page: runs list (`UTable`) → run detail: leaderboard with CI bars, finish-position distribution, bb/100 over cumulative hands (does it converge?), and the B2 scouting reports for that run. "Run this lineup again" copies the CLI command (spending stays a terminal action, not a button).

#### Verification
- [ ] **Pilot:** 1 duplicate match (≤ $1) passes the data-quality gate before the 10-match run
- [ ] 10-match duplicate run of 4 cheap models finishes under budget; JSONL is resumable (kill mid-run, rerun, same totals)
- [ ] CIs narrow as matches grow (screenshot at 5 vs 20 matches)
- [ ] Chip conservation holds per hand across the whole run

---

## Sprint B4: Strategy Lab (explore / exploit, run by Fable) `[Not Started]`
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
- [ ] A 2-generation mini-run (4 cards, $3 cap) completes end to end; the explore quota holds; the predictions file was written **before** the first hand (check timestamps)
- [ ] The control card is in every generation; the champion's lead over the control has a CI reported
- [ ] Held-out final runs on seeds never used in training generations (asserted in code)
- [ ] `/lab` renders lineage, verdicts, and the prior-vs-result scatter

---

## Open Questions (for Kyle)
1. ~~Budget for B4~~ **Resolved 2026-10-09:** $50 total key quota; B4 gets ≤ $25. Pilot first (2 generations × 4 cards, ≤ $3), then show Kyle the pilot summary + projected cost before the full run.
2. **Base model for strategy cards:** one cheap model (cleaner experiment, the default) or the top cards crossed across 2–3 base models (tells us whether strategies transfer)?
3. **Should B1 spectator sessions feed B3's results?** It's free data, but those sessions aren't duplicate-seeded. Default: store them, tagged `casual`, and exclude them from CIs.

## Out of scope even for bonus
- Real-money or human-vs-human anything.
- Fine-tuning any model: the lab only changes prompts (strategy cards).
- Public leaderboards / deploy (same gate as the main plan).
