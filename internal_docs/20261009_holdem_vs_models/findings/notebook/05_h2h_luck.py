"""Head-to-head, luck and the duplicate design.
- chip flow (official) normalised per 100 hands both seats were dealt
- Sol's take from each opponent in the B3 field and on the B4 held-out table
- card luck: does duplicate seeding cancel it? (per tournament vs per match spread)
- all-in luck (04_allin_ev.ts) per model, per tournament vs per match
- bust timing and finish shape (bimodality)
Writes out/h2h_luck.json.   python3 -I 05_h2h_luck.py
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nb import *

res = {}
off = json.load(open(os.path.join(OUT, 'main_official.json')))
H = seathands('main')
D = decisions('main')

# ── flow per 100 shared hands ─────────────────────────────────────────────────────────────
shared = defaultdict(int)
for (tid, hn), rows in group(H, 'tournamentId', 'handNo').items():
    ms = [r['model'] for r in rows]
    for a in ms:
        for b in ms:
            if a != b:
                shared[(a, b)] += 1
flow = off['flow']
res['flow_bb'] = flow
res['flow_per100'] = {a: {b: (100 * flow[a][b] / shared[(a, b)] if shared[(a, b)] else None) for b in MAIN_ORDER} for a in MAIN_ORDER}
res['shared_hands'] = {f'{LABEL[a]}|{LABEL[b]}': shared[(a, b)] for a in MAIN_ORDER for b in MAIN_ORDER if a < b}

# ── heads-up postflop pots: who wins when exactly two saw the flop ───────────────────────
hu = defaultdict(lambda: [0.0, 0])
for (tid, hn), rows in group(H, 'tournamentId', 'handNo').items():
    sf = [r for r in rows if r['sawFlop'] == 1]
    if len(sf) != 2:
        continue
    a, b = sf
    hu[(a['model'], b['model'])][0] += a['deltaBb']
    hu[(a['model'], b['model'])][1] += 1
    hu[(b['model'], a['model'])][0] += b['deltaBb']
    hu[(b['model'], a['model'])][1] += 1
res['hu_postflop'] = {f'{LABEL[a]}>{LABEL[b]}': {'n': v[1], 'bb_per_pot': v[0] / v[1]} for (a, b), v in hu.items()}

# ── Sol on the held-out lab table (different field: carded Lunas, control, Haiku) ─────────
HH = seathands('20261010_lab__heldout')
flow_h = defaultdict(float)
for (tid, hn), rows in group(HH, 'tournamentId', 'handNo').items():
    won = [r for r in rows if r['delta'] > 0]
    tot = sum(r['delta'] for r in won)
    if not tot:
        continue
    for l in rows:
        if l['delta'] >= 0:
            continue
        for w in won:
            amt = -l['delta'] * (w['delta'] / tot) / l['bb']
            flow_h[(w['player'], l['player'])] += amt
            flow_h[(l['player'], w['player'])] -= amt
players_h = sorted({r['player'] for r in HH})
res['heldout_flow_sol'] = {p: flow_h[('openai/gpt-6-sol', p)] for p in players_h if p != 'openai/gpt-6-sol'}
res['heldout_bb100'] = {p: 100 * sum(r['deltaBb'] for r in HH if r['player'] == p) / sum(1 for r in HH if r['player'] == p) for p in players_h}

# ── card luck and the duplicate design ────────────────────────────────────────────────────
# card quality = mean heads-up preflop equity of the hands a model was dealt (first preflop decision)
firstEq = {}
for d in D:
    if d['street'] != 'preflop':
        continue
    k = (d['tournamentId'], d['handNo'], d['seatId'])
    firstEq.setdefault(k, d['eqHU'])
cq_t = defaultdict(list)   # (tournament, model) -> eqs
cq_m = defaultdict(list)   # (match, model)
for h in H:
    e = firstEq.get((h['tournamentId'], h['handNo'], h['seatId']))
    if e is None:
        continue
    cq_t[(h['tournamentId'], h['model'])].append(e)
    cq_m[(h['matchId'], h['model'])].append(e)
def spread(dct, unit):
    # within each unit, range of mean card quality across the 5 models
    by = defaultdict(dict)
    for (u, m), v in dct.items():
        if len(v) >= 10:
            by[u][m] = float(np.mean(v))
    sds = [np.std(list(x.values())) for x in by.values() if len(x) == 5]
    return float(np.mean(sds)), len(sds)
res['card_quality_sd_between_models'] = {'per_tournament': spread(cq_t, 't'), 'per_match': spread(cq_m, 'm')}
# premium hands: pocket pairs TT+ and AK, per model per tournament vs per match
def premium(hole):
    r1, r2 = hole[0], hole[2]
    return (r1 == r2 and r1 in 'TJQKA') or {r1, r2} == {'A', 'K'}
prem_t = defaultdict(int); prem_m = defaultdict(int)
for h in H:
    if premium(h['hole']):
        prem_t[(h['tournamentId'], h['model'])] += 1
        prem_m[(h['matchId'], h['model'])] += 1
tids = sorted({h['tournamentId'] for h in H}); mids = sorted({h['matchId'] for h in H})
res['premiums'] = {
    'per_tournament_max_minus_min_mean': float(np.mean([max(prem_t[(t, m)] for m in MAIN_ORDER) - min(prem_t[(t, m)] for m in MAIN_ORDER) for t in tids])),
    'per_match_max_minus_min_mean': float(np.mean([max(prem_m[(t, m)] for m in MAIN_ORDER) - min(prem_m[(t, m)] for m in MAIN_ORDER) for t in mids])),
    'per_model_total': {LABEL[m]: sum(prem_m[(t, m)] for t in mids) for m in MAIN_ORDER},
}

# all-in luck by tournament and by match
al = [row for row in csv.DictReader(open(os.path.join(CACHE, 'allin_main.csv')))]
lt = defaultdict(float); lm = defaultdict(float)
for row in al:
    lt[(row['tournamentId'], row['model'])] += float(row['luckBb'])
    lm[(row['matchId'], row['model'])] += float(row['luckBb'])
res['allin'] = json.load(open(os.path.join(OUT, 'allin_main.json')))['models']
res['allin_luck_abs_mean'] = {
    'per_tournament': float(np.mean([abs(lt[(t, m)]) for t in tids for m in MAIN_ORDER])),
    'per_match_per_tournament': float(np.mean([abs(lm[(t, m)]) / 5 for t in mids for m in MAIN_ORDER])),
}

# what bb/100 CI would we have without duplicate pairing? resample tournaments independently
def bb100(rows, m):
    rr = [r for r in rows if r['model'] == m]
    return 100 * sum(r['deltaBb'] for r in rr) / len(rr) if rr else float('nan')
ci = {}
for m in MAIN_ORDER:
    ci[m] = {'match': cluster_boot(H, 'matchId', lambda rows: bb100(rows, m)), 'tournament': cluster_boot(H, 'tournamentId', lambda rows: bb100(rows, m))}
res['ci_cluster_choice'] = ci

# ── finish shape and bust timing ──────────────────────────────────────────────────────────
T = [json.loads(l) for l in open(os.path.join(ROOT, 'data/runs/20261010_main.jsonl')) if '"type":"tournament"' in l]
bust = defaultdict(list)
first_out = Counter()
for t in T:
    busted = [f for f in t['finish'] if f.get('bustHand') is not None]
    for f in busted:
        bust[f['modelId']].append(f['bustHand'])
    if busted:
        fo = min(busted, key=lambda f: (f['bustHand'], -f['place']))
        first_out[fo['modelId']] += 1
res['bust_hands'] = {LABEL[m]: {'n': len(v), 'median': float(np.median(v)), 'before_hand_15': sum(1 for x in v if x < 15)} for m, v in bust.items()}
res['first_out'] = {LABEL[m]: c for m, c in first_out.items()}
res['finishes'] = off['finishes']
res['reasons'] = Counter(t['reason'] for t in T)
res['survivors_at_cap'] = Counter(sum(1 for f in t['finish'] if f.get('bustHand') is None) for t in T if t['reason'] == 'hand_cap')
res['cap_winner'] = Counter(LABEL[t['finish'][0]['modelId']] for t in T if t['reason'] == 'hand_cap')
res['finished_winner'] = Counter(LABEL[t['finish'][0]['modelId']] for t in T if t['reason'] == 'finished')
# chip-lead winner at cap: how big a lead?
res['cap_leader_share'] = float(np.mean([t['finish'][0]['stack'] / 7500 for t in T if t['reason'] == 'hand_cap']))

save('h2h_luck.json', res)
print(json.dumps({k: res[k] for k in ('flow_per100', 'heldout_flow_sol', 'heldout_bb100', 'card_quality_sd_between_models', 'premiums', 'allin_luck_abs_mean', 'bust_hands', 'first_out', 'cap_winner', 'finished_winner', 'cap_leader_share', 'survivors_at_cap')}, indent=1, default=lambda x: round(x, 2)))
print({LABEL[m]: {k: tuple(r(x, 1) for x in v) for k, v in c.items()} for m, c in ci.items()})
print({k: v for k, v in res['hu_postflop'].items() if v['n'] >= 20})
