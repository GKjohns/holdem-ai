# v2 fairness audit: what a seat saw vs what a human at the table knows

**Date:** 2026-10-11 · **Scope:** the B3 benchmark (`data/runs/20261010_main.jsonl`), the B4 lab and the code at `0e97446`
**Rule (unchanged):** a seat gets nothing a human in that chair wouldn't have. That means no odds, no equity, no hand-strength labels and no computed stats. Within that rule it should get *everything* a human would have.

Sources read: `SeatView` (`shared/utils/types.ts`), `seatView()` (`shared/utils/table.ts`), `renderPrompt()` / `tableState()` / `INSTRUCTIONS` / `decideWithLlm()` (`server/utils/decide.ts`), `buildMenu()` (`shared/utils/menu.ts`), `bench/runner.ts`, `shared/utils/tournament.ts` and `shared/utils/models.ts`. Findings numbers are from `internal_docs/20261009_holdem_vs_models/findings/report.html` (the "report").

## What a seat actually received (v1, real snapshots)

These are rendered from the `view` stored with each decision in the B3 main run. The views predate the B5 `game` field, so the header reads only "Big blind 20". The system prompt those seats got said "cash game … The blinds never change. Play to win chips."

**m01-r2 #8, preflop, GPT-6 Luna:**

```
Hand #8, preflop. Big blind 20.
You are GPT-6 Luna, in early position, playing against GPT-6 Luna Decisions, Jev, GPT-6 Sol, Claude Haiku 5.5.

Your cards: 7d 2s
Board: (no community cards yet)

Pot: 30 (every chip put in this hand, including this street).
You: 1200 behind, 0 in front of you this street. To call: 20.

Seating, clockwise from the button: Jev (button), GPT-6 Sol (small blind), Claude Haiku 5.5 (big blind), GPT-6 Luna (you, early), GPT-6 Luna Decisions (cutoff).

Other players:
- GPT-6 Luna Decisions (cutoff): 1440 behind, 0 in front this street, in the hand
- Jev (button): 2283 behind, 0 in front this street, in the hand
- GPT-6 Sol (small blind): 1395 behind, 10 in front this street, in the hand; posted the small blind (10)
- Claude Haiku 5.5 (big blind): 1152 behind, 20 in front this street, in the hand; posted the big blind (20)

Action so far this hand (after the blinds):
- none yet

Table talk you already said this session (say something new or stay quiet):
- "Let's see who wants to play."   … (6 lines)

Your options (pick one id):
- fold — Fold and give up this hand
- call — Call 20 (pot becomes 50)
- raise_min — Raise to 40, the minimum raise (pot becomes 70)
- raise_half_pot — Raise to 45, raising by half the pot (pot becomes 75)
- raise_pot — Raise to 70, raising by the size of the pot (pot becomes 100)
- raise_2x_pot — Raise to 120, raising by twice the pot (pot becomes 150)
- all_in — Go all-in, raising to 1200 (pot becomes 1230)
```

**m03-r1 #38, river, GPT-6 Sol.** This is hand 38 of a tournament, and one player had already busted. The prompt has no trace of hands 1–37:

```
Hand #38, river. Big blind 160.
You are GPT-6 Sol, in the small blind, playing against GPT-6 Luna, GPT-6 Luna Decisions, Jev.
Your cards: 2d Kc
Board: 8h 2c 7c 3h 7h
Pot: 480 …  You: 930 behind …  To call: 0.
Seating, clockwise from the button: Jev (button), GPT-6 Sol (you, small blind), GPT-6 Luna (big blind), GPT-6 Luna Decisions (cutoff).
Other players: … (busted Haiku is simply gone; nothing says a fifth player existed)
Action so far this hand (after the blinds): preflop … flop … turn: everyone checks
Your options: check, raise_min (160), raise_half_pot (240), raise_pot (480), all_in (930)
```

