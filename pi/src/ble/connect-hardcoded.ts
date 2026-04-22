/**
 * Scan-then-connect mot HARDCODED_DEVICE — speglar pi/scripts/noble-scan-isolated.mjs
 * exakt: vänta på poweredOn → startScanningAsync([], true) → matcha discover-event
 * → stopScanningAsync → peripheral.connectAsync.
 *
 * Inga watchdogs, ingen reconnect-loop, ingen force-mutate av noble._state.
 * Se mem://pi/ble/never-force-mutate-noble-state.
 */

import { noble, getNoble } from './noble-singleton.js';
import { HARDCODED_DEVICE, matchesHardcoded } from './hardcoded-device.js';
import { SERVICE_UUID, CHAR_UUID, setDevice, bleStats } from './state.js';
import { brightMaxBuf, stopKeepAlive, resetLastSent } from './protocol.js';
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';

// Flagga som persisterar över systemd-restart. Sätts när vi kör process.exit(0)
// pga consecutive connect-failures, läses i index.ts boot för att auto-anropa
// connectHardcoded() direkt efter restart (så användaren slipper trycka Anslut).
const RECONNECT_FLAG = '/tmp/lotus-auto-reconnect-on-boot';
export function setReconnectOnBootFlag(): void {
  try { writeFileSync(RECONNECT_FLAG, String(Date.now()), 'utf8'); } catch {}
}
export function consumeReconnectOnBootFlag(): boolean {
  try {
    if (!existsSync(RECONNECT_FLAG)) return false;
    unlinkSync(RECONNECT_FLAG);
    return true;
  } catch { return false; }
}

// Consecutive connect-failures räknare. Mönster från fältet: BLEDOM ansluter
// alltid på 1-2s eller aldrig. Efter 2 misslyckanden i rad är noble's HCI-state
// fastnat — enda fungerande lösning är full process-restart (systemd Restart=always).
const CONSECUTIVE_FAIL_LIMIT = 2;
let _consecutiveFailures = 0;

// Engine-callbacks — sätts av piEngine via setEngineBleCallbacks() vid boot.
// Används så att engine kan toggla keep-alive/idle-heartbeat baserat på
// faktisk BLE-status (inte vid engine.start() innan lampan är ansluten).
let _onConnected: (() => void) | null = null;
let _onDisconnected: (() => void) | null = null;
export function setEngineBleCallbacks(onConnected: () => void, onDisconnected: () => void): void {
  _onConnected = onConnected;
  _onDisconnected = onDisconnected;
}

let _connected: any = null;
let _connectInFlight: Promise<{ connected: boolean; error?: string }> | null = null;
let _lastConnectCallAt = 0;
let _connectCallCount = 0;

// ── Auto-reconnect-loop ──────────────────────────────────────────────────
// Aktiveras när en lyckad connect följs av disconnect (alltså: lampan VAR
// ansluten och tappade länken). Inaktiveras vid manuell disconnectHardcoded()
// eller när reconnect lyckas. Backoff: 2s → 4s → 8s → 16s → max 30s.
// MAX_ATTEMPTS hindrar oändlig boot-loop om lampan är permanent borta —
// efter 20 försök (~10 min total backoff) pausas loopen och kräver manuell
// trigger via /api/ble/connect. Räknaren nollställs vid lyckad reconnect.
const AUTO_RECONNECT_MAX_ATTEMPTS = 20;
let _autoReconnectEnabled = false;
let _autoReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _autoReconnectAttempt = 0;
let _autoReconnectGivenUp = false;

// Debounce-skydd: keep-alive-fail OCH peripheral.disconnect kan båda
// schemalägga reconnect inom samma race-fönster. 1s debounce kollapsar
// dubbla triggers så vi inte räknar upp _autoReconnectAttempt två gånger.
let _lastReconnectRequestAt = 0;
const RECONNECT_DEBOUNCE_MS = 1000;

