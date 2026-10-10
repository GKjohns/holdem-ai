# Hold'em AI — Implementation Plan

**Created:** October 9, 2026
**Status:** Complete (Sprints 1–4); bonus B1–B4 not started
**Context:** Kyle wants a no-limit Texas Hold'em game where the human sits at a table of AI opponents, each seat a different model: general LLMs (GPT-6, Claude, Gemini) and the new **decision models** (OpenAI's `gpt-6-luna-decisions` and TypeSafe AI's `jev`), which answer typed questions with probabilities instead of writing prose. It's a sibling of `2048-ai`: same stack, same taste, same "watch models think" hook.

**Goal:** `npm run dev` → pick 1–5 AI opponents → play hands of no-limit hold'em against them in a clean UI, see each model's reasoning (or probability spread) revealed after every hand, and get a session leaderboard when you leave or bust.

**Scope:** Single-player, single-browser-tab cash game: fixed blinds, 2–6 seats, full NLHE rules (min-raise, all-ins, side pots, split pots, button rotation, eliminations). Two decider paths behind one action-menu interface. Local dev only — deploy is a follow-up.

---

## Handoff / Execution Notes (read first — this plan is self-contained)

**Repo & runtime**
- Repo: `~/Programming/Workspace/holdem-ai/` (new, its own repo). Nuxt app at the **repo root** (no `src/`, no Supabase, no auth) — deliberately copies the shape of `~/Programming/Workspace/2048-ai/`, not cosmo, because there's no DB/auth/SaaS shell to inherit. The folder currently holds only `.env` (see below) and this `internal_docs/` folder.
- Node 22 (`nvm use 22`). Commands once scaffolded: `npm run dev`, `npm run typecheck` (`nuxt typecheck`), `npm run lint` (`eslint .`), `npm test` (`node --test tests/*.test.ts` — Node's built-in TS stripping, no vitest).
- **Gateway key is already provisioned.** `holdem-ai/.env` (mode 600) contains `AI_GATEWAY_API_KEY` for a dedicated Vercel AI Gateway key named `holdem-ai-50` (team scope, **$50/month quota**, alerts at 50/75/100%; created via `vercel ai-gateway api-keys create`; the earlier $25 `holdem-ai` key was removed). See **Budget** below. Verified working against `openai/gpt-6-sol`, `openai/gpt-6-luna-decisions`, and `typesafe-ai/jev` on 2026-10-09. **Never print, copy, or commit it.** Do not reuse cosmo's or 2048-ai's key.
- Run the app for verification: `npm run dev` → `http://localhost:3000`. Per Kyle's standing preference, start the dev server in the background and open the page early so he can click around.

**Conventions to match** (copy from 2048-ai, file pointers below)
- `package.json` deps: `nuxt ^4.5.2`, `@nuxt/ui ^4.11.1`, `ai ^7.0.68`, `zod ^4.4.3`, `tailwindcss ^4.3.3`, `@iconify-json/lucide`; dev: `@nuxt/eslint`, `eslint`, `eslint-plugin-better-tailwindcss`, `typescript`, `vue-tsc`. No `@ai-sdk/gateway` dep — bare `provider/model` strings resolve through the gateway inside `ai`. `.npmrc`: `legacy-peer-deps=true`.
- `nuxt.config.ts`: `compatibilityDate: '2026-06-30'`, eslint stylistic `commaDangle: 'never'`, `braceStyle: '1tbs'`, `runtimeConfig.aiGatewayApiKey` (maps `AI_GATEWAY_API_KEY`), fonts Geist (sans) + Fraunces (numerals). **Do not** set `future.compatibilityVersion` (reka-ui hydration crash under Nuxt UI v4).
- Styling: `app.config.ts` `primary: 'orange'`, `neutral: 'stone'`; `app/assets/css/main.css` warm-paper token block + `.dark` block + `--series-{openai,anthropic,google,eval}` vendor colors — copy from `2048-ai/app/assets/css/main.css`, drop the tile tokens, add `--felt-bg` / `--felt-border` / `--card-red` / `--card-black` light+dark. Seat badges color by **vendor** (`--series-openai` for Luna Decisions too); the LLM/Decision tag carries the kind. `--series-eval` (ink) is for TypeSafe/Jev.
- Pure engine modules in `shared/utils/` imported with **relative `.ts` paths** (no Nitro auto-imports) so `node --test` and `bench/` scripts run them under bare Node — same as `2048-ai/shared/utils/game.ts` and `server/utils/decide.ts`.
- Nuxt UI primitives first: `UApp`, `UButton`, `UFieldGroup` (v4 has no `UButtonGroup`), `USelectMenu`, `USlider`, `UBadge`, `UCard`, `UAccordion`, `UTable`, `UModal`, `UColorModeButton`, `useToast`. **Deliberate deviation:** the felt/seat layout and playing cards are custom markup — a poker table has no Nuxt UI equivalent. Keep them small, dumb components.
- Comment density: sparse, "why" comments only (match 2048-ai).

**Model call rules (hard-won in 2048-ai — don't relearn them)**
- Every gateway call gets an abort timeout and `maxRetries: 1`. A hung request stalled 2048-ai's benchmark for hours.
- Never send `temperature` (Claude 5 / GPT-6 reject it). `maxOutputTokens: 4000` for LLMs (reasoning tokens count; lower caps return empty output).
- Reasoning effort via top-level `reasoning` (ai@7). Set it explicitly on every OpenAI model (unset = slow). GPT-6 has **no `'minimal'`** — use `'none'`. Leave Haiku unset unless measured.
- `providerOptions: { gateway: { caching: 'auto' } }` on LLM calls (instructions are identical every turn).

**Contracts (spelled out — implement exactly)**

```ts
// shared/utils/cards.ts
type Rank = '2'|'3'|'4'|'5'|'6'|'7'|'8'|'9'|'T'|'J'|'Q'|'K'|'A'
type Suit = 's'|'h'|'d'|'c'
type Card = `${Rank}${Suit}`            // 'As', 'Td'

// shared/utils/table.ts — the engine (pure, immutable-ish: functions return new state)
type Street = 'preflop'|'flop'|'turn'|'river'|'showdown'|'complete'
interface Seat {
  id: string                     // 'you' | 'seat-1'..'seat-5'
  name: string                   // 'You' | model label
  modelId: string | null         // null for the human
  stack: number
  hole: Card[]                   // [] until dealt
  committed: number              // chips put in on the current street
  totalCommitted: number         // chips put in this hand (side pots)
  folded: boolean
  allIn: boolean
  busted: boolean                // stack 0 at hand start → sits out
  actedThisRound: boolean        // reset on each street and for everyone else on a full raise; round closes when all non-folded, non-all-in seats have acted and matched currentBet
  lastAction?: string            // 'raises to 60'
}
interface TableState {
  handNo: number; seed: number; deck: Card[]; board: Card[]
  seats: Seat[]; button: number; toAct: number | null
  street: Street; smallBlind: number; bigBlind: number
  currentBet: number             // highest street commitment
  lastRaiseSize: number          // increment of the last full bet/raise (starts at bigBlind); min legal raise-to = currentBet + lastRaiseSize
  log: ActionEvent[]             // this hand, in order
  result?: HandResult            // set when street === 'complete'
}
type PlayerAction =
  | { type: 'fold' } | { type: 'check' } | { type: 'call' }
  | { type: 'raise'; to: number }        // "raise to" total for the street; bet = raise when currentBet 0
  | { type: 'all_in' }
interface ActionEvent { seatId: string; street: Street; action: PlayerAction; added: number; raiseTo?: number; tableTalk?: string } // added = chips moved from stack this action
interface HandResult {
  pots: { amount: number; eligible: string[]; winners: string[]; handName: string }[]
  shown: Record<string, { cards: Card[]; best5: Card[]; handName: string }>  // seats reaching showdown
  deltas: Record<string, number>
}
// street: 'showdown' is transient (cards turned up, pots being awarded); 'complete' = result set, waiting for "Next hand".
// SeatView — the ONLY thing sent to /api/decide. Contains exactly what a human in that seat could see or be told by
// the dealer (own cards, board, chip counts, pot, amount to call, positions, action history) — nothing derived.
interface SeatView {
  handNo: number; street: Street; board: Card[]; hole: Card[]
  me: { id: string; name: string; stack: number; committed: number }
  pot: number                    // all chips in, incl. current street
  toCall: number; minRaiseTo: number; maxRaiseTo: number   // maxRaiseTo = committed + stack
  canRaise: boolean              // false when a short all-in didn't reopen action for this seat
  bigBlind: number; position: string   // 'button' | 'small blind' | 'big blind' | 'early' | 'middle' | 'cutoff'
  opponents: { id: string; name: string; stack: number; committed: number; folded: boolean; allIn: boolean }[]
  log: ActionEvent[]
}
// API: newTable(config, seed) · startHand(state) · legalActions(state) · applyAction(state, seatId, action)
//      seatView(state, seatId)  // strips every other seat's hole cards — the ONLY thing sent to /api/decide

// shared/utils/menu.ts — the shared action menu every AI picks from
type MenuId = 'fold'|'check'|'call'|'raise_min'|'raise_half_pot'|'raise_pot'|'raise_2x_pot'|'all_in'
interface MenuOption { id: MenuId; action: PlayerAction; label: string; describe: string } // describe = one sentence in words
// buildMenu(view) → only legal options. Sizing: raise_X_pot to = currentBet + X × (pot + toCall)  (pot after calling);
// raise_min to = minRaiseTo. A preset below minRaiseTo is dropped; one ≥ maxRaiseTo collapses into all_in; duplicates deduped.
// No 'fold' when check is free (the human UI still allows it). No raise options when !canRaise.

// POST /api/decide   body: { modelId: string, view: SeatView }   (zod-validated)
interface Decision {
  menuId: MenuId; action: PlayerAction
  reasoning: string                 // LLM prose; for decision models: built from option text + ranked probs
  tableTalk?: string                // LLM only; truncated server-side to 80 chars; must not reveal cards
  probabilities?: Partial<Record<MenuId, number>>   // decision models only (legal ids only)
  fallback: boolean; requested?: string    // illegal choice OR timeout/model error → decide() returns a fallback (check if free, else fold); it does not throw
  model: string; latencyMs: number; usage: { input: number; output: number }
}
// errors: 503 if aiGatewayApiKey missing · 400 bad body. Model errors/timeouts come back as 200 + fallback: true.
// Client fetch timeout 35 s (> server's 30 s) so the server's fallback wins; a network failure client-side also falls back to check/fold.
// Shared types (Card, Seat, TableState, SeatView, PlayerAction, MenuId, Decision) live in shared/utils/types.ts.
```

**Decider paths (both in `server/utils/decide.ts`, branch on `ModelOption.kind`)**
- `kind: 'llm'` → `generateText({ model, instructions, prompt, output: Output.object({ schema }) , ... })`. Schema: `{ reasoning: string (1–2 sentences), tableTalk: string (required — empty string allowed; no zod `.max()`, truncate server-side), choice: z.enum(legal menu ids) }`. Required fields only: strict structured output on OpenAI rejects optionals. Prompt = seat view rendered as text + menu (`id — describe`) + this hand's action log.
- `kind: 'evaluation'` → `experimental_evaluate as evaluate` from `'ai'`: `state` = the seat view as a JSON object (same table information the LLMs get — no precomputed hand strength or odds), `questions: { action: { type: 'choice', instructions, criteria: Record<MenuId, describe> } }`. Read `result.answers.action.choice` + `.probabilities` (may be missing → `{}`). Verified 2026-10-09: Luna Decisions 300 ms, Jev 262 ms; both returned `{type:'choice', choice, probabilities}`. **`evaluate()` has no `reasoning` param** (`ai/dist/index.d.ts:7750`) — Luna Decisions advertises effort levels, but they'd go through `providerOptions`; Sprint 2 finds the key or leaves it at default.
- Timeout: **30 s** (not 2048-ai's 60 s — a player waiting a minute is worse than a fallback fold). `decide()` catches timeout/model errors and returns a fallback Decision (so `bench/selfplay.ts`, which calls `decide()` directly, gets the same behavior).

**Execution order & rules**
- Sprint 1 is foundational (scaffold + engine + `types.ts` + `models.ts` + tests). After it, **Sprints 2 and 3 can run in parallel** (disjoint files: 2 owns `server/`, `shared/utils/pricing.ts`, `bench/`; 3 owns `app/`). Until Sprint 2 lands, Sprint 3 runs against a throwaway `server/api/decide.post.ts` stub only if needed — Sprint 2 overwrites it. Sprint 4 is sequential after both.
- Per-sprint loop: implement → `npm run typecheck && npm run lint && npm test` → Playwright check for UI sprints (delegate to a subagent; screenshots stay out of the main loop) → update this file's sprint status + deviations → report.
- Phase 5 verification artifact (`verification/index.html` + `.webp` screenshots) is required before calling it done.

**Budget (Kyle, 2026-10-09): $50 total across this plan + bonus sprints.** The key's quota is the hard stop; these are the soft allocations:

| Phase | Cap |
|---|---|
| Sprints 1–4 (dev + verification) | $3 |
| B1 + B2 (spectator/narrator testing) | $5 |
| B3 tournaments (pilot + full) | $15 |
| B4 Strategy Lab (pilot + full) | $25 |
| Reserve | $2 |

**Pilot-before-scale rule:** every batch run (Sprint 2 self-play, B3, B4) starts with a small pilot (≤ 10% of its cap) and must pass a data-quality gate before scaling. The gate: (1) zero engine errors and chips conserved, (2) fallback + parse-error rate < 5% per model, (3) no degenerate model (e.g. folds > 90% or never raises; it means the prompt or menu is broken, not that the model is bad), (4) measured cost per hand within 2× of the dry-run estimate, (5) the output files contain every field the analysis needs (spot-check that a stats/results page renders from them). Failed gate → fix and re-pilot, never scale. **Before any spend above $5 in one run, show Kyle the pilot summary and the projected cost.**

**Commit/push policy:** `git init` + local commits per sprint are fine. **Do not** create a GitHub repo, push, or create a Vercel project without Kyle's go-ahead.

---

## Current State

### What Exists
- `holdem-ai/.env` with the dedicated gateway key; this plan folder (`implementation_plan.md`, `storyboard.html`).
- Prior art to copy from (read, don't modify): `2048-ai/shared/utils/rng.ts` (mulberry32 seeded RNG), `server/utils/decide.ts` (LLM + Jev branching, `withTimeout`, fallback), `server/api/move.post.ts` (route skeleton), `shared/utils/models.ts`, `shared/utils/pricing.ts`, `app/components/AgentLog.vue`, `app/composables/useAgent.ts` (abortable client loop), `app/assets/css/main.css`.

### What Changes
- Everything — new repo.

### What Stays
- 2048-ai is untouched (read-only reference). Other projects' gateway keys untouched.

---

## Architecture

```
 browser (all game state lives here; refresh = new session)
 ┌──────────────────────────────────────────────────────────┐
 │ useTable() ── engine (shared/utils/table.ts) ──┐          │
 │   human acts → applyAction                      │          │
 │   AI seat to act → seatView(state, seat) ───────┼─► POST /api/decide
 │                    ◄── Decision ────────────────┘          │
 │   applyAction(menu option) → next seat / street / showdown │
 └──────────────────────────────────────────────────────────┘
 server /api/decide: buildMenu(view) → decide()
        ├─ llm:        generateText + Output.object  → gateway
        └─ evaluation: experimental_evaluate (choice) → gateway (luna-decisions, jev)
```

Trust note: the engine runs client-side, so a curious human could read AI hole cards in devtools. Accepted — it's single-player and cheating only cheats yourself. What matters is that **models never see other seats' cards**: the server only ever receives a `seatView`.

---

## Models (initial roster — `shared/utils/models.ts`)

| Label | id | kind | reasoning |
|---|---|---|---|
| GPT-6 Sol | `openai/gpt-6-sol` | llm | `low` |
| GPT-6 Astra | `openai/gpt-6-astra` | llm | `low` |
| GPT-6 Luna | `openai/gpt-6-luna` | llm | `none` |
| Claude Opus 5.5 | `anthropic/claude-opus-5.5` | llm | `low` |
| Claude Sonnet 5.5 | `anthropic/claude-sonnet-5.5` | llm | `low` |
| Claude Haiku 5.5 | `anthropic/claude-haiku-5.5` | llm | unset (measure in Sprint 2) |
| Gemini 3.1 Pro | `google/gemini-3.1-pro-preview` | llm | `low` |
| GPT-6 Luna Decisions | `openai/gpt-6-luna-decisions` | evaluation | default (see Decider paths) |
| Jev | `typesafe-ai/jev` | evaluation | — |

All ids confirmed present in the gateway's `/v1/models` on 2026-10-09. Default lineup: Sol, Opus 5.5, Luna Decisions, Jev (5-handed with you).

---

## Storyboard

Interactive mock: [`storyboard.html`](./storyboard.html) — open it in a browser; buttons, selects, and the raise slider work.

1. **Setup** — pick 1–5 opponents (grouped Language / Decision models), stack + blinds, "Deal me in". *Sprint 3*
2. **Mid-hand, AI thinking** — flop out, one seat pulsing "thinking…", action bar disabled, table-talk log with reasoning locked. *Sprint 3*
3. **Your turn** — action bar live: fold / call / raise presets + slider. *Sprint 3*
4. **Showdown + hand review** — cards up, winning five highlighted, chip deltas; the table-talk panel unlocks per-seat reasoning / probability bars by street. *Sprint 4*
5. **Session summary** — leaderboard modal: net chips, hands won, avg decision time, cost. (Storyboard shows a VPIP column — cut from v1.) *Sprint 4*

---

## Sprint Breakdown

### Sprint 1: Scaffold + poker engine — Foundational `[Complete]`
**Goal:** a booting Nuxt shell and a fully tested, pure NLHE engine.
**Estimated effort:** 3–4 hours

#### Tasks
- 1.1 Scaffold by copying 2048-ai's config files (not its app code): `package.json` (rename, same deps/scripts), `.npmrc`, `nuxt.config.ts`, `eslint.config.mjs`, `tsconfig.json`, `app/app.config.ts`, `app/assets/css/main.css` (tokens per Handoff notes), `.gitignore` (must include `.env`, `.data`, `.output`, `.nuxt`, `node_modules`, `.playwright-mcp`). `.env.example` with `AI_GATEWAY_API_KEY=` only. `app/app.vue` shell: header (wordmark "Hold'em AI", color mode button), `NuxtPage`. `npm install`, `git init`, first commit.
- 1.2 `shared/utils/types.ts` — every type in the Contracts block. `shared/utils/rng.ts` — copy mulberry32 from 2048-ai. `shared/utils/cards.ts` — `fullDeck()`, `shuffle(deck, rng)`, `cardLabel`, `parseCard`. `shared/utils/models.ts` — roster table below (`{ id, label, vendor, kind: 'llm'|'evaluation', reasoning? }` with `Reasoning = 'none'|'low'|'medium'|'high'` — widened from 2048-ai's, which has `'minimal'` and no `'none'`), `findModel`, `DEFAULT_LINEUP`.
- 1.3 `shared/utils/handRank.ts` — `rankHand(cards)` 7-card evaluator (named to avoid confusion with `experimental_evaluate`): best of 21 five-card combos → `{ rank: number (comparable), category, best5, name }` ("Two pair, aces and sevens"). Wheel (A-2-3-4-5) straight, kicker comparisons.
- 1.4 `shared/utils/table.ts` — engine per the contract. Rules it must get right:
  - Blinds: short stack posts what it has and is all-in. Heads-up: button posts SB, acts first preflop, **acts last postflop**.
  - Round closure via `actedThisRound`; BB gets its preflop option when limped to.
  - NLHE min-raise via `lastRaiseSize`; an all-in smaller than a full raise does **not** reopen action for seats that already acted (`canRaise: false` in their view).
  - Uncalled portion of a bet is returned before pots are built. Side pots from `totalCommitted`; odd chip to first winner left of button.
  - Fold-to-one ends the hand without showdown (winner's cards not shown). When ≤ 1 seat can still act and others are all-in, run out the board and go to showdown.
  - Human may fold even when check is free. Button rotation skips busted seats.
  - `seatView`, `legalActions`.
- 1.5 `shared/utils/menu.ts` — `buildMenu(view)` per contract (labels/describe in words with chip amounts and the resulting pot size — e.g. `Call 40 (pot becomes 170)`; never odds, hand strength, or any other computed judgment).
  - Also `menuToAction`.
- 1.6 `tests/` — `handRank.test.ts` (each category, kickers, wheel, ties), `table.test.ts` (blinds/heads-up order pre + post flop, BB option, min-raise, short all-in not reopening, short-stack blind, uncalled bet return, all-in runout, 3-way side pot, split pot, fold-through, bust + button skip, chip conservation invariant across 500 seeded random-action hands), `menu.test.ts` (sizing formula, dedupe into all-in, below-min presets dropped, no check when facing bet, no raises when `!canRaise`).

#### Verification
- [x] `npm test` green; chip-conservation property test passes on 500 seeded hands (29 tests: 6 handRank, 17 table, 6 menu; the 500-hand walk covers 106 tables, 330 showdowns, 117 multi-pot hands, 28 no-reopen spots, 14 splits)
- [x] `npm run typecheck && npm run lint` clean
- [x] `npm run dev` boots: `/` returns 200 with the "Hold'em AI" header and the color-mode toggle; dark tokens are defined. Dark mode was not screenshotted; Sprint 3's Playwright pass covers it.

#### Notes & deviations (2026-10-09)
- **Extra exports:** `TableConfig { players, stacks: number | number[], smallBlind, bigBlind }` and `LegalActions { seatId, toCall, canCheck, canRaise, minRaiseTo, maxRaiseTo }` in `types.ts`. `table.ts` also exports `potTotal`, `positionOf`, `activeSeatCount`, and `withTableTalk(state, seatId, text)`, which attaches table talk to the latest log event so Sprint 3 can store it after `applyAction`. `handRank.ts` exports `compareHands` and `RankedHand`; `cards.ts` exports `rankValue`, `suitOf`, `RANKS`, `SUITS`.
- **No `showdown` resting state:** the engine passes through `'showdown'` and returns `'complete'` with `result` set, so the UI stages the reveal itself.
- **After a hand,** `totalCommitted` and `committed` keep the hand's values for display, but the pot has already been paid into stacks. Count chips as the sum of stacks once `street === 'complete'`.
- **Busted seats** are marked `folded: true` as well as `busted: true` so every "in hand" check skips them. The UI should check `busted` first. They are left out of `SeatView.opponents` and `result.deltas`.
- **Blinds are not `ActionEvent`s** (`PlayerAction` has no post). They show as `seat.lastAction` ("posts big blind 10") and in `committed`. Sprint 2's prompt should describe the blinds from `position` + `committed`.
- **Rule decisions:**
  - Callers owe the full big blind even when the BB is short (`currentBet = bigBlind`).
  - Re-raise eligibility for a seat that already acted is `currentBet − committed ≥ lastRaiseSize`. Short all-ins don't reopen action, but several short all-ins that add up to a full raise do, which is the TDA cumulative rule.
  - `canRaise` is false when no other live seat has chips behind. A lone seat that already covers every all-in opponent gets no decision and the board runs out (e.g. heads-up with the BB all-in for less than the SB).
  - Uncalled chips are returned at the end of each betting round, not only at hand end, so the pot shown during an all-in runout is correct.
  - Odd chips go one at a time to the winners in seat order starting left of the button.
  - The button moves to the next seat with chips (moving button, no dead-button rule).
  - The first hand's button is seat 0, the human.
  - Each hand's deck is seeded with `seed ^ handNo·φ`, so a hand replays from `(seed, handNo)`.
  - The engine burns a card before each street.
- **Menu wording:** for example `Raise to 250, raising by the size of the pot (pot becomes 400)`, `Bet 50, betting half the pot (...)`, `Go all-in, raising to 1000 (...)`. A short call reads `Call 40 (all-in)`. When `minRaiseTo === maxRaiseTo` the menu shows only `all_in`. Menu `currentBet` is derived as `me.committed + toCall`, which only matters when `canRaise` is true.
- **Tooling:** `.npmrc` keeps `legacy-peer-deps=true`. `server/` doesn't exist yet; Sprint 2 creates it. The favicon is a spade on felt green.

---

### Sprint 2: Deciders + API + self-play harness `[Complete]`
**Goal:** any model can make a legal poker decision through `/api/decide`, proven by an all-AI self-play run.
**Estimated effort:** 3 hours

#### Tasks
- 2.1 `shared/utils/pricing.ts` — USD per 1M input/output tokens for the 9 roster ids (2048-ai lacks Sonnet/Haiku 5.5 and luna-decisions; pull those from gateway `/v1/models` pricing). Try `providerOptions` for Luna Decisions effort (e.g. `{ openai: { reasoningEffort: 'low' } }`); keep it only if a warning-free call shows a latency/answer difference, else leave default and note it in `models.ts`.
- 2.2 **No facts module (Kyle's call, 2026-10-09):** AIs get only what a human at the table has. Hand strength, odds, and equity are the model's job — via reasoning (LLMs) or intuition (decision models). Instructions may state the rules of hold'em and hand rankings (a human player knows those), not strategy math.
- 2.3 `server/utils/decide.ts` — `decide({ modelId, view, signal })` per "Decider paths". Plain module with relative imports (runs under bare Node). LLM instructions: rules summary, "you are seat X playing against <model labels>", output contract, "tableTalk is in-character banter, never reveal or hint your exact cards". Decision-model reasoning string: chosen option's `describe` + top probabilities, e.g. `Call 40 (pot becomes 170) — call 81%, raise 18%`.
- 2.4 `server/api/decide.post.ts` — zod-validated `{ modelId, view }`, 503/400 per contract (copy `2048-ai/server/api/move.post.ts` skeleton). The menu is built server-side from the view.
- 2.5 `bench/selfplay.ts` — `node bench/selfplay.ts --hands 20 --models jev,openai/gpt-6-luna-decisions,openai/gpt-6-luna` runs an all-AI table through the engine + `decide()` directly, prints each action + final stacks + cost. Default to the two decision models + Luna (cheap). Also measure Haiku 5.5 latency unset vs `low` and record the pick in `models.ts` doc comment.

#### Verification
- [x] `curl -X POST localhost:3000/api/decide` with a fixture view returns a legal `Decision` for one LLM, Luna Decisions, and Jev (GPT-6 Sol fold 2.8 s, Luna Decisions fold 83% in 0.18 s, Jev call 59% in 0.25 s). Requests and responses are in `verification/samples/`.
- [x] Self-play 20 hands with 3 cheap models: zero engine errors, chips conserved, 0% fallback for all three (`samples/selfplay-20.{txt,json}`). This ran only after the 5-hand pilot passed the gate.
- [x] Missing key → 503 with "AI_GATEWAY_API_KEY is not set. Add it to .env and restart the dev server." Tested on a keyless copy on port 3011 (`samples/response-missing-key.json`).
- [x] Spend for the sprint < $2: about $0.03 by the summary printouts (20-hand run $0.0124, pilots $0.006, Haiku check $0.002, samples and probes under $0.005)

#### Notes & deviations (2026-10-09)
- **Files:** `server/utils/decide.ts`, `server/api/decide.post.ts`, `shared/utils/pricing.ts` (`PRICING` + `costUsd`), `bench/selfplay.ts`, `bench/latency.ts`. `models.ts` changed only in a doc comment and Haiku's `reasoning`.
- **`experimental_decide`, not `experimental_evaluate`:** ai@7 marks `experimental_evaluate` as a deprecated alias of `experimental_decide`. They are the same function.
- **Luna Decisions refusals:** in the first pilot, Luna Decisions refused one flop spot (`DecisionRefusalError`, top set facing a check) on 4 of 4 tries. That was a 6.3% fallback rate, so the pilot failed the gate. Rewording the question fixed it, so `decide()` now retries a refusal once with "Which option is the best poker play here?". After that, the re-pilot and the 20-hand run had 0 fallbacks. Refusals are only logged (`[decide] refusal, retrying reworded`) and are not on `Decision`. B3 should grep for them.
- **Luna Decisions effort:** `providerOptions.openai.reasoningEffort` comes back as an `unsupported` warning, with the same answer and latency. It stays at default, as noted in `models.ts`.
- **Haiku 5.5 → `reasoning: 'low'`:** on 5 views, unset averaged 2.5 s with a 4.5 s / 497-token thinking tail. `low` averaged 1.6 s and made the same choice on 4 of 5 (`samples/haiku-latency.txt`).
- **What the models see:** the human's seat is named "You", so prompts call it "Human player". Blinds aren't log events, so on preflop each seat's blind is shown as `committed − logged preflop chips`. Decision models get the same facts as JSON (`tableState`) and the menu `describe` strings as criteria.
- **Route order:** a missing key returns 503 before the body is validated (400).
- **Self-play harness:** busted seats rebuy between hands, and chip conservation is checked against starting chips plus rebuys. `--dry-run` plays passive-leaning random actions and estimates tokens as chars/4, scaled by input tokens measured on the fixture (LLM ×1.3, Luna Decisions ×1.9, Jev ×3.1). The first estimator used uniform random play and raw chars/4. It said $0.00025/hand, and the first pilot measured $0.00065, 2.6× over. Random play folds hands away early, and the decision models' JSON costs more tokens than chars/4 counts. I recalibrated the estimator instead of loosening the gate. The new estimate is $0.0006/hand, and the 20-hand run measured $0.00062/hand. `--out` writes `{ summary, decisions }`, but not views.
- **Engine gap (for Sprint 4 / B3, not fixed here):** `SeatView` has no seat order or opponent positions, so a model can't tell who has the button except from the order of the action log.

---

### Sprint 3: Setup screen + playable table `[Complete]`
**Goal:** a human can sit down, pick opponents, and play complete hands in the browser.
**Estimated effort:** 4 hours

#### Tasks
- 3.1 `app/pages/index.vue` — setup card (storyboard frame 1): 1–5 `USelectMenu` seats grouped by kind, add/remove, stack (500/1,000/2,000) and blinds (5/10, 10/20) selects, "Deal me in" → `/play`. Lineup kept in `useState` (refresh = new session). Debug: `/play?stacks=100,500,1000,1000,1000` overrides starting stacks (for side-pot screenshots).
- 3.2 `app/composables/useTable.ts` — owns `TableState`; loop: when `toAct` is an AI seat, POST `seatView` to `/api/decide` (AbortController + run id like `useAgent.ts`, 35 s client timeout), enforce a minimum 700 ms "thinking" display so decision models don't feel instant, apply action, advance; when a Decision has `fallback: true` (or the fetch itself fails → client-side check-else-fold) toast "Claude Opus 5.5 timed out — checked". Stores every `Decision` per hand for Sprint 4's review. Auto-deals next hand only on user click.
- 3.3 Components: `PlayingCard.vue` (face/back, sm/md sizes), `PokerTable.vue` (felt + seat positions for 2–6 players, human bottom-center, board + pot center), `SeatPod.vue` (name, vendor `UBadge` in series color, LLM/Decision tag, stack in Fraunces, bet pill, dealer button, thinking pulse / folded dim / all-in badge / last action), `ActionBar.vue` (Fold / Check-or-Call N / raise presets Min · ½ pot · Pot · All-in + `USlider` + amount; disabled with "Waiting on X…" when not your turn), `TableTalk.vue` (newest-first log; LLM table talk in quotes; reasoning locked mid-hand — Sprint 4 unlocks it inline).
- 3.4 `app/pages/play.vue` — grid `lg:grid-cols-[minmax(0,1fr)_360px]`, stacks on mobile; header shows hand #, blinds, "Leave table". Redirect to `/` if no lineup.

#### Verification (Playwright via subagent)
- [x] Setup → Deal me in → table renders 5 seats, blinds posted, hole cards shown (screenshot, light + dark) — `sprint3_setup.webp`, `sprint3_setup_menu.webp`, `sprint3_your_turn.webp`, `sprint3_your_turn_dark.webp`
- [x] An AI seat shows thinking state then an action; log updates — `sprint3_ai_thinking.webp`
- [x] Human fold / call / raise (preset + slider) all advance the hand; illegal amounts impossible — `sprint3_raise_preset.webp` (Pot preset = 35 at 5/10 preflop; slider arrows move it; typing 5 or 99999 snaps back into range)
- [x] Play 3 full hands to completion incl. one showdown; no console errors — `sprint3_showdown.webp`, `sprint3_mobile_390_result.webp` (3-way all-in)
- [x] 390 px wide viewport: no horizontal scroll, action bar usable — `sprint3_mobile_390.webp` (scrollWidth 390)
- [x] Watch mode (added): 4 cheap seats at Max, ~20 hands unattended, chips conserved (sum 4,000), live reasoning / table talk / probability bars, Pause · 1× · 4× · Max — `sprint3_setup_watch.webp`, `sprint3_watch_mode.webp`, `sprint3_watch_mode_dark.webp`
- [x] Play mode keeps reasoning sealed mid-hand: `tests/reveal.test.ts` + Playwright DOM check (0 reasoning/probability nodes before the hand ends)

#### Notes & deviations (2026-10-09)
- **Watch mode pulled in from B1.1–B1.3 (Kyle).** Setup has a "Your seat" Play / Watch `UFieldGroup`; Watch takes 2–6 AI seats (ids `seat-1`..`seat-6`, no `you`) and the button reads "Start the table". `useTable` allows zero human seats and has `pace` (Pause · 1× · 4× · Max = 1.5 s / 0.4 s / 0 floor per action), auto-deals after a beat, and stops when one seat holds every chip or at 100 hands. Every hole card is face up; Table talk shows reasoning, table talk and probability bars live. `WatchBar.vue` replaces the action bar. The engine needed no change. Chip race, stats tab, cost meter and narrator stay in B1/B2.
- **Information hygiene:** `app/utils/reveal.ts` (`canRevealReasoning`, `canShowHoleCards`) is the single gate, tested in `tests/reveal.test.ts`. In Play mode `play.vue` passes Table talk an empty decision map until `street === 'complete'`, so reasoning never reaches the DOM mid-hand. Once a Play hand completes the inline reasoning/probabilities show (Sprint 4 can restyle that as the per-seat accordion).
- **Finished hands stay up (Kyle):** board, showdown cards and final bets stay until the next deal; a result strip over the felt ("Jev wins 340 with two pair, …", one clause per pot) and a per-seat +/− chip pill. On < 640 px the final bet pills hide to make room for the strip. Watch-mode deal beat is 4 s at 1×, 2 s at 4×, 1 s at Max; pausing during the beat restarts it on resume.
- **Storyboard deviations:** felt/card tokens now use the storyboard's sage felt (`--felt-bg #a4ae9f`, plus `--felt-ink`, `--card-bg`, `--back-a/b`), replacing Sprint 1's deep green. Hand # / blinds / Leave table live in the app header via `useTableHeader()` (Leave currently returns to `/`; Sprint 4 swaps in the summary modal by watching `leaveRequests`). Probability bars group menu ids into fold / check / call / raise (`DecisionDetail.vue`, reusable by Sprint 4).
- **Debug params:** `/play?stacks=…` (per Sprint 3.1), plus `?seats=jev,gpt-6-luna` (id or suffix) and `?mode=watch`, which skip the setup screen.
- **For Sprint 4:** `useTable().decisions` holds every `DecisionRecord { handNo, seatId, street, logIndex, decision }` for the session; `actionLabels` holds the engine's per-event text. `SeatPod` takes `delta`/`handName`/`shown`; `PlayingCard` takes `emphasis: 'hi' | 'lo'` for best5 highlighting (not wired yet).
- **Known issues:** `UInputNumber` resets an out-of-range typed value to the min rather than clamping to the max (still legal). The decision models sometimes choose an option that isn't their top probability (seen on Luna Decisions); worth a look in Sprint 2/4. `sprint3_showdown.webp` predates the result strip, chip pills and bar-color fix; `sprint3_watch_mode.webp` shows the final look. Spend: about 25 hands of real play (mostly the Watch run at Max, which went longer than planned), cheap seats only.

---

### Sprint 4: Showdown review, session summary, docs `[Complete]`
**Goal:** the "watch models think" payoff, and a reason to play one more session.
**Estimated effort:** 2–3 hours

#### Tasks
- 4.1 Showdown on the table: reveal shown hands, highlight `best5`, winner ring, per-seat chip delta, hand name per pot (side pots labeled "Side pot 2"). "Next hand" button.
- 4.2 Hand review inside `TableTalk.vue` (no separate component): at `street === 'complete'` the lock lifts and a `UAccordion` per AI seat shows each decision by street — LLM reasoning prose / decision-model probability bars (`UProgress` per option), latency, fallback badge.
- 4.3 `SessionSummary.vue` — `UModal` on "Leave table" or when the human busts: `UTable` with player, net chips, hands won, avg decision ms, cost (`pricing.ts` × usage). "Play again (same table)" / "New table".
- 4.4 AI eliminations: busted seats show "busted" and sit out; if all AIs bust, show summary with "You cleaned out the table".
- 4.4a **Hand history + chip trends (Kyle, 2026-10-09: "the game happens and it just looks like it disappears").** Pulls B1.4 into the main build.
  - `useTable` keeps a session history: per completed hand → `{ handNo, board, pots (amount, winners, handName), deltas, stacksAfter, shown, decisions }`. In memory only.
  - Side panel gets tabs (`UTabs`): **Table talk · Hands · Chips**.
    - **Hands:** newest-first list of completed hands — `#14 · Jev won 340 (two pair) · board A♠7♣2♥9♦K♣`, your/seat deltas as colored chips; click to expand → the full action log + revealed reasoning for that hand (reuses the 4.2 review rendering).
    - **Chips:** stack-over-hands line chart, one line per seat in vendor series colors (inline SVG, no chart lib; follow the `dataviz` skill), plus a current-stacks bar list sorted by stack with net +/- since start.
  - Works in both Play and Watch modes; Watch mode keeps Hands/Chips live as hands auto-deal.
- 4.4b Follow-ups from Sprint 2:
  - **SeatView gap:** add seat order + each opponent's position (button/SB/BB/…) — a human at the table sees where everyone sits. Additive field; update `menu`/prompt rendering and tests.
  - Record refusal retries on the `Decision` (`retried: true`) instead of only logging, so B3 can count them.
  - Prompt names the human seat "Human player"; fine for Play mode, must not appear in Watch mode.
  - GPT-6 Luna repeats one table-talk line; add a "vary your table talk, don't repeat earlier lines" instruction and pass the seat's prior lines this session.
- 4.5 `README.md` (what it is, roster, how decision models differ, how to run, env) and `AGENTS.md` (engine-is-pure rule, relative imports, model-call rules, key-handling rule). Fix the 2048-ai mistake: point at files that exist.

#### Verification (Playwright, run in the main loop)
- [x] Showdown screenshot: cards revealed, winning five lifted and the rest dimmed, winner ring, result line, review panel with GPT-6 Sol's reasoning and per-option bars for Jev + Luna Decisions — `sprint4_showdown.webp` (re-take of `sprint3_showdown`, now with the result line), `sprint4_review_luna_decisions.webp` (4 decisions, preflop to river)
- [x] Side pot via `/play?stacks=100,500,1000,1000,1000`: "Main pot · Luna Decisions wins 201 … / Side pot · Luna Decisions wins 294 …", 495 total — `sprint4_side_pot.webp`
- [x] Leave table → summary modal; GPT-6 Sol row $0.019 after 3 hands — `sprint4_summary_leave.webp`; Watch-mode Leave pauses the table under the modal — `sprint4_summary_watch.webp`
- [x] Bust the human → "You're out of chips" summary opens by itself — `sprint4_summary_busted.webp` (and again on the side-pot hand)
- [x] 4.4a after 10 Watch hands at Max: Hands tab (newest first, board + colored chip swings, expanded hand shows every hole card and the full log with reasoning) — `sprint4_hands_tab_watch.webp`; Chips tab (stack lines with crosshair tooltip, legend, current-stacks bars with net) — `sprint4_chips_tab_watch.webp`
- [x] Typed raise above max clamps to all-in (99999 → 1,000, button "All-in 1,000"); typed 5 clamps to the min (20)
- [x] Play mode still sealed mid-hand (0 reasoning/probability nodes); 390 px wide with the Chips tab open: no horizontal scroll; no console errors this session
- [x] `npm test` (39 tests, +3 prompt, +3 session, +1 seating), `npm run typecheck`, `npm run lint` green

#### Notes & deviations (2026-10-10)
- **New components:** `HandLog.vue` (the action log, pulled out of `TableTalk.vue` so the live panel and the Hands tab share it), `HandReview.vue` (the 4.2 per-seat accordion), `HandHistory.vue` (Hands tab), `ChipChart.vue` (Chips tab), `SessionSummary.vue`. The plan said "no separate component" for 4.2; reusing the review in the Hands tab needed one. `TableTalk.vue` is now the tabbed panel (`UTabs`: Table talk · Hands · Chips). Pure numbers live in `app/utils/session.ts` (`summaryRows`, `stackSeries`, `potLabel`, `potSentence`) with `tests/session.test.ts`.
- **Hand review placement:** in Play mode, when the hand ends the review replaces the live log in the Table talk tab (as in storyboard frame 4). The first LLM seat opens by default. Each decision shows street, action, latency, table talk, and either the reasoning or one `UProgress` row per option ≥ 1% (the chosen one in primary). The full chronological log for that hand is in the Hands tab. Watch mode keeps the live log, since hands auto-deal after a short beat. The compact fold/call/raise strip stays in the live log.
- **`useTable` additions:** `history: HandRecord[]` (`handNo, board, button, pots, shown, deltas, stacksAfter, holes, log, actionLabels, blindsNote, decisions`), `startingStacks`, `startedAt`, `reset()` (same seats and stacks, new seed), `resume`. A decision's `logIndex` is now taken before the action is applied, and a hand is recorded right after its last decision is pushed, so the record includes it.
- **Hole cards in history:** `HandRecord.holes` keeps every seat's cards, but the Hands tab shows them through `canShowHoleCards`, so Play mode shows only showdown cards and your own.
- **Chip chart (dataviz skill):** inline SVG with 2 px lines, end dots with a surface ring, hairline grid, three compact y ticks, a crosshair that snaps to the nearest hand, a tooltip with line keys, and a legend. Direct end labels appear only with ≤ 4 seats whose end points are ≥ 11 px apart. Hue follows the vendor `--series-*` colors, and a second or third seat sharing a hue is dashed or dotted. **The human needs its own chart hue:** primary orange is ΔE-indistinguishable from `--series-openai`, so I added `--series-human` (light `#b03a8c`, dark `#b04fb0`). `validate_palette.js --pairs all` passes for both against the three vendor hues (worst CVD ΔE 9.2 light / 8.8 dark). Jev's ink `--series-eval` fails the validator's chroma and lightness checks by design, because it's the neutral; it was kept as is. The human stays primary everywhere else on the table.
- **Pot labels:** "Main pot / Side pot", or "Side pot 1, Side pot 2" when there are several (standard usage, rather than the plan's "Side pot 2" for the first side pot). Labels appear only on multi-pot hands. The best-five highlight uses the main-pot winner's `best5`; that is the best hand at showdown.
- **Summary:** it opens on Leave, and on its own when `finished` fires: you busted, "You cleaned out the table" when you hold every chip, or a Watch table that ends or hits the cap. Avg decision and cost are "—" for you. Costs under $0.001 show four decimals. Closing the modal resumes; Watch mode is paused while it's open. "Play again (same table)" resets in place; "New table" goes to `/`.
- **4.4:** busted seats show a red "Busted" badge and sit out (the engine already skipped them).
- **4.4b:** `SeatView` gains `opponents[].position`, `seatOrder` (ids clockwise from the button) and an optional client-filled `priorTableTalk` (the seat's last ≤ 6 distinct lines this session). `seatView()`, the zod schema (new fields optional), the prompt ("Seating, clockwise from the button: …", positions on each opponent line, "Table talk you already said…"), the decision-model JSON (`seating_clockwise_from_button`, `opponents[].position`) and the tests were updated together. `Decision.retried` is set when Luna Decisions refuses and the reworded retry answers, and the review shows a "refused once, asked again" badge. `tests/prompt.test.ts` checks that a Watch-mode prompt and its JSON never mention a human. The instructions now say to vary table talk.
- **Raise input:** `UInputNumber` no longer gets `min`/`max`; it reset out-of-range input to the min. A watcher clamps to [min raise, all-in] instead.
- **4.5:** `README.md` (what it is, roster, the two decider kinds, the app, a code map that only names files that exist, setup, env) and `AGENTS.md` (pure engine + relative `.ts` imports, `seatView` as the only model input and the checklist for adding a field, reveal gate, model-call rules, key handling).
- **Spend:** about $0.05 over about 24 hands. That's more hands than the 15 planned: getting a side pot took 8 hands at the short-stack table. Gateway-reported per-seat costs from the summaries: Watch table (Jev, Luna Decisions, Luna, Haiku, 10 hands) $0.020; Sol table (3 hands) $0.019; side-pot table and checks under $0.01. Well under the $1 cap.
- **Known issues / not verified in the browser:** "You cleaned out the table" (needs every AI to bust) is wired but wasn't reached. The table still shows final bet pills after a hand (Sprint 3 behavior), including a seat's uncalled bet. A Sprint 3 HMR-era `Cannot read properties of null (reading 'hole')` render error was in the Playwright console history from before this session; it didn't recur. The decision models still sometimes pick an option that isn't their top probability (visible now in the review bars).

---

## Phase 5: Verification artifact
`internal_docs/20261009_holdem_vs_models/verification/index.html` + `screenshots/*.webp` (cwebp q72, cap 1400 px) + `samples/` (one `/api/decide` response per decider kind, self-play printout). One section per sprint, captioned screenshots, golden-path run at the end.

## Reference Docs
- [`bonus_sprints.md`](./bonus_sprints.md) — optional Sprints B1–B4 (spectator mode, narrator, tournaments + batch runner, Fable-run Strategy Lab). Run only after Sprints 1–4; each stops cleanly on its own. Storyboard frames 6–7.
- [`storyboard.html`](./storyboard.html)

## Environment / Config Changes

| Variable | Required | Description |
|----------|----------|-------------|
| `AI_GATEWAY_API_KEY` | yes | Dedicated `holdem-ai-50` gateway key, already in `.env`. $50/mo quota. When deployed, add to the Vercel project's env (follow-up). |

## What's Deferred / Out of Scope
- Deploying to Vercel / creating the GitHub repo (needs Kyle's go-ahead; key would be added as a project env var then).
- Multiplayer humans, accounts, persistence, hand-history export.
- Tournaments / rising blinds.
- AI-vs-AI spectating, narration, tournaments/benchmark, Strategy Lab → see `bonus_sprints.md` (B1–B4). `bench/selfplay.ts` is the seed for B3's runner.
- Server-authoritative game state (anti-cheat) — unnecessary for single-player.
- Live reasoning during a hand the human is playing (would leak hand info; revealed post-hand). B1 spectator mode shows it live because no human is seated.

## Open Questions
1. ~~Same facts for every model?~~ **Resolved 2026-10-09:** nothing a human wouldn't have. No equity/pot-odds/hand-strength helpers for any AI; they compute it themselves.
2. ~~Table talk~~ **Resolved:** keep it.

## Review Notes (Phase 2.5)
- **Simplicity/alignment review (fresh-eyes subagent) — applied:** spelled out `SeatView` and the missing engine state (`actedThisRound`, `lastRaiseSize`, heads-up postflop order, short blinds, uncalled-bet return, all-in runout); fixed `UButtonGroup` → `UFieldGroup`; removed the false claim that `evaluate()` takes `reasoning`; widened `Reasoning` to include `'none'`; renamed `evaluate.ts` → `handRank.ts`; moved `types.ts` + `models.ts` into Sprint 1 so Sprints 2/3 are truly disjoint; `decide()` returns fallbacks instead of throwing; client timeout 35 s > server 30 s; required `tableTalk` + server-side truncation; cut VPIP, localStorage, separate HandReview panel; added `?stacks=` debug param for side-pot verification.
- **Considered and kept:** self-play harness (cheapest end-to-end proof of `decide()`), table talk, 700 ms thinking floor, cost column.
- **Prod-safety review — skipped:** greenfield, no deploy, no shared DB, no live users. Revisit when it gets a Vercel project.
- **Docs/analytics review — done inline:** no analytics framework in this repo by design (local toy); docs commitment is README + AGENTS.md in 4.5, and `.env.example` in 1.1.
