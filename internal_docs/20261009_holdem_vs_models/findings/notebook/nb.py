"""Shared loaders for the B5 Python notebook (stdlib + numpy only).

Reads the flat tables written by 01_extract.ts under cache/ and offers tiny helpers:
grouping, bootstrap over clusters (matches), and JSON output to out/.
"""
import csv, json, os, glob, math, random
from collections import defaultdict, Counter
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, 'cache')
OUT = os.path.join(HERE, 'out')
ROOT = os.path.abspath(os.path.join(HERE, '../../../..'))
os.makedirs(OUT, exist_ok=True)

LABEL = {
    'openai/gpt-6-sol': 'Sol', 'openai/gpt-6-luna': 'Luna', 'openai/gpt-6-luna-decisions': 'Luna Decisions',
    'anthropic/claude-haiku-5.5': 'Haiku', 'typesafe-ai/jev': 'Jev', 'google/gemini-3.1-pro-preview': 'Gemini',
}
MAIN_ORDER = ['openai/gpt-6-sol', 'openai/gpt-6-luna', 'openai/gpt-6-luna-decisions', 'anthropic/claude-haiku-5.5', 'typesafe-ai/jev']
NUM = {'rotation', 'handNo', 'level', 'bb', 'logIndex', 'nSeats', 'nLive', 'stack', 'stackBb', 'committed', 'pot', 'toCall',
       'potOdds', 'facingFrac', 'facingAllIn', 'nRaisesBefore', 'raiseTo', 'addChips', 'addFracPot', 'addBb', 'eqActual',
       'eqRandom', 'eqHU', 'latencyMs', 'inTok', 'outTok', 'costUsd', 'fallback', 'retried', 'choiceNotTop', 'topP', 'pChosen',
       'entropy', 'talkLen', 'reasonLen', 'deltaBb', 'showdown', 'wonAny', 'seed', 'nDealt', 'seatIdx', 'button', 'stackBefore',
       'delta', 'vpip', 'pfr', 'sawFlop', 'uncontested', 'bustedThisHand', 'nDecisions',
       'p_fold', 'p_check', 'p_call', 'p_raise_min', 'p_raise_half_pot', 'p_raise_pot', 'p_raise_2x_pot', 'p_all_in'}


def _conv(row):
    for k, v in row.items():
        if k in NUM:
            row[k] = float(v) if v not in ('', None) else None
    return row


def load(prefix, pattern):
    rows = []
    for p in sorted(glob.glob(os.path.join(CACHE, f'{prefix}_{pattern}.csv'))):
        with open(p, newline='') as f:
            rows.extend(_conv(r) for r in csv.DictReader(f))
    return rows


def decisions(pattern='main'):
    return load('decisions', pattern)


def seathands(pattern='main'):
    return load('seathands', pattern)


def texts(pattern='main'):
    out = []
    for p in sorted(glob.glob(os.path.join(CACHE, f'text_{pattern}.jsonl'))):
        with open(p) as f:
            out.extend(json.loads(l) for l in f if l.strip())
    return out


def group(rows, *keys):
    g = defaultdict(list)
    for r in rows:
        g[tuple(r[k] for k in keys) if len(keys) > 1 else r[keys[0]]].append(r)
    return g


def pct(n, d):
    return None if not d else 100.0 * n / d


def cluster_boot(rows, cluster_key, stat, iters=2000, seed=1):
    """Percentile 95% CI of stat(rows) resampling whole clusters (e.g. matches)."""
    rng = random.Random(seed)
    cl = group(rows, cluster_key)
    keys = list(cl)
    point = stat(rows)
    draws = []
    for _ in range(iters):
        sample = []
        for _k in keys:
            sample.extend(cl[keys[rng.randrange(len(keys))]])
        v = stat(sample)
        if v is not None and not (isinstance(v, float) and math.isnan(v)):
            draws.append(v)
    draws.sort()
    if not draws:
        return point, None, None
    return point, draws[int(0.025 * (len(draws) - 1))], draws[int(0.975 * (len(draws) - 1))]


def save(name, obj):
    with open(os.path.join(OUT, name), 'w') as f:
        json.dump(obj, f, indent=1, default=lambda x: round(x, 4) if isinstance(x, float) else str(x))


def r(x, n=1):
    return None if x is None else round(x, n)
