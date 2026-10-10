"""Smaller threads: where each model's bb come from (no-showdown vs showdown, preflop vs later),
Sol's short-stack shoves, Haiku's misread hands and early busts, biggest pots, Gemini in the pilot,
casual sessions on disk. Writes out/extras.json.   python3 -I 12_extras.py
"""
import sys, os, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nb import *

D = decisions('main'); H = seathands('main')
res = {}

# ── where the bb come from ────────────────────────────────────────────────────────────────
src = {}
for m in MAIN_ORDER:
    hs = [h for h in H if h['model'] == m]
    n = len(hs)
    sd = [h for h in hs if h['showdown'] == 1]
    nosd = [h for h in hs if h['showdown'] == 0]
    pre_end = [h for h in hs if h['board'] == '' ]
    src[m] = {'hands': n, 'bb100_showdown': 100 * sum(h['deltaBb'] for h in sd) / n, 'bb100_no_showdown': 100 * sum(h['deltaBb'] for h in nosd) / n,
              'bb100_preflop_ended': 100 * sum(h['deltaBb'] for h in pre_end) / n,
              'won_uncontested_pct': pct(sum(1 for h in nosd if h['deltaBb'] > 0), n)}
res['sources'] = src

# ── Sol's preflop shoves ──────────────────────────────────────────────────────────────────
sh = [d for d in D if d['model'] == 'openai/gpt-6-sol' and d['street'] == 'preflop' and d['menuId'] == 'all_in']
res['sol_shoves'] = {'n': len(sh), 'median_stack_bb': float(np.median([d['stackBb'] for d in sh])), 'share_under_15bb': pct(sum(1 for d in sh if d['stackBb'] < 15), len(sh)),
                     'eqHU_mean': float(np.mean([d['eqHU'] for d in sh])), 'won_hand_pct': pct(sum(d['wonAny'] for d in sh), len(sh)), 'bb_per_shove': float(np.mean([d['deltaBb'] for d in sh])),
                     'unopened_share': pct(sum(1 for d in sh if d['nRaisesBefore'] == 0), len(sh))}
# others' preflop shove counts at <15bb
short = {}
for m in MAIN_ORDER:
    s = [d for d in D if d['model'] == m and d['street'] == 'preflop' and d['stackBb'] < 15 and d['toCall'] < d['stack']]
    short[m] = {'n': len(s), 'shove': pct(sum(1 for d in s if d['menuId'] == 'all_in'), len(s)), 'fold': pct(sum(1 for d in s if d['menuId'] == 'fold'), len(s)),
                'limp_or_call': pct(sum(1 for d in s if d['menuId'] in ('call', 'check')), len(s)), 'small_raise': pct(sum(1 for d in s if d['menuId'] in ('raise_min', 'raise_half_pot', 'raise_pot', 'raise_2x_pot')), len(s))}
res['short_stack_preflop'] = short

# ── Haiku: misread "sets", early busts ────────────────────────────────────────────────────
rs = json.load(open(os.path.join(OUT, 'reasoning.json')))
T = texts('main')
dkey = {(d['tournamentId'], d['handNo'], d['logIndex']): d for d in D}
hk_set = []
for x in T:
    if x['model'] != 'anthropic/claude-haiku-5.5' or x['street'] == 'preflop':
        continue
    if re.search(r"(?:i have|i hold|i flopped|i've got|giving me|gives me)\s+(?:a |an |the |top |bottom )?(?:set|trips|three of a kind)\b", x['reasoning'] or '', re.I):
        d = dkey.get((x['tournamentId'], x['handNo'], x['logIndex']))
        if d and d['made'] in ('pair', 'two_pair', 'high_card'):
            hk_set.append((x['tournamentId'], x['handNo'], d['hole'], d['board'], d['deltaBb'], x['menuId']))
hands_set = {}
for t, h, hole, board, dbb, a in hk_set:
    hands_set[(t, h)] = (hole, board, dbb)
res['haiku_false_set'] = {'decisions': len(hk_set), 'hands': len(hands_set), 'bb_total': sum(v[2] for v in hands_set.values()),
                          'pocket_pair_share': pct(sum(1 for v in hands_set.values() if v[0][0] == v[0][2]), len(hands_set)),
                          'aggressive_share': pct(sum(1 for x in hk_set if x[5].startswith('raise') or x[5] == 'all_in'), len(hk_set)),
                          'examples': sorted([{'tournamentId': k[0], 'handNo': k[1], 'hole': v[0], 'board': v[1], 'deltaBb': v[2]} for k, v in hands_set.items()], key=lambda e: e['deltaBb'])[:6]}
# Haiku's busting hands
busts = [h for h in H if h['model'] == 'anthropic/claude-haiku-5.5' and h['bustedThisHand'] == 1]
res['haiku_busts'] = sorted([{'tournamentId': h['tournamentId'], 'handNo': h['handNo'], 'hole': h['hole'], 'board': h['board'], 'deltaBb': h['deltaBb'], 'level': h['level']} for h in busts], key=lambda e: e['handNo'])[:12]

# ── the biggest pots of the run (by bb moved) ─────────────────────────────────────────────
big = sorted(H, key=lambda h: -abs(h['deltaBb']))
seen = set(); top = []
for h in big:
    k = (h['tournamentId'], h['handNo'])
    if k in seen:
        continue
    seen.add(k)
    rows = [x for x in H if x['tournamentId'] == h['tournamentId'] and x['handNo'] == h['handNo']]
    top.append({'tournamentId': h['tournamentId'], 'handNo': h['handNo'], 'bb': h['bb'], 'board': h['board'],
                'seats': {LABEL[x['model']]: {'hole': x['hole'], 'deltaBb': x['deltaBb']} for x in rows if x['deltaBb'] != 0}})
    if len(top) >= 10:
        break
res['biggest_pots'] = top

# ── Gemini in the pilot ───────────────────────────────────────────────────────────────────
po = json.load(open(os.path.join(OUT, 'pilot_official.json')))
res['pilot'] = {'leaderboard': po['leaderboard'], 'style': [{k: s[k] for k in ('modelId', 'hands', 'vpip', 'pfr', 'af', 'wtsd', 'wsd', 'avgMs', 'costUsd', 'decisions')} for s in po['style']], 'ops': po['ops']}

# ── casual sessions on disk ───────────────────────────────────────────────────────────────
sess = []
for p in sorted(glob.glob(os.path.join(ROOT, 'data/sessions/*.jsonl'))):
    lines = [json.loads(l) for l in open(p) if l.strip()]
    st = next((l for l in lines if l['type'] == 'session_start'), None)
    hands = [l for l in lines if l['type'] == 'hand']
    sess.append({'file': os.path.basename(p), 'mode': st['mode'] if st else None, 'seats': [s['name'] for s in st['seats']] if st else None, 'hands': len(hands)})
res['sessions'] = sess

save('extras.json', res)
print(json.dumps({k: res[k] for k in ('sources', 'sol_shoves', 'short_stack_preflop', 'haiku_false_set', 'sessions')}, indent=1, default=lambda x: round(x, 1)))
print(json.dumps(res['biggest_pots'][:5], indent=0))
print(json.dumps(res['pilot']['style'], default=lambda x: round(x, 1)))
