import { useState, useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import CalibrationOverlay from "@/components/CalibrationOverlay";
import { Button } from "@/components/ui/button";
import { getBleWriteStats, getPipelineTimings } from "@/lib/bledom";
import NowPlayingBar from "@/components/NowPlayingBar";
import {
  connectBLEDOM, getLastDevice, autoReconnect,
  sendToBLE, sendPower, setActiveChar, clearActiveChar, getLastTickToWriteMs,
  type BLEConnection, type BleReconnectStatus
} from "@/lib/bledom";
import { setBleConnection } from "@/lib/bleStore";
import { Power, Bluetooth, Loader2, Eye, EyeOff, Settings, Monitor, Bug } from "lucide-react";
import MicPanel from "@/components/MicPanel";
import MonitorView from "@/components/MonitorView";
import DebugOverlay from "@/components/DebugOverlay";
import { useSonosNowPlaying } from "@/hooks/useSonosNowPlaying";
import { extractPalette } from "@/lib/colorExtract";
import {
  loadCalibrationFromCloud, setActiveDeviceName, saveCalibration,
  applyColorCalibration, getCalibration
} from "@/lib/lightCalibration";
import { useLiveSessionWriter, type MasterDebugState } from "@/hooks/useLiveSession";
import { useBpm } from "@/hooks/useBpm";

const Index = () => {
  const navigate = useNavigate();
  const [isMaster, setIsMaster] = useState(() => {
    const forcedRole = new URLSearchParams(window.location.search).get("role");
    if (forcedRole === "master") return true;
    if (forcedRole === "monitor") return false;
    const storedRole = localStorage.getItem("deviceRole");
    if (storedRole === "master") return true;
    if (storedRole === "monitor") return false;
    return false;
  });
  const [connection, setConnection] = useState<BLEConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentColor, setCurrentColor] = useState<[number, number, number]>([255, 80, 0]);
  const [palette, setPalette] = useState<[number, number, number][]>([]);
  const paletteIndexRef = useRef(0);
  const [isOn, setIsOn] = useState(true);
  const [showOverlay, setShowOverlay] = useState(true);
  const [showDebug, setShowDebug] = useState(() => localStorage.getItem("showDebug") !== "false");
  const [autoHide, setAutoHide] = useState(() => localStorage.getItem("autoHide") !== "false");
  const [bleReconnectStatus, setBleReconnectStatus] = useState<BleReconnectStatus | null>(null);
  const [tickToWriteMs, setTickToWriteMs] = useState(0);
  const [activeCalibration, setActiveCalibration] = useState(getCalibration);
  const [showCalibration, setShowCalibration] = useState(() => new URLSearchParams(window.location.search).has('cal'));

  const overlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastArtUrlRef = useRef<string | null>(null);
  const currentColorRef = useRef(currentColor);

  const [lastDevice] = useState(() => getLastDevice());
  const { nowPlaying, smoothedRtt, getPosition } = useSonosNowPlaying();
  const { update: updateLiveSession } = useLiveSessionWriter();
  const trackTraits = useBpm(nowPlaying?.trackName ?? null, nowPlaying?.artistName ?? null);
  const bpm = trackTraits.bpm;

  useEffect(() => { currentColorRef.current = currentColor; }, [currentColor]);

  const handleColorChange = useCallback((color: [number, number, number]) => {
    setCurrentColor(color);
  }, []);

  // Extract palette from album art when track changes
  useEffect(() => {
    const artUrl = nowPlaying?.albumArtUrl;
    if (!artUrl || artUrl === lastArtUrlRef.current) return;
    lastArtUrlRef.current = artUrl;
    extractPalette(artUrl, 5).then((colors) => {
      if (colors.length > 0) {
        setCurrentColor(colors[0]);
        setPalette(colors);
        paletteIndexRef.current = 0;
      }
    });
  }, [nowPlaying?.albumArtUrl]);

  // Auto-reconnect to last known BLE device on mount
  useEffect(() => {
    if (!isMaster) return;
    if (connection) return;
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
  }, [isMaster]);

  // Poll e2e latency metric
  useEffect(() => {
    if (!isMaster) return;
    if (!connection && !nowPlaying?.trackName) return;

    const id = setInterval(() => {
      setTickToWriteMs(getLastTickToWriteMs());
      const bleStats = getBleWriteStats();
      const pipeline = getPipelineTimings();
      const cal = activeCalibration;
      updateLiveSession({
        debug_state: {
          bleConnected: !!connection,
          bleDeviceName: connection?.device?.name ?? null,
          bleWritesPerSec: bleStats.writesPerSec,
          bleDropsPerSec: bleStats.droppedPerSec,
          bleLastWriteMs: bleStats.lastWriteMs,
          e2eMs: getLastTickToWriteMs(),
          rmsMs: pipeline.rmsMs,
          smoothMs: pipeline.smoothMs,
          bleCallMs: pipeline.bleCallMs,
          totalTickMs: pipeline.totalTickMs,
          sonosConnected: !!nowPlaying?.trackName,
          sonosRtt: smoothedRtt,
          syncMode: 'mic',
          bleMinIntervalMs: getBleMinInterval(),
          maxBrightness: cal.maxBrightness,
          dynamicDamping: cal.dynamicDamping,
          attackAlpha: cal.attackAlpha,
          releaseAlpha: cal.releaseAlpha,
          sonosVolume: nowPlaying?.volume ?? null,
        },
      });
    }, 500);
    return () => clearInterval(id);
  }, [isMaster, connection, nowPlaying?.trackName, nowPlaying?.playbackState, nowPlaying?.volume, smoothedRtt, activeCalibration]);

  // Push now-playing info to live session when master
  useEffect(() => {
    if (!isMaster) return;
    if (!connection && !nowPlaying?.trackName) return;

    const posFn = getPosition;
    const pos = posFn?.();
    updateLiveSession({
      track_name: nowPlaying?.trackName ?? null,
      artist_name: nowPlaying?.artistName ?? null,
      album_art_url: nowPlaying?.albumArtUrl ?? null,
      bpm: bpm ?? null,
      is_playing: nowPlaying?.playbackState === "PLAYBACK_STATE_PLAYING",
      position_ms: pos?.positionMs ?? 0,
      duration_ms: nowPlaying?.durationMs ?? 0,
      device_name: connection?.device?.name ?? null,
    });
  }, [isMaster, connection, nowPlaying?.trackName, nowPlaying?.artistName, nowPlaying?.albumArtUrl, nowPlaying?.playbackState, nowPlaying?.durationMs, connection?.device?.name]);

  // Live status callback from MicPanel
  const [dropActive, setDropActive] = useState(false);
  const [bandLevels, setBandLevels] = useState<{ bass: number; midHi: number }>({ bass: 0, midHi: 0 });

  const handleLiveStatus = useCallback((status: { brightness: number; color: [number, number, number]; isWhiteKick: boolean; isDrop: boolean; bassLevel: number; midHiLevel: number }) => {
    if (!isMaster) return;
    setDropActive(status.isDrop);
    setBandLevels({ bass: status.bassLevel, midHi: status.midHiLevel });
    const [r, g, b] = status.isWhiteKick ? [255, 255, 255] : status.color;
    updateLiveSession({
      color_r: r,
      color_g: g,
      color_b: b,
      brightness: status.brightness,
      section_type: null,
    });
  }, [isMaster, updateLiveSession]);

  // Toggle role
  const toggleRole = useCallback(() => {
    setIsMaster(prev => {
      const next = !prev;
      localStorage.setItem("deviceRole", next ? "master" : "monitor");
      return next;
    });
  }, []);

  const activateMaster = useCallback(() => {
    localStorage.setItem("deviceRole", "master");
    setIsMaster(true);
  }, []);

  // If monitor mode, render MonitorView
  if (!isMaster) {
    return (
      <div className="relative h-[100dvh]">
        <MonitorView />
        <div className="pointer-events-none absolute inset-x-0 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-[200] px-4 flex justify-center">
          <button
            onClick={activateMaster}
            className="pointer-events-auto w-full max-w-sm h-11 rounded-full text-sm font-bold tracking-wide uppercase bg-secondary text-foreground border border-border shadow-lg active:scale-95 transition-transform"
          >
            Aktivera Master på denna enhet
          </button>
        </div>
      </div>
    );
  }

  // Auto-hide overlay after 3s
  const resetOverlayTimer = () => {
    setShowOverlay(true);
    if (!autoHide) return;
    if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current);
    overlayTimerRef.current = setTimeout(() => setShowOverlay(false), 3000);
  };

  const finishConnect = async (conn: BLEConnection) => {
    setConnection(conn);
    setBleConnection(conn);
    setBusy(false);
    setActiveChar(conn.characteristic);
    await sendPower(conn.characteristic, true);
    const calibrated = applyColorCalibration(...currentColorRef.current);
    await sendToBLE(conn.characteristic, ...calibrated, 100);

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
      clearActiveChar();
      setConnection(null);
      setBleConnection(null);
      setBleReconnectStatus({ attempt: 0, maxAttempts: 100, phase: 'waiting', targetName: conn.device?.name || undefined });
    });
  };

  const handleConnect = async (scanAll = false) => {
    setBusy(true);
    setError(null);
    try {
      await finishConnect(await connectBLEDOM(scanAll));
    } catch (e: any) {
      setError(e.message || "Kunde inte ansluta");
      setBusy(false);
    }
  };

  const handlePowerToggle = async () => {
    if (!connection) return;
    const next = !isOn;
    setIsOn(next);
    await sendPower(connection.characteristic, next).catch(() => {});
  };

  const [r, g, b] = currentColor;
  const accent = `rgb(${r},${g},${b})`;
  const char = connection?.characteristic;

  return (
    <div
      className="relative h-[100dvh] bg-background overflow-hidden"
      style={{ backgroundImage: `radial-gradient(ellipse at 50% 60%, rgba(${r},${g},${b},0.08) 0%, transparent 70%)` }}
      onPointerMove={connection ? resetOverlayTimer : undefined}
      onPointerDown={connection ? resetOverlayTimer : undefined}
    >
      <div className="absolute inset-0">
        <MicPanel char={char} currentColor={currentColor} palette={palette} sonosVolume={nowPlaying?.volume} isPlaying={!nowPlaying || nowPlaying.playbackState !== "PLAYBACK_STATE_PAUSED"} bpm={bpm} energy={trackTraits.energy} danceability={trackTraits.danceability} happiness={trackTraits.happiness} loudness={trackTraits.loudness} onLiveStatus={handleLiveStatus} onColorChange={handleColorChange} />
      </div>

      {/* Connection overlay — busy auto-connecting */}
      {!connection && busy && (
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
      {(connection || !busy) && (
        <div
          className={`absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] transition-opacity duration-500 backdrop-blur-lg border-b border-white/5 ${showOverlay ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          style={{ background: 'hsl(var(--background) / 0.3)' }}
        >
          <div className="flex items-center gap-2">
            {connection ? (
              <>
                <button
                  onClick={() => handleConnect(true)}
                  className="p-0.5 rounded-full active:scale-90 transition-transform"
                  title="Byt enhet"
                >
                  <Bluetooth className="w-3.5 h-3.5" style={{ color: isOn ? accent : "hsl(var(--muted-foreground))" }} />
                </button>
                <span className="text-xs font-bold tracking-widest text-foreground/70 uppercase">
                  {connection.device.name || "BLEDOM01"}
                </span>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">Ej ansluten</span>
            )}
          </div>
          <div className="flex items-center gap-1">
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
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleRole}
              className="rounded-full h-7 px-2.5 text-[10px] font-bold tracking-wide active:scale-90 transition-all duration-200 text-muted-foreground"
            >
              <Monitor className="w-3.5 h-3.5 mr-1" />
              Monitor
            </Button>
            {connection && (
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

      {/* Debug overlay */}
      {/* Calibration overlay */}
      {showCalibration && (
        <CalibrationOverlay
          onClose={() => setShowCalibration(false)}
          onCalibrationChange={(cal) => setActiveCalibration(cal)}
        />
      )}

      {showDebug && <DebugOverlay
        smoothedRtt={smoothedRtt}
        palette={palette}
        paletteIndex={paletteIndexRef.current}
        sonosVolume={nowPlaying?.volume}
        liveBpm={bpm}
        maxBrightness={activeCalibration.maxBrightness}
        dynamicDamping={activeCalibration.dynamicDamping}
        gainMode={nowPlaying?.volume != null ? 'vol' : 'manual'}
        bleConnected={!!connection}
        bleDeviceName={connection?.device?.name}
        bleReconnectStatus={bleReconnectStatus}
        bleMinIntervalMs={getBleMinInterval()}
        deviceRole="master"
        dropActive={dropActive}
        energy={trackTraits.energy}
        danceability={trackTraits.danceability}
        happiness={trackTraits.happiness}
        loudness={trackTraits.loudness}
        bassLevel={bandLevels.bass}
        midHiLevel={bandLevels.midHi}
      />}
    </div>
  );
};

export default Index;
