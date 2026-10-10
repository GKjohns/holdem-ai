# v2 data-quality audit (2026-10-12), see data_quality.md. Run from the repo root:
#   python3 internal_docs/20261011_v2_fairness/data_quality_audit.py
# Per study and model: fallbacks, retries, output tokens vs the 8000 cap, hidden (reasoning) tokens,
# latency tails, reasoning that ends mid-sentence, talk rate, price-table cost, chip conservation.
import json,sys,collections,statistics as st,re
R='data/runs/'  # run from the repo root
files={'A_sol':'20261011_v2A_sol','A_opus':'20261011_v2A_opus','A_fable':'20261011_v2A_fable','B_luna':'20261011_v2B_luna','sanity':'20261011_v2_sanity_cheap'}
P={'openai/gpt-6-sol':(2,10,.2,2.5),'openai/gpt-6-luna':(.1,.5,.01,.125),'anthropic/claude-opus-5.5':(4,20,.2,5),'anthropic/claude-haiku-5.5':(.1,.5,.01,.125),'openai/gpt-6-luna-decisions':(.1,0,.1,.1),'typesafe-ai/jev':(.042,0,.042,.042),'anthropic/claude-fable-5.1':(10,50,.25,12.5)}
def cost(m,u):
    p=P[m];r=u.get('cacheRead',0);w=u.get('cacheWrite',0)
    return (max(0,u['input']-r-w)*p[0]+r*p[2]+w*p[3]+u['output']*p[1])/1e6
D=collections.defaultdict(list); T=collections.defaultdict(lambda: collections.Counter()); extra=collections.Counter()
def rec(study,d,view=None):
    D[(study,d['model'])].append(d)
for study,f in files.items():
    for l in open(R+f+'.jsonl'):
        o=json.loads(l)
        if o['type']=='hand':
            if o.get('engineErrors'): T[study]['engineErrHands']+=1
            T[study]['hands']+=1
            # chip conservation
            if sum(o['stacksBefore'].values())!=sum(o['stacksAfter'].values()): T[study]['chipLeak']+=1
            if sum(o['result']['deltas'].values())!=0: T[study]['deltaNonzero']+=1
            for x in o['decisions']: rec(study,x['decision'])
        elif o['type']=='tournament':
            T[study]['tourn']+=1; T[study]['fallbacks']+=o['fallbacks']; T[study]['engineErrors']+=o.get('engineErrors',0) or 0
            if not o.get('chipsConserved',True): T[study]['notConserved']+=1
            T[study]['reason_'+o['reason']]+=1
for l in open(R+'20261011_v2_probe.jsonl'):
    o=json.loads(l); rec('probe',o['decision'])
for s,c in T.items(): print(s,dict(c))
def pct(a,q): a=sorted(a); return a[min(len(a)-1,int(q*len(a)))]
print()
hdr='study model n fb retried sleep notTop requested outMax out_p99 out_p50 >=2000 >=4000 latP50 latP95 latP99 latMax >20s >25s emptyR noEndPunct talk% cost'
print(hdr)
ex=collections.defaultdict(list)
for (s,m),ds in sorted(D.items()):
    out=[d['usage']['output'] for d in ds]; lat=[d['latencyMs'] for d in ds]
    llm = not m.endswith(('decisions','jev'))
    noend=[d for d in ds if llm and not d['fallback'] and not re.search(r'[.!?)"\'”’…%\]]\s*$', d['reasoning'].strip())]
    for d in noend[:4]: ex[(s,m)].append(d['reasoning'][-120:])
    print(s,m.split('/')[1],len(ds),sum(d['fallback'] for d in ds),sum(bool(d.get('retried')) for d in ds),sum(bool(d.get('retriedAfterSleep')) for d in ds),sum(bool(d.get('choiceNotTop')) for d in ds),sum(bool(d.get('requested')) for d in ds),
      max(out),pct(out,.99),pct(out,.5),sum(o>=2000 for o in out),sum(o>=4000 for o in out),pct(lat,.5),pct(lat,.95),pct(lat,.99),max(lat),sum(x>20000 for x in lat),sum(x>25000 for x in lat),
      sum(llm and not d['reasoning'].strip() for d in ds),len(noend),round(100*sum(bool(d.get('tableTalk')) for d in ds)/len(ds),1),round(sum(cost(m,d['usage']) for d in ds),3))
for k,v in ex.items(): print(k,v)
print('\nvisible-vs-billed output (est visible tokens = chars/3.6 + 25 JSON overhead)')
for (s,m),ds in sorted(D.items()):
    if m.endswith(('decisions','jev')): continue
    hidden=[d['usage']['output']-(len(d['reasoning'])+len(d.get('tableTalk','')))/3.6-25 for d in ds]
    print(s,m.split('/')[1],'median hidden',round(st.median(hidden)),'p90',round(pct(hidden,.9)),'share>100 hidden',round(sum(h>100 for h in hidden)/len(ds),2),'reasoning chars p50/max',st.median(len(d['reasoning']) for d in ds),max(len(d['reasoning']) for d in ds))
    top=max(ds,key=lambda d:d['usage']['output']); print('   top',top['usage'],top['latencyMs'],repr(top['reasoning'][:200]))
