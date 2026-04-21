/**
 * BLE module — public API re-exports for the hardcoded-only flow.
 */

export type { DeviceMode, PiCharacteristic, DiscoveredDevice, BleConnectionEvent } from './types.js';

export { bleStats, BLE_BUILD_TAG, SERVICE_UUID, CHAR_UUID } from './state.js';
export { getDevice, setDevice, isDemandActive, logConnectionEvent } from './state.js';
export { getSubsystemState, getAllSubsystemStates, markSubsystemStarting, markSubsystemReady, markSubsystemError, resetSubsystem } from './state.js';
export type { SubsystemId, SubsystemStatus, SubsystemState } from './state.js';
export { noble, hasNobleLoaded } from './state.js';

export { sendToBLE, setIdleColor, resetLastSent, setDimmingGamma, getDimmingGamma, getMinWriteIntervalMs, setMinWriteIntervalMs, startKeepAlive, stopKeepAlive } from './protocol.js';

export { connectHardcoded, disconnectHardcoded, getHardcodedConnected, getHardcodedPeripheral } from './connect-hardcoded.js';
export { startBleEngineMinimal, isMinimalEngineStarted } from './engine-start-minimal.js';
export { HARDCODED_DEVICE, matchesHardcoded } from './hardcoded-device.js';
export { isHci0Up } from './adapter-hci-check.js';
