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
| `LOTUS_FP=1` | av | Landmärkesgenerering (125 Hz). På sedan 2026-09-02. |
| `LOTUS_SYNC_PROBE=1` | av | Skriver (position, rå-RMS) till `syncprobe.tsv` — blockerande, bara vid felsökning. |
| `LOTUS_BLE_INTERVAL_UNITS` | 12 (=15 ms) | BLE-anslutningsintervall i 1,25 ms-enheter. Finns för mätt A/B mot WiFi-samexistens. |
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
