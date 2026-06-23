# ble-driver — komplett integrationsguide

Allt ett annat **Node.js-projekt** behöver för att styra en BLE-lampa
(BLEDOM / ELK-BLEDOM-klass, 9-byte `0x7e…0xef`-protokoll) genom att kopiera
in den här mappen. Inget annat från det här repot behövs.

> **Räckvidd:** Node.js + Linux/BlueZ + [`@stoprocent/noble`]. Fungerar **inte**
> i webbläsare (ingen Web-BLE) och inte på macOS/Windows utan motsvarande
> HCI-stack. En lampa per process (modulen är singleton-baserad).

---

## 1. Vad du kopierar

Kopiera hela mappen `ble-driver/` till ditt projekt (t.ex. `src/ble-driver/`).
Den har **noll imports utanför sig själv** — verifiera med:

```bash
grep -rnE "from ['\"]\.\./|import\(['\"]\.\./" ble-driver/   # → tomt
```

Filer i mappen:

| Fil | Ansvar |
| --- | --- |
| `index.ts` | Publikt API: `createLampDriver()` + låg-nivå-exports |
| `connect.ts` | scan → connect → anchor write, auto-reconnect, idle-disconnect |
| `protocol.ts` | Paketformat, write-gate (lease + ACL-outstanding), keep-alive, gamma |
| `state.ts` | BLE-core-state: connected device, `bleStats`, UUID:er |
| `controllerDrain.ts` | Läser noble/HCI outstanding-paket för backpressure |
| `forceConnInterval.ts` | Tvingar 7.5–10ms connection interval via `hcitool` |
| `adapter-hci-check.ts` | `isHci0Up()` — passiv koll att hci0 är UP RUNNING |
| `noble-singleton.ts` | Lazy `@stoprocent/noble`-singleton (`getNobleAsync`) |
| `reconnect-flag.ts` | `/tmp`-flagga för auto-restart efter process.exit |
| `device-config.ts` | Mål-lampa (`setDeviceConfig`, `matchesHardcoded`) |
| `log.ts` | Lokal logger (env-gated `LOTUS_DEBUG`, override via `setLogger`) |
| `types.ts` | TypeScript-typer |

---

## 2. Beroenden

```bash
npm install @stoprocent/noble
```

TypeScript-projektet måste vara ESM med NodeNext-resolution (drivern använder
`.js`-suffix i imports):

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext"
  }
}
```

```jsonc
// package.json
{ "type": "module" }
```

---

## 3. OS-förberedelser (Linux/Raspberry Pi)

BLE kräver rättigheter och en levande Bluetooth-stack:

```bash
# 1. bluetoothd måste äga och väcka adaptern (engine rör ALDRIG hci0 själv)
sudo systemctl enable --now bluetooth

# 2. Ge node-binären BLE-capabilities (annars kan noble inte öppna HCI-socket)
sudo setcap 'cap_net_admin,cap_net_raw+eip' "$(command -v node)"

# 3. För forceConnInterval (låg latens) krävs samma på hcitool
sudo setcap 'cap_net_admin,cap_net_raw+eip' /usr/bin/hcitool
```

> `setcap` på `node` försvinner vid Node-uppgradering; på `hcitool` vid
> paketuppgradering. Lägg båda i ditt provisioning-/installskript.

---

## 4. Bootstrap — ladda noble + vänta på poweredOn

`connect()` kräver att noble är laddad och `poweredOn`. Kör detta **en gång**
vid uppstart innan du ansluter:

```ts
import { getNobleAsync, isHci0Up } from './ble-driver/index.js';

async function bootBle(): Promise<void> {
  // Vänta passivt på att bluetoothd tagit upp adaptern (mutera den ALDRIG själv)
  const start = Date.now();
  while (!isHci0Up() && Date.now() - start < 8000) {
    await new Promise(r => setTimeout(r, 250));
  }
  if (!isHci0Up()) throw new Error('hci0 inte UP — kör: sudo systemctl restart bluetooth');

  const noble = await getNobleAsync();
  if (noble.state !== 'poweredOn') {
    await noble.waitForPoweredOnAsync(5000);
  }
}
```

---

## 5. Steg-för-steg-exempel

```ts
import { createLampDriver, getNobleAsync, isHci0Up } from './ble-driver/index.js';

