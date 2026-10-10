"""Reasoning quality: do the LLMs read their own hand right? Regex-extracted claims in the
reasoning text are checked against the engine's truth:
  - preflop: suited/offsuit and the two ranks named
  - postflop: positive claims of a made hand (top pair, two pair, set/trips, straight, flush, full house)
  - pot odds: "X to 1" and "need N%" statements vs the real price
Writes out/reasoning.json (rates + sampled examples).   python3 -I 09_reasoning.py
"""
import sys, os, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nb import *

D = decisions('main')
T = texts('main')
dkey = {(d['tournamentId'], d['handNo'], d['logIndex']): d for d in D}
LLM = ['openai/gpt-6-sol', 'openai/gpt-6-luna', 'anthropic/claude-haiku-5.5']
CAT = {n: i for i, n in enumerate(['high_card', 'pair', 'two_pair', 'trips', 'straight', 'flush', 'full_house', 'quads', 'straight_flush'])}
RV = {r: i for i, r in enumerate('23456789TJQKA')}
RANKNAME = {'ace': 'A', 'king': 'K', 'queen': 'Q', 'jack': 'J', 'ten': 'T', 'nine': '9', 'eight': '8', 'seven': '7', 'six': '6', 'five': '5', 'four': '4', 'three': '3', 'two': '2', 'deuce': '2', '10': 'T'}
SYM = {'♠': 's', '♥': 'h', '♦': 'd', '♣': 'c'}

POS = r"(?:i have|i hold|i've got|i've made|i made|i now have|i flopped|i turned|i rivered|i hit|giving me|gives me|i'm holding)\s+(?:a |an |the |now |made |top |bottom |second )?"
CLAIMS = {
    'top_pair': (re.compile(POS + r"top pair", re.I), lambda d: top_pair(d)),
    'two_pair': (re.compile(POS + r"two pair", re.I), lambda d: CAT[d['made']] >= 2),
    'set_trips': (re.compile(POS + r"(?:set|trips|three of a kind)\b", re.I), lambda d: CAT[d['made']] >= 3),
    'straight': (re.compile(POS + r"(?:\w+[- ]high |nut )?straight\b(?!\s*(?:draw|possib|and|or|flush draw|-draw))", re.I), lambda d: CAT[d['made']] in (4, 8)),
    'flush': (re.compile(POS + r"(?:\w+[- ]high |nut |[a-z]+ )?flush\b(?!\s*(?:draw|possib|and|or|-draw))", re.I), lambda d: CAT[d['made']] >= 5),
    'full_house': (re.compile(POS + r"(?:full house|boat)\b", re.I), lambda d: CAT[d['made']] >= 6),
}

def cards(s):
    return re.findall('..', s)

def top_pair(d):
    b = cards(d['board']); h = cards(d['hole'])
    top = max(RV[c[0]] for c in b)
    hr = [RV[c[0]] for c in h]
    return top in hr or (hr[0] == hr[1] and hr[0] > top) or CAT[d['made']] >= 2

RW = r"(ace|king|queen|jack|ten|nine|eight|seven|six|five|four|three|two|deuce|[AKQJT]|[2-9])"

def rk(w):
    w = w.lower()
    return RANKNAME.get(w, w.upper())

def preflop_read(text, hole):
    """Only explicit descriptions of the seat's own two cards: 'K-9 offsuit', 'ace-eight suited',
    'KhQh', 'pocket jacks'. Returns (issues, checked)."""
    t = re.sub(r'\b10\b', 'T', text)
    for k, v in SYM.items():
        t = t.replace(k, v)
    hs = cards(hole)
    suited = hs[0][1] == hs[1][1]
    ranks = {c[0] for c in hs}
    issues = []
    checked = False
    # "<r>-<r> suited|offsuit" or "<r><r>s/o"
    m = re.search(r"\b" + RW + r"(?:[shdc])?[- ]?" + RW + r"(?:[shdc])?\s+(suited|offsuit|off-suit|unsuited)\b", t, re.I)
    m2 = re.search(r"\b([AKQJT2-9])[shdc]([AKQJT2-9])[shdc]\b", t)
    m3 = re.search(r"\bpocket (aces|kings|queens|jacks|tens|nines|eights|sevens|sixes|fives|fours|threes|twos|deuces)\b", t, re.I)
    if m:
        checked = True
        named = {rk(m.group(1)), rk(m.group(2))}
        if not (named <= set('AKQJT98765432')) or any(c.isdigit() for c in m.group(1) + m.group(2)) and (m.group(1) + m.group(2)).isdigit() and len(m.group(0).split()[0]) == 2:
            pass
        if named != ranks:
            issues.append(f'names {m.group(1)}-{m.group(2)}, holds {hole}')
        says_suited = m.group(3).lower() == 'suited'
        if says_suited != suited:
            issues.append(f'says {m.group(3).lower()}, holds {hole}')
    elif m2:
        checked = True
        if {m2.group(1), m2.group(2)} != ranks:
            issues.append(f'names {m2.group(0)}, holds {hole}')
    elif m3:
        checked = True
        word = m3.group(1).lower()
        r0 = {'aces': 'A', 'kings': 'K', 'queens': 'Q', 'jacks': 'J', 'tens': 'T', 'nines': '9', 'eights': '8', 'sevens': '7', 'sixes': '6', 'fives': '5', 'fours': '4', 'threes': '3', 'twos': '2', 'deuces': '2'}[word]
        if ranks != {r0}:
            issues.append(f'says pocket {word}, holds {hole}')
    return issues, checked