function clearAutoReconnect(): void {
  if (_autoReconnectTimer) { clearTimeout(_autoReconnectTimer); _autoReconnectTimer = null; }
  _autoReconnectAttempt = 0;
  _autoReconnectGivenUp = false;
}

/**
 * Schemalägg auto-reconnect med exponentiell backoff (2→4→8→16→30s).
 * Exporterad så keep-alive-fail-pathen i protocol.ts kan trigga loopen
 * direkt — peripheral.disconnect-eventet är inte garanterat att fyra
 * när BLEDOM tappas via supervision timeout (reason=8).
 */
export function scheduleAutoReconnect(): void {
  if (!_autoReconnectEnabled) {
    // Aktivera loopen om vi någon gång har varit anslutna — annars triggas
    // den aldrig efter en supervision-timeout (peripheral-disconnect-eventet
    // hinner inte fyra innan keep-alive ger upp och nollar device).
    if (_connected || bleStats.disconnectCount > 0) {
      _autoReconnectEnabled = true;
    } else {
      return;
    }
  }
  if (_autoReconnectTimer) return; // redan schemalagd
  if (_connectInFlight) return;     // pågående connect täcker behovet
  if (_connected && _connected.state === 'connected') return; // redan uppe

  _autoReconnectAttempt++;
  const backoffs = [2000, 4000, 8000, 16000, 30000];
  const delay = backoffs[Math.min(_autoReconnectAttempt - 1, backoffs.length - 1)];
  console.log(`[auto-reconnect] försök #${_autoReconnectAttempt} om ${delay}ms`);
  _autoReconnectTimer = setTimeout(async () => {
    _autoReconnectTimer = null;
    if (!_autoReconnectEnabled) return;
    if (_connected && _connected.state === 'connected') {
      console.log(`[auto-reconnect] redan ansluten — avbryter loop`);
      _autoReconnectAttempt = 0;
      return;
    }
    try {
      const r = await connectHardcoded();
      if (r.connected) {
        console.log(`[auto-reconnect] ✓ återansluten efter ${_autoReconnectAttempt} försök (${r.durationMs}ms)`);
        _autoReconnectAttempt = 0;
      } else {
        console.warn(`[auto-reconnect] ✗ försök #${_autoReconnectAttempt} misslyckades: ${r.error ?? 'okänt fel'}`);
        scheduleAutoReconnect(); // nästa försök, ökad backoff
      }
    } catch (e: any) {
      console.warn(`[auto-reconnect] ✗ försök #${_autoReconnectAttempt} kastade: ${e?.message ?? e}`);
      scheduleAutoReconnect();
    }
  }, delay);
}

export function getHardcodedConnected(): { connected: boolean; name: string; mac: string } {
  return { connected: !!_connected && _connected.state === 'connected', name: HARDCODED_DEVICE.name, mac: HARDCODED_DEVICE.mac };
}

export function getAutoReconnectStatus(): { enabled: boolean; attempt: number; pending: boolean } {
  return { enabled: _autoReconnectEnabled, attempt: _autoReconnectAttempt, pending: !!_autoReconnectTimer };
}

export function getHardcodedPeripheral(): any | null {
  return _connected;
}

export async function disconnectHardcoded(): Promise<{ disconnected: boolean }> {
  // Manuell disconnect → stoppa auto-reconnect-loopen så vi inte kämpar mot användaren.
  _autoReconnectEnabled = false;
  clearAutoReconnect();
  if (!_connected) return { disconnected: true };
  // Engine hanterar stopp av keep-alive + idle-heartbeat via callback.
  _onDisconnected?.();
  setDevice(null);
  resetLastSent();
  try { await _connected.disconnectAsync(); } catch {}
  _connected = null;
  return { disconnected: true };
}

