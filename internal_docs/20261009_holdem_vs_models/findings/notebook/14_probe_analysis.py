"""Reads cache/probe.jsonl (11_probe.ts) and summarises the three experiments.
Writes out/probe.json.   python3 -I 14_probe_analysis.py
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nb import *

P = [json.loads(l) for l in open(os.path.join(CACHE, 'probe.jsonl')) if l.strip()]
coarse = lambda m: 'fold' if m == 'fold' else ('passive' if m in ('check', 'call') else 'aggressive')
res = {'calls': len(P), 'cost_pricing': sum(p['costUsd'] for p in P), 'fallbacks': sum(p['fallback'] for p in P),
       'cost_by_exp': {e: sum(p['costUsd'] for p in P if p['exp'] == e) for e in ('replay', 'ladder', 'talk')}}

# ── replay ────────────────────────────────────────────────────────────────────────────────
R = [p for p in P if p['exp'] == 'replay']
by = defaultdict(dict)
for p in R:
    by[(p['spot'], p['model'])][p['rep']] = p
selfagree = {}
for m in MAIN_ORDER:
    pairs = [(v[0], v[1]) for (s, mm), v in by.items() if mm == m and 0 in v and 1 in v]
    selfagree[LABEL[m]] = {'n': len(pairs), 'exact': pct(sum(a['menuId'] == b['menuId'] for a, b in pairs), len(pairs)),
                           'coarse': pct(sum(coarse(a['menuId']) == coarse(b['menuId']) for a, b in pairs), len(pairs))}
res['self_agreement'] = selfagree
# agreement with the original decision in the B3 run (same model, same view)
orig = {}
for m in MAIN_ORDER:
    xs = [v[0] for (s, mm), v in by.items() if mm == m and 0 in v and v[0]['meta']['origModel'] == m]
    orig[LABEL[m]] = {'n': len(xs), 'exact': pct(sum(x['menuId'] == x['meta']['origChoice'] for x in xs), len(xs)),
                      'coarse': pct(sum(coarse(x['menuId']) == coarse(x['meta']['origChoice']) for x in xs), len(xs))}
res['agreement_with_original'] = orig
spots = sorted({p['spot'] for p in R})
cross = {}
for i, a in enumerate(MAIN_ORDER):
    for b in MAIN_ORDER[i + 1:]:
        n = ex = co = 0
        for s in spots:
            if 0 in by.get((s, a), {}) and 0 in by.get((s, b), {}):
                x, y = by[(s, a)][0], by[(s, b)][0]
                n += 1; ex += x['menuId'] == y['menuId']; co += coarse(x['menuId']) == coarse(y['menuId'])
        cross[f'{LABEL[a]}|{LABEL[b]}'] = {'n': n, 'exact': pct(ex, n), 'coarse': pct(co, n)}
res['cross_agreement'] = cross
prof = {}
for m in MAIN_ORDER:
    xs = [v[0] for (s, mm), v in by.items() if mm == m and 0 in v]
    c = Counter(coarse(x['menuId']) for x in xs)
    prof[LABEL[m]] = {k: pct(c[k], len(xs)) for k in ('fold', 'passive', 'aggressive')} | {'n': len(xs)}
res['replay_profile'] = prof

# ── ladder: fold % by bet size ────────────────────────────────────────────────────────────
L = [p for p in P if p['exp'] == 'ladder']
ALPHA = {'size_0.33': 0.33 / 1.33, 'size_0.75': 0.75 / 1.75, 'size_1.5': 1.5 / 2.5}
lad = {}
for m in MAIN_ORDER:
    out = {}
    for v in ('size_0.33', 'size_0.75', 'size_1.5'):
        xs = [p for p in L if p['model'] == m and p['variant'] == v]
        out[v] = {'n': len(xs), 'fold': pct(sum(p['menuId'] == 'fold' for p in xs), len(xs)), 'raise': pct(sum(coarse(p['menuId']) == 'aggressive' for p in xs), len(xs)),
                  'max_fold_alpha': 100 * ALPHA[v]}
        for name, lo, hi in (('weak', 0, .4), ('medium', .4, .7), ('strong', .7, 1.01)):
            ys = [p for p in xs if lo <= p['meta']['eqRandom'] < hi]
            out[v][f'fold_{name}'] = pct(sum(p['menuId'] == 'fold' for p in ys), len(ys))
    # decision models: mean fold probability by size
    pf = {v: float(np.mean([(p['probabilities'] or {}).get('fold', 0) for p in L if p['model'] == m and p['variant'] == v])) for v in ALPHA}
    out['mean_p_fold'] = pf if m in ('openai/gpt-6-luna-decisions', 'typesafe-ai/jev') else None
    # within-spot monotonicity: share of spots whose action got "more foldy" as the bet grew
    spots_m = group([p for p in L if p['model'] == m], 'spot')
    mono = flip = 0
    for s, xs in spots_m.items():
        d = {p['variant']: p['menuId'] == 'fold' for p in xs}
        if len(d) == 3:
            mono += d['size_0.33'] <= d['size_0.75'] <= d['size_1.5']
            flip += d['size_0.33'] != d['size_1.5']
    out['spots'] = len(spots_m); out['monotone_spots'] = mono; out['spots_changing_with_size'] = flip
    lad[LABEL[m]] = out
res['ladder'] = lad

# ── talk: strong claim / weak claim vs silent at 75% pot ──────────────────────────────────
Tk = [p for p in P if p['exp'] == 'talk']
talk = {}
for m in MAIN_ORDER:
    base = {p['spot']: p for p in L if p['model'] == m and p['variant'] == 'size_0.75'}
    out = {'silent': pct(sum(p['menuId'] == 'fold' for p in base.values()), len(base))}
    for v in ('talk_strong', 'talk_weak'):
        xs = [p for p in Tk if p['model'] == m and p['variant'] == v]
        out[v] = pct(sum(p['menuId'] == 'fold' for p in xs), len(xs))
        out[v + '_n'] = len(xs)
        out[v + '_changed_vs_silent'] = sum(1 for p in xs if p['spot'] in base and p['menuId'] != base[p['spot']]['menuId'])
    # reasoning that mentions the talk
    mention = [p for p in Tk if p['model'] == m and any(w in (p['reasoning'] or '').lower() for w in ('nuts', 'says', 'said', 'claim', 'talk', 'nothing', 'table'))]
    out['reasoning_mentions_talk'] = len(mention)
    out['examples'] = [{'variant': p['variant'], 'spot': p['spot'], 'menuId': p['menuId'], 'reasoning': (p['reasoning'] or '')[:220]} for p in mention[:3]]
    talk[LABEL[m]] = out
res['talk'] = talk

save('probe.json', res)
print('calls', res['calls'], 'cost', round(res['cost_pricing'], 3), res['cost_by_exp'], 'fallbacks', res['fallbacks'])
print('self', selfagree)
print('orig', orig)
for k, v in sorted(cross.items(), key=lambda x: -(x[1]['coarse'] or 0)):
    print('  ', k, v)
print('profile', prof)
for m, o in lad.items():
    print(m, {k: (v if not isinstance(v, dict) else {kk: r(vv) for kk, vv in v.items()}) for k, v in o.items()})
for m, o in talk.items():
    print(m, {k: v for k, v in o.items() if k != 'examples'})
    for e in o['examples']:
        print('    ', e)
