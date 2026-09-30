// FALSK NOBLE for skrapbanken: en perifer (lampans MAC) som ansluter direkt, en characteristic som tar writeAsync,
// och en HCI-attrapp (_bindings._hci) med ACL-raknare + socket som skickar Number_Of_Completed_Packets pa
// radions raster (LOTUS_BLE_INTERVAL_UNITS * 1,25 ms) - sa controllerDrain och raster.ts (tick-synk) kor som pa Pi:n.
import { EventEmitter } from 'node:events';

const HANDLE = 64;
const UNITS = Math.max(6, Math.min(3200, Number(process.env.LOTUS_BLE_INTERVAL_UNITS) || 12));
const PERIOD = UNITS * 1.25;
const MAC = (process.env.FAKE_BLE_MAC || 'be:67:00:15:09:41').toLowerCase();
const UUID = MAC.replace(/[^0-9a-f]/g, '');

const socket = new EventEmitter();
const aclConn = { pending: 0 };
const hci = { _socket: socket, _aclConnections: new Map([[HANDLE, aclConn]]), _aclQueue: [] };
const nocp = Buffer.alloc(8); nocp[0] = 0x04; nocp[1] = 0x13; nocp[2] = 5; nocp[3] = 1; nocp.writeUInt16LE(HANDLE, 4); nocp.writeUInt16LE(1, 6);

let rasterOn = false; let nextAt = 0;
function rasterLoop() {
  if (!rasterOn) return;
  const now = performance.now();
  if (now >= nextAt) {
    while (nextAt <= now) nextAt += PERIOD;
    if (aclConn.pending > 0) { aclConn.pending--; socket.emit('data', nocp); }
  }
  setTimeout(rasterLoop, Math.max(0, Math.floor(nextAt - performance.now())));
}

class Characteristic extends EventEmitter {
  constructor() { super(); this.uuid = 'fff3'; this.properties = ['write', 'writeWithoutResponse']; }
  writeAsync(_buf, _wr) { aclConn.pending++; return Promise.resolve(); }
  write(_buf, _wr, cb) { aclConn.pending++; if (cb) queueMicrotask(() => cb(null)); }
}

class Peripheral extends EventEmitter {
  constructor() {
    super(); this.id = UUID; this.uuid = UUID; this.address = MAC; this.addressType = 'public'; this.rssi = -60;
    this.advertisement = { localName: 'ELK-BLEDOM01', serviceUuids: [] }; this.state = 'disconnected';
    this._ch = new Characteristic();
  }
  async connectAsync() { this.state = 'connected'; if (!rasterOn) { rasterOn = true; nextAt = performance.now() + PERIOD; rasterLoop(); } }
  async disconnectAsync() { this.state = 'disconnected'; rasterOn = false; this.emit('disconnect'); }
  connect(cb) { this.connectAsync().then(() => cb?.(null)); }
  disconnect(cb) { this.disconnectAsync().then(() => cb?.()); }
  async discoverSomeServicesAndCharacteristicsAsync() { return { services: [], characteristics: [this._ch] }; }
  async discoverAllServicesAndCharacteristicsAsync() { return { services: [], characteristics: [this._ch] }; }
  updateRssi(cb) { cb?.(null, this.rssi); }
}

class Noble extends EventEmitter {
  constructor() {
    super(); this.state = 'poweredOn'; this._state = 'poweredOn'; this._peripherals = new Map();
    this._bindings = { _handles: { [UUID]: HANDLE }, _hci: hci };
    this.address = '00:00:00:00:00:00';
  }
  async waitForPoweredOnAsync() { return; }
  async startScanningAsync() {
    setTimeout(() => {
      const p = this._peripherals.get(UUID) ?? new Peripheral();
      this._peripherals.set(UUID, p);
      this.emit('discover', p);
    }, 50);
  }
  startScanning(_s, _d, cb) { this.startScanningAsync().then(() => cb?.()); }
  async stopScanningAsync() { return; }
  stopScanning(cb) { cb?.(); }
  reset() { }
}

export default new Noble();
