"""Why were Fable's pre-registered predictions one-directionally wrong?
1. calibration: predicted vs measured (lab + the pilot Fable never saw): r, slope, spreads
2. noise budget: per-match lead SD (within card), so how much of the measured spread is noise
3. style moved, results didn't: VPIP/PFR/AF displacement from the control vs bb/100
Writes out/fable.json.   python3 -I 10_fable.py
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nb import *

res = {}
def calib(scatter, cards):
    pc = {c['id']: c['predicted'] for c in cards}
    rows = []
    for s in scatter:
        p = pc.get(s['cardId'], {})
        rows.append({'cardId': s['cardId'], 'label': s['label'].replace('Luna · ', ''), 'gen': s['gen'], 'pred_bb100': s['predicted'], 'actual_bb100': s['actual'],
                     'lo': s['lo'], 'hi': s['hi'], 'pred_lead': p.get('vsControl')})
    x = np.array([r['pred_bb100'] for r in rows]); y = np.array([r['actual_bb100'] for r in rows])
    slope, icpt = np.polyfit(x, y, 1)
    return rows, {'n': len(rows), 'r': float(np.corrcoef(x, y)[0, 1]), 'slope': float(slope), 'intercept': float(icpt),
                  'sd_pred': float(x.std(ddof=1)), 'sd_actual': float(y.std(ddof=1)),
                  'mean_err_pred_pos': float(np.mean([b - a for a, b in zip(x, y) if a > 0])) if (x > 0).any() else None,
                  'mean_err_pred_neg': float(np.mean([b - a for a, b in zip(x, y) if a < 0])) if (x < 0).any() else None,
                  'n_pred_pos_below': int(sum(1 for a, b in zip(x, y) if a > 0 and b < a)), 'n_pred_pos': int((x > 0).sum()),
                  'n_pred_neg_above': int(sum(1 for a, b in zip(x, y) if a < 0 and b > a)), 'n_pred_neg': int((x < 0).sum()),
                  'mae': float(np.mean(np.abs(y - x))), 'mae_if_predicted_control': float(np.mean(np.abs(y - 10)))}

lab = json.load(open(os.path.join(OUT, 'lab_official.json')))
pil = json.load(open(os.path.join(OUT, 'lab_pilot_official.json')))
res['lab_rows'], res['lab_calib'] = calib(lab['scatter'], lab['cards'])
res['pilot_rows'], res['pilot_calib'] = calib(pil['scatter'], pil['cards'])
res['control_bb100'] = lab['control']['bb100']

# ── noise budget: per-match leads from the lab table files ────────────────────────────────
per_match = defaultdict(list)  # cardId -> [lead per match]
noise_pairs = []
for path in sorted(glob.glob(os.path.join(CACHE, 'seathands_20261010_lab__g*.csv'))):
    rows = load('seathands', os.path.basename(path)[len('seathands_'):-4])
    table = os.path.basename(path)[len('seathands_20261010_lab__'):-4]   # g0-g0c04
    card = table.split('-')[1]
    for mid, rr in group(rows, 'matchId').items():
        def b100(p):
            x = [r for r in rr if r['player'] == p]
            return 100 * sum(r['deltaBb'] for r in x) / len(x) if x else None
        c, k = b100(card), b100('control')
        if c is not None and k is not None:
            per_match[card].append(c - k)
        c2 = b100('control-2')
        if c2 is not None and k is not None:
            noise_pairs.append(c2 - k)
within = [np.std(v, ddof=1) for v in per_match.values() if len(v) >= 3]
res['per_match_leads'] = {k: v for k, v in per_match.items()}
res['noise'] = {'within_card_sd_per_match': float(np.sqrt(np.mean(np.square(within)))), 'cards_used': len(within),
                'control2_minus_control_per_match_sd': float(np.std(noise_pairs, ddof=1)) if len(noise_pairs) > 1 else None,
                'control2_matches': len(noise_pairs), 'control2_mean': float(np.mean(noise_pairs)) if noise_pairs else None}
# observed spread of own-table leads vs what noise alone would give
leads = {c: float(np.mean(v)) for c, v in per_match.items()}
n_m = {c: len(v) for c, v in per_match.items()}
sd_noise = res['noise']['within_card_sd_per_match']
obs_var = float(np.var(list(leads.values()), ddof=1))
noise_var = float(np.mean([sd_noise ** 2 / n_m[c] for c in leads]))
res['spread'] = {'observed_sd_of_leads': obs_var ** 0.5, 'expected_sd_from_noise_alone': noise_var ** 0.5,
                 'implied_true_sd': max(0.0, obs_var - noise_var) ** 0.5,
                 'predicted_sd_of_leads': float(np.std([c['predicted']['vsControl'] for c in lab['cards']], ddof=1))}

# ── style displacement vs result ──────────────────────────────────────────────────────────
st = {s['seatId']: s for s in lab['styles']}
ctl = st['control']
pooled = {p['cardId']: p for p in lab['pooled']}
disp = []
for c in lab['cards']:
    s = st.get(c['id'])
    if not s:
        continue
    disp.append({'cardId': c['id'], 'name': c['name'], 'axes': c['axes'], 'hands': s['hands'], 'vpip': s['vpip'], 'pfr': s['pfr'], 'af': s['af'], 'wtsd': s['wtsd'], 'wsd': s['wsd'],
                 'd_vpip': s['vpip'] - ctl['vpip'], 'd_pfr': s['pfr'] - ctl['pfr'], 'pred_bb100': c['predicted']['bb100'],
                 'pooled_bb100': pooled[c['id']]['bb100']['value'], 'pooled_lead': pooled[c['id']]['lead']['value']})
res['style'] = disp
res['control_style'] = {k: ctl[k] for k in ('vpip', 'pfr', 'af', 'wtsd', 'wsd', 'hands')}
x = np.array([abs(d['d_vpip']) + abs(d['d_pfr']) for d in disp]); y = np.array([abs(d['pooled_bb100'] - lab['control']['bb100']['value']) for d in disp])
res['style_vs_result_r'] = float(np.corrcoef(x, y)[0, 1])

save('fable.json', res)
print('lab', {k: r(v, 2) for k, v in res['lab_calib'].items()})
print('pilot', {k: r(v, 2) for k, v in res['pilot_calib'].items()})
for row in res['pilot_rows']:
    print('  pilot', row['label'], row['pred_bb100'], r(row['actual_bb100']))
print('noise', res['noise'])
print('spread', {k: r(v) for k, v in res['spread'].items()})
for d in disp:
    print(f"  {d['name']:22s} vpip {d['vpip']:5.1f} pfr {d['pfr']:5.1f} af {d['af'] if d['af'] is None else round(d['af'], 1)}  pred {d['pred_bb100']:5} pooled {d['pooled_bb100']:6.1f}")
print('control', res['control_style'], 'style vs |result| r', r(res['style_vs_result_r'], 2))
