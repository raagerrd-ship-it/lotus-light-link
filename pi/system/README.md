# Pi-sidan: skript och systemd-enheter

Det här är filerna som får lotus-light att fungera på Raspberry Pi:n men som
inte är TypeScript — de bodde tidigare **bara på Pi:n** och fanns i inget repo.
Dör SD-kortet är de borta, och flera av dem bär hårdvunna lärdomar.

Kopiorna här är avbilder av vad som ligger i drift, för att kunna återskapa en
Pi. De deployas inte härifrån; installation sker för hand.

## bin/ → `/usr/local/bin/`

| Fil | Vad den gör |
|---|---|
| `lotus-ble-prime.sh` | **Den enda kända boten** när lampan inte kommer upp. Rensar bluetoothds inaktuella enhetspost, cyklar adaptern, och — avgörande — **scannar och ansluter i SAMMA bluetoothctl-session**. Utan scanningen hänger motorns direktanslutning i 30 s om och om igen. |
| `lotus-blewatch.sh` | Vakthund. Primar länken när BLE varit nere, och **startar motorn om den är stoppad** (stod tidigare `|| continue`, alltså blind för det värsta som kan hända). |
| `lotus-corpus.sh` | Spelar in en låt vid låtbyte. Läser låtpositionen ur motorns svar på `/api/raw-capture/start`, inte ur sin egen statusläsning — den senare gav offsets som var flera sekunder fel. Respekterar reglaget `recordEnabled`. |

## systemd/ → `/etc/systemd/system/`

Filer med `.d.` i namnet är drop-ins: `lotus-refine.d.cpu.conf` hör hemma som
`/etc/systemd/system/lotus-refine.service.d/cpu.conf`.

**CPU-fälten:** motorn har `CPUAffinity=1` och tunga bakgrundstjänster hålls
borta därifrån. `bluetooth` har **medvetet inget fält** — att pinna bluetoothd
till en egen kärna tredubblade loopens fördröjning och fördubblade BLE:s
skrivlatens. Se `pi/src/ble-driver/protocol.ts` och projektminnet.

## Miljövariabler motorn läser (drop-ins under `lotus-light-engine.service.d/`)

