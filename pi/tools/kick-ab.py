# KORS PA PI:N:  python3 -u kick-ab.py 1500      (sekunder; 1500 = 25 min)
#
# VIKTIGT — tre satt det gick fel innan det fungerade (2026-09-04):
#   1. Starta det i FORGRUNDEN av en ssh som du haller oppen (eller bakgrundar
#      pa din sida). `setsid nohup ... &` overlevde inte pa ett tillforlitligt
#      satt och lamnade ibland en foraldralos process som fortsatte vaxla
#      audioClock — tva skript samtidigt gor bada dataseten till skrap.
#   2. Kontrollera att EXAKT ett skript kor:
#        ps -eo pid,args | awk '$2=="python3" && $0 ~ /kick-ab.py/'
#      (`pgrep -f kick-ab.py` matchar aven din egen shell-rad.)
#   3. `kicks` ligger i status under memory-objektet, inte i takt-objektet.
#
# STAMPELMATNING: variansen i intervallet mellan pafoljande kicks, samma lat,
# ljudklocka AV/PA vaxlat var SEG:e sekund utan omstart.
#
# Pa en lat med stadig takt ar det sanna intervallet nastan konstant, sa
# spridningen i uppmatt intervall ar stampeljitter + musikens mikrotiming.
# Musiken ar densamma i bada villkoren -> skillnaden ar stampeln.
import json,sys,time,urllib.request,statistics,collections
TOTAL=int(sys.argv[1]) if len(sys.argv)>1 else 1500
SEG=90; SETTLE=8
API="http://127.0.0.1:3051/api/"
def get(p):
    return json.load(urllib.request.urlopen(API+p,timeout=3))
def put(on):
    req=urllib.request.Request(API+"calibration",data=json.dumps({"audioClock":on}).encode(),
        headers={"Content-Type":"application/json"},method="PUT")
    urllib.request.urlopen(req,timeout=4).read()
def find(o, key="beatErr"):
    # BUGG som gav noll intervall: `kicks` ligger i memory-objektet, INTE i
    # takt-objektet (det med beatErr). Sok darfor pa ratt nyckel.
    if isinstance(o,dict):
        if key in o: return o
        for v in o.values():
            r=find(v, key)
            if r: return r
seen=set(); segs=[]   # segs: list of dict(cond, track, kicks[], bpms[])
cond=False; t0=time.time(); segStart=t0
put(cond); cur={"cond":cond,"track":None,"kicks":[],"bpms":[]}; segs.append(cur)
while time.time()-t0 < TOTAL:
    now=time.time()
    if now-segStart >= SEG:
        print("  segment klart: %s %-24s onsets=%d" % ("PA" if cond else "AV", str(cur["track"])[:24], len(cur["kicks"])), flush=True)
        cond=not cond; put(cond); segStart=now
        cur={"cond":cond,"track":None,"kicks":[],"bpms":[]}; segs.append(cur)
    try:
        d=get("status"); b=find(d) or {}; km=find(d,"kicks") or {}
        tr=(d.get("sonos") or {}).get("trackName") or "?"
        if cur["track"] is None: cur["track"]=tr
        elif cur["track"]!=tr:               # latbyte mitt i segmentet -> nytt segment
            cur={"cond":cond,"track":tr,"kicks":[],"bpms":[]}; segs.append(cur); segStart=now
        if b.get("locked") and b.get("bpm"): cur["bpms"].append(float(b["bpm"]))
        for k in (km.get("kicks") or []):
            kk=round(float(k),2)
            if kk in seen: continue
            seen.add(kk)
            if now-segStart >= SETTLE: cur["kicks"].append(kk)
    except Exception: pass
    time.sleep(1)
put(False)   # lamna AV (default)

# ── analys per (lat, villkor) ──
by=collections.defaultdict(lambda: {"dev":[], "n":0})
for s in segs:
    if len(s["kicks"])<4 or not s["bpms"]: continue
    per=60000/statistics.median(s["bpms"])
    ks=sorted(s["kicks"]); raw=[ks[i+1]-ks[i] for i in range(len(ks)-1)]
    # kickAtMs ar en ONSET-tid (~4/takt: bas, virvel, hi-hat), sa intervallen
    # ligger pa 1, 1/2, 1/4 av taktslaget. Normalisera varje intervall till
    # narmaste subdivision (k=1,2,4) och mat avvikelsen fran DEN — stampeljitter
    # syns lika bra oavsett vilken subdivision slaget landade pa.
    dev=[]
    for x in raw:
        best=None
        for k in (1,2,4):
            tgt=per/k
            if abs(x/tgt-1) <= 0.15:
                d=abs(x-tgt)
                if best is None or d<best: best=d
        if best is not None: dev.append(best)
    if len(dev)<4: continue
    key=(s["track"][:30], "PA " if s["cond"] else "AV ")
    by[key]["dev"]+= dev; by[key]["n"]+=len(dev)
tracks=sorted({k[0] for k in by})
print("Stampeljitter = spridning i kick-intervall, SAMMA lat, AV vs PA")
print("%-32s %-4s %5s %8s %8s" % ("lat","vill","n","MAD ms","p90 ms"))
pool={"AV ":[], "PA ":[]}
for t in tracks:
    if by.get((t,"AV "),{}).get("n",0)<30 or by.get((t,"PA "),{}).get("n",0)<30: continue
    for c in ("AV ","PA "):
        dv=sorted(by[(t,c)]["dev"]); pool[c]+=dv
        print("%-32s %-4s %5d %8.2f %8.2f" % (t,c,len(dv),statistics.median(dv),dv[int(len(dv)*0.9)]))
print("---")
for c in ("AV ","PA "):
    dv=sorted(pool[c])
    if dv: print("%-32s %-4s %5d %8.2f %8.2f" % ("ALLA (samma latar bada)",c,len(dv),statistics.median(dv),dv[int(len(dv)*0.9)]))
    else:  print("%-32s %-4s  inga latar med >=30 intervall i bada villkoren" % ("ALLA",c))
print("segment: %d, latar totalt: %d" % (len(segs), len({s['track'] for s in segs})))
