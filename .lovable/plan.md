
## Sammanfattning av granskningen

Idle-disconnect-flödet (Sonos paus → 2 min → BLE off + mic stop) och wake-flödet (Sonos PLAYING → reconnect + mic) är till 90% korrekt implementerat, men **tre defekter** gör att funktionen ofta inte triggar i praktiken:

---

## Bug 1 (KRITISK): `setPlaying(false)`-debouncen kan permanent blockera idle-disconnect

I `pi/src/piEngine.ts` rad 633:

```ts
if (!playing && now - this._lastPlayingChangeAt < PLAYING_DEBOUNCE_MS) {
  dlog('[Engine] setPlaying(false) debounced — för nära senaste flip');
  return;   // ← BUG: returnerar UTAN att uppdatera _lastPlayingChangeAt
}
this._lastPlayingChangeAt = now;
```

Problem: Sonos-pollern kallar `applySonosStateToEngine` var 2:a sekund (poll) eller vid varje SSE-event. När musik pausas:

1. Första `setPlaying(false)` kommer t.ex. 400 ms efter senaste PLAYING-flip → debounce-blockad, return.
2. `_lastPlayingChangeAt` uppdateras INTE.
3. Nästa poll 2 s senare: `playing===wasPlaying` (båda `true`!) → tidig return på rad 626 (`if (playing === wasPlaying) return`). ← **engine tror fortfarande att musiken spelar**.
4. Idle-timern startar aldrig. BLE-länken hålls vid liv. Mic fortsätter köra. CPU-besparingen sker aldrig.

Det här triggas garanterat varje gång användaren pausar inom 500 ms av en STOPPED→PLAYING-flap (vanligt vid trackbyte → paus).

**Fix:** Debouncen ska bara filtrera bort SNABBA flaps, inte tappa state. Två rena alternativ:

a) Schemalägg en deferred re-check istället för att tappa eventet:
```ts
if (!playing && now - this._lastPlayingChangeAt < PLAYING_DEBOUNCE_MS) {
  setTimeout(() => this.setPlaying(false), PLAYING_DEBOUNCE_MS);
  return;
}
```

b) Eller: ta bort debouncen helt eftersom Sonos-pollern redan bara emitar nya `playbackState`-värden och TV-mode-handling sker uppströms. Den ursprungliga motivationen (PLAYING→STOPPED→PLAYING vid trackbyte) hanteras bättre i pollern.

Rekommendation: variant (a) — minimal blast radius.

---

## Bug 2: Wake-pathen kan trigga reconnect medan slow-retry pågår

I `pi/src/index.ts` rad 110–121 görs:

```ts
if (!getHardcodedConnected().connected && wasAutoDisconnected()) {
  void connectHardcoded();
}
```

Men `wasAutoDisconnected()` returnerar `true` även när disconnect var `'supervision-timeout'` (icke-manuell), inte bara `'idle-timeout'`. Detta är OK i sig, MEN:

- Om slow-retry-loopen är aktiv (efter ≥4 consecutive failures) kommer Sonos-PLAYING att skjuta in extra `connectHardcoded()`-anrop ovanpå den. `_connectInFlight`-guarden räddar oss för parallella anrop, men `_slowRetryAttempts`-räknaren räknas inte upp av PLAYING-triggade försök, vilket kan fördröja den nukleära reseten.

- Viktigare: efter idle-timeout-disconnect sätts `_autoReconnectEnabled = false` (rad 218 i connect-hardcoded.ts) och `clearAutoReconnect()` körs. Bra. Men när Sonos PLAYING triggar `connectHardcoded()` och den **lyckas**, så återställs `_autoReconnectEnabled = true` (rad 477). Då fungerar nästa supervision-timeout korrekt. Detta steg är OK.

**Faktisk svaghet här:** wake-pathen särskiljer inte `'idle-timeout'` från `'supervision-timeout'`. Båda betyder "auto", så villkoret är slappt men det matchar `wasAutoDisconnected()`-semantiken. Ingen fix behövs här — bara en kommentar/tightening om vi vill vara explicita.

---

## Bug 3: Race mellan `handleIdleDisconnect()` och en ankommande PLAYING-event

`handleIdleDisconnect()` (piEngine.ts 539–582) är `async` och tar upp till ~500 ms (HCI drain) + `triggerIdleDisconnect()` + `stopMic()`. Mellan steg 4 (BLE off) och steg 5 (`stopMic`) kan Sonos-pollern kalla `applySonosStateToEngine` med PLAYING:

1. PLAYING-pathen i index.ts kallar `alsaMic.startMic()` — mic startas
2. Direkt efter kör `handleIdleDisconnect()` steg 5: `stopMic()` — mic dödas igen
3. Användaren får tyst lampa trots att musiken spelar

Sannolikheten är låg (~500 ms-fönster) men reproducerbar.

**Fix:** I början av `handleIdleDisconnect()`, kontrollera även att vi inte är mitt i en wake-trigger:

```ts
private async handleIdleDisconnect(): Promise<void> {
  this._idleDisconnectTimer = null;
  if (this.playing || this._bleOwner === 'none') {
    this._idleEnteredAt = null;
    return;
  }
  // ... och igen efter varje await:
  await new Promise(r => setTimeout(r, 20));
  if (this.playing) { dlog('[Engine] Idle-disconnect avbruten mid-flight'); return; }
  // ...
}
```

Lägg in `if (this.playing) return` efter await-stället på rad 561 och igen efter `triggerIdleDisconnect()` på rad 568, innan `stopMic()`.

---

## Bug 4 (mindre): `_idleEnteredAt` nollställs inte vid debounce-block

Eftersom Bug 1 kan blockera setPlaying(false) återkommer vi aldrig in i grenen som rensar `_idleEnteredAt`. När Bug 1 är fixad försvinner detta.

---

## Plan — ändringar

**Fil: `pi/src/piEngine.ts`**

1. Rad 633–637: Byt debounce-`return` mot deferred re-call (Bug 1).
2. Rad 539–582 `handleIdleDisconnect`: Lägg till `if (this.playing) return` mid-flight efter de två await-stegen (Bug 3).

**Fil: `pi/src/index.ts`** — ingen ändring behövs (wake-pathen är OK).

**Fil: `pi/src/ble/connect-hardcoded.ts`** — ingen ändring behövs.

---

## Förväntat beteende efter fix

- Pause → exakt 2 min senare: idle-färg @ 100%, BLE disconnect, mic stop. Pålitligt även om paus sker i samma sekund som ett trackbyte.
- PLAYING under handleIdleDisconnect's drain-fönster avbryter cleanen, mic + BLE behålls, ingen tyst lampa.
- Restart-trösklar (slow-retry, nukleär reset) oförändrade.

---

## Verifiering efter deploy

1. Starta musik → pausa → vänta 2 min → kolla `journalctl -u lotus-light-engine | grep -E "Idle-disconnect|micPausedForIdle"` — ska visa schemalagd + utförd cleanup.
2. Pausa direkt efter trackbyte (inom 500 ms) → vänta 2 min → samma logg ska visa cleanup. Tidigare: tom logg.
3. Starta musik igen → BLE reconnectar inom 2–4 s, lampan svarar.
4. `/api/status.idle` ska visa `enteredAt`, `disconnectInMs`, `micPausedForIdle: true` efter cleanup.
