# Auto-disconnect efter 2 min idle + ALSA-stop + Sonos-only reconnect

## Mål
Auto-disconnect BLE efter 2 min Sonos-paus, stoppa ALSA-mikrofonen för CPU-besparing (~20-25% mindre last), och auto-reconnect + restart mic när Sonos PLAYING återkommer — endast om föregående disconnect var auto.

## Filändringar

### 1. `pi/src/alsaMic.ts` — lägg till `isMicActive()`
`startMic()` (rad 507) och `stopMic()` (rad 642) finns redan med korrekt state-nollställning. `startMic()` har redan `if (capture) return` idempotency. Lägg bara till en getter:
```ts
export function isMicActive(): boolean { return capture !== null; }
```

### 2. `pi/src/ble/connect-hardcoded.ts` — disconnect-tracking + idle-trigger
Modul-state (~rad 55):
```ts
let _lastDisconnectWasAuto = false;
let _lastDisconnectReason: 'manual'|'idle-timeout'|'supervision-timeout'|'unknown' = 'unknown';
export function wasAutoDisconnected(): boolean { return _lastDisconnectWasAuto; }
export function getLastDisconnectReason(): string { return _lastDisconnectReason; }
```

I `disconnectHardcoded()` (rad 150) — sätt först:
```ts
_lastDisconnectWasAuto = false;
_lastDisconnectReason = 'manual';
```

Ny export `triggerIdleDisconnect()` (samma teardown som `disconnectHardcoded` men markerar som auto):
```ts
export async function triggerIdleDisconnect(): Promise<void> {
  _lastDisconnectWasAuto = true;
  _lastDisconnectReason = 'idle-timeout';
  _autoReconnectEnabled = false;
  clearAutoReconnect();
  if (!_connected) return;
  _onDisconnected?.();
  detachControllerDrain();
  setDevice(null);
  resetLastSent();
  try { await _connected.disconnectAsync(); } catch {}
  _connected = null;
}
```

Vid lyckad connect (där `_consecutiveFailures = 0` sätts, ~rad 487): nollställ `_lastDisconnectWasAuto = false; _lastDisconnectReason = 'unknown'`.

**Obs:** Befintlig `scheduleAutoReconnect`-loop (supervision-timeout-recovery) är separat och oförändrad — den triggar EJ på idle-disconnect eftersom `_autoReconnectEnabled` slås av där.

### 3. `pi/src/piEngine.ts` — idle-timer + handleIdleDisconnect

Statiska imports i toppen:
- `triggerIdleDisconnect` från `./ble/connect-hardcoded.js`
- `isControllerDrainAttached`, `getOutstandingPackets` från `./ble/controllerDrain.js`
- `stopMic` från `./alsaMic.js`

Nya privata fält i `PiLightEngine` (efter rad 473):
```ts
private _idleDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
private _idleEnteredAt: number | null = null;
private _micPausedForIdle = false;
private _lastPlayingChangeAt = 0;
private static readonly IDLE_DISCONNECT_MS = 2 * 60 * 1000;
private static readonly PLAYING_DEBOUNCE_MS = 500;
```

I `setPlaying()` (rad 512):
- **Debounce före** befintlig `if (playing === wasPlaying) return`: om `Date.now() - _lastPlayingChangeAt < 500` → returnera. Annars uppdatera timestamp.
- I `if (!playing)`-grenen (efter `forceIdleNow`/`startKeepAlive`, endast om `_bleOwner !== 'none'`): rensa ev. existerande timer, sätt `_idleEnteredAt = Date.now()`, schemalägg `setTimeout(() => void this.handleIdleDisconnect(), IDLE_DISCONNECT_MS)`.
- I `else`-grenen (idle → active): clearTimeout `_idleDisconnectTimer`, nollställ `_idleEnteredAt`.

I `onBleConnected()` och `onBleDisconnected()` (rad 483/505): rensa `_idleDisconnectTimer` + `_idleEnteredAt`. Sätt `_micPausedForIdle = false` i `onBleConnected`.

