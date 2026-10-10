"""Builds ../report.html from out/*.json (run 02–14 first). Charts are inline SVG from charts.py.
   python3 -I 15_build_report.py
"""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nb import OUT, LABEL, MAIN_ORDER
from charts import ci_dots, hbars, stacked_share, lines, scatter, heat_table, cards_html, esc

J = lambda n: json.load(open(os.path.join(OUT, n)))
off, br, h2h, dm, bets, talk, rs, fab, ex, dup, al, pr = (J('main_official.json'), J('breadth.json'), J('h2h_luck.json'), J('decision_models.json'), J('bets.json'),
                                                        J('talk.json'), J('reasoning.json'), J('fable.json'), J('extras.json'), J('duplicate.json'), J('allin_main.json'), J('probe.json'))
L = lambda m: LABEL[m]
lb = {x['modelId']: x for x in off['leaderboard']}

# ── charts ───────────────────────────────────────────────────────────────────────────────
c_leader = ci_dots([(L(m), lb[m]['bb100']['value'], lb[m]['bb100']['lo'], lb[m]['bb100']['hi'],
                     f"avg finish {lb[m]['avgFinish']['value']:.2f} · {off['finishes'][m][0]} wins / 40") for m in MAIN_ORDER],
                   (-120, 130), [-100, -50, 0, 50, 100], unit='bb/100, 95% CI (8 matches)')
c_finish = stacked_share([(L(m), off['finishes'][m]) for m in MAIN_ORDER], ['1st', '2nd', '3rd', '4th', '5th'], 'finish positions')
alladj = al['models']
c_luck = hbars([(L(m), alladj[m]['adjustedBb100'], f"{L(m)}: {alladj[m]['bb100']:+.1f} actual, {alladj[m]['adjustedBb100']:+.1f} after replacing {alladj[m]['allinShowdowns']} all-in runouts with equity") for m in MAIN_ORDER],
               (-80, 100), [-50, 0, 50], 'bb/100 with all-in luck removed')
fl = h2h['flow_per100']['openai/gpt-6-sol']
c_solflow = hbars([(L(m), fl[m], f"Sol took {fl[m]:.1f} bb per 100 hands shared with {L(m)}") for m in MAIN_ORDER if m != 'openai/gpt-6-sol'],
                  (0, 70), [0, 20, 40, 60], 'bb Sol won per 100 hands shared', color='--m-sol', width=440, label_w=110)
hf = h2h['heldout_flow_sol']
HL = {'anthropic/claude-haiku-5.5': 'Haiku', 'control': 'Luna (no card)', 'g0c05': 'Luna · Bot Hunter', 'g0c04': 'Luna · Balanced Solid', 'g0c07': 'Luna · Silver Tongue'}
c_heldflow = hbars([(HL[k], v, f'Sol won {v:.0f} bb net from {HL[k]} over 3 held-out matches') for k, v in sorted(hf.items(), key=lambda kv: -kv[1])],
                   (0, 180), [0, 50, 100, 150], 'bb Sol won from each seat, held-out', color='--m-sol', label_w=150, width=440)
src = ex['sources']
c_src = heat_table([L(m) for m in MAIN_ORDER], ['At showdown', 'Without showdown', 'Total'],
                   lambda r, c: {'At showdown': src[[m for m in MAIN_ORDER if L(m) == r][0]]['bb100_showdown'], 'Without showdown': src[[m for m in MAIN_ORDER if L(m) == r][0]]['bb100_no_showdown'],
                                 'Total': lb[[m for m in MAIN_ORDER if L(m) == r][0]]['bb100']['value']}[c], lambda v: f'{v:+.0f}', 70)
lv = br['by_level']
c_level = heat_table([L(m) for m in MAIN_ORDER], ['10/20', '20/40', '40/80', '80/160', '160/320'],
                     lambda r, c: lv[[m for m in MAIN_ORDER if L(m) == r][0]].get(str(['10/20', '20/40', '40/80', '80/160', '160/320'].index(c)), {}).get('bb100'),
                     lambda v: f'{v:+.0f}', 110,
                     title_fn=lambda r, c, v: f"{r} at blinds {c}: {v:+.0f} bb/100 over {lv[[m for m in MAIN_ORDER if L(m) == r][0]][str(['10/20', '20/40', '40/80', '80/160', '160/320'].index(c))]['n']:.0f} hands")