/**
 * Pre-connect cleanup: rensa stale peripheral + noble's interna cache.
 *
 * Bakgrund: när BLEDOM tappar länken tyst (keep-alive failar i bakgrunden,
 * radio-timeout utan disconnect-event) sitter noble kvar med en peripheral
 * i `_peripherals[id]` som internt tror att GATT-sessionen lever. Nästa
 * `connectAsync()` mot samma instans hänger då oändligt.
 *
 * Lösningen är att purga cache-entrien så scan skapar en fresh peripheral.
 * Idempotent — inget händer om allt redan är rent.
 *
 * Se mem://pi/ble/stale-peripheral-cache.
 */
export async function forceCleanupStalePeripheral(reason: string): Promise<void> {
  const n: any = getNoble();

  // 1. Stoppa pågående scan (säkerhetsåtgärd om förra cyklen kraschade mitt i)
  try { await n.stopScanningAsync(); } catch {}

  // 2. Force-disconnect stale peripheral om den ligger kvar
  if (_connected) {
    const state = _connected.state;
    console.log(`[connect-hardcoded] cleanup (${reason}): stale peripheral state=${state}, force-disconnecting`);
    const periph = _connected;
    const disconnectEvent = `disconnect:${periph.uuid ?? periph.id}`;
    try { n.removeAllListeners?.(disconnectEvent); } catch {}
    try { periph.removeAllListeners?.('disconnect'); } catch {}
    try {
      await Promise.race([
        periph.disconnectAsync?.(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('disconnect timeout')), 1000)),
      ]);
    } catch (e: any) {
      console.log(`[connect-hardcoded] cleanup: disconnect ignored (${e?.message ?? e})`);
    }
    _connected = null;
  }

  // 3. Purga noble's interna peripheral-cache för target-MAC
  try {
    const peripherals = n._peripherals;
    if (peripherals && typeof peripherals === 'object') {
      const targetId = HARDCODED_DEVICE.idNoColon;
      const targetAddr = HARDCODED_DEVICE.addressLower;
      const keys = Object.keys(peripherals);
      for (const key of keys) {
        const p = peripherals[key];
        const pid = (p?.id ?? key).toLowerCase().replace(/[^0-9a-f]/g, '');
        const paddr = (p?.address ?? '').toLowerCase();
        if (pid === targetId || paddr === targetAddr) {
          delete peripherals[key];
          console.log(`[connect-hardcoded] cleanup: noble._peripherals[${key}] purged`);
        }
      }
    }
  } catch (e: any) {
    console.warn(`[connect-hardcoded] cleanup: cache purge fel (${e?.message ?? e}) — fortsätter ändå`);
  }

  // 4. Engine-side state reset (no-op om redan rent)
  try { _onDisconnected?.(); } catch {}
  try { setDevice(null); } catch {}
  try { resetLastSent(); } catch {}
}

