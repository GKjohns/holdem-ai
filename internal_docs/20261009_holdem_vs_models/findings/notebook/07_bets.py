"""Facing bets: fold rates by bet size (vs the pot-odds alpha), and the quality of call/fold
decisions measured against the god-view truth. On the river the truth is exact: calling wins
eqActual * (pot + toCall) and costs toCall, so a fold with eqActual = 1 or a call with eqActual = 0
is a clean mistake. Also: how each model's own bets fare by size (fold equity).
Writes out/bets.json.   python3 -I 07_bets.py
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nb import *

D = decisions('main')
res = {}
POST = ('flop', 'turn', 'river')
BUCKETS = [('small (<40% pot)', 0, 0.4), ('medium (40–75%)', 0.4, 0.75), ('pot-ish (75–125%)', 0.75, 1.25), ('overbet (>125%)', 1.25, 99)]
bucket = lambda f: next((b[0] for b in BUCKETS if b[1] <= f < b[2]), None)

fold_by = {}
for m in MAIN_ORDER:
    f = [d for d in D if d['model'] == m and d['street'] in POST and d['toCall'] > 0]
    out = {}
    for name, lo, hi in BUCKETS:
        s = [d for d in f if lo <= d['facingFrac'] < hi]
        out[name] = {'n': len(s), 'fold': pct(sum(d['menuId'] == 'fold' for d in s), len(s)),
                     'alpha': 100 * float(np.mean([d['facingFrac'] / (1 + d['facingFrac']) for d in s])) if s else None,
                     # how often folding gave up the best hand right now (god view, vs live hands)
                     'folded_best_now': pct(sum(1 for d in s if d['menuId'] == 'fold' and d['eqActual'] >= 0.5), sum(1 for d in s if d['menuId'] == 'fold'))}
    # facing an all-in (any street but preflop)
    s = [d for d in f if d['facingAllIn'] == 1]
    out['facing all-in'] = {'n': len(s), 'fold': pct(sum(d['menuId'] == 'fold' for d in s), len(s))}
    fold_by[m] = out
res['fold_by_size'] = fold_by

# Preflop: folding to a shove / big raise
pre = {}
for m in MAIN_ORDER:
    f = [d for d in D if d['model'] == m and d['street'] == 'preflop' and d['toCall'] > 0]
    big = [d for d in f if d['toCall'] >= 0.5 * (d['stack'] + d['toCall']) or d['facingAllIn'] == 1]
    pre[m] = {'n': len(big), 'fold': pct(sum(d['menuId'] == 'fold' for d in big), len(big)),
              'call_eq_mean': float(np.mean([d['eqActual'] for d in big if d['menuId'] != 'fold'])) if big else None,
              'fold_eq_mean': float(np.mean([d['eqActual'] for d in big if d['menuId'] == 'fold'])) if big else None}
res['preflop_vs_big'] = pre

# ── decision quality vs immediate pot odds (god view) ─────────────────────────────────────
def quality(rows):
    n = len(rows)
    folds = [d for d in rows if d['menuId'] == 'fold']
    calls = [d for d in rows if d['menuId'] == 'call']
    bad_fold = [d for d in folds if d['eqActual'] * (d['pot'] + d['toCall']) - d['toCall'] > 0]
    bad_call = [d for d in calls if d['eqActual'] * (d['pot'] + d['toCall']) - d['toCall'] < 0]
    ev_lost_fold = sum((d['eqActual'] * (d['pot'] + d['toCall']) - d['toCall']) / d['bb'] for d in bad_fold)
    ev_lost_call = sum(-(d['eqActual'] * (d['pot'] + d['toCall']) - d['toCall']) / d['bb'] for d in bad_call)
    return {'n': n, 'folds': len(folds), 'calls': len(calls), 'bad_fold': len(bad_fold), 'bad_call': len(bad_call),
            'bad_fold_rate': pct(len(bad_fold), len(folds)), 'bad_call_rate': pct(len(bad_call), len(calls)),
            'bb_lost_bad_folds': ev_lost_fold, 'bb_lost_bad_calls': ev_lost_call}
qual = {}
for m in MAIN_ORDER:
    river = [d for d in D if d['model'] == m and d['street'] == 'river' and d['toCall'] > 0 and d['nLive'] == 2]
    qual[m] = {'river_hu': quality(river)}
    # the same against what the seat could know: equity vs random hands (a crude, opponent-agnostic read)
    rv = [d for d in D if d['model'] == m and d['street'] == 'river' and d['toCall'] > 0]
    qual[m]['river_all'] = quality(rv)
    # river spots: hero folded the winner — examples
    ex = [d for d in river if d['menuId'] == 'fold' and d['eqActual'] == 1]
    ex.sort(key=lambda d: -(d['pot'] + d['toCall']) / d['bb'])
    qual[m]['folded_winner_examples'] = [{k: d[k] for k in ('tournamentId', 'handNo', 'hole', 'board', 'made', 'pot', 'toCall', 'bb', 'facingAgg')} for d in ex[:4]]
    cx = [d for d in river if d['menuId'] == 'call' and d['eqActual'] == 0]
    cx.sort(key=lambda d: -d['toCall'] / d['bb'])
    qual[m]['called_loser_examples'] = [{k: d[k] for k in ('tournamentId', 'handNo', 'hole', 'board', 'made', 'pot', 'toCall', 'bb', 'facingAgg')} for d in cx[:4]]
res['quality'] = qual

# who bets into whom on the river, and does it work? (bettor perspective: fold equity by size)
bettor = {}
for m in MAIN_ORDER:
    b = [d for d in D if d['model'] == m and d['street'] in POST and d['toCall'] == 0 and (d['menuId'].startswith('raise') or d['menuId'] == 'all_in')]
    out = {}
    for d in b:
        sz = d['menuId']
        o = out.setdefault(sz, {'n': 0, 'eq': [], 'won': 0, 'bb': 0.0})
        o['n'] += 1; o['eq'].append(d['eqActual']); o['won'] += d['wonAny']; o['bb'] += d['deltaBb']
    bettor[m] = {k: {'n': v['n'], 'eqActual_mean': float(np.mean(v['eq'])), 'won_hand': pct(v['won'], v['n']), 'bb_per_bet_hand': v['bb'] / v['n']} for k, v in out.items()}
    # bluff share: bets with eqActual < 0.3 (behind live hands right now)
    bettor[m]['_bluff_share'] = pct(sum(1 for d in b if d['eqActual'] < 0.3), len(b))
    bettor[m]['_value_share'] = pct(sum(1 for d in b if d['eqActual'] >= 0.7), len(b))
res['bettor'] = bettor

# opponents' fold rate against each bettor's river bets (does anyone get folded to more?)
fold_vs = defaultdict(lambda: [0, 0])
for d in D:
    if d['street'] in POST and d['toCall'] > 0 and d['facingAgg']:
        fold_vs[d['facingAgg']][0] += d['menuId'] == 'fold'
        fold_vs[d['facingAgg']][1] += 1
res['fold_vs_aggressor'] = {LABEL.get(k, k): {'n': v[1], 'fold': pct(v[0], v[1])} for k, v in fold_vs.items()}

save('bets.json', res)
for m in MAIN_ORDER:
    print(f'\n== {LABEL[m]}')
    print(' fold by size', {k: (v['n'], r(v['fold']), r(v.get('alpha')), r(v.get('folded_best_now'))) for k, v in fold_by[m].items()})
    print(' pre vs big', {k: r(v, 2) for k, v in pre[m].items()})
    for k in ('river_hu', 'river_all'):
        print(' ', k, {kk: r(vv, 1) for kk, vv in qual[m][k].items()})
    print(' folded winners', qual[m]['folded_winner_examples'][:2])
    print(' bettor', {k: ({kk: r(vv, 2) for kk, vv in v.items()} if isinstance(v, dict) else r(v)) for k, v in bettor[m].items()})
print(res['fold_vs_aggressor'])
