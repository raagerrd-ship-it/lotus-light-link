import { useState, useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import CalibrationOverlay from "@/components/CalibrationOverlay";
import { Button } from "@/components/ui/button";
import NowPlayingBar from "@/components/NowPlayingBar";
import {
  connectBLEDOM, getLastDevice, autoReconnect,
  sendPower, addActiveChar, removeActiveChar, clearActiveChar,
  sendHardwareBrightness, updateCharMode, setDeviceMode, getSavedDeviceMode,
  type BLEConnection, type BleReconnectStatus, type DeviceMode
} from "@/lib/engine/bledom";
import { addBleConnection, removeBleConnection } from "@/lib/engine/bleStore";
import { Power, Bluetooth, BluetoothSearching, Loader2, Eye, EyeOff, Settings, Bug, Plus, Palette, Sun, X } from "lucide-react";
import MicPanel from "@/components/MicPanel";
import DebugOverlay from "@/components/DebugOverlay";
import AuthButton from "@/components/AuthButton";
import { useSonosNowPlaying } from "@/hooks/useSonosNowPlaying";
import { useAuth } from "@/hooks/useAuth";
import { extractPalette } from "@/lib/ui/colorExtract";
import {
  setActiveDeviceName, saveCalibration,
  getCalibration, getPresets, getActivePreset, setActivePreset,
  savePresetCalibration, PRESET_NAMES, type PresetName,
} from "@/lib/engine/lightCalibration";
import { loadCalibrationFromCloud, installCloudSync, setCloudUserId, loadSettingsFromCloud, saveSettingsToCloud } from "@/lib/ui/calibrationCloud";
import { debugData } from "@/lib/ui/debugStore";

// Install cloud sync hook (only fires when userId is set)
installCloudSync();

const Index = () => {
  const navigate = useNavigate();
  const [connections, setConnections] = useState<BLEConnection[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentColor, setCurrentColor] = useState<[number, number, number]>([255, 80, 0]);
  
  const [isOn, setIsOn] = useState(true);
  const [showOverlay, setShowOverlay] = useState(true);
  const [showDebug, setShowDebug] = useState(() => localStorage.getItem("showDebug") !== "false");
  const [autoHide, setAutoHide] = useState(() => localStorage.getItem("autoHide") !== "false");
  const [bleReconnectStatus, setBleReconnectStatus] = useState<BleReconnectStatus | null>(null);
  const [activeCalibration, setActiveCalibration] = useState(getCalibration);
  const [activePreset, setActivePresetState] = useState<PresetName | null>(() => getActivePreset());
  const [showCalibration, setShowCalibration] = useState(() => new URLSearchParams(window.location.search).has('cal'));
  const tickMs = 125;

  const overlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastArtUrlRef = useRef<string | null>(null);
  const currentColorRef = useRef(currentColor);

  const [lastDevice] = useState(() => getLastDevice());
  const { nowPlaying, smoothedRtt, getPosition } = useSonosNowPlaying();
  const { user, loading: authLoading, signIn, signOut } = useAuth();

  const connected = connections.length > 0;

  // Sync cloud user id
  useEffect(() => {
    setCloudUserId(user?.id ?? null);
    if (user?.id) {
      loadSettingsFromCloud().then(() => {
        setActiveCalibration(getCalibration());
        setActivePresetState(getActivePreset());
      });
    }
  }, [user?.id]);

  useEffect(() => { currentColorRef.current = currentColor; }, [currentColor]);

  // Keep debugStore in sync
  useEffect(() => {
    debugData.bleConnected = connected;
    debugData.bleDeviceName = connections.map(c => c.device?.name).filter(Boolean).join(', ') || null;
  }, [connections, connected]);

  useEffect(() => {
    debugData.bleReconnectStatus = bleReconnectStatus;
  }, [bleReconnectStatus]);

  useEffect(() => {
    debugData.smoothedRtt = smoothedRtt;
    debugData.sonosVolume = nowPlaying?.volume ?? null;
    debugData.gainMode = nowPlaying?.volume != null ? 'vol' : 'manual';
  }, [smoothedRtt, nowPlaying?.volume]);

  useEffect(() => {
    debugData.dynamicDamping = activeCalibration.dynamicDamping;
  }, [activeCalibration]);

  // Extract dominant color from album art when track changes
  useEffect(() => {
    const artUrl = nowPlaying?.albumArtUrl;
    if (!artUrl || artUrl === lastArtUrlRef.current) return;
    lastArtUrlRef.current = artUrl;
    extractPalette(artUrl, 1).then((colors) => {
      if (colors.length > 0) {
        setCurrentColor(colors[0]);
      }
    });
  }, [nowPlaying?.albumArtUrl]);

  // Auto-reconnect to last known BLE device on mount
  useEffect(() => {
    if (connected) return;
    const last = getLastDevice();
    if (!last) return;

    const ac = new AbortController();
    setBusy(true);
    setBleReconnectStatus({ attempt: 0, maxAttempts: 100, phase: 'waiting', targetName: last.name || undefined });

    autoReconnect(ac.signal, (status) => {
      setBleReconnectStatus(status);
    }).then((conn) => {
      if (conn) {
        finishConnect(conn);
      } else {
        setBusy(false);
        setBleReconnectStatus(null);
      }
    }).catch(() => {
      setBusy(false);
      setBleReconnectStatus(null);
    });

    return () => ac.abort();
  }, []);

  // Live status callback from MicPanel
  const handleLiveStatus = useCallback((status: { brightness: number; color: [number, number, number]; bassLevel: number; midHiLevel: number; bleSentColor?: [number, number, number]; bleSentBright?: number; bleColorSource?: 'normal' | 'idle'; micRms?: number; isPlayingState?: boolean; isPunch?: boolean }) => {
    debugData.bassLevel = status.bassLevel;
    debugData.midHiLevel = status.midHiLevel;
    if (status.bleSentColor) {
      debugData.bleBaseColor = status.bleSentColor;
      debugData.bleSentColor = status.bleSentColor;
    }
    if (status.bleSentBright != null) debugData.bleSentBright = status.bleSentBright;
    debugData.bleColorSource = status.bleColorSource ?? 'normal';
    if (status.micRms != null) debugData.micRms = status.micRms;
    if (status.isPlayingState != null) debugData.isPlayingState = status.isPlayingState;

  }, []);

  // Auto-hide overlay after 3s
  const resetOverlayTimer = () => {
    setShowOverlay(true);
    if (!autoHide) return;
    if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current);
    overlayTimerRef.current = setTimeout(() => setShowOverlay(false), 3000);
  };

  const handleToggleDeviceMode = (conn: BLEConnection) => {
    const newMode: DeviceMode = conn.mode === 'rgb' ? 'brightness' : 'rgb';
    setDeviceMode(conn.device?.id, newMode);
    updateCharMode(conn.characteristic, newMode);
    setConnections(prev => prev.map(c =>
      c.device?.id === conn.device?.id ? { ...c, mode: newMode } : c
    ));
  };

  const handleDisconnectDevice = (conn: BLEConnection) => {
    try { conn.device?.gatt?.disconnect(); } catch {}
    removeActiveChar(conn.characteristic);
    removeBleConnection(conn);
    setConnections(prev => prev.filter(c => c.device?.id !== conn.device?.id));
  };

  const finishConnect = async (conn: BLEConnection) => {
    setConnections(prev => {
      if (prev.some(c => c.device?.id === conn.device?.id)) return prev;
      return [...prev, conn];
    });
    addBleConnection(conn);
    setBusy(false);
    addActiveChar(conn.characteristic, conn.mode);
    await sendPower(conn.characteristic, true);
    await sendHardwareBrightness(conn.characteristic);

    const deviceName = conn.device?.name;
    if (deviceName) {
      setActiveDeviceName(deviceName);
      loadCalibrationFromCloud(deviceName).then((data) => {
        if (data) {
          saveCalibration(data.calibration, deviceName);
          setActiveCalibration(data.calibration);
        }
      }).catch(() => {});
    }

    conn.device.addEventListener("gattserverdisconnected", () => {
      removeActiveChar(conn.characteristic);
      setConnections(prev => prev.filter(c => c.device?.id !== conn.device?.id));
      removeBleConnection(conn);
    });
  };

  const handleConnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await finishConnect(await connectBLEDOM());
    } catch (e: any) {
      setError(e.message || "Kunde inte ansluta");
      setBusy(false);
    }
  };

  const handleAddDevice = async () => {
    setBusy(true);
    setError(null);
    try {
      await finishConnect(await connectBLEDOM());
    } catch (e: any) {
      setError(e.message || "Kunde inte ansluta");
      setBusy(false);
    }
  };

  const handlePresetSwitch = useCallback((name: PresetName) => {
    const presets = getPresets();
    const cal = presets[name];
    setActivePresetState(name);
    setActivePreset(name);
    const firstDeviceName = connections[0]?.device?.name;
    saveCalibration(cal, firstDeviceName, { localOnly: true });
    setActiveCalibration(cal);
    if (user) saveSettingsToCloud();
  }, [connections, user]);

  const handlePresetSave = useCallback((name: PresetName, cal: import("@/lib/engine/lightCalibration").LightCalibration) => {
    savePresetCalibration(name, cal);
    setActivePresetState(name);
    setActivePreset(name);
    if (user) saveSettingsToCloud();
  }, [user]);

  const handlePowerToggle = async () => {
    if (!connected) return;
    const next = !isOn;
    setIsOn(next);
    await Promise.allSettled(
      connections.map(c => sendPower(c.characteristic, next).catch(() => {}))
    );
  };

  const [r, g, b] = currentColor;
  const accent = `rgb(${r},${g},${b})`;
  const firstChar = connections[0]?.characteristic;

  return (
    <div
      className="relative h-[100dvh] bg-background overflow-hidden"
      style={{ backgroundImage: `radial-gradient(ellipse at 50% 60%, rgba(${r},${g},${b},0.08) 0%, transparent 70%)` }}
      onPointerMove={connected ? resetOverlayTimer : undefined}
      onPointerDown={connected ? resetOverlayTimer : undefined}
    >
      <div className="absolute inset-0 transition-[bottom] duration-300" style={{ bottom: showCalibration ? '16rem' : (nowPlaying?.trackName && nowPlaying.playbackState !== "PLAYBACK_STATE_IDLE" ? '4.5rem' : 0) }}>
        <MicPanel char={firstChar} currentColor={currentColor} sonosVolume={nowPlaying?.volume} isPlaying={!!nowPlaying?.trackName && nowPlaying.playbackState === "PLAYBACK_STATE_PLAYING"} trackName={nowPlaying?.trackName ?? null} tickMs={tickMs} onLiveStatus={handleLiveStatus} />
      </div>

      {/* Connection overlay — busy auto-connecting */}
      {!connected && busy && (
        <div className="absolute inset-0 z-30 flex items-center justify-center animate-fade-in" style={{ background: 'hsl(var(--background) / 0.82)' }}>
          <div className="flex flex-col items-center gap-4 text-center px-8">
            <Loader2 className="w-8 h-8 animate-spin" style={{ color: accent }} />
            <p className="text-sm text-muted-foreground">
              Ansluter{lastDevice ? ` till ${lastDevice.name}` : '…'}
            </p>
          </div>
        </div>
      )}

      {/* Header */}
      {(connected || !busy) && (
        <div
          className={`absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] transition-opacity duration-500 backdrop-blur-lg border-b border-white/5 ${showOverlay ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          style={{ background: 'hsl(var(--background) / 0.3)' }}
        >
           <div className="flex items-center gap-1.5 min-w-0 overflow-x-auto">
             {connected ? (
               <>
                 {/* Per-device chips */}
                 {connections.map((c, i) => (
                   <div
                     key={c.device?.id || i}
                     className="flex items-center gap-0.5 rounded-full px-1.5 py-0.5 shrink-0"
                     style={{ background: 'hsl(var(--foreground) / 0.08)' }}
                   >
                     <Bluetooth className="w-2.5 h-2.5 shrink-0" style={{ color: isOn ? accent : 'hsl(var(--muted-foreground))' }} />
                     <span className="text-[10px] font-bold tracking-wide text-foreground/70 uppercase truncate max-w-[4rem]">
                       {c.device?.name || `BLE${i + 1}`}
                     </span>
                     <button
                       onClick={() => handleToggleDeviceMode(c)}
                       className="p-0.5 rounded-full active:scale-90 transition-transform"
                       title={c.mode === 'rgb' ? 'RGB → Brightness' : 'Brightness → RGB'}
                     >
                       {c.mode === 'rgb'
                         ? <Palette className="w-2.5 h-2.5 text-foreground/50" />
                         : <Sun className="w-2.5 h-2.5 text-foreground/50" />
                       }
                     </button>
                     <button
                       onClick={() => handleDisconnectDevice(c)}
                       className="p-0.5 rounded-full active:scale-90 transition-transform"
                       title="Koppla bort"
                     >
                       <X className="w-2.5 h-2.5 text-foreground/40 hover:text-foreground/80" />
                     </button>
                   </div>
                 ))}
                 {/* Add device */}
                 <button
                   onClick={handleAddDevice}
                   className="p-1 rounded-full active:scale-90 transition-transform shrink-0"
                   title="Lägg till enhet"
                   disabled={busy}
                 >
                   <Plus className="w-3 h-3 text-foreground/50 hover:text-foreground/80" />
                 </button>
                <div className="flex items-center gap-0.5 ml-1">
                  {PRESET_NAMES.map(name => (
                    <button
                      key={name}
                      onClick={() => handlePresetSwitch(name)}
                      className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold tracking-wide transition-all active:scale-90 ${
                        activePreset === name
                          ? 'text-background'
                          : 'text-foreground/50 hover:text-foreground/80'
                      }`}
                      style={activePreset === name ? { background: accent } : undefined}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">Ej ansluten</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <AuthButton user={user} loading={authLoading} onSignIn={signIn} onSignOut={signOut} accent={accent} />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                setShowDebug(prev => {
                  const next = !prev;
                  localStorage.setItem("showDebug", String(next));
                  return next;
                });
              }}
              className="rounded-full w-7 h-7 active:scale-90 transition-transform"
              style={showDebug ? { color: accent } : undefined}
            >
              <Bug className="w-3.5 h-3.5" />
            </Button>
            {connected && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    const next = !autoHide;
                    setAutoHide(next);
                    localStorage.setItem("autoHide", String(next));
                    if (!next) {
                      if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current);
                      setShowOverlay(true);
                    }
                  }}
                  className="rounded-full w-7 h-7 active:scale-90 transition-transform"
                  style={autoHide ? { color: accent } : undefined}
                >
                  {autoHide ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </Button>
                <Button variant="ghost" size="icon" onClick={() => setShowCalibration(true)} className="rounded-full w-7 h-7 active:scale-90 transition-transform" style={{ color: accent }}>
                  <Settings className="w-3.5 h-3.5" />
                </Button>
                <Button variant="ghost" size="icon" onClick={handlePowerToggle} className="rounded-full w-7 h-7 active:scale-90 transition-transform" style={isOn ? { color: accent } : undefined}>
                  <Power className="w-4 h-4" />
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Now playing */}
      {nowPlaying?.trackName && nowPlaying.playbackState !== "PLAYBACK_STATE_IDLE" && (
        <div
          className={`absolute bottom-0 left-0 right-0 z-20 pb-[env(safe-area-inset-bottom)] transition-opacity duration-500 backdrop-blur-lg border-t border-white/5 ${showOverlay ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          style={{ background: 'hsl(var(--background) / 0.3)' }}
        >
          <NowPlayingBar nowPlaying={nowPlaying} accentColor={currentColor} getPosition={getPosition} />
        </div>
      )}

      {/* Calibration overlay */}
      {showCalibration && (
        <CalibrationOverlay
          onClose={() => setShowCalibration(false)}
          onCalibrationChange={(cal) => setActiveCalibration(cal)}
          activePreset={activePreset}
          onPresetSave={handlePresetSave}
        />
      )}

      {showDebug && <DebugOverlay />}
    </div>
  );
};

export default Index;
