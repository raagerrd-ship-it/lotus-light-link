// Engine barrel export — portable, no framework dependencies
export { LightEngine, type TickData, type TickCallback } from './lightEngine';
export { connectBLEDOM, autoReconnect, sendToBLE, sendPower, setActiveChar, clearActiveChar, sendHardwareBrightness, saveLastDevice, getLastDevice, type BLEConnection, type BleReconnectStatus } from './bledom';
export { getBleConnection, setBleConnection, subscribeBle } from './bleStore';
export { getCalibration, saveCalibration, applyColorCalibration, getActiveDeviceName, setActiveDeviceName, getIdleColor, saveIdleColor, setCloudSaveHook, DEFAULT_CALIBRATION, PRESET_NAMES, getPresets, getActivePreset, setActivePreset, savePresetCalibration, type LightCalibration, type PresetName } from './lightCalibration';
export { computeBands, type BandResult } from './audioAnalysis';
export { createAgcState, rescaleAgc, updateGlobalAgc, updateBandPeaks, getEffectiveMax, normalizeBand, normalizeValue, type AgcState } from './agc';
export { smooth, computeBrightnessPct, applyDynamics } from './brightnessEngine';
