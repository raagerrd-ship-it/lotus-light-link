# ble-driver

Fristående BLE-lampdriver för **Node.js + [@abandonware/noble]** som styr en
BLEDOM/ELK-klass-lampa (9-byte `0x7e…0xef`-protokoll) över GATT.

Mappen har **inga imports utanför sig själv** — kopiera hela `ble-driver/` rakt
in i ett annat Node-projekt och styr en lampa. (Kräver Linux/BlueZ + noble med
rätt capabilities, t.ex. `setcap cap_net_admin,cap_net_raw+eip` på node-binären.)

## Snabbstart

```ts
import { createLampDriver } from './ble-driver/index.js';

const lamp = createLampDriver({
  device: { name: 'ELK-BLEDOM01', mac: 'BE:67:00:15:09:41' },
  // logger: console.log,        // valfritt; annars tyst om inte LOTUS_DEBUG=1
  // slotLeaseMs: 25,            // write-cadence-cap (default 25ms ≈ 40Hz)
  // dimmingGamma: 1.8,          // perceptuell dimring
});

await lamp.connect();
lamp.startKeepAlive();           // håll länken vid liv när inga färgwrites sker

// Skicka färger i en loop — respektera backpressure via canWriteNow().
setInterval(() => {
  if (lamp.canWriteNow()) lamp.setColor(255, 80, 0, 100); // r,g,b,brightness(0–100)
}, 25);
```

## API

| Metod | Beskrivning |
| --- | --- |
| `connect()` / `disconnect()` | Anslut/koppla från mål-lampan (scan → connect → anchor write). |
| `isConnected()` | `true` om GATT-länken är uppe. |
| `setColor(r,g,b,brightness=100)` | Skicka färg + ljusstyrka. Returnerar `WriteResult` (`sent`/`busy`/`no-device`). |
| `setIdleColor(r,g,b)` | Uppdatera idle-färg (keep-alive bär den). |
| `setPower(on)` | Väck/släck LED-drivern (BLEDOM intern off-state). |
| `canWriteNow()` | Billig backpressure-check (lease + ACL-outstanding). |
| `startKeepAlive()` / `stopKeepAlive()` | 200ms keep-alive mot supervision-timeout. |
| `setDimmingGamma()` / `getDimmingGamma()` | Justera dimring-gamma. |
| `setSlotLeaseMs(ms)` | Write-cadence-cap. |
| `getStats()` | Ögonblicksbild av write/latency/reconnect-statistik. |

## Konfiguration

`createLampDriver(config)`:

- `device` — mål-lampans `{ name, mac }` (default = projektets BLEDOM).
- `logger` — valfri loggfunktion (default: env-gated `LOTUS_DEBUG`).
- `slotLeaseMs` / `dimmingGamma` — runtime-tuning.
- `onConsecutiveFailures({count,error})` — körs precis innan `process.exit(0)`
  vid N connect-fel i rad (noble HCI-stuck → enda recovery är process-restart).

## Begränsningar

- Node-/noble-/Linux-beroende. Fungerar **inte** i webbläsare (ingen Web-BLE).
- En lampa i taget (singleton-state per process).
