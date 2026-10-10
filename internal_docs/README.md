# internal_docs

Working notes for each round of the project, kept as they were written. Raw run data (`data/`) is gitignored and not in the repo; these folders hold the plans, audits, analysis scripts and summaries.

## [`20261011_v2_fairness/`](20261011_v2_fairness/) (current)

The results the blog post reports.

- [`audit.md`](20261011_v2_fairness/audit.md): what a v1 seat saw, compared with what a human at the table knows.
- [`design.md`](20261011_v2_fairness/design.md): the guest-seat duplicate design and its expected precision, written before the money was spent.
- [`results.md`](20261011_v2_fairness/results.md): Study A (Sol, Opus, Fable as guests), Study B (personas on Luna and on Sol), which v1 findings survived, cost.
- [`data_quality.md`](20261011_v2_fairness/data_quality.md): every v2 decision checked for truncation, fallbacks and timeouts. None found.
- `out/`: machine-readable summaries from `bench/v2report.ts` and friends.

## [`20261009_holdem_vs_models/`](20261009_holdem_vs_models/) (v1, superseded)

The original build plan, bonus sprints (stats, narrator, batch tournaments, the Strategy Lab) and a findings report with its analysis notebook.

**v1's benchmark numbers are superseded by v2.** The v2 audit found that several v1 results came from the harness, not the models:

- **No memory.** Seats saw only the current hand, so nobody could read an opponent's history.
- **No payouts.** Seats weren't told the field size, the payout structure or who had busted, and the prompt called every table a cash game.
- **Unequal effort.** GPT-6 Luna ran at reasoning `none` while the others ran at `low`.
- Also: no bet sizes between 1/2 pot and pot, no overbet short of 2x, and a 50-hand cap that decided about half the tournaments.

v2 fixed all of these and reran the study. Some v1 findings held (Jev pays everyone, Haiku misreads its own hand, nobody overbets, talk is ignored); others didn't (Sol is no longer alone at the top, and Luna's river folding mostly came from effort `none`). The comparison table is in `results.md`.
