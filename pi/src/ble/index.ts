/**
 * BLE module — app-glue. Re-exporterar den portabla ble-driver/ plus det
 * app-specifika subsystem-state-lagret, så resten av appen importerar precis
 * som tidigare via './ble'.
 */

export type { DeviceMode, PiCharacteristic, DiscoveredDevice } from '../ble-driver/types.js';

export { bleStats, BLE_BUILD_TAG, SERVICE_UUID, CHAR_UUID } from '../ble-driver/state.js';
export { getDevice, setDevice, isDemandActive } from '../ble-driver/state.js';
export { noble, hasNobleLoaded } from '../ble-driver/state.js';

export { sendToBLE, canWriteNow, setIdleColor, resetLastSent, setDimmingGamma, getDimmingGamma, getSlotLeaseMs, setSlotLeaseMs, startKeepAlive, stopKeepAlive, sendPower } from '../ble-driver/protocol.js';

export { connectHardcoded, disconnectHardcoded, getHardcodedConnected, getHardcodedPeripheral, scanForDevices } from '../ble-driver/connect.js';
export { startBleEngineMinimal, isMinimalEngineStarted } from './engine-start-minimal.js';
export { HARDCODED_DEVICE, matchesHardcoded, setDeviceConfig } from '../ble-driver/device-config.js';
export { isHci0Up } from '../ble-driver/adapter-hci-check.js';
export { getOutstandingPackets, isControllerDrainAttached, getAttachedHandle } from '../ble-driver/controllerDrain.js';

export { getSubsystemState, getAllSubsystemStates, markSubsystemStarting, markSubsystemReady, markSubsystemError, resetSubsystem, getSubsystemTransitions } from './subsystem-state.js';
export type { SubsystemId, SubsystemStatus, SubsystemState, SubsystemTransition } from './subsystem-state.js';

export { createLampDriver } from '../ble-driver/index.js';
export type { LampDriver, LampDriverConfig, LampDevice } from '../ble-driver/index.js';
