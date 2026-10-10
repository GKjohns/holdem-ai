"""Decision models (Luna Decisions, Jev): probability shape, entropy, off-argmax choices, and the
duplicate natural experiment: identical cards + seat + board + action history played by different
models in different rotations. Pairwise agreement says who plays like whom.
Writes out/decision_models.json.   python3 -I 06_decision_models.py
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nb import *

D = decisions('main')
res = {}
DM = ['openai/gpt-6-luna-decisions', 'typesafe-ai/jev']
coarse = lambda m: 'fold' if m == 'fold' else ('passive' if m in ('check', 'call') else 'aggressive')

# ── probability shape ─────────────────────────────────────────────────────────────────────
shape = {}
for m in DM:
    ds = [d for d in D if d['model'] == m]
    tops = np.array([d['topP'] for d in ds])
    ent = np.array([d['entropy'] for d in ds])
    by_street = {}
    for st in ('preflop', 'flop', 'turn', 'river'):
        s = [d for d in ds if d['street'] == st]
        by_street[st] = {'n': len(s), 'topP': float(np.mean([d['topP'] for d in s])), 'entropy': float(np.mean([d['entropy'] for d in s]))}
    hist = np.histogram(tops, bins=[0, .3, .4, .5, .6, .7, .8, .9, .95, 1.0001])[0].tolist()
    nt = [d for d in ds if d['choiceNotTop'] == 1]
    mismatch = [d for d in ds if d['top'] and d['top'] != d['menuId'] and d['topP'] > (d['pChosen'] or 0)]
    # mass the model put on options it did not take (if it had sampled, how often would it deviate?)
    off_mass = float(np.mean([1 - (d['pChosen'] or 0) for d in ds]))
    # how decisive per action chosen
    by_action = {a: float(np.mean([d['topP'] for d in ds if d['menuId'] == a])) for a in set(d['menuId'] for d in ds)}
    shape[m] = {'n': len(ds), 'topP_mean': float(tops.mean()), 'topP_median': float(np.median(tops)), 'share_topP_ge_0.9': float((tops >= .9).mean()),
                'share_topP_lt_0.5': float((tops < .5).mean()), 'entropy_mean': float(ent.mean()), 'by_street': by_street, 'topP_hist': hist,
                'choiceNotTop': len(nt), 'argmax_mismatch': len(mismatch), 'off_choice_mass': off_mass, 'topP_by_action': by_action,
                'not_top_examples': [{k: d[k] for k in ('tournamentId', 'handNo', 'street', 'hole', 'board', 'menuId', 'top', 'topP', 'pChosen', 'toCall', 'pot')} for d in nt]}
res['shape'] = shape

# does confidence track the difficulty of the spot? topP vs |eqRandom - potOdds| when facing a bet
conf = {}
for m in DM:
    f = [d for d in D if d['model'] == m and d['toCall'] > 0 and d['street'] != 'preflop']
    close = [d['topP'] for d in f if abs(d['eqRandom'] - d['potOdds']) < 0.1]
    clear = [d['topP'] for d in f if abs(d['eqRandom'] - d['potOdds']) >= 0.3]
    conf[m] = {'close_n': len(close), 'close_topP': float(np.mean(close)) if close else None, 'clear_n': len(clear), 'clear_topP': float(np.mean(clear)) if clear else None}
res['confidence_vs_difficulty'] = conf

# ── duplicate natural experiment: same spot, different model ──────────────────────────────
spots = {k: v for k, v in group(D, 'spotKey').items() if len({d['model'] for d in v}) >= 2}
pair = defaultdict(lambda: [0, 0, 0])  # exact agree, coarse agree, n
pf_pair = defaultdict(lambda: [0, 0])
for k, v in spots.items():
    one = {}
    for d in v:
        one.setdefault(d['model'], d)  # one decision per model per spot
    ms = sorted(one)
    for i in range(len(ms)):
        for j in range(i + 1, len(ms)):
            a, b = one[ms[i]], one[ms[j]]
            key = (ms[i], ms[j])
            pair[key][0] += a['menuId'] == b['menuId']
            pair[key][1] += coarse(a['menuId']) == coarse(b['menuId'])
            pair[key][2] += 1
agree = {}
for (a, b), (ex, co, n) in pair.items():
    agree[f'{LABEL[a]}|{LABEL[b]}'] = {'n': n, 'exact': ex / n, 'coarse': co / n}
res['same_spot_agreement'] = agree
res['same_spot_count'] = {'spots': len(spots), 'by_street': Counter(v[0]['street'] for v in spots.values())}

# for spots shared with Luna: what probability did Luna Decisions / Jev give to Luna's (and Sol's) actual action?
prob_given = defaultdict(list)
for k, v in spots.items():
    one = {}
    for d in v:
        one.setdefault(d['model'], d)
    for dm in DM:
        if dm not in one:
            continue
        for other in MAIN_ORDER:
            if other == dm or other not in one:
                continue
            act = one[other]['menuId']
            p = one[dm].get(f'p_{act}')
            if p is not None:
                prob_given[(dm, other)].append(p)
res['dm_prob_for_other_action'] = {f'{LABEL[a]} on {LABEL[b]}': {'n': len(v), 'mean_p': float(np.mean(v))} for (a, b), v in prob_given.items()}

# coarse action profile in the shared preflop spots, so agreement can be read against base rates
prof = {}
for m in MAIN_ORDER:
    s = [d for v in spots.values() for d in v if d['model'] == m]
    c = Counter(coarse(d['menuId']) for d in s)
    prof[LABEL[m]] = {k: c[k] / len(s) for k in ('fold', 'passive', 'aggressive')} | {'n': len(s)}
res['same_spot_profile'] = prof

# chance agreement if two models acted independently with their own marginal rates (coarse)
chance = {}
for (a, b), (ex, co, n) in pair.items():
    pa = prof[LABEL[a]]; pb = prof[LABEL[b]]
    chance[f'{LABEL[a]}|{LABEL[b]}'] = sum(pa[k] * pb[k] for k in ('fold', 'passive', 'aggressive'))
res['same_spot_chance_coarse'] = chance

save('decision_models.json', res)
for m in DM:
    s = shape[m]
    print(LABEL[m], {k: (r(v, 3) if isinstance(v, float) else v) for k, v in s.items() if k not in ('by_street', 'not_top_examples', 'topP_by_action')})
    print('  by street', {k: (v['n'], r(v['topP'], 3), r(v['entropy'], 2)) for k, v in s['by_street'].items()})
    print('  by action', {k: r(v, 3) for k, v in s['topP_by_action'].items()})
    for e in s['not_top_examples']:
        print('  notTop', e)
print('conf', conf)
print('spots', res['same_spot_count'])
for k, v in sorted(agree.items(), key=lambda x: -x[1]['coarse']):
    print(f'  {k:28s} n={v["n"]:4d} exact={v["exact"]:.2f} coarse={v["coarse"]:.2f} chance={chance[k]:.2f}')
print(res['dm_prob_for_other_action'])
print(prof)
