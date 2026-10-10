"""Breadth: style profiles, positional play, sizing, ops (cost/latency/tokens), per-level results.
Writes out/breadth.json.   python3 -I 03_breadth.py
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nb import *

D = decisions('main')
H = seathands('main')
off = json.load(open(os.path.join(OUT, 'main_official.json')))
res = {}

# ── standings (official numbers) ──────────────────────────────────────────────────────────
res['leaderboard'] = [{'model': x['modelId'], 'hands': x['hands'], 'bb100': x['bb100'], 'avgFinish': x['avgFinish']} for x in off['leaderboard']]
res['pairs'] = off['pairs']
res['finishes'] = off['finishes']
res['plackettLuce'] = off['plackettLuce']
res['flow'] = off['flow']
res['style_official'] = [{k: s[k] for k in ('modelId', 'hands', 'vpip', 'pfr', 'af', 'wtsd', 'wsd', 'counts', 'avgMs', 'costUsd', 'decisions')} for s in off['style']]

byM = group(D, 'model')
hByM = group(H, 'model')

# ── preflop profile ───────────────────────────────────────────────────────────────────────
pre = {}
for m in MAIN_ORDER:
    ds = [d for d in byM[m] if d['street'] == 'preflop']
    unopened = [d for d in ds if d['nRaisesBefore'] == 0 and d['position'] != 'big blind']
    facing = [d for d in ds if d['nRaisesBefore'] >= 1]
    facing1 = [d for d in ds if d['nRaisesBefore'] == 1]
    c_un = Counter('raise' if d['menuId'].startswith('raise') or d['menuId'] == 'all_in' else d['menuId'] for d in unopened)
    c_f = Counter('raise' if d['menuId'].startswith('raise') or d['menuId'] == 'all_in' else d['menuId'] for d in facing1)
    hs = hByM[m]
    # hand-selection quality: preflop heads-up equity of the first decision's hand, VPIP vs not
    first = {}
    for d in ds:
        key = (d['tournamentId'], d['handNo'])
        if key not in first:
            first[key] = d
    played = [d['eqHU'] for k, d in first.items()]
    vp = {(h['tournamentId'], h['handNo']): h['vpip'] for h in hs}
    eq_in = [d['eqHU'] for k, d in first.items() if vp.get(k) == 1]
    eq_out = [d['eqHU'] for k, d in first.items() if vp.get(k) == 0]
    # AUC: P(random played hand > random folded hand)
    a = np.array(eq_in); b = np.array(eq_out)
    auc = float(((a[:, None] > b[None, :]).mean() + 0.5 * (a[:, None] == b[None, :]).mean())) if len(a) and len(b) else None
    allin_pre = sum(1 for d in ds if d['menuId'] == 'all_in')
    pre[m] = {
        'unopened_n': len(unopened), 'open_raise': pct(c_un['raise'], len(unopened)), 'limp': pct(c_un['call'], len(unopened)), 'open_fold': pct(c_un['fold'], len(unopened)),
        'vs_raise_n': len(facing1), 'vs_raise_fold': pct(c_f['fold'], len(facing1)), 'vs_raise_call': pct(c_f['call'], len(facing1)), 'vs_raise_3bet': pct(c_f['raise'], len(facing1)),
        'preflop_allin_n': allin_pre, 'preflop_decisions': len(ds),
        'eqHU_played': float(np.mean(eq_in)) if eq_in else None, 'eqHU_folded': float(np.mean(eq_out)) if eq_out else None, 'selection_auc': auc,
    }
res['preflop'] = pre

# VPIP / PFR / bb100 by position
posres = {}
for m in MAIN_ORDER:
    hs = [h for h in hByM[m] if h['position']]
    gp = group(hs, 'position')
    posres[m] = {p: {'n': len(v), 'vpip': pct(sum(h['vpip'] for h in v), len(v)), 'pfr': pct(sum(h['pfr'] for h in v), len(v)),
                     'bb100': 100 * sum(h['deltaBb'] for h in v) / len(v)} for p, v in gp.items()}
res['position'] = posres

# ── postflop profile ──────────────────────────────────────────────────────────────────────
post = {}
for m in MAIN_ORDER:
    ds = [d for d in byM[m] if d['street'] in ('flop', 'turn', 'river')]
    free = [d for d in ds if d['toCall'] == 0]
    facing = [d for d in ds if d['toCall'] > 0]
    agg = lambda d: d['menuId'].startswith('raise') or d['menuId'] == 'all_in'
    post[m] = {
        'checked_to_n': len(free), 'bet_when_checked_to': pct(sum(agg(d) for d in free), len(free)),
        'facing_n': len(facing), 'fold_to_bet': pct(sum(d['menuId'] == 'fold' for d in facing), len(facing)),
        'call_bet': pct(sum(d['menuId'] == 'call' for d in facing), len(facing)), 'raise_bet': pct(sum(agg(d) for d in facing), len(facing)),
    }
    for st in ('flop', 'turn', 'river'):
        f = [d for d in facing if d['street'] == st]
        post[m][f'fold_to_bet_{st}'] = pct(sum(d['menuId'] == 'fold' for d in f), len(f))
        post[m][f'facing_n_{st}'] = len(f)
res['postflop'] = post

# ── bet sizing: which menu size when aggressive ───────────────────────────────────────────
SIZES = ['raise_min', 'raise_half_pot', 'raise_pot', 'raise_2x_pot', 'all_in']
sizing = {}
for m in MAIN_ORDER:
    for st_group, sts in (('preflop', ('preflop',)), ('postflop', ('flop', 'turn', 'river'))):
        ag = [d for d in byM[m] if d['street'] in sts and d['menuId'] in SIZES]
        c = Counter(d['menuId'] for d in ag)
        # all_in that is effectively a small amount (short stack) vs a real overbet
        allin_bb = [d['addBb'] for d in ag if d['menuId'] == 'all_in']
        sizing.setdefault(m, {})[st_group] = {'n': len(ag), **{s: pct(c[s], len(ag)) for s in SIZES},
                                              'median_add_frac_pot': float(np.median([d['addFracPot'] for d in ag])) if ag else None,
                                              'allin_median_bb': float(np.median(allin_bb)) if allin_bb else None}
res['sizing'] = sizing

# ── ops: cost, latency, tokens ─────────────────────────────────────────────────────────────
ops = {}
lb = {x['modelId']: x for x in off['leaderboard']}
for m in MAIN_ORDER:
    ds = byM[m]
    lat = np.array([d['latencyMs'] for d in ds])
    cost = sum(d['costUsd'] for d in ds)
    hands = lb[m]['hands']
    bbwon = lb[m]['bb100']['value'] * hands / 100
    ops[m] = {'decisions': len(ds), 'lat_mean': float(lat.mean()), 'lat_p50': float(np.median(lat)), 'lat_p95': float(np.percentile(lat, 95)), 'lat_max': float(lat.max()),
              'in_tok': float(np.mean([d['inTok'] for d in ds])), 'out_tok': float(np.mean([d['outTok'] for d in ds])),
              'cost': cost, 'cost_per_decision': cost / len(ds), 'cost_per_100_hands': 100 * cost / hands, 'bb_won': bbwon,
              'usd_per_bb_won': cost / bbwon if bbwon > 0 else None, 'fallbacks': sum(d['fallback'] for d in ds),
              'decisions_per_hand': len(ds) / hands}
res['ops'] = ops
res['run_cost'] = sum(d['costUsd'] for d in D)

# latency vs spot: Sol thinks longer when?
think = {}
for m in ('openai/gpt-6-sol', 'anthropic/claude-haiku-5.5', 'openai/gpt-6-luna'):
    ds = byM[m]
    out = {}
    for st in ('preflop', 'flop', 'turn', 'river'):
        s = [d for d in ds if d['street'] == st]
        out[st] = {'out_tok': float(np.mean([d['outTok'] for d in s])), 'lat': float(np.mean([d['latencyMs'] for d in s]))}
    big = [d for d in ds if d['toCall'] > 0 and d['toCall'] >= 0.5 * d['stack']]
    small = [d for d in ds if d['toCall'] == 0]
    out['facing_half_stack_out_tok'] = float(np.mean([d['outTok'] for d in big])) if big else None
    out['checked_to_out_tok'] = float(np.mean([d['outTok'] for d in small]))
    # correlation of output tokens with spot difficulty (|eqActual - potOdds| small = close)
    f = [d for d in ds if d['toCall'] > 0]
    close = [d['outTok'] for d in f if abs(d['eqRandom'] - d['potOdds']) < 0.1]
    clear = [d['outTok'] for d in f if abs(d['eqRandom'] - d['potOdds']) >= 0.3]
    out['close_spot_out_tok'] = float(np.mean(close)) if close else None
    out['clear_spot_out_tok'] = float(np.mean(clear)) if clear else None
    think[m] = out
res['think'] = think

# ── results by blind level (stack depth) ──────────────────────────────────────────────────
lv = {}
for m in MAIN_ORDER:
    hs = hByM[m]
    gl = group(hs, 'level')
    lv[m] = {int(k): {'n': len(v), 'bb100': 100 * sum(h['deltaBb'] for h in v) / len(v), 'chips': sum(h['delta'] for h in v),
                      'avg_stack_bb': float(np.mean([h['stackBb'] for h in v]))} for k, v in sorted(gl.items())}
res['by_level'] = lv
# chip-based alternative: total chips won per model / tournaments (chips are what places you)
chips = {m: sum(h['delta'] for h in hByM[m]) for m in MAIN_ORDER}
res['chips_total'] = chips

save('breadth.json', res)

# ── print ─────────────────────────────────────────────────────────────────────────────────
for m in MAIN_ORDER:
    print(f"\n== {LABEL[m]}")
    print(' pre', {k: r(v, 2) for k, v in pre[m].items()})
    print(' post', {k: r(v) for k, v in post[m].items()})
    print(' size', {k: {kk: r(vv, 2) for kk, vv in v.items()} for k, v in sizing[m].items()})
    print(' ops', {k: r(v, 5) for k, v in ops[m].items()})
    print(' pos', {p: (v['n'], r(v['vpip']), r(v['pfr']), r(v['bb100'])) for p, v in posres[m].items()})
    print(' level', {k: (v['n'], r(v['bb100']), v['chips'], r(v['avg_stack_bb'])) for k, v in lv[m].items()})
print('\nthink', json.dumps(think, indent=0, default=lambda x: round(x, 1)))
print('chips', chips, 'run cost', res['run_cost'])