// ── 1. Bootstrap BLE (gör EN gång vid uppstart) ──
async function bootBle(): Promise<void> {
  const start = Date.now();
  while (!isHci0Up() && Date.now() - start < 8000) {
    await new Promise(r => setTimeout(r, 250));
  }
  if (!isHci0Up()) throw new Error('hci0 inte UP — kör: sudo systemctl restart bluetooth');

  const noble = await getNobleAsync();
  if (noble.state !== 'poweredOn') {
    await noble.waitForPoweredOnAsync(5000);
  }
}

await bootBle();

// ── 2. Skapa drivern ──
const lamp = createLampDriver({
  device: { name: 'ELK-BLEDOM01', mac: 'BE:67:00:15:09:41' }, // ← DIN lampa
  // logger: console.log,   // valfritt; annars tyst om inte LOTUS_DEBUG=1
  // slotLeaseMs: 25,        // write-cadence (default 25ms ≈ 40Hz)
  // dimmingGamma: 1.8,      // perceptuell dimring
  onConsecutiveFailures: ({ count, error }) => {
    console.error(`BLE gav upp efter ${count} fel (${error}) — processen startar om`);
    // (drivern kör process.exit(0); låt en supervisor, t.ex. systemd
    //  Restart=always, starta om processen med en fräsch HCI-socket)
  },
});

// ── 3. Anslut ──
const r = await lamp.connect();   // scan → connect → anchor write
if (!lamp.isConnected()) throw new Error('kunde inte ansluta');

// ── 4. Starta keep-alive (krävs för att hålla länken vid liv) ──
lamp.startKeepAlive();

// ── 5. Tänd lampan ──
await lamp.powerOn();

// ── 6. Skicka färger (respektera ALLTID backpressure) ──
if (lamp.canWriteNow()) {
  lamp.setColor(255, 80, 0, 100);    // r, g, b, brightness(0–100)
}

// Exempel: loop med färgbyte var 25 ms
let hue = 0;
const colorInterval = setInterval(() => {
  if (lamp.canWriteNow()) {
    hue = (hue + 15) % 360;
    const [r, g, b] = hsvToRgb(hue, 1, 1);   // din egen hsvToRgb()
    lamp.setColor(r, g, b, 80);
  }
}, 25);

// Efter några sekunder:
clearInterval(colorInterval);

// ── 7. Sätt idle-färg (visas när inget annat skickas) ──
lamp.setIdleColor(10, 10, 30);

// ── 8. Släck lampan ──
await lamp.powerOff();