# facing bets, natural data (Luna) and the ladder experiment
lad = pr['ladder']
c_ladder = lines([(name, [lad[name][v]['fold'] for v in ('size_0.33', 'size_0.75', 'size_1.5')]) for name in ('Sol', 'Luna', 'Luna Decisions', 'Haiku', 'Jev')],
                 ['⅓ pot', '¾ pot', '1½ pot'], (0, 100), [0, 25, 50, 75, 100], 'fold % on the same 36 spots',
                 ref=('break-even bluff %', [100 * 0.33 / 1.33, 100 * 0.75 / 1.75, 100 * 1.5 / 2.5]))
q = bets['quality']
c_riverfold = hbars([(L(m), 100 * q[m]['river_hu']['bad_fold'] / max(1, q[m]['river_hu']['folds']),
                      f"{L(m)}: {q[m]['river_hu']['bad_fold']} of {q[m]['river_hu']['folds']} heads-up river folds gave up the best hand ({q[m]['river_hu']['bb_lost_bad_folds']:.0f} bb of pot odds forgone)") for m in MAIN_ORDER],
                    (0, 60), [0, 20, 40], '% of heads-up river folds that held the winning hand', fmt='{:.0f}%')
# talk tell
tl = talk['tells']
c_tell = heat_table(['Sol', 'Luna', 'Haiku'], ['bets with talk', 'silent bets', 'talk rate on bets'],
                    lambda r, c: {'bets with talk': tl[{'Sol': 'openai/gpt-6-sol', 'Luna': 'openai/gpt-6-luna', 'Haiku': 'anthropic/claude-haiku-5.5'}[r]]['eq_talk'] * 100,
                                  'silent bets': tl[{'Sol': 'openai/gpt-6-sol', 'Luna': 'openai/gpt-6-luna', 'Haiku': 'anthropic/claude-haiku-5.5'}[r]]['eq_silent'] * 100,
                                  'talk rate on bets': 100 * tl[{'Sol': 'openai/gpt-6-sol', 'Luna': 'openai/gpt-6-luna', 'Haiku': 'anthropic/claude-haiku-5.5'}[r]]['bets_talk_n'] / tl[{'Sol': 'openai/gpt-6-sol', 'Luna': 'openai/gpt-6-luna', 'Haiku': 'anthropic/claude-haiku-5.5'}[r]]['bets_n']}[c],
                    lambda v: f'{v:.0f}%', 100, diverging=False)
# reasoning
rb = rs['by_model']
c_misread = hbars([('Sol · made-hand claims', 100 * sum(rb['openai/gpt-6-sol']['claims_wrong'].values()) / sum(rb['openai/gpt-6-sol']['claims'].values()), 'Sol: 0 wrong of 112 made-hand claims'),
                   ('Luna · made-hand claims', 100 * sum(rb['openai/gpt-6-luna']['claims_wrong'].values()) / sum(rb['openai/gpt-6-luna']['claims'].values()), 'Luna: 9 wrong of 138'),
                   ('Haiku · made-hand claims', 100 * sum(rb['anthropic/claude-haiku-5.5']['claims_wrong'].values()) / sum(rb['anthropic/claude-haiku-5.5']['claims'].values()), 'Haiku: 67 wrong of 244'),
                   ('Haiku · "set" claims', 100 * rb['anthropic/claude-haiku-5.5']['claims_wrong']['set_trips'] / rb['anthropic/claude-haiku-5.5']['claims']['set_trips'], 'Haiku: 38 of 64 claimed sets were not sets'),
                   ('Haiku · preflop hand named', rb['anthropic/claude-haiku-5.5']['preflop_misread_rate_of_named'], 'Haiku: 167 of 906 preflop hand descriptions wrong')],
                  (0, 65), [0, 20, 40, 60], '% of checkable claims that were wrong', fmt='{:.0f}%', label_w=200,
                  color='--m-haiku')
