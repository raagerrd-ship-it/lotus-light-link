import { useState, useCallback, useEffect, useRef } from "react";
import { DEFAULT_TICK_MS } from "@/lib/engine/lightEngine";
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
import { Power, Bluetooth, BluetoothSearching, Loader2, Eye, EyeOff, Settings, Bug, Plus, Palette, Sun, X, Plug, Pipette, BarChart3, Play } from "lucide-react";
import MicPanel from "@/components/MicPanel";
import DebugOverlay from "@/components/DebugOverlay";
import AuthButton from "@/components/AuthButton";
import { useSonosNowPlaying } from "@/hooks/useSonosNowPlaying";
import { useAuth } from "@/hooks/useAuth";
import { extractPalette, getCachedPalette, prefetchPalette } from "@/lib/ui/colorExtract";
import { getDimmingGamma, setDimmingGamma } from "@/lib/engine/bledom";
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
  const [currentPalette, setCurrentPalette] = useState<[number, number, number][]>([]);
  
  const [isOn, setIsOn] = useState(true);
  const [activated, setActivated] = useState(false);
  const [showOverlay, setShowOverlay] = useState(true);
  const [showDebug, setShowDebug] = useState(() => localStorage.getItem("showDebug") !== "false");
  const [chartEnabled, setChartEnabled] = useState(() => localStorage.getItem("chartEnabled") !== "false");
  const [autoHide, setAutoHide] = useState(() => localStorage.getItem("autoHide") !== "false");
  const [bleReconnectStatus, setBleReconnectStatus] = useState<BleReconnectStatus | null>(null);
  const [activeCalibration, setActiveCalibration] = useState(getCalibration);
  const [activePreset, setActivePresetState] = useState<PresetName | null>(() => getActivePreset());
  const [showCalibration, setShowCalibration] = useState(() => new URLSearchParams(window.location.search).has('cal'));
  const [colorSource, setColorSource] = useState<'proxy' | 'manual'>(() => (localStorage.getItem('colorSource') as 'proxy' | 'manual') || 'proxy');
  const [manualColor, setManualColor] = useState<[number, number, number]>(() => {
    try { return JSON.parse(localStorage.getItem('manualColor') || '[255,80,0]'); } catch { return [255, 80, 0]; }
  });
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [tickMs, setTickMs] = useState(() => {
    const saved = localStorage.getItem('tickMs');
    if (saved) return Math.max(20, Math.min(125, Number(saved)));
    return Math.max(20, Math.min(125, DEFAULT_TICK_MS));
  });
  const [dimmingGamma, setDimmingGammaState] = useState(() => getDimmingGamma());

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

  // Extract dominant colors from album art when track changes (proxy mode only)
  useEffect(() => {
    if (colorSource !== 'proxy') return;
    const artUrl = nowPlaying?.albumArtUrl;
    if (!artUrl || artUrl === lastArtUrlRef.current) return;
    lastArtUrlRef.current = artUrl;

    // Try cache first (from prefetch), otherwise extract
    const cached = getCachedPalette(artUrl);
    if (cached && cached.length > 0) {
      console.log('[palette] cache hit — instant color');
      setCurrentColor(cached[0]);
      setCurrentPalette(cached.slice(0, 4));
      return;
    }
    extractPalette(artUrl, 4).then((colors) => {
      if (colors.length > 0) {
        setCurrentColor(colors[0]);
        setCurrentPalette(colors.slice(0, 4));
      }
    });
  }, [nowPlaying?.albumArtUrl, colorSource]);

  // Prefetch next track's palette in the background
  useEffect(() => {
    if (colorSource !== 'proxy') return;
    const nextArt = nowPlaying?.nextAlbumArtUrl;
    if (nextArt) {
      prefetchPalette(nextArt, 4);
    }
  }, [nowPlaying?.nextAlbumArtUrl, colorSource]);

  // Sync palette to debug store
  useEffect(() => { debugData.palette = currentPalette; }, [currentPalette]);

  // Apply manual color when in manual mode
  useEffect(() => {
    if (colorSource === 'manual') {
      setCurrentColor(manualColor);
    }
  }, [colorSource, manualColor]);

  // Auto-reconnect to last known BLE device — only when activated
  const reconnectAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!activated || connected) return;
    const last = getLastDevice();
    if (!last) return;

    const ac = new AbortController();
    reconnectAbortRef.current = ac;
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
  }, [activated]);

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

  const disconnectListenersRef = useRef(new Map<string, () => void>());

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

    // Remove previous disconnect listener for this device (prevents accumulation)
    const deviceId = conn.device?.id;
    if (deviceId && disconnectListenersRef.current.has(deviceId)) {
      disconnectListenersRef.current.get(deviceId)!();
    }

    const onDisconnect = async () => {
      console.log('[BLE] device disconnected, attempting reconnect...');
      removeActiveChar(conn.characteristic);
      setConnections(prev => prev.filter(c => c.device?.id !== conn.device?.id));
      removeBleConnection(conn);
      // Clean up this listener ref
      if (deviceId) disconnectListenersRef.current.delete(deviceId);

      setBleReconnectStatus({ attempt: 1, maxAttempts: 100, phase: 'waiting', targetName: conn.device?.name || conn.device?.id });
      try {
        const newConn = await autoReconnect(undefined, setBleReconnectStatus);
        setBleReconnectStatus(null);
        if (newConn) {
          console.log('[BLE] reconnected successfully');
          await finishConnect(newConn);
        }
      } catch (e: any) {
        console.warn('[BLE] reconnect failed:', e?.message);
        setBleReconnectStatus(null);
      }
    };

    conn.device.addEventListener("gattserverdisconnected", onDisconnect);
    if (deviceId) {
      disconnectListenersRef.current.set(deviceId, () => {
        conn.device.removeEventListener("gattserverdisconnected", onDisconnect);
      });
    }
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
    if (!activated) return;
    if (reconnectAbortRef.current) reconnectAbortRef.current.abort();
    setBleReconnectStatus(null);
    // Remove all disconnect listeners before disconnecting
    for (const cleanup of disconnectListenersRef.current.values()) cleanup();
    disconnectListenersRef.current.clear();
    for (const c of connections) {
      try { c.device?.gatt?.disconnect(); } catch {}
      removeActiveChar(c.characteristic);
      removeBleConnection(c);
    }
    clearActiveChar();
    setConnections([]);
    setBusy(false);
    setIsOn(true);
    setActivated(false);
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
      {/* Start screen — before activation */}
      {!activated && !busy && (
        <div className="absolute inset-0 z-30 flex items-center justify-center">
          <button
            onClick={() => setActivated(true)}
            className="flex flex-col items-center gap-3 p-8 rounded-2xl active:scale-95 transition-transform"
          >
            <div className="w-16 h-16 rounded-full flex items-center justify-center border-2 border-foreground/20" style={{ background: `rgba(${r},${g},${b},0.15)` }}>
              <Play className="w-7 h-7 ml-0.5" style={{ color: accent }} />
            </div>
            <span className="text-sm font-medium text-foreground/70">Starta</span>
          </button>
        </div>
      )}

      {activated && (
        <div className="absolute inset-0 transition-[top,bottom] duration-300" style={{ top: showOverlay && (connected || !busy) ? '2.75rem' : 0, bottom: showCalibration ? '16rem' : (showOverlay && nowPlaying?.trackName && nowPlaying.playbackState !== "PLAYBACK_STATE_IDLE" ? '4.5rem' : 0) }}>
          <MicPanel char={firstChar} currentColor={currentColor} palette={currentPalette} sonosVolume={nowPlaying?.volume} isPlaying={!!nowPlaying?.trackName && nowPlaying.playbackState === "PLAYBACK_STATE_PLAYING"} trackName={nowPlaying?.trackName ?? null} tickMs={tickMs} chartEnabled={chartEnabled} onLiveStatus={handleLiveStatus} />
        </div>
      )}

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
      {activated && (connected || !busy) && (
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
            <div className="relative">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  if (colorSource === 'proxy') {
                    setColorSource('manual');
                    localStorage.setItem('colorSource', 'manual');
                    setShowColorPicker(true);
                  } else {
                    setColorSource('proxy');
                    localStorage.setItem('colorSource', 'proxy');
                    setShowColorPicker(false);
                    lastArtUrlRef.current = null; // force re-extract
                  }
                  if (user) saveSettingsToCloud();
                }}
                className="rounded-full w-7 h-7 active:scale-90 transition-transform"
                title={colorSource === 'proxy' ? 'Byt till manuell färg' : 'Byt till proxy-färg'}
                style={colorSource === 'manual' ? { color: accent } : undefined}
              >
                {colorSource === 'proxy' ? <Plug className="w-3.5 h-3.5" /> : <Pipette className="w-3.5 h-3.5" />}
              </Button>
              {showColorPicker && colorSource === 'manual' && (
                <div className="absolute right-0 top-full mt-1 p-2 rounded-lg backdrop-blur-xl border border-white/10 z-50" style={{ background: 'hsl(var(--background) / 0.85)' }}>
                  <input
                    type="color"
                    value={`#${manualColor.map(c => c.toString(16).padStart(2, '0')).join('')}`}
                    onChange={(e) => {
                      const hex = e.target.value;
                      const rgb: [number, number, number] = [
                        parseInt(hex.slice(1, 3), 16),
                        parseInt(hex.slice(3, 5), 16),
                        parseInt(hex.slice(5, 7), 16),
                      ];
                      setManualColor(rgb);
                      localStorage.setItem('manualColor', JSON.stringify(rgb));
                      if (user) saveSettingsToCloud();
                    }}
                    className="w-10 h-10 rounded-lg cursor-pointer border-0 p-0 bg-transparent"
                  />
                </div>
              )}
            </div>
            <AuthButton user={user} loading={authLoading} onSignIn={signIn} onSignOut={signOut} accent={accent} />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                setChartEnabled(prev => {
                  const next = !prev;
                  localStorage.setItem("chartEnabled", String(next));
                  return next;
                });
              }}
              className="rounded-full w-7 h-7 active:scale-90 transition-transform"
              style={chartEnabled ? { color: accent } : undefined}
              title={chartEnabled ? 'Stäng av diagram' : 'Slå på diagram'}
            >
              <BarChart3 className="w-3.5 h-3.5" />
            </Button>
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
              </>
            )}
            <Button variant="ghost" size="icon" onClick={handlePowerToggle} className="rounded-full w-7 h-7 active:scale-90 transition-transform" style={{ color: 'hsl(var(--destructive))' }} title="Stäng av">
              <Power className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Now playing */}
      {nowPlaying?.trackName && nowPlaying.playbackState !== "PLAYBACK_STATE_IDLE" && (
        <div
          className={`absolute bottom-0 left-0 right-0 z-20 pb-[env(safe-area-inset-bottom)] transition-opacity duration-500 backdrop-blur-lg border-t border-white/5 ${showOverlay ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          style={{ background: 'hsl(var(--background) / 0.3)' }}
        >
          <NowPlayingBar nowPlaying={nowPlaying} accentColor={currentColor} getPosition={getPosition} nextPrefetched={!!nowPlaying.nextAlbumArtUrl && !!getCachedPalette(nowPlaying.nextAlbumArtUrl)} />
        </div>
      )}

      {/* Calibration overlay */}
      {showCalibration && (
        <CalibrationOverlay
          onClose={() => setShowCalibration(false)}
          onCalibrationChange={(cal) => setActiveCalibration(cal)}
          activePreset={activePreset}
          onPresetSave={handlePresetSave}
          tickMs={tickMs}
          onTickMsChange={(ms) => { setTickMs(ms); localStorage.setItem('tickMs', String(ms)); }}
          dimmingGamma={dimmingGamma}
          onDimmingGammaChange={(v) => { setDimmingGammaState(v); setDimmingGamma(v); }}
        />
      )}

      {activated && showDebug && <DebugOverlay />}
    </div>
  );
};

export default Index;