// ── 9. Avsluta snyggt ──
lamp.stopKeepAlive();
await lamp.disconnect();
```

---

## 6. API-referens

`createLampDriver(config)` returnerar ett objekt med:

| Metod | Beskrivning |
| --- | --- |
| `connect(): Promise<{connected,error?,durationMs}>` | Anslut till mål-lampan |
| `disconnect(): Promise<{disconnected}>` | Manuell frånkoppling (stoppar auto-reconnect) |
| `isConnected(): boolean` | `true` om GATT-länken är uppe |
| `setColor(r,g,b,brightness=100): WriteResult` | Skicka färg + ljusstyrka |
| `setIdleColor(r,g,b): void` | Sätt idle-färg (bärs av keep-alive, ingen write) |
| `setPower(on): Promise<'sent'\|'no-device'\|'error'>` | Väck/släck LED-drivern |
| `canWriteNow(): boolean` | Billig backpressure-check (gör detta före varje write) |
| `startKeepAlive() / stopKeepAlive(): void` | 200ms keep-alive mot supervision-timeout |
| `setDimmingGamma(v) / getDimmingGamma()` | Dimring-gamma 1.0–3.0 |
| `setSlotLeaseMs(ms): void` | Write-cadence-cap (5–500ms) |
| `getStats(): object` | Ögonblicksbild: sent/lat/reconnect/outstanding m.m. |

**`config`-fält:** `device?: {name,mac}`, `logger?`, `slotLeaseMs?`,
`dimmingGamma?`, `onConsecutiveFailures?`.

**`WriteResult`** (retur från `setColor`): `'sent'` | `'busy'` (gate stängd —
försök igen nästa tick) | `'no-change'` | `'no-device'`.

---

## 7. Viktiga kontrakt (läs detta — annars hackar ljuset)

1. **Skriv aldrig snabbare än gaten tillåter.** Anropa `canWriteNow()` före
   varje `setColor()`. BLEDOM ger ingen ACK; paket köas i HCI-lagret om du
   spammar och lampan halkar sekunder efter. Gaten kombinerar en tick-lease
   (`slotLeaseMs`) med en ACL-outstanding-gräns (max 6 paket ute samtidigt).

2. **`setColor` är synkron och fire-and-forget.** Den `await`:ar aldrig
   radio-bekräftelse — den returnerar `'sent'`/`'busy'` direkt. Backpressure
   sköts av gaten, inte av promise-resolve.

3. **Kör alltid keep-alive.** Utan en write var ~200ms tappar BLEDOM länken via
   supervision-timeout. `startKeepAlive()` löser detta; den följer samma gate.

4. **Brightness ligger i RGB.** I RGB-läge styr själva RGB-värdena ljusstyrkan
   (0x03-paketet ignorerar brightness-byten). Drivern pre-skalar RGB med
   `brightness` × perceptuell gamma-LUT åt dig.

5. **HCI-stuck → process.exit.** Efter 4 connect-fel i rad är noble:s HCI-state
   fast; enda återställning är process-omstart. Drivern sätter en
   `/tmp`-flagga, kör din `onConsecutiveFailures`-hook och därefter
   `process.exit(0)`. Kör processen under en supervisor (systemd
   `Restart=always`) som ger den en fräsch HCI-socket. **Lägg aldrig till
   same-process-retry** — det fixar inte stuck-state.

6. **Rör aldrig hci0 aktivt.** Låt `bluetoothd` äga adaptern; vänta passivt med
   `isHci0Up()`. Aktiv `hciconfig up` från din process racear bluetoothd och
   ger `Error.Busy`.

---

## 8. Egen mål-lampa

Default är projektets BLEDOM. Sätt din egen på två sätt:

```ts
// A) via config
createLampDriver({ device: { name: 'MIN-LAMPA', mac: 'AA:BB:CC:DD:EE:FF' } });

// B) i efterhand
import { setDeviceConfig } from './ble-driver/index.js';
setDeviceConfig({ name: 'MIN-LAMPA', mac: 'AA:BB:CC:DD:EE:FF' });
```

Hitta MAC: kör `getNobleAsync()`, lyssna på `noble.on('discover', p => …)` och
läs `p.address` / `p.advertisement.localName`.

---

## 9. Ovanpå drivern: ljudreaktiv motor (valfritt)

Det här repots `piEngine.ts` är ett **lager ovanpå** drivern: det mappar
ljud-FFT → färg/ljusstyrka och anropar `sendToBLE`/`canWriteNow`/`startKeepAlive`
(re-exporterade från drivern). Vill du ha samma beteende i ett annat projekt:
kopiera `ble-driver/` + `piEngine.ts` och mata motorn med dina FFT-frames. För
ren färgstyrning behövs bara `ble-driver/`.

---

## 10. Felsökning

| Symptom | Orsak / åtgärd |
| --- | --- |
| `getNoble() called before getNobleAsync()` | Kör bootstrap (steg 4) först |
| Ansluter aldrig, `hci0 inte UP` | `sudo systemctl restart bluetooth` |
| `Permission denied` vid scan | `setcap` på node-binären (steg 3) |
| Lampan hackar/halkar efter ljudet | Du skriver utan `canWriteNow()` eller utan keep-alive |
| Tyst lampa efter ett tag | Saknar `startKeepAlive()` → supervision-timeout |
| Hög latens trots gate | `forceConnInterval` kräver `setcap` på `hcitool` |
| Processen dör med exit 0 | Förväntat efter 4 connect-fel — låt supervisor starta om |

Aktivera utförlig logg: `LOTUS_DEBUG=1 node dist/index.js` (eller skicka egen
`logger` i config).