# decision models: confidence histograms
def hist_svg(hist, var, label):
    bins = ['<30', '30', '40', '50', '60', '70', '80', '90', '95+']
    tot = sum(hist); mx = max(hist) / tot
    w, h, left, bottom = 440, 190, 8, 34
    bw = (w - left * 2) / len(hist)
    out = [f'<svg viewBox="0 0 {w} {h}" class="chart" role="img" aria-label="{esc(label)}">']
    for i, c in enumerate(hist):
        bh = (h - bottom - 10) * (c / tot) / mx
        out.append(f'<g><title>{esc(label)}: top probability {bins[i]}% in {c} of {tot} decisions</title><rect x="{left + i * bw + 1:.1f}" y="{h - bottom - bh:.1f}" width="{bw - 2:.1f}" height="{bh:.1f}" rx="2" style="fill:var({var})"/></g>')
        out.append(f'<text x="{left + i * bw + bw / 2:.1f}" y="{h - bottom + 14}" class="tick" text-anchor="middle">{bins[i]}</text>')
    out.append(f'<line x1="{left}" x2="{w - left}" y1="{h - bottom}" y2="{h - bottom}" class="zero"/>')
    out.append(f'<text x="{w - left}" y="{h - 2}" class="axis-label" text-anchor="end">probability of the chosen option, %</text></svg>')
    return '\n'.join(out)
sh = dm['shape']
c_hist_ld = hist_svg(sh['openai/gpt-6-luna-decisions']['topP_hist'], '--m-lunad', 'Luna Decisions')
c_hist_jev = hist_svg(sh['typesafe-ai/jev']['topP_hist'], '--m-jev', 'Jev')
# agreement matrix: self on the diagonal (probe), cross-model on identical views (probe)
names = ['Sol', 'Luna', 'Luna Decisions', 'Haiku', 'Jev']
def agree(a, b):
    if a == b:
        return pr['self_agreement'][a]['exact']
    k = f'{a}|{b}' if f'{a}|{b}' in pr['cross_agreement'] else f'{b}|{a}'
    return pr['cross_agreement'][k]['exact']
c_agree = heat_table(names, names, agree, lambda v: f'{v:.0f}', 100, diverging=False,
                     title_fn=lambda r, c, v: (f'{r} agreed with itself on {v:.0f}% of re-asked views' if r == c else f'{r} and {c} chose the same option on {v:.0f}% of identical views'))
# Fable calibration
rows = fab['lab_rows']
c_fable = scatter([(x['label'], x['pred_bb100'], x['actual_bb100'], x['lo'], x['hi']) for x in rows], (-80, 70), (-80, 70), [-75, -50, -25, 0, 25, 50],
                  'Fable’s predicted bb/100', 'measured bb/100',
                  labels={'Silver Tongue': (-9, 'end'), 'Bot Hunter': (-9, 'end', -10), 'Blitz Maniac': (9, 'start'), 'Balanced Solid': (-9, 'end', 12), 'Granite Rock': (-9, 'end'), 'Small Ball Chatter': (9, 'start', -8)},
                  fit=(fab['lab_calib']['slope'], fab['lab_calib']['intercept']))
# style moved, results didn't
st = sorted(fab['style'], key=lambda d: d['vpip'])
c_style = heat_table([d['name'] for d in st] + ['Luna (no card)'], ['VPIP %', 'PFR %', 'bb/100'],
                     lambda r, c: ({'VPIP %': fab['control_style']['vpip'], 'PFR %': fab['control_style']['pfr'], 'bb/100': fab['control_bb100']['value']}[c] if r == 'Luna (no card)'
                                   else {'VPIP %': [d for d in st if d['name'] == r][0]['vpip'], 'PFR %': [d for d in st if d['name'] == r][0]['pfr'], 'bb/100': [d for d in st if d['name'] == r][0]['pooled_bb100']}[c]),
                     lambda v: f'{v:.0f}', 90, diverging=False, plain=('bb/100',))

