"""Table talk: how much each LLM talks, repetition, naming opponents, verbal hole-card leaks
(rank words that match the speaker's own cards), whether talking/what is said tracks hand strength,
and whether anyone's reasoning ever reacts to talk.
Writes out/talk.json.   python3 -I 08_talk.py
"""
import sys, os, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nb import *

D = decisions('main')
T = texts('main')
dkey = {(d['tournamentId'], d['handNo'], d['logIndex']): d for d in D}
LLM = ['openai/gpt-6-sol', 'openai/gpt-6-luna', 'anthropic/claude-haiku-5.5']
res = {}

RANKW = {'A': ['ace', 'aces', 'bullets', 'rockets'], 'K': ['king', 'kings', 'cowboys'], 'Q': ['queen', 'queens', 'ladies'], 'J': ['jack', 'jacks', 'hooks'],
         'T': ['ten', 'tens'], '9': ['nine', 'nines'], '8': ['eight', 'eights'], '7': ['seven', 'sevens'], '6': ['six', 'sixes'],
         '5': ['five', 'fives'], '4': ['four', 'fours'], '3': ['three', 'threes', 'treys'], '2': ['two', 'twos', 'deuces', 'ducks']}
SUITW = {'h': ['heart', 'hearts', 'heart-y'], 's': ['spade', 'spades'], 'd': ['diamond', 'diamonds'], 'c': ['club', 'clubs']}
NAMES = ['sol', 'luna', 'haiku', 'jev', 'claude', 'gpt', 'decisions']

def words(s):
    return re.findall(r"[a-z][a-z\-']*", s.lower())

def leak(talk, hole, board):
    """Rank or suit words in the talk that match the speaker's hole cards and are not explained by the board."""
    w = set(words(talk))
    hits = []
    board_ranks = {c[0] for c in re.findall('..', board)}
    for c in re.findall('..', hole):
        rk, st = c[0], c[1]
        if rk not in board_ranks and any(x in w for x in RANKW[rk]):
            hits.append(rk)
        if any(x in w for x in SUITW[st]):
            hits.append(st)
    # rank words that are NOT in the hand or board (bluffing/false talk)
    false_r = [rk for rk, ws in RANKW.items() if any(x in w for x in ws) and rk not in hole[::2] and rk not in board_ranks]
    return hits, false_r

stats = {}
leaks = []
for m in LLM:
    t = [x for x in T if x['model'] == m]
    tk = [x for x in t if x['tableTalk']]
    seen = defaultdict(set)
    rep = 0
    named = 0
    leak_n = 0; false_n = 0; rank_word_n = 0
    for x in tk:
        tt = x['tableTalk']
        if tt in seen[x['tournamentId']]:
            rep += 1
        seen[x['tournamentId']].add(tt)
        w = set(words(tt))
        if w & set(NAMES):
            named += 1
        d = dkey.get((x['tournamentId'], x['handNo'], x['logIndex']))
        if not d:
            continue
        hits, fr = leak(tt, d['hole'], d['board'])
        if any(any(x2 in w for x2 in ws) for ws in RANKW.values()):
            rank_word_n += 1
        if hits:
            leak_n += 1
            leaks.append({'model': LABEL[m], 'tournamentId': x['tournamentId'], 'handNo': x['handNo'], 'street': x['street'], 'hole': d['hole'], 'board': d['board'], 'talk': tt, 'hits': hits, 'menuId': x['menuId']})
        if fr:
            false_n += 1
    byact = {}
    for a in ('fold', 'check', 'call', 'aggressive'):
        s = [x for x in t if (x['menuId'] == a if a != 'aggressive' else (x['menuId'].startswith('raise') or x['menuId'] == 'all_in'))]
        byact[a] = pct(sum(1 for x in s if x['tableTalk']), len(s))
    stats[m] = {'decisions': len(t), 'talk': len(tk), 'talk_rate': pct(len(tk), len(t)), 'avg_len': float(np.mean([len(x['tableTalk']) for x in tk])) if tk else 0,
                'distinct': len(set(x['tableTalk'] for x in tk)), 'repeat_in_tournament': pct(rep, len(tk)), 'names_opponent': pct(named, len(tk)),
                'mentions_rank_word': rank_word_n, 'leaks_own_card': leak_n, 'leak_rate': pct(leak_n, len(tk)), 'false_rank_word': false_n,
                'talk_rate_by_action': byact, 'top_lines': Counter(x['tableTalk'] for x in tk).most_common(8)}
res['stats'] = stats
res['leak_examples'] = [l for l in leaks if l['model'] == 'Haiku'][:40]
res['leak_examples_other'] = [l for l in leaks if l['model'] != 'Haiku'][:20]