**The same table as decision-model JSON** (m02-r0 #30, Luna Decisions):
`{ game: "No-limit Texas Hold'em cash game", hand_number: 30, me: { position, hole_cards: ["Ad","5d"], stack_behind: 395, … }, pot: 120, to_call: 80, big_blind: 80, seating_clockwise_from_button: [...], opponents: [{ name, position, stack_behind, in_front_this_street, status, blind_posted }], action_so_far: [] }`.

## Item by item

| # | What | Human knows? | v1 gave it? | Evidence it shaped results | v2 fix |
|---|---|---|---|---|---|
| 1 | Every opponent's current stack | yes | **yes** | none | kept |
| 2 | Each player's chips in the pot this hand / stack at the start of the hand | yes (chips in front, counted down) | **partly**: this street's bet only. Earlier streets had to be reconstructed from the log | small. Pot-commitment reads need it | `inPot` per player ("300 in the pot this hand") |
| 3 | Who is all-in | yes | yes (`allIn` → "all-in") | none | kept |
| 4 | Button and blind positions | yes | yes | none | kept |
| 5 | Seat order; **who still acts after you** | yes | **partly**: seating given, acting order left to infer | none measured | `actingAfter`: "Still to act after you this round: …" |
| 6 | Bet to call, min raise, max raise | yes | yes, as menu entries | see #14 | explicit range in the menu |
| 7 | Pot **and side pots** | yes (the dealer splits them) | **partly**: one total only | 202 all-in hands, some multiway | `pots`: main pot + side pots with who's eligible, once someone is all-in |
| 8 | Blind level and when it rises | yes | **no** in B3/B4. All 15,913 B3 decisions were told "cash game … blinds never change". The B5 fix added `game`, which was verified in code but never run | **large.** With <15 bb Sol shoved 33% of spots, everyone else 0–3% (report "How Sol wins"). bb/100 by level | kept (`game`), plus the full structure: starting stack, field size, "double every 10 hands" |
| 9 | Payouts; finishing order matters | yes (posted before the start) | **no**. The B5 prompt said "finish as high as you can", but no payout table. B3 said "play to win chips" | **large.** The objective the seats were told ≠ how they were scored. bb/100 over-weights levels 1–2 by 16× (report "Stack depth and the cap") | payouts 50/30/20 in the table header; v2 standings lead with prize share |
| 10 | How many players remain; who busted, in what place | yes | **no**. Busted seats vanish from `opponents` | shapes bubble play (4th of 6 with 3 paid) | `eliminated` (name, place, hand), "Players left: 4 of 6" |
| 11 | **Memory of earlier hands**: actions, showdown cards, who won, talk | yes | **no.** Every decision was memoryless. The B4 planner prompt says so outright ("It has NO memory of earlier hands … cannot track an opponent across hands") | **large.** Exactly 1 of 15,913 reasoning texts used an opponent's talk. Jev's fold rate moved 33%→86% on one line of talk because nothing else was known. Sol's talk was a strength tell (AUC 0.73) nobody could learn. Jev paid Sol 4× everyone else's rate, a leak a human would adjust to | `history`: the last 10–19 hands (every action with sizes, every table-talk line, every hand shown at showdown, who won which pot, busts), plus the seat's own hole cards in those hands (`myCards`). Window = this block of 10 hands + the previous one, so it only ever grows by appending within a block (cache-friendly) and a human-plausible amount is remembered |
| 12 | Full action sequence of the current hand with sizes | yes | yes | none | kept |
| 13 | Table talk | yes | yes for this hand; earlier hands' talk was lost | see #11 | talk now lives in the history |
| 14 | **Action menu / bet sizes** | a human can bet any amount | **no**: min, ½ pot, pot, 2× pot, all-in. Nothing between ½ pot and pot, no ⅓ or ¾, and no free amount | **large.** "Twice the pot" was picked 26 times in 15,913 decisions, and after the flop 53–81% of bets were ½ pot. The 1½-pot overbet that made Luna/Luna Decisions fold 50–67% of strong hands was never on the menu, so the menu shaped the bet-size picture | presets ⅓, ½, ¾, pot, 1½×, 2× pot for every seat; language models also get `raise_to` with any `amount` in range (out of range is clamped to the nearest legal size, like a dealer would, and flagged in `requested`) |
| 15 | Card representation | a human sees the card | "Kh" codes only | **probable.** Haiku: 38 of 64 "set" claims were wrong, plus 98 "suited" slips on offsuit hands | cards also spelled out: "K♥ K♦ (king of hearts, king of diamonds)". Hands are never named |
| 16 | **Reasoning effort** | n/a (fairness) | **unequal**: Sol/Haiku/Opus/Gemini `low`, Luna **`none`**, decision models fixed | Luna's output was flat at ~57 tokens on every street (report "Cost and speed"), so it never thought before answering. "Luna folds winners" may partly be no-thinking | one policy: **`low` for every language model**, the lowest level every one of them supports. It's what Sol won with in v1, and it keeps Opus/Fable affordable. Decision models have no effort knob |
| 17 | `maxOutputTokens` 4000, 30 s timeout, fallback = check/fold | n/a | same for all | none in v1: 0 fallbacks, p99 latency ≤ 7.2 s, max output 1,235 tokens. Opus/Fable weren't in B3 | batch timeout raised to 60 s (watchdog 75 s) and max output to 8000, so a slower model is never folded by the clock. Fallbacks are counted and gated at 0 |
| 18 | **Hand cap** | n/a (structure) | 50-hand cap, not told to the seats | 20 of 40 tournaments were decided by chip count at the cap, 15 of them heads-up | structure that ends naturally: blinds keep doubling every 10 hands up to 10,240/20,480, and the safety cap of 250 hands is never reached in practice. Seats are told there's no hand limit |
| 19 | Scoring metric vs objective | n/a | bb/100 (chip EV per hand) | rewards early-level chips 16×. Haiku: 2nd-worst bb/100 but fewer chips lost than Luna Decisions | v2 standings: **prize share** (the stated payout), with average finish and bb/100 as secondary |
| 20 | Prompt caching | n/a (cost) | gateway `caching: 'auto'` puts the breakpoint at the end of a prompt that changes on every call, so every Anthropic call was billed as a **cache write (1.25×)** with no reads. GPT-6 likewise reports a cache write every call | explains why metering ran ~1.1× the price table | Anthropic: explicit breakpoint after the shared history (reads at 2.5–5% of input). `auto` dropped. `usage` now logs cache read/write tokens and `pricing.ts` prices them |
| 21 | Strategy card placement | n/a | appended to the system prompt | none | moved into the user turn, after the shared history, so seats at one table share the cached prefix (Study B) |
| 22 | Opponent identity | yes (names) | yes (model names) | none | kept |

Not a gap: odds, equity, hand names and stats stay out. The new history gives raw events only. A showdown lists the cards shown and who won the pot, never the hand's name ("two pair"), and nothing is aggregated.

## Lesser notes

- `blindPosted()` infers a blind from preflop chips minus logged actions. That's correct, and it's kept.
- The decision-model JSON names the game, but it had no notion of field size, payouts or history. v2 adds the same facts the text prompt has (`earlier_hands` as the same lines, `my_cards_in_earlier_hands`, `pots`, `players_left`, `eliminated`, `payouts`, `acting_after_me`, `in_pot`).
- Old run files stay parseable: every new `SeatView` field is optional, the new `MenuId`s only widen the union, and B3/B4 views render as before.