ops = br['ops']
def ops_rows():
    out = []
    for m in MAIN_ORDER:
        o = ops[m]
        upb = f"${o['usd_per_bb_won']:.4f}" if o['usd_per_bb_won'] else '—'
        out.append(f"<tr><th>{L(m)}</th><td>{o['decisions']:,}</td><td>{o['lat_mean'] / 1000:.2f} s</td><td>{o['lat_p95'] / 1000:.1f} s</td><td>{o['in_tok']:.0f}</td><td>{o['out_tok']:.0f}</td><td>${o['cost']:.2f}</td><td>${o['cost_per_100_hands']:.3f}</td><td>{upb}</td></tr>")
    return '\n'.join(out)

so = {m: off['style'][i] for i, m in enumerate(MAIN_ORDER)} if False else {s['modelId']: s for s in off['style']}
pf, po = br['preflop'], br['postflop']
def style_rows():
    out = []
    for m in MAIN_ORDER:
        s = so[m]
        out.append(f"<tr><th>{L(m)}</th><td>{s['vpip']:.0f}</td><td>{s['pfr']:.0f}</td><td>{pf[m]['limp']:.0f}</td><td>{pf[m]['vs_raise_fold']:.0f}</td><td>{s['af']:.1f}</td><td>{po[m]['fold_to_bet']:.0f}</td><td>{po[m]['fold_to_bet_river']:.0f}</td><td>{s['wtsd']:.0f}</td><td>{s['wsd']:.0f}</td><td>{pf[m]['selection_auc']:.2f}</td></tr>")
    return '\n'.join(out)

# duplicate showcase m04 hand 4
SHOW = [('Sol', 'm04-r4', 2055, 'raised, bet flop and turn, called Jev’s river shove'),
        ('Luna', 'm04-r1', 1220, 'raised, called Jev’s 3-bet, bet the flop, checked it down'),
        ('Jev', 'm04-r3', 750, 'called Haiku’s 3-bet, bet the flop, check-called all-in on the turn'),
        ('Luna Decisions', 'm04-r2', 510, 'raised, bet flop and turn, everyone folded the turn'),
        ('Haiku', 'm04-r0', 155, 'min-raised, bet small twice, took it down on the turn')]
c_show = hbars([(f'{n}', v / 20, f'{n} in {t}: +{v} chips (+{v / 20:.1f} bb) holding A♦Q♠ — {how}') for n, t, v, how in SHOW], (0, 110), [0, 25, 50, 75, 100], 'bb won with A♦ Q♠ in hand #4 of match m04', fmt='+{:.1f}')

tk = pr['talk']
P = pr
ldr = P['ladder']

# ── page ─────────────────────────────────────────────────────────────────────────────────
css = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'report.css')).read()
body = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'report_body.html')).read()
fill = {k: v for k, v in globals().items() if k.startswith('c_')}
fill['ops_rows'] = ops_rows()
fill['style_rows'] = style_rows()
fill['AQ'] = cards_html('AdQs')
fill['A6'] = cards_html('6cAc')
fill['BOARD_M04'] = cards_html('8hQdJs2sAs')
fill['HK_44'] = cards_html('4h4c'); fill['HK_44B'] = cards_html('2c9dAh')
fill['HK_55'] = cards_html('5s5d'); fill['HK_55B'] = cards_html('6d6c2s')
fill['K5'] = cards_html('5sKc'); fill['K5B'] = cards_html('Ks6sAc4c')
fill['JT'] = cards_html('JhTs')
fill['L_QJ'] = cards_html('QhJc'); fill['L_QJB'] = cards_html('9d4cJs4d3d')
fill['L_JJ'] = cards_html('JcJd'); fill['L_JJB'] = cards_html('6cQd2d3dAd')
fill['QJ'] = cards_html('QsJd'); fill['BOARD_M03'] = cards_html('9cThKhAh4s')
for k, v in pr['talk'].items():
    pass
import re
def sub(m):
    key = m.group(1)
    if key not in fill:
        raise KeyError(key)
    return str(fill[key])
page = '<meta charset="utf-8">\n<title>Hold’em AI Field Report</title>\n<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' \
       '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap">\n' \
       f'<style>\n{css}\n</style>\n' + re.sub(r'\{\{(\w+)\}\}', sub, body)
dest = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'report.html'))
open(dest, 'w').write(page)
print('wrote', dest, len(page) // 1024, 'KB')
