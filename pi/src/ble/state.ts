// Shim — BLE-core-state flyttad till ../ble-driver/state.ts; subsystem-tracking
// ligger i ./subsystem-state.ts. Behålls för befintliga importvägar.
export * from '../ble-driver/state.js';
export * from './subsystem-state.js';
