"""Duplicate scoring, bridge style. In a match every rotation deals the same cards to the same seat
for hand k, so for each (match, hand, seat) we can compare what different models did with
identical hole cards. Also: with the full board recovered from whichever rotation got furthest,
rank every seat's 7-card hand and ask how much each model won when it was dealt the best hand at
the table (value extraction) or the second best (damage control).
Writes out/duplicate.json.   python3 -I 13_duplicate.py
"""
import sys, os, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nb import *

H = seathands('main')
res = {}
cells = group(H, 'matchId', 'handNo', 'seatIdx')

# ── pairwise same-cards difference (bb per shared hand) ───────────────────────────────────
pair = defaultdict(list)
for k, rows in cells.items():
    by = {}
    for r0 in rows:
        by.setdefault(r0['model'], r0['deltaBb'])
    ms = list(by)
    for a in ms:
        for b in ms:
            if a != b:
                pair[(a, b)].append(by[a] - by[b])
res['same_cards_diff'] = {f'{LABEL[a]}|{LABEL[b]}': {'n': len(v), 'bb_per_hand': float(np.mean(v)), 'bb100': 100 * float(np.mean(v))} for (a, b), v in pair.items()}
# cluster-bootstrap CI by match for Sol vs each
rng = random.Random(3)
ci = {}
for b in MAIN_ORDER:
    a = 'openai/gpt-6-sol'
    if a == b:
        continue
    per_match = defaultdict(list)
    for k, rows in cells.items():
        by = {}
        for r0 in rows:
            by.setdefault(r0['model'], r0['deltaBb'])
        if a in by and b in by:
            per_match[k[0]].append(by[a] - by[b])
    ms = list(per_match)
    draws = []
    for _ in range(2000):
        s = [x for _m in ms for x in per_match[ms[rng.randrange(len(ms))]]]
        draws.append(100 * np.mean(s))
    draws.sort()
    ci[LABEL[b]] = (100 * float(np.mean([x for v in per_match.values() for x in v])), draws[50], draws[1949])
res['sol_same_cards_ci'] = ci

# ── best / second-best hand at the table ──────────────────────────────────────────────────
# full board per (match, hand) from the rotation that dealt the most cards
boards = {}
for h in H:
    k = (h['matchId'], h['handNo'])
    if len(h['board']) > len(boards.get(k, '')):
        boards[k] = h['board']
# rank 7-card hands with the notebook's evaluator via node (one call)
todo = [(h['matchId'], h['handNo'], h['seatIdx'], h['hole'], boards.get((h['matchId'], h['handNo']), '')) for h in H]
uniq = sorted({(m, hn, si, hole, b) for m, hn, si, hole, b in todo if len(b) == 10})
inp = '\n'.join(f'{hole}{b}' for _m, _h, _s, hole, b in uniq)
js = "import { evalCards, cardInt } from './lib.ts'; import { readFileSync } from 'node:fs';" \
     "const out = readFileSync(0,'utf8').trim().split('\\n').map(l => evalCards(l.match(/../g).map(cardInt))); console.log(JSON.stringify(out))"
scores = json.loads(subprocess.run(['node', '--input-type=module', '-e', js], input=inp, capture_output=True, text=True, cwd=os.path.dirname(os.path.abspath(__file__))).stdout)
score = {u[:3]: s for u, s in zip(uniq, scores)}
rank = {}
for (m, hn), rows in group(H, 'matchId', 'handNo').items():
    pass
seat_scores = defaultdict(dict)
for (m, hn, si), s in score.items():
    seat_scores[(m, hn)][si] = s
for k, d in seat_scores.items():
    order = sorted(d.values(), reverse=True)
    for si, s in d.items():
        rank[(k[0], k[1], si)] = 1 + order.index(s)  # ties share the better rank
val = {}
for m in MAIN_ORDER:
    hs = [h for h in H if h['model'] == m and (h['matchId'], h['handNo'], h['seatIdx']) in rank]
    best = [h for h in hs if rank[(h['matchId'], h['handNo'], h['seatIdx'])] == 1]
    second = [h for h in hs if rank[(h['matchId'], h['handNo'], h['seatIdx'])] == 2]
    rest = [h for h in hs if rank[(h['matchId'], h['handNo'], h['seatIdx'])] >= 3]
    val[m] = {'hands_ranked': len(hs), 'best_n': len(best), 'best_bb': float(np.mean([h['deltaBb'] for h in best])),
              'best_showdown_pct': pct(sum(h['showdown'] for h in best), len(best)), 'best_folded_pct': pct(sum(1 for h in best if h['foldStreet']), len(best)),
              'second_n': len(second), 'second_bb': float(np.mean([h['deltaBb'] for h in second])),
              'rest_n': len(rest), 'rest_bb': float(np.mean([h['deltaBb'] for h in rest]))}
res['by_table_rank'] = val
res['boards_recovered'] = sum(1 for b in boards.values() if len(b) == 10)
res['boards_total'] = len(boards)

save('duplicate.json', res)
for k, v in sorted(res['same_cards_diff'].items()):
    if k.startswith('Sol|'):
        print(k, v['n'], round(v['bb100'], 1))
print('sol CI', {k: tuple(round(x, 1) for x in v) for k, v in ci.items()})
for m in MAIN_ORDER:
    print(LABEL[m], {k: r(v, 2) for k, v in val[m].items()})
print('boards', res['boards_recovered'], '/', res['boards_total'])
