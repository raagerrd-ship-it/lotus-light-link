/**
 * Backward-compatible shim — re-exports everything from ble/ module.
 * IMPORTANT: must stay side-effect free so importing './nobleBle.js' at boot
 * does NOT initialize BLE before the user presses Starta motor.
 */
export * from './ble/index.js';
