#!/usr/bin/env node
/**
 * Isolerat test av noble.startScanningAsync().
 *
 * Loggar varje steg + lyssnar på ALLA noble-events för att se var den fastnar.
 * Kör med: sudo node pi/scripts/noble-scan-isolated.mjs
 * Eller med samma capabilities som servicen:
 *   sudo -E capsh --caps="cap_net_raw,cap_net_admin+eip cap_net_raw,cap_net_admin+p" \
 *     --user=$USER -- -c "node pi/scripts/noble-scan-isolated.mjs"
 */

const t0 = Date.now();
const ts = () => `+${(Date.now() - t0).toString().padStart(5, ' ')}ms`;
const log = (...a) => console.log(ts(), ...a);

log('1. Importing @stoprocent/noble...');
const noble = (await import('@stoprocent/noble')).default;
log('2. Imported. typeof noble.startScanningAsync =', typeof noble.startScanningAsync);
log('   noble.state =', noble.state, '| noble._state =', noble._state);

// Lyssna på ALLA events
const events = ['stateChange', 'scanStart', 'scanStop', 'discover', 'warning', 'error'];
for (const ev of events) {
  noble.on(ev, (...args) => {
    const arg0 = args[0];
    if (ev === 'discover') {
      log(`[event:${ev}]`, arg0?.address, arg0?.advertisement?.localName ?? '(no name)', `rssi=${arg0?.rssi}`);
    } else {
      log(`[event:${ev}]`, ...args.map(a => typeof a === 'object' ? JSON.stringify(a).slice(0, 100) : a));
    }
  });
}

log('3. Waiting 1s for any initial stateChange events...');
await new Promise(r => setTimeout(r, 1000));
log('   noble.state efter 1s =', noble.state);

// Försök tvinga state om den inte är poweredOn
if (noble.state !== 'poweredOn') {
  log('4. State är inte poweredOn — försöker waitForPoweredOnAsync(3s)...');
  try {
    await Promise.race([
      noble.waitForPoweredOnAsync(3000),
      new Promise((_, rej) => setTimeout(() => rej(new Error('outer timeout 4s')), 4000))
    ]);
    log('   waitForPoweredOnAsync resolved. state =', noble.state);
  } catch (e) {
    log('   waitForPoweredOnAsync FEL:', e.message);
  }
} else {
  log('4. State redan poweredOn — hoppar waitForPoweredOnAsync');
}

log('5. Anropar noble.startScanningAsync([], true) med 8s outer timeout...');
const scanStart = Date.now();
try {
  await Promise.race([
    noble.startScanningAsync([], true).then(() => log(`   startScanningAsync RESOLVED efter ${Date.now() - scanStart}ms`)),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`outer timeout efter ${Date.now() - scanStart}ms`)), 8000))
  ]);
} catch (e) {
  log('   startScanningAsync FEL:', e.message);
  log('   noble.state efter fel =', noble.state);
  log('   Försöker stopScanningAsync ändå...');
  try {
    await Promise.race([
      noble.stopScanningAsync(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('stop outer timeout 3s')), 3000))
    ]);
    log('   stopScanningAsync OK');
  } catch (e2) {
    log('   stopScanningAsync FEL:', e2.message);
  }
  process.exit(1);
}

log('6. Scan startad — väntar 5s på discover-events...');
await new Promise(r => setTimeout(r, 5000));

log('7. Anropar stopScanningAsync...');
try {
  await Promise.race([
    noble.stopScanningAsync(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('stop outer timeout 3s')), 3000))
  ]);
  log('   stopScanningAsync OK');
} catch (e) {
  log('   stopScanningAsync FEL:', e.message);
}

log('8. Klart. Avslutar.');
process.exit(0);