| Variabel | Default | Betydelse |
|---|---|---|
| `LOTUS_FP=1` | av | Tvingar landmärkesvägen PÅ. Sedan 2026-09-18 följer den i stället togglen **Använd inspelning** (av = noll kostnad); drop-in:en `fp.conf` är borttagen. |
| `LOTUS_SYNC_PROBE=1` | av | Skriver (position, rå-RMS) till `syncprobe.tsv` — blockerande, bara vid felsökning. |
| `LOTUS_BAND_EVERY_HOPS` | 7 (=18,67 ms, 53,6 Hz); **drop-in `band-every.conf` sätter 9** (24 ms, 41,7 Hz) | Paketperiod i analysator-hop (2,667 ms). 8 = 21,33 ms/46,9 Hz, 9 = 24 ms/41,7 Hz. Byts med omstart; sätt `tick-ms` (lease) strax under perioden (23 vid 9) och mät intervallet live via `PUT /api/ble/interval`. **Kedje-svepet 2026-09-18 (7 punkter, 4 min/punkt, `GET /api/ble/gaps`):** marginal period−intervall ≥ 5 ms → 0,1–0,2 % skip, 3,7–4 ms → 1–4 %; färre paket/s = jämnare leverans (gap p90/median 1,066 vid 7 → 1,03 vid 9); CPU flat 24–27 %. 9 valt av ögat ("blinkar fint"). PLL:ens tickkvantisering växer med perioden (medel period/2) — därför ring-matad PLL (`LOTUS_PLL_RING`). |
| `LOTUS_BLE_INTERVAL_UNITS` | 12 (=15 ms); **drop-in `ble-interval.conf` sätter 14** (17,5 ms) | BLE-anslutningsintervall i 1,25 ms-enheter. Byts live med `PUT /api/ble/interval {units}` (lecup på levande länk); värdet lever i processen, drop-in:en ger persistens. **Svepet 2026-09-18:** 14 vid period 24 ms = marginal 6,5 ms, skip 0,2 %; <15 ms (≤11 enh) nekas av länken; **13 enheter vid 8 hop gav 3 styrenhetsstopp på 4 min — undvik.** **15 (18,75 ms) vid 7 hop provat samma dag: SÄMRE** — skipBusy 1,2 → 8,3 %, outstandingAge p95 20 → 29 ms, sänt 52,9 → 48,5/s. Writern är busy-gatad på ACL-kvittot: intervallet måste ligga tydligt UNDER paketperioden (18,67 ms), inte lika med. Kvot ≈1 är värsta fallet. Nästa kandidat enligt samma fysik: 8 (10 ms), men +50 % radiohändelser för remsan — ej provat. |
| `LOTUS_BLE_LATENCY` | 0 | Slave latency. Frigör periferins radio, inte Pi:ns — intervallet är det som spelar roll. |
| `LOTUS_PLL_RING` | av (opt-in `=1`); **drop-in `pll-ring.conf` sätter 0 uttryckligen** | Taktklockans PLL fasar mot kick-**ringen** (analysatorns sub-hop-stämpel) i stället för motorns egen onset vid ticktid. **Mätt 2026-09-18 och AVSLAGET:** ringens kickar grindas i analysatorn mot vårt eget grid (±max(30, 0,15·slag) ms runt åttondelslinjerna) och första transienten efter att fönstret öppnar rapporteras → PLL:en jagar sin egen grindkant: err ≈ −0,9·tolerans i alla lägen (−65 ms @130 BPM, −75..−80 @105–113, −7..−20 @224) oavsett gain och tempo, ankaret drev −20 ms/slag, integratorn tolkade jakten som snabbare tempo och skenade till 2×. Motorns onset vid ticktid har en konstant fördröjning (err −5..−35 @124, drift = analysatorns heltalskvantisering) som `beatLeadMs` absorberar. Riktig lösning kräver ogrindade kicktider ur analysatorn (root-ägd på Pi:n) utan att tappa taktfasen. Mätskript: `scratchpad/grid_hist.py` (histogram ring-kick mot grid) och ankar-drift-sonden (G = ts+leadMs+nextBeatMs per sampel, dG mod period). |
| `beatBpmGain` / `beatBpmKeep` (kal) | 0 / 0 | PLL:ens tempo-integrator (BPM per slag och enhet fasfel) och hur stor andel av analysatorns värde PLL:en får behålla/avvika vid hopp. **Tecknet på integratorn var inverterat** (kick före gridlinjen = gridet för långsamt → bpm *sänktes* till −4-klampen → konstant släp 50–80 ms) — rättat 2026-09-18, men även med rätt tecken skenade den på åttondelskickar (grindkant-jakten). Av tills en kick-baserad tempoestimator finns; nästa försök 1–2 med klamp ±3 % (tar bort heltalskvantiseringen, kan inte nå 2×). Tick-sparningen skriver hela cal-objektet: byt aldrig ett fälts semantik utan att byta namn. |
| `LOTUS_FFT_EVERY` | 1 | Kör analysatorn (512-FFT, var 3:e anrop 2048-FFT, onset/kick/tempo) bara var N:e 128-hop (1–4). Analysatorn får `hopSize = 128·N` och matas N·128 kontiguerliga sampel per anrop, så det glidande FFT-fönstret (som matas inuti `process()`) förblir obrutet och dtHop-konstanterna skalar; paketperiod (18,67 ms), ljudklocka (varje 128-hop) och band-cadence rörs inte. Hop-räknade konstanter i analysatorn (kick-warmup, onset-median) blir N× längre i tid; kickstämpelns upplösning 2,67 → 5,33 ms vid 2. **2026-09-18: baslinje every=1 mätt (HEAD-alsaMic.js, PARTIELLT 2 min, avbrutet): kick-MAD 4,12 / p90 20,0 ms (n=355), CPU 30 %, analyser msEMA 0,34 ms, overBudget 286/89 s, skipBusy 2,2 %, outstandingAge p95 20 ms. every=2 EJ mätt — A/B återstår (drop-in `fft-every.conf` + omstart per sida, ≥15 min per sida, samma spellista, jämför mot denna baslinje).** |

## Skrivs INTE hit

`replicate.token` och `songs.json` ligger under
`/var/lib/pi-control-center/apps/lotus-light/`. Nyckeln ska aldrig i repot.

## Motor-begärd prime (2026-09-17)

`sbin/lotus-ble-prime-req` → `/usr/local/sbin/`, `systemd/lotus-ble-prime.{path,service}`.

Motorn skriver `ble-prime.req` (MAC) efter **två `connectAsync timed out` i rad** — aldrig på
"Hittade inte" (remsan frånvarande, prime hjälper inte). Path-enheten kör hjälparen som root:
validera → **radera begäran först** → cooldown 120 s (`/run/lotus-ble-prime.last`) →
`touch /run/lotus-ble-prime.lock` → `systemctl stop` → `lotus-ble-prime.sh` → `start` → släpp lås.
**blewatch hoppar över hela sin iteration medan låset finns** — annars startar den motorn mitt
i prime (uppmätt 16:41). Samma sekvens som blewatch, men efter ~10 s i stället för 57–220 s.
Uppmätt utlösare: 8 timeouts på 97 s efter 11 h idle; `hci down/up` i prime.sh röjde det.

## En skribent av länkparametrar (2026-09-18)

`lotus-ble-interval.service` (+ `/usr/local/bin/lotus-ble-interval.sh`, `hcitool lecup --min 12 --max 12`
var 15 s på **vilken handle som helst**) är **borttagen**. btmon visade tre skribenter i konflikt —
remsans egen begäran (60–85 ms, supervision 1 s, auto-beviljad av kärnan), motorn var 25 s, och
tjänsten var 15 s → `Transaction Collision (0x23)` → `LL Response Timeout (0x22)` → länken dog vid
återanslutning. Nu är motorn (`forceConnInterval.ts`) enda skribenten: väntar 1,2 s in remsans
begäran, 5 försök, och re-assert var 25:e s **även efter give-up** (det var tjänstens enda riktiga
roll). Vill du tillbaka: `LOTUS_BLE_INTERVAL_UNITS` styr målet; tjänsten ska inte återinföras.
