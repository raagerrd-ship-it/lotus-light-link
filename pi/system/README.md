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
| `LOTUS_BLE_INTERVAL_UNITS` | 12 (=15 ms) | BLE-anslutningsintervall i 1,25 ms-enheter. **15 (18,75 ms) provat 2026-09-18: SÄMRE** — skipBusy 1,2 → 8,3 %, outstandingAge p95 20 → 29 ms, sänt 52,9 → 48,5/s. Writern är busy-gatad på ACL-kvittot: intervallet måste ligga tydligt UNDER paketperioden (18,67 ms), inte lika med. Kvot ≈1 är värsta fallet. Nästa kandidat enligt samma fysik: 8 (10 ms), men +50 % radiohändelser för remsan — ej provat. |
| `LOTUS_BLE_LATENCY` | 0 | Slave latency. Frigör periferins radio, inte Pi:ns — intervallet är det som spelar roll. |

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