export async function connectHardcoded(timeoutMs = 6000): Promise<{ connected: boolean; error?: string; durationMs: number }> {
  _connectCallCount++;
  const sinceLast = Date.now() - _lastConnectCallAt;
  _lastConnectCallAt = Date.now();
  // Diagnostik: om någon hamrar denna endpoint vill vi se det i loggen.
  // Stack-trace ger oss caller (HTTP-route, intern reconnect, etc).
  console.log(`[connect-hardcoded] CALL #${_connectCallCount} (${sinceLast}ms sedan förra)`);
  if (sinceLast < 500 && _connectCallCount > 1) {
    console.warn(`[connect-hardcoded] ⚠ Hammered: ${sinceLast}ms sedan förra anropet — caller-stack:\n${new Error().stack?.split('\n').slice(2, 6).join('\n')}`);
  }
  if (_connectInFlight) {
    console.log(`[connect-hardcoded]   → in-flight, väntar på pågående connect`);
    const r = await _connectInFlight;
    return { ...r, durationMs: 0 };
  }
  if (_connected && _connected.state === 'connected') {
    console.log(`[connect-hardcoded]   → redan ansluten, returnerar idempotent`);
    return { connected: true, durationMs: 0 };
  }

  const t0 = Date.now();
  const ts = () => `+${(Date.now() - t0).toString().padStart(5, ' ')}ms`;

  const inflight = (async (): Promise<{ connected: boolean; error?: string }> => {
    const n = getNoble();

    // 0. Pre-connect cleanup — purga ev. stale peripheral i noble's cache,
    //    annars hänger connectAsync tyst om förra länken dog utan disconnect-event.
    console.log(`${ts()} 0. pre-connect cleanup…`);
    await forceCleanupStalePeripheral('pre-connect');

    console.log(`${ts()} 1. waitForPoweredOnAsync(10s)…`);
    try {
      await (n as any).waitForPoweredOnAsync(10_000);
      console.log(`${ts()}    poweredOn (state=${n.state})`);
    } catch (e: any) {
      console.log(`${ts()}    waitForPoweredOnAsync FEL: ${e?.message ?? e}`);
      return { connected: false, error: `waitForPoweredOnAsync failed: ${e?.message ?? e}` };
    }

    return await new Promise<{ connected: boolean; error?: string }>((resolve) => {
      let resolved = false;
      let discoverCount = 0;
      let matched = false; // sätts när vi hittat target — påverkar timeout-meddelandet
      const finish = (r: { connected: boolean; error?: string }) => {
        if (resolved) return;
        resolved = true;
        try { n.removeListener('discover', onDiscover); } catch {}
        clearTimeout(timer);
        resolve(r);
      };

      // Helper: race en promise mot en hård timeout. noble's connectAsync
      // kan på Pi Zero 2W hänga oändligt om L2CAP-handshake tappas, vilket
      // tidigare lät yttre 8s-watchdogen fyra "ingen matchade" trots match.
      const withTimeout = <T,>(p: Promise<T>, label: string, ms: number): Promise<T> =>
        Promise.race([
          p,
          new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
        ]);

      const onDiscover = async (peripheral: any) => {
        discoverCount++;
        const isMatch = matchesHardcoded(peripheral);
        // Logga BARA matchande enheter — annars spammar varje närliggande
        // BLE-advertisement loggen och äter CPU på Pi Zero 2W.
        if (!isMatch) return;
        matched = true;
        const name = peripheral.advertisement?.localName ?? '(no name)';
        console.log(`${ts()} [event:discover] ${peripheral.address} ${name} rssi=${peripheral.rssi} ← MATCH`);
        console.log(`${ts()} 3. MATCH efter ${discoverCount} discover-events — stopScanningAsync…`);
        try {
          await n.stopScanningAsync();
          console.log(`${ts()}    stopScanningAsync OK`);
        } catch (e: any) {
          console.warn(`${ts()}    stopScanningAsync warning: ${e?.message ?? e}`);
        }
        console.log(`${ts()} 4. peripheral.connectAsync() (5s timeout)…`);
        try {
          await withTimeout(peripheral.connectAsync(), 'connectAsync', 4000);
          _connected = peripheral;
          // Rensa ev. gamla disconnect-listeners från tidigare connect-cyklar.
          // Noble emittar internt `disconnect:<uuid>` på SIG noble-objektet,
          // och peripheral.once('disconnect') registreras DÄR — inte på
          // peripheral självt. Därför måste vi rensa på noble-instansen,
          // annars staplas listeners → MaxListenersExceededWarning efter ~10
          // reconnects mot samma MAC.
          const disconnectEvent = `disconnect:${peripheral.uuid ?? peripheral.id}`;
          try { (n as any).removeAllListeners?.(disconnectEvent); } catch {}
          try { peripheral.removeAllListeners?.('disconnect'); } catch {}
          peripheral.once?.('disconnect', () => {
            console.log(`[connect-hardcoded] peripheral disconnected (${peripheral.address})`);
            _onDisconnected?.();
            setDevice(null);
            resetLastSent();
            bleStats.disconnectCount++;
            bleStats.lastDisconnectAt = new Date().toISOString();
            if (_connected === peripheral) _connected = null;
            // Auto-reconnect: vi var ANSLUTNA och tappade länken → starta backoff-loop.
            // (Aktiveras nedan vid lyckad connect så manuella connect-fel inte triggar.)
            scheduleAutoReconnect();
          });
          console.log(`${ts()} 5. ANSLUTEN ${peripheral.address}`);

          // ── 6. GATT discovery: hitta write-characteristic så vi kan skriva färg + hålla keep-alive ──
          console.log(`${ts()} 6. discoverSomeServicesAndCharacteristicsAsync([${SERVICE_UUID}], [${CHAR_UUID}])…`);
          try {
            const result = await withTimeout<any>(
              peripheral.discoverSomeServicesAndCharacteristicsAsync([SERVICE_UUID], [CHAR_UUID]),
              'GATT discovery',
              8000,
            );
            const characteristics = Array.isArray(result) ? result[1] : result?.characteristics;
            const ch = characteristics?.[0];
            if (!ch) {
              console.warn(`${ts()}    GATT: ingen ${CHAR_UUID}-characteristic hittad — keep-alive startas EJ`);
              finish({ connected: true });
              return;
            }

            // CRITICAL: samma anchor write som i vanliga connect.ts.
            // Utan den kan länken se "connected" ut men första riktiga
            // färgskrivningen hänga/tyst droppas, vilket ger 0 pkt/s.
            console.log(`${ts()} 7. anchor write (3s timeout)…`);
            try {
              await withTimeout(ch.writeAsync(brightMaxBuf, true), 'anchor write', 3000);
              console.log(`${ts()}    anchor write OK`);
            } catch (e: any) {
              // RACE GUARD: withTimeout(anchor write, 3000) kan kasta sent
              // om writeAsync resolvar precis runt 3s-gränsen. Om finish()
              // redan körts (resolved=true) är vi redan anslutna.
              if (resolved) {
                console.log(`${ts()}    (ignorerar sen anchor-write-timeout: ${e?.message ?? e})`);
                return;
              }
              console.warn(`${ts()}    anchor write FEL: ${e?.message ?? e} — disconnectar`);
              try { await peripheral.disconnectAsync(); } catch {}
              finish({ connected: false, error: `Anchor write failed: ${e?.message ?? e}` });
              return;
            }

            setDevice({
              peripheral,
              characteristic: ch,
              mode: 'rgb',
              name: HARDCODED_DEVICE.name,
              id: peripheral.id,
            });
            // Aktivera auto-reconnect-loopen — från och med nu räknas varje
            // disconnect som "tappad länk vi vill ha tillbaka".
            _autoReconnectEnabled = true;
            clearAutoReconnect();
            // Notifiera engine — den startar keep-alive + idle-heartbeat
            // (om Sonos är pausad). Vid spelande musik skippar engine
            // keep-alive eftersom mic-writes håller länken.
            _onConnected?.();
            console.log(`${ts()} 8. anslutning klar — engine notifierad om BLE-status`);
            finish({ connected: true });
          } catch (e: any) {
            // RACE GUARD: samma sen-timeout-mönster som connectAsync nedan.
            // GATT discovery kan resolva precis runt 8s-gränsen och tickande
            // setTimeout kastar ändå — disconnecta INTE en lyckad session.
            if (resolved) {
              console.log(`${ts()}    (ignorerar sen GATT-discovery-timeout: ${e?.message ?? e})`);
              return;
            }
            console.warn(`${ts()}    GATT discovery FEL: ${e?.message ?? e} — försöker disconnecta`);
            try { await peripheral.disconnectAsync(); } catch {}
            finish({ connected: false, error: `GATT discovery failed: ${e?.message ?? e}` });
          }
        } catch (e: any) {
          // RACE GUARD: withTimeout's interna setTimeout(4000) fortsätter ticka
          // även efter att connectAsync redan resolvat — om GATT+anchor+finish()
          // hann köras före timeouten, kastar racet ändå "connectAsync timed out"
          // ~1s senare. Då har vi en LYCKAD, ANSLUTEN session som inte får dödas.
          // Bevisat i fält: 22:45:28 "anslutning klar" → 22:45:29 timeout-catch
          // disconnectade samma peripheral. Om resolved=true → ignorera tyst.
          if (resolved) {
            console.log(`${ts()}    (ignorerar sen connectAsync-timeout: ${e?.message ?? e} — vi är redan anslutna)`);
            return;
          }
          console.log(`${ts()}    connectAsync FEL: ${e?.message ?? e} — disconnectar och ger upp`);
          try { await peripheral.disconnectAsync(); } catch {}
          finish({ connected: false, error: `connectAsync failed: ${e?.message ?? e}` });
        }
      };

      n.on('discover', onDiscover);

      const timer = setTimeout(async () => {
        if (matched) {
          // Detta ska aldrig hända nu (connectAsync har egen 5s timeout) —
          // men om det gör det, säg sanningen istället för "ingen matchade".
          console.log(`${ts()} TIMEOUT efter ${timeoutMs}ms — match hittades men connect hängde (${discoverCount} discover-events)`);
        } else {
          console.log(`${ts()} TIMEOUT efter ${timeoutMs}ms — ${discoverCount} discover-events totalt, ingen matchade`);
        }
        try { await n.stopScanningAsync(); } catch {}
        finish({
          connected: false,
          error: matched
            ? `Match hittad men connect hängde efter ${timeoutMs}ms`
            : `Hittade inte ${HARDCODED_DEVICE.mac} efter ${timeoutMs}ms (${discoverCount} discover-events)`,
        });
      }, timeoutMs);

      console.log(`${ts()} 2. startScanningAsync([], true)…`);
      n.startScanningAsync([], true)
        .then(() => console.log(`${ts()}    startScanningAsync OK — väntar på match (${HARDCODED_DEVICE.mac})`))
        .catch((e: any) => {
          console.log(`${ts()}    startScanningAsync FEL: ${e?.message ?? e}`);
          finish({ connected: false, error: `startScanningAsync failed: ${e?.message ?? e}` });
        });
    });
  })();

  _connectInFlight = inflight;
  try {
    const r = await inflight;
    if (r.connected) {
      // Lyckad connect → nollställ failure-räknaren.
      if (_consecutiveFailures > 0) {
        console.log(`[connect-hardcoded] ✓ connect lyckades efter ${_consecutiveFailures} failures — räknaren nollställd`);
      }
      _consecutiveFailures = 0;
    } else {
      _consecutiveFailures++;
      console.warn(`[connect-hardcoded] ✗ connect misslyckades (${_consecutiveFailures}/${CONSECUTIVE_FAIL_LIMIT} consecutive failures)`);
      if (_consecutiveFailures >= CONSECUTIVE_FAIL_LIMIT) {
        // Mönster från fältet: BLEDOM ansluter alltid på 1-2s eller aldrig.
        // 2 misslyckade i rad = noble's HCI-state är fastnat. Enda fungerande
        // lösning är full process-restart (systemd Restart=always startar om).
        // Sätt flagga så engine auto-anropar connectHardcoded() vid boot.
        console.error(`[connect-hardcoded] ⚠ ${CONSECUTIVE_FAIL_LIMIT} consecutive failures — sätter reconnect-flagga och process.exit(0) för systemd restart`);
        setReconnectOnBootFlag();
        // Liten delay så HTTP-svar hinner ut till UI innan vi dör.
        setTimeout(() => process.exit(0), 500);
      }
    }
    return { ...r, durationMs: Date.now() - t0 };
  } finally {
    _connectInFlight = null;
  }
}
