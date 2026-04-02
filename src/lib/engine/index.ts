// Engine barrel export — portable, no framework dependencies
export { LightEngine, DEFAULT_TICK_MS, type TickData, type TickCallback } from './lightEngine';
export { connectBLEDOM, autoReconnect, sendToBLE, sendPower, setActiveChar, addActiveChar, removeActiveChar, clearActiveChar, clearAllChars, getActiveCharCount, sendHardwareBrightness, saveLastDevice, getLastDevice, updateCharMode, getSavedDeviceMode, setDeviceMode, resetLastSent, setBleMinIntervalMs, type BLEConnection, type BleReconnectStatus, type DeviceMode } from './bledom';
export { getBleConnection, getBleConnections, setBleConnection, addBleConnection, removeBleConnection, clearBleConnections, subscribeBle } from './bleStore';
export { getCalibration, saveCalibration, applyColorCalibration, getActiveDeviceName, setActiveDeviceName, getIdleColor, saveIdleColor, setCloudSaveHook, DEFAULT_CALIBRATION, PRESET_NAMES, getPresets, getActivePreset, setActivePreset, savePresetCalibration, type LightCalibration, type PresetName } from './lightCalibration';
export { computeBands, type BandResult } from './audioAnalysis';
export { createAgcState, rescaleAgc, updateRunningMax, volumeToBucket, updateVolumeTable, getFloorForVolume, normalizeBand, normalizeValue, createVolumeTable, migrateToVolumeTable, type AgcState, type AgcVolumeTable } from './agc';
export { smooth, computeBrightnessPct, applyDynamics, extraSmooth } from './brightnessEngine';
