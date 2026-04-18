#!/usr/bin/env node
/**
 * Replikerar EXAKT vad nobleScanConnect i pi/src/ble/connect.ts gör.
 * Användning:
 *   sudo node pi/scripts/noble-connect-replica.mjs BE:67:00:15:09:41
 */

const target = (process.argv[2] || '').trim();
if (!target) {
  console.error('Usage: sudo node noble-connect-replica.mjs <MAC>');
  process.exit(1);
}

const t0 = Date.now();
const ts = () => `+${(Date.now() - t0).toString().padStart(5, ' ')}ms`;
const log = (...a) => console.log(ts(), ...a);

const normalizeBleKey = (s) => (s || '').toLowerCase().replace(/[^0-9a-f]/g, '');
const targetNorm = normalizeBleKey(target);
log('Target normalized:', targetNorm);

log('1. Importing @stoprocent/noble...');
const noble = (await import('@stoprocent/noble')).default;
log('   typeof startScanningAsync =', typeof noble.startScanningAsync);
log('   noble.state =', noble.state);

// Replikera forceNobleStateMutate (best-effort)
try {
  if (noble.state !== 'poweredOn') {
    log('2. force-mutating _state to poweredOn...');
    noble._state = 'poweredOn';
  }
} catch (e) {
  log('   force-mutate FEL:', e.message);
}

log('3. waitForPoweredOnAsync(800ms)...');
try {
  await noble.waitForPoweredOnAsync(800);
  log('   poweredOn OK. state =', noble.state);
} catch (e) {
  log('   waitForPoweredOnAsync FEL:', e.message, '— fortsätter ändå');
}

let found = null;
const onDiscover = (peripheral) => {
  const pid = normalizeBleKey(peripheral.id);
  const pmac = normalizeBleKey(peripheral.address);
  const name = peripheral.advertisement?.localName ?? '(no name)';
  log(`[discover] id=${pid} mac=${pmac} name=${name} rssi=${peripheral.rssi}`);
  if (pid === targetNorm || pmac === targetNorm) {
    log('   ✓ MATCH!');
    found = peripheral;
  }
};
noble.on('discover', onDiscover);

log('4. startScanningAsync([], true) — 5s window...');
try {
  await noble.startScanningAsync([], true);
  log('   scan started');
} catch (e) {
  log('   startScanningAsync FEL:', e.message);
  process.exit(1);
}

const scanStart = Date.now();
while (!found && Date.now() - scanStart < 5000) {
  await new Promise(r => setTimeout(r, 100));
}

log('5. stopScanningAsync...');
try {
  await noble.stopScanningAsync();
  log('   scan stopped');
} catch (e) {
  log('   stop FEL:', e.message);
}
noble.removeListener('discover', onDiscover);

if (!found) {
  log('✗ Hittade inte', targetNorm, 'inom 5s');
  process.exit(2);
}

log('6. peripheral.connectAsync()...');
const connStart = Date.now();
try {
  await Promise.race([
    found.connectAsync(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('connect outer timeout 10s')), 10000))
  ]);
  log(`   ✓ CONNECTED efter ${Date.now() - connStart}ms`);
} catch (e) {
  log('   connectAsync FEL:', e.message);
  process.exit(3);
}

log('7. discoverAllServicesAndCharacteristicsAsync...');
try {
  const { services, characteristics } = await found.discoverAllServicesAndCharacteristicsAsync();
  log(`   ✓ ${services.length} services, ${characteristics.length} chars`);
  for (const c of characteristics) {
    log(`   - char ${c.uuid} props=${c.properties.join(',')}`);
  }
} catch (e) {
  log('   GATT FEL:', e.message);
}

log('8. disconnectAsync...');
try { await found.disconnectAsync(); } catch {}
log('   Klart.');
process.exit(0);