Ny privat metod:
```ts
private async handleIdleDisconnect(): Promise<void> {
  this._idleDisconnectTimer = null;
  if (this.playing || this._bleOwner === 'none') {
    this._idleEnteredAt = null;
    return;
  }
  // 1. Idle-färg @ 100% (sista write)
  const idle = loadIdleColor();
  try { sendToBLE(idle[0], idle[1], idle[2], 100); } catch {}
  // 2. Vänta tills HCI-kö tom (max 500ms)
  const deadline = Date.now() + 500;
  while (isControllerDrainAttached() && getOutstandingPackets() > 0) {
    if (Date.now() > deadline) break;
    await new Promise(r => setTimeout(r, 20));
  }
  // 3. Stoppa keep-alive + disconnect (markeras som auto)
  stopKeepAlive();
  try { await triggerIdleDisconnect(); } catch {}
  // 4. Stoppa ALSA → ~20-25% CPU-besparing
  try { stopMic(); this._micPausedForIdle = true; } catch {}
  this._idleEnteredAt = null;
}
```

Getters för status-API:
```ts
getIdleEnteredAt(): number | null { return this._idleEnteredAt; }
isMicPausedForIdle(): boolean { return this._micPausedForIdle; }
```

### 4. `pi/src/index.ts` — Sonos PLAYING triggar mic+BLE restart

Statiska imports högst upp: `isMicActive, startMic` från `./alsaMic.js`, `wasAutoDisconnected, getHardcodedConnected, connectHardcoded` från `./ble/connect-hardcoded.js`.

I `applySonosStateToEngine` före `engineInstance.setPlaying(isPlaying)` (rad 89):
```ts
if (isPlaying || state.isTvMode) {
  if (!isMicActive()) {
    try { startMic(); } catch (e: any) { dlog(`[Sonos] startMic failed: ${e?.message ?? e}`); }
  }
  if (!getHardcodedConnected().connected && wasAutoDisconnected()) {
    void connectHardcoded();
  }
}
```
Båda är non-blocking. ALSA första audio-callback kommer ~200-300ms; BLE reconnect ~2-4s — ALSA hinner upp innan BLE behöver första writen.

### 5. `pi/src/configServer.ts` — `/api/status` exponerar idle-info

Importera `getLastDisconnectReason` från `./ble/connect-hardcoded.js`. I status-payload:
```ts
idle: engine ? {
  enteredAt: engine.getIdleEnteredAt(),
  disconnectInMs: engine.getIdleEnteredAt()
    ? Math.max(0, engine.getIdleEnteredAt()! + 120000 - Date.now())
    : null,
  micPausedForIdle: engine.isMicPausedForIdle(),
  lastDisconnectReason: getLastDisconnectReason(),
} : null,
```

### 6. Memory
Ny `mem://pi/runtime/idle-disconnect-policy.md` (type: feature):
- 2 min idle (hårdkodat) → idle-färg @ 100% → BLE disconnect → ALSA stop
- Sonos PLAYING-event triggar reconnect + startMic, **bara om `wasAutoDisconnected()`**
- Manuell UI-disconnect blockerar Sonos-reconnect tills nästa manuella connect
- 500ms debounce på setPlaying mot trackbyte-flaps

Uppdatera `mem://pi/ble/manual-only-connection-policy.md` med tillägg: undantag för idle-auto-reconnect via Sonos PLAYING gäller endast efter idle-timeout-disconnect.

Lägg referens i `mem://index.md` under Memories.

## Acceptanskriterier
1. Pausa Sonos i 2 min → keep-alive bär idle-färg, sedan en sista write @ 100%, sedan disconnect. `top` visar Lotus ~5% CPU (vs 25-30% under play).
2. Spela Sonos igen → ALSA + BLE startar parallellt, ljus inom 2-4s.
3. Manuell disconnect via UI → spela musik → INGEN auto-reconnect.
4. Snabba play/pause inom 500ms → debounce filtrerar.
5. `/api/status.idle` rapporterar `disconnectInMs`, `micPausedForIdle`, `lastDisconnectReason`.

## Inte i scope
- Audio-wake (medvetet uteslutet — rumssamtal = falsk-positives)
- UI-konfigurerbar timeout
- Disconnect i TV-läge (TV behandlas som playing)