res = {}
out = {}
examples = defaultdict(list)
for m in LLM:
    t = [x for x in T if x['model'] == m]
    pre_n = pre_checked = 0; pre_bad = 0; pre_kinds = Counter()
    claim_n = Counter(); claim_bad = Counter()
    odds_n = 0; odds_err = []
    for x in t:
        d = dkey.get((x['tournamentId'], x['handNo'], x['logIndex']))
        if not d:
            continue
        txt = x['reasoning'] or ''
        if d['street'] == 'preflop':
            pre_n += 1
            iss, checked = preflop_read(txt, d['hole'])
            pre_checked += checked or bool(iss)
            if iss:
                pre_bad += 1
                for i in iss:
                    pre_kinds[' '.join(i.split(' ')[:2]).rstrip(',')] += 1
                examples[(m, 'preflop')].append({'tournamentId': x['tournamentId'], 'handNo': x['handNo'], 'hole': d['hole'], 'issue': iss, 'reasoning': txt[:220]})
        else:
            for name, (rx, ok) in CLAIMS.items():
                if rx.search(txt):
                    # skip negated / hypothetical mentions
                    span = rx.search(txt)
                    before = txt[max(0, span.start() - 25):span.start()].lower()
                    if re.search(r"\b(no|not|don't|without|if|could|might|unless|beat|vs|against|or)\b", before) or re.search(r"\bno\b", span.group(0)):
                        continue
                    # "a jack gives me a straight" is a draw, not a claim
                    if re.search(r"\b(a|an|any|another)\s+(ace|king|queen|jack|ten|nine|eight|seven|six|five|four|three|two|deuce|[2-9akqjt]|heart|spade|club|diamond)\s*$", before.strip() + ' ', re.I):
                        continue
                    claim_n[name] += 1
                    if not ok(d):
                        claim_bad[name] += 1
                        examples[(m, name)].append({'tournamentId': x['tournamentId'], 'handNo': x['handNo'], 'street': d['street'], 'hole': d['hole'], 'board': d['board'], 'made': d['made'], 'reasoning': txt[:240]})
        # pot odds statements
        if d['toCall'] > 0:
            true_ratio = d['pot'] / d['toCall']
            true_need = 100 * d['toCall'] / (d['pot'] + d['toCall'])
            for mm in re.finditer(r'(\d+(?:\.\d+)?)\s*(?:-| )?(?:to|:)\s*1\b', txt):
                odds_n += 1
                odds_err.append(('ratio', float(mm.group(1)), true_ratio, x['tournamentId'], x['handNo']))
            for mm in re.finditer(r'(?:need(?:s|ing)?|requires?|only)\s+(?:about |roughly |around |just |only |~)?(\d+(?:\.\d+)?)\s*%', txt):
                odds_n += 1
                odds_err.append(('need', float(mm.group(1)), true_need, x['tournamentId'], x['handNo']))
    rel = [abs(a - b) / b for kind, a, b, *_ in odds_err if b > 0]
    out[m] = {'preflop_decisions': pre_n, 'preflop_with_hand_named': pre_checked, 'preflop_misreads': pre_bad, 'preflop_misread_rate_of_named': pct(pre_bad, pre_checked), 'preflop_kinds': dict(pre_kinds),
              'claims': dict(claim_n), 'claims_wrong': dict(claim_bad), 'claim_wrong_rate': pct(sum(claim_bad.values()), sum(claim_n.values())),
              'odds_statements': odds_n, 'odds_within_15pct': pct(sum(1 for e in rel if e <= 0.15), len(rel)), 'odds_off_by_50pct_plus': pct(sum(1 for e in rel if e >= 0.5), len(rel)),
              'odds_examples': [{'kind': k, 'said': a, 'true': round(b, 2), 'tournamentId': tid, 'handNo': hn} for k, a, b, tid, hn in odds_err[:12]]}
res['by_model'] = out
res['examples'] = {f'{LABEL[m]}|{k}': v[:8] for (m, k), v in examples.items()}
save('reasoning.json', res)
for m in LLM:
    print(LABEL[m], json.dumps({k: v for k, v in out[m].items() if k != 'odds_examples'}, default=lambda x: round(x, 1)))
for (m, k), v in examples.items():
    print('\n', LABEL[m], k, len(v))
    for e in v[:4]:
        print('   ', e)
