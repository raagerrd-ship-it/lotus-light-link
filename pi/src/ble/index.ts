/**
 * BLE module — public API re-exports for the hardcoded-only flow.
 *
 * Quarantined files (connect, scan, save, reconnect, adapter, heartbeat,
 * watchdog, sysExec, scan-*) are deleted. Allt scan/select/forget/demand/
 * watchdog är borta. UI:t använder bara:
 *   POST /api/ble/engine/start  → engine-start-minimal.ts
 *   POST /api/ble/connect       → connect-hardcoded.ts
 *   POST /api/ble/disconnect    → connect-hardcoded.ts
 *   GET  /api/ble/state         → connect-hardcoded.ts
 */

export type { DeviceMode, PiCharacteristic, DiscoveredDevice, BleConnectionEvent } from './types.js';

// State & subsystem
export { bleStats, BLE_BUILD_TAG, SERVICE_UUID, CHAR_UUID } from './state.js';
export { getDevice, setDevice, isDemandActive, logConnectionEvent } from './state.js';
export { getSubsystemState, getAllSubsystemStates, markSubsystemStarting, markSubsystemReady, markSubsystemError, resetSubsystem } from './state.js';
export type { SubsystemId, SubsystemStatus, SubsystemState } from './state.js';
export { noble, hasNobleLoaded } from './state.js';

// Protocol (write pipeline)
export { sendToBLE, sendRawColor, resetLastSent, setDimmingGamma, getDimmingGamma, getMinWriteIntervalMs, setMinWriteIntervalMs, stopKeepAlive } from './protocol.js';

// Hardcoded connect flow
export { connectHardcoded, disconnectHardcoded, getHardcodedConnected, getHardcodedPeripheral } from './connect-hardcoded.js';
export { startBleEngineMinimal, isMinimalEngineStarted } from './engine-start-minimal.js';
export { HARDCODED_DEVICE, matchesHardcoded } from './hardcoded-device.js';
export { isHci0Up } from './adapter-hci-check.js';