# ── does talking (or what is said) track strength? ────────────────────────────────────────
STRONG = {'value', 'pay', 'strong', 'like', 'love', 'nice', 'good', 'trouble', 'sorry', 'think', 'confident', 'mine'}
WEAK = {'probe', 'cheap', 'peek', 'small', 'look', 'modest', 'price', 'see', 'chase', 'curious'}
tell = {}
for m in LLM:
    ag = [(x, dkey.get((x['tournamentId'], x['handNo'], x['logIndex']))) for x in T if x['model'] == m and (x['menuId'].startswith('raise') or x['menuId'] == 'all_in') and x['street'] != 'preflop']
    ag = [(x, d) for x, d in ag if d]
    talk = [d['eqRandom'] for x, d in ag if x['tableTalk']]
    silent = [d['eqRandom'] for x, d in ag if not x['tableTalk']]
    a = np.array(talk); b = np.array(silent)
    auc = float(((a[:, None] > b[None, :]).mean() + 0.5 * (a[:, None] == b[None, :]).mean())) if len(a) and len(b) else None
    # postflop calls: talk vs silent
    cl = [(x, dkey.get((x['tournamentId'], x['handNo'], x['logIndex']))) for x in T if x['model'] == m and x['menuId'] == 'call' and x['street'] != 'preflop']
    cl = [(x, d) for x, d in cl if d]
    # lexical: strong-sounding vs weak-sounding lines among postflop bets
    st = [d['eqRandom'] for x, d in ag if x['tableTalk'] and set(words(x['tableTalk'])) & STRONG]
    wk = [d['eqRandom'] for x, d in ag if x['tableTalk'] and set(words(x['tableTalk'])) & WEAK]
    tell[m] = {'bets_n': len(ag), 'bets_talk_n': len(talk), 'eq_talk': float(np.mean(talk)) if talk else None, 'eq_silent': float(np.mean(silent)) if silent else None,
               'auc_talk_vs_silent': auc, 'strong_words_n': len(st), 'eq_strong_words': float(np.mean(st)) if st else None,
               'weak_words_n': len(wk), 'eq_weak_words': float(np.mean(wk)) if wk else None,
               'calls_eq_talk': float(np.mean([d['eqRandom'] for x, d in cl if x['tableTalk']])) if cl else None,
               'calls_eq_silent': float(np.mean([d['eqRandom'] for x, d in cl if not x['tableTalk']])) if cl else None}
res['tells'] = tell

# Haiku's leaks: did they leak *strength*? equity when leaking vs not, on Haiku's talk lines
hk = [(x, dkey.get((x['tournamentId'], x['handNo'], x['logIndex']))) for x in T if x['model'] == 'anthropic/claude-haiku-5.5' and x['tableTalk']]
lk = [d['eqRandom'] for x, d in hk if d and leak(x['tableTalk'], d['hole'], d['board'])[0]]
nlk = [d['eqRandom'] for x, d in hk if d and not leak(x['tableTalk'], d['hole'], d['board'])[0]]
res['haiku_leak_strength'] = {'leak_n': len(lk), 'eq_leak': float(np.mean(lk)), 'eq_noleak': float(np.mean(nlk))}

# ── does anyone react to talk? reasoning that mentions what an opponent said ──────────────
react = Counter(); react_ex = []
pat = re.compile(r"(table talk|banter|\bsaid\b|\bsays\b|\bclaims?\b|their talk|his talk|chatter|trash talk)", re.I)
for x in T:
    if x['model'] in LLM and pat.search(x['reasoning'] or ''):
        react[x['model']] += 1
        if len(react_ex) < 12:
            react_ex.append({'model': LABEL[x['model']], 'tournamentId': x['tournamentId'], 'handNo': x['handNo'], 'reasoning': x['reasoning'][:240]})
res['reasoning_mentions_talk'] = {LABEL[m]: react[m] for m in LLM}
res['reasoning_mentions_talk_examples'] = react_ex

save('talk.json', res)
for m in LLM:
    s = stats[m]
    print(LABEL[m], {k: (r(v, 1) if isinstance(v, float) else v) for k, v in s.items() if k not in ('top_lines',)})
    print('   top', s['top_lines'][:5])
    print('   tell', {k: r(v, 3) for k, v in tell[m].items()})
print('haiku leak strength', res['haiku_leak_strength'])
for l in res['leak_examples'][:15]:
    print('  ', l['tournamentId'], int(l['handNo']), l['street'], l['hole'], l['board'], '|', l['talk'], l['hits'])
print(res['reasoning_mentions_talk'])
for e in react_ex[:8]:
    print('  ', e)
