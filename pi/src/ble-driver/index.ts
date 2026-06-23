/**
 * ble-driver — portabel BLE-lampdriver (BLEDOM/ELK-klass) för Node + noble.
 *
 * Fristående: inga imports utanför denna mapp. Kopiera mappen rakt in i ett
 * annat Node-projekt och styr en lampa med createLampDriver().
 *
 * Minimal användning:
 *   import { createLampDriver } from './ble-driver/index.js';
 *   const lamp = createLampDriver({ device: { name: 'ELK-BLEDOM01', mac: 'BE:67:00:15:09:41' } });
 *   await lamp.connect();
 *   lamp.startKeepAlive();
 *   setInterval(() => { if (lamp.canWriteNow()) lamp.setColor(255, 80, 0, 100); }, 25);
 *
 * Lagret ovanpå (ljudreaktiv motor) ligger i pi/src/piEngine.ts och bygger på
 * de råa funktionerna som re-exporteras härifrån.
 */

import { setDeviceConfig, type LampDevice } from './device-config.js';
import { setLogger } from './log.js';
import {
  connectHardcoded, disconnectHardcoded, getHardcodedConnected, setRestartHook,
} from './connect.js';
import {
  sendToBLE, setIdleColor, sendPower, canWriteNow,
  setDimmingGamma, getDimmingGamma, setSlotLeaseMs, startKeepAlive, stopKeepAlive,
} from './protocol.js';
import { bleStats } from './state.js';

export interface LampDriverConfig {
  /** Mål-lampa. Default = projektets BLEDOM. */
  device?: LampDevice;
  /** Valfri logger (annars tyst om inte LOTUS_DEBUG=1). */
  logger?: (...args: unknown[]) => void;
  /** Tick-lease i ms (write-cadence-cap). Default 25. */
  slotLeaseMs?: number;
  /** Dimming-gamma 1.0–3.0. Default 1.8. */
  dimmingGamma?: number;
  /** Körs precis innan process.exit(0) vid N consecutive connect-failures. */
  onConsecutiveFailures?: (info: { count: number; error: string }) => void;
}

/** Tunt skal runt drivermodulen — ingen ny logik, bara en bekväm yta. */
export function createLampDriver(config: LampDriverConfig = {}) {
  if (config.device) setDeviceConfig(config.device);
  if (config.logger) setLogger(config.logger);
  if (config.slotLeaseMs != null) setSlotLeaseMs(config.slotLeaseMs);
  if (config.dimmingGamma != null) setDimmingGamma(config.dimmingGamma);
  if (config.onConsecutiveFailures) setRestartHook(config.onConsecutiveFailures);

  return {
    connect: () => connectHardcoded(),
    disconnect: () => disconnectHardcoded(),
    isConnected: () => getHardcodedConnected().connected,
    /** Skicka färg + ljusstyrka (0–100). Returnerar WriteResult. */
    setColor: (r: number, g: number, b: number, brightness = 100) => sendToBLE(r, g, b, brightness),
    setIdleColor,
    setPower: sendPower,
    powerOn: () => sendPower(true),
    powerOff: () => sendPower(false),
    canWriteNow,
    setDimmingGamma,
    getDimmingGamma,
    setSlotLeaseMs,
    startKeepAlive,
    stopKeepAlive,
    getStats: () => ({ ...bleStats }),
  };
}

export type LampDriver = ReturnType<typeof createLampDriver>;
export type { LampDevice };

// ── Låg-nivå re-exports (för motor-lagret och app-glue) ──
export type { DeviceMode, PiCharacteristic, DiscoveredDevice, ConnectedDevice } from './types.js';
export { bleStats, BLE_BUILD_TAG, SERVICE_UUID, CHAR_UUID, getDevice, setDevice, isDemandActive, noble, hasNobleLoaded } from './state.js';
export {
  sendToBLE, canWriteNow, setIdleColor, resetLastSent, setDimmingGamma, getDimmingGamma,
  getSlotLeaseMs, setSlotLeaseMs, startKeepAlive, stopKeepAlive, sendPower,
} from './protocol.js';
export {
  connectHardcoded, disconnectHardcoded, getHardcodedConnected, getHardcodedPeripheral,
  getLastDisconnectReason, wasAutoDisconnected, getAutoReconnectStatus,
  forceCleanupStalePeripheral, scheduleAutoReconnect, triggerIdleDisconnect,
  setEngineBleCallbacks, setRestartHook,
} from './connect.js';
export { HARDCODED_DEVICE, matchesHardcoded, setDeviceConfig } from './device-config.js';
export { isHci0Up } from './adapter-hci-check.js';
export { getOutstandingPackets, isControllerDrainAttached, getAttachedHandle, attachControllerDrain, detachControllerDrain } from './controllerDrain.js';
export { getNoble, getNobleAsync } from './noble-singleton.js';
export { setReconnectOnBootFlag, consumeReconnectOnBootFlag, clearReconnectOnBootFlag } from './reconnect-flag.js';
