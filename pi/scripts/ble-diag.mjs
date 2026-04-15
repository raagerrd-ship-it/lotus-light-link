#!/usr/bin/env node
/**
 * BLE diagnostics: verify saved metadata and test reconnect.
 * Run: node pi/scripts/ble-diag.mjs
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const DATA_DIR = process.env.LOTUS_DATA_DIR || '/opt/lotus-light/pi/data';

function read(key) {
  try { return readFileSync(join(DATA_DIR, `${key}.json`), 'utf-8').trim() || null; } catch { return null; }
}

console.log('═══════════════════════════════════════');
console.log('  BLE Diagnostics');
console.log('═══════════════════════════════════════\n');

// 1. Saved device metadata
const id = read('ble-device-id');
const name = read('ble-device-name');
const address = read('ble-device-address');
const addressType = read('ble-address-type');
const connectable = read('ble-connectable');
const serviceUuids = read('ble-service-uuids');

console.log('── Saved Device ──');
console.log(`  ID:           ${id || '(none)'}`);
console.log(`  Name:         ${name || '(none)'}`);
console.log(`  Address:      ${address || '(none)'}`);
console.log(`  Address Type: ${addressType || '⚠ MISSING — reconnect will guess "random"'}`);
console.log(`  Connectable:  ${connectable ?? '⚠ MISSING'}`);
console.log(`  Service UUIDs:${serviceUuids || '(none)'}`);

if (!id) {
  console.log('\n❌ No saved device. Scan and select a device first via PCC.');
  process.exit(1);
}

if (!addressType) {
  console.log('\n⚠  addressType is missing — this means the device was saved before');
  console.log('   the metadata update. Re-scan and re-select the device in PCC');
  console.log('   to capture addressType from noble.\n');
}

// 2. Adapter state
console.log('\n── Adapter ──');
try {
  const { execSync } = await import('child_process');
  const hci = execSync('hciconfig hci0 2>&1', { encoding: 'utf-8', timeout: 3000 });
  const upMatch = hci.match(/UP|DOWN/);
  const addrMatch = hci.match(/BD Address: ([0-9A-Fa-f:]+)/);
  console.log(`  Status:  ${upMatch?.[0] ?? 'unknown'}`);
  console.log(`  BD Addr: ${addrMatch?.[1] ?? 'unknown'}`);

  // rfkill
  try {
    const rfkill = execSync('rfkill list bluetooth 2>&1', { encoding: 'utf-8', timeout: 2000 });
    const blocked = rfkill.includes('Soft blocked: yes') || rfkill.includes('Hard blocked: yes');
    console.log(`  Blocked: ${blocked ? '⚠ YES' : 'No'}`);
  } catch {}
} catch (e) {
  console.log(`  ⚠ Could not read adapter: ${e.message}`);
}

// 3. Test noble connect
console.log('\n── Noble Connect Test ──');
console.log(`  Target: ${address} (addressType: ${addressType || 'random'})`);

try {
  const noble = (await import('@stoprocent/noble')).default;

  // Wait for adapter state
  const state = await new Promise((resolve) => {
    if (noble.state === 'poweredOn') return resolve('poweredOn');
    const t = setTimeout(() => resolve(noble.state ?? 'timeout'), 5000);
    noble.on('stateChange', (s) => { if (s === 'poweredOn') { clearTimeout(t); resolve(s); } });
  });

  console.log(`  Noble state: ${state}`);

  if (state !== 'poweredOn') {
    console.log('  ❌ Adapter not poweredOn — cannot test connect');
    process.exit(1);
  }

  const target = address.toLowerCase();
  const opts = addressType ? { addressType } : undefined;
  console.log(`  Connecting: noble.connectAsync("${target}"${opts ? `, {addressType: "${addressType}"}` : ''})...`);

  const start = Date.now();
  const peripheral = await Promise.race([
    noble.connectAsync(target, opts),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 6s')), 6000)),
  ]);

  const ms = Date.now() - start;
  console.log(`  ✅ Connected in ${ms}ms`);
  console.log(`  Peripheral ID:   ${peripheral.id}`);
  console.log(`  Address:         ${peripheral.address}`);
  console.log(`  Address Type:    ${peripheral.addressType}`);
  console.log(`  Connectable:     ${peripheral.connectable}`);
  console.log(`  RSSI:            ${peripheral.rssi}`);

  // GATT discovery
  console.log('\n── GATT Discovery ──');
  try {
    const services = await peripheral.discoverServicesAsync(['fff0']);
    console.log(`  Services found: ${services.length}`);
    if (services.length > 0) {
      const chars = await services[0].discoverCharacteristicsAsync(['fff3']);
      console.log(`  Characteristics: ${chars.length}`);
      if (chars.length > 0) {
        // Test write (blue color)
        await chars[0].writeAsync(Buffer.from([0x7e, 0x07, 0x05, 0x03, 0x00, 0x00, 0xff, 0x00, 0xef]), true);
        console.log('  ✅ Write OK — lampan borde lysa blå!');
      }
    }
  } catch (e) {
    console.log(`  ⚠ GATT failed: ${e.message}`);
  }

  await peripheral.disconnectAsync().catch(() => {});
} catch (e) {
  console.log(`  ❌ Connect failed: ${e.message}`);
  console.log('  → Om timeout: addressType kan vara fel. Testa att skanna om i PCC.');
}

console.log('\n═══════════════════════════════════════');
setTimeout(() => process.exit(0), 1000);
