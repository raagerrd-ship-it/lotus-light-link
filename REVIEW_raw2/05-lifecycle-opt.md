# ANDRA PASS (opt/förenkla) — Agent 5: index / lifecycle / health / restartLog / subsystem-state

**Ram:** SD-write redan minimalt (restart-log bara vid restart, marker 1×/boot, transitions debounce 1s). 1Hz-
schedulern har bara 2 tasks. 3-state-livscykeln är lagom minimal. Komplexiteten sitter i MASKINERI runt den.
Inga nya hot-path/SD-fynd — mest FÖRENKLING (ta bort skör/död komplexitet).

## 1 · simplify · MED — Duplicerad BLE-reconnect-infrastruktur: TVÅ backoff-schedulers för ETT jobb
- engineLifecycle.ts:33-165 scheduleConnectRetries [2/5/10/20s] + 5 modulvars + getConnectRetryStatus VS
  connect.ts:79-182 scheduleAutoReconnect [2/4/8/16/30s] + egna _autoReconnect*-state + give-up.
- Komplementära triggers idag: connect.ts armar bara efter LYCKAD connect droppar (peripheral disconnect);
  lifecycle:s retry täcker INITIAL connect-fail i toMotorOn. Redan kopplade: varje lifecycle-retry kör
  connectHardcoded() → driver _consecutiveFailures mot CONSECUTIVE_FAIL_LIMIT=4 → exit(0).
- Fix: låt connect.ts arma scheduleAutoReconnect även för Sonos-PLAYING-initial-connect, radera lifecycle:s
  scheduleConnectRetries + state + status-endpoint. ~70 rader + 5 vars bort. ⚠️ Beteende: unifierar timings +
  eskalering; BEVARA manual-only-policy (auto-reconnect AV efter UI-disconnect→IGNITION_OFF där toMotorOn hoppas).
  Med risk (in i connect.ts, policy-känsligt). Deliberat refaktor.

## 2 · simplify · MED — Vestigial reconnect-flag: skrivs överallt, konsumeras ingenstans
- ble-driver/reconnect-flag.ts (hela) + index.ts:557-561/571/638/648/656 + connect.ts:594. /tmp/lotus-auto-
  reconnect-on-boot sätts vid varje connect, av båda krash-handlers, av fail-exit — men boot-consume (:590)
  IGNORERAR returvärdet (kommentar: "consumeras inte längre vid boot" — Sonos playbackState är sanning nu). Flaggan
  driver INGET beslut. tmpfs (RAM, ingen SD). Fix: radera reconnect-flag.ts + re-export (ble/index.ts:93) + alla
  call-sites. Noll funktionellt. Caveat: författaren lämnade den som "redundant safety net" — verifiera ingen
  ops-script grep:ar /tmp-pathen.

## 3 · simplify · LOW-MED — globalThis.__lotusSetEngineCb-indirektion + ordnings-skör fallback
- index.ts:179-191 + 564-583. setEngineBleCallbacks har single-slot semantik → en globalThis-funktion multiplexar
  engine:s onBleConnected/Disconnected med main:s flagg-wrappers. I verklig boot-ordning kör ensureEngineInstance
  ALLTID efter main satt globalen → else-grenen :186-191 är död, OCH om den körde skulle den KLOBBRA main:s
  flagg-hooks. Fix: additiv semantik (lista) på setEngineBleCallbacks el. main komponerar engine-cb:s i sina
  wrappers + släng globalen + else-grenen. Huvudorsaken boot läses som rörigt. Med risk (connect.ts-semantik).

## 4 · simplify · LOW — Dubbel onSonosChange-prenumeration → 2 boot-fetches + dubbel per-poll-fanout
- index.ts:309 (listener A: applySonosStateToEngine+noteTrackName) + :613-620 (listener B: playing→lifecycle).
  onSonosChange (sonosPoller.ts:86) är additiv OCH gör färsk fetchStatusOnce() vid varje registrering → 2
  synkrona boot-fetches. Fix: en listener som dispatchar till båda. Låg prio (2s-kadens).

## 5 · optimize · LOW — logRuntimePermissions fork:ar `id -Gn` vid boot, dubblerar process.getgroups()
- index.ts:337-342 (execFile id -Gn) vs :333-34 (redan loggar getgroups()). Fork+exec bara för grupp-NAMN. Droppa
  eller gate bakom DEBUG_ENABLED. En färre child-process i sköra boot-fönstret.

## 6 · simplify · LOW — Watchdog lastTickOk är write-only död state
- index.ts:433/453/466 tilldelar lastTickOk; ALDRIG läst (bara curTickOk i logg :481). Radera + 3 tilldelningar.
  Trivia.

**Net:** Inga nya hot-path/SD-problem (redan tight). Starkaste: #1 (dubbel reconnect-infra) + #2 (vestigial
reconnect-flag) → ~100+ rader bort, "när restartar/reconnectar vi motorn" enkel-källad på Sonos. #3 = varför boot
läses rörigt. #1+#3 når in i connect.ts (koordinera).
