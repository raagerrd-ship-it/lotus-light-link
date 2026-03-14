import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { getBleWriteStats, getPipelineTimings, getBleMinInterval } from "@/lib/bledom";
import NowPlayingBar from "@/components/NowPlayingBar";
import {
  connectBLEDOM, getLastDevice, autoReconnect,
  sendColor, sendBrightness, sendPower, setActiveChar, clearActiveChar, getLastTickToWriteMs,
  setBleMinInterval,
  type BLEConnection, type BleReconnectStatus
} from "@/lib/bledom";
import { setBleConnection } from "@/lib/bleStore";
import { Power, Bluetooth, Loader2, Eye, EyeOff, Settings, Monitor } from "lucide-react";
import MicPanel from "@/components/MicPanel";
import MonitorView from "@/components/MonitorView";
import DebugOverlay from "@/components/DebugOverlay";
import { useSonosNowPlaying } from "@/hooks/useSonosNowPlaying";
import { useSongEnergyCurve } from "@/hooks/useSongEnergyCurve";
import { extractPalette } from "@/lib/colorExtract";
import {
  loadCalibrationFromCloud, setActiveDeviceName, saveCalibration,
  applyColorCalibration, getCalibration
} from "@/lib/lightCalibration";
import { useLiveSessionWriter, type MasterDebugState } from "@/hooks/useLiveSession";
import { getCurrentSection } from "@/lib/sectionLighting";
import { getAutoSyncState } from "@/lib/autoSync";

const Index = () => {
  const navigate = useNavigate();
  const [isMaster, setIsMaster] = useState(() => {
    const forcedRole = new URLSearchParams(window.location.search).get("role");
    if (forcedRole === "master") return true;
    if (forcedRole === "monitor") return false;

    // Safer default: monitor unless explicitly set to master on this device.
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
  const [autoHide, setAutoHide] = useState(() => localStorage.getItem("autoHide") !== "false");
  const [bleReconnectStatus, setBleReconnectStatus] = useState<BleReconnectStatus | null>(null);
  const [tickToWriteMs, setTickToWriteMs] = useState(0);
  const [activeCalibration, setActiveCalibration] = useState(getCalibration);

  const overlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastArtUrlRef = useRef<string | null>(null);
  const currentColorRef = useRef(currentColor);

  const [lastDevice] = useState(() => getLastDevice());
  const { nowPlaying, smoothedRtt, getPosition } = useSonosNowPlaying();
  const { update: updateLiveSession } = useLiveSessionWriter();

  // Energy curve: lookup saved curve for current track
  const trackKey = useMemo(() => {
    if (!nowPlaying?.trackName || !nowPlaying?.artistName) return null;
    return { trackName: nowPlaying.trackName, artistName: nowPlaying.artistName };
  }, [nowPlaying?.trackName, nowPlaying?.artistName]);
  const { curve: energyCurve, recordedVolume, savedAgcState, bpm, beatGrid, sections, drops, loading: curveLoading, saveCurve } = useSongEnergyCurve(trackKey);
  const hasCurve = Array.isArray(energyCurve) && energyCurve.length > 10;
  const activeLookAheadMs = hasCurve ? activeCalibration.chainLatencyMs : activeCalibration.bleLatencyMs;

  useEffect(() => { currentColorRef.current = currentColor; }, [currentColor]);

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
    // Prevent idle/stale master tabs from overwriting active session state.
    if (!connection && !nowPlaying?.trackName) return;

    const id = setInterval(() => {
      setTickToWriteMs(getLastTickToWriteMs());
      // Push debug state to live session
      const bleStats = getBleWriteStats();
      const pipeline = getPipelineTimings();
      const isPlaying = nowPlaying?.playbackState === "PLAYBACK_STATE_PLAYING";
      const curveStatus: MasterDebugState['curveStatus'] =
        curveLoading ? 'loading'
        : !nowPlaying?.trackName ? 'none'
        : energyCurve ? 'saved'
        : isPlaying ? 'recording'
        : 'none';
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
          curveStatus,
          curveTrackName: nowPlaying?.trackName ?? null,
          curveSamples: energyCurve?.length,
          sonosConnected: !!nowPlaying?.trackName,
          sonosRtt: smoothedRtt,
        },
      });
    }, 500);
    return () => clearInterval(id);
  }, [isMaster, connection, nowPlaying?.trackName, nowPlaying?.playbackState, energyCurve, curveLoading, smoothedRtt]);

  // Push now-playing info to live session when master
  useEffect(() => {
    if (!isMaster) return;
    // Prevent idle/stale master tabs from overwriting active session state.
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
  }, [isMaster, connection, nowPlaying?.trackName, nowPlaying?.artistName, nowPlaying?.albumArtUrl, nowPlaying?.playbackState, nowPlaying?.durationMs, bpm, connection?.device?.name]);

  // Live status callback from MicPanel
  const handleLiveStatus = useCallback((status: { brightness: number; color: [number, number, number]; sectionType?: string; isWhiteKick: boolean }) => {
    if (!isMaster) return;
    const [r, g, b] = status.isWhiteKick ? [255, 255, 255] : status.color;
    // Get current section
    const posFn = getPosition;
    const pos = posFn?.();
    let sectionType: string | undefined;
    if (sections && pos) {
      const elapsed = performance.now() - pos.receivedAt;
      const sec = getCurrentSection(sections, (pos.positionMs + elapsed + activeLookAheadMs) / 1000);
      sectionType = sec?.type;
    }
    updateLiveSession({
      color_r: r,
      color_g: g,
      color_b: b,
      brightness: status.brightness,
      section_type: sectionType ?? null,
    });
  }, [isMaster, updateLiveSession, getPosition, sections, activeLookAheadMs]);

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

  // ── Master mode (existing UI) ──

  const finishConnect = async (conn: BLEConnection) => {
    setConnection(conn);
    setBleConnection(conn);
    setBusy(false);
    setActiveChar(conn.characteristic);
    await sendPower(conn.characteristic, true);
    await sendBrightness(conn.characteristic, 100);

    const calibrated = applyColorCalibration(...currentColorRef.current);
    await sendColor(conn.characteristic, ...calibrated).catch(() => {});

    const deviceName = conn.device?.name;
    if (deviceName) {
      setActiveDeviceName(deviceName);
      loadCalibrationFromCloud(deviceName).then((data) => {
        if (data) {
          saveCalibration(data.calibration, deviceName);
          setActiveCalibration(data.calibration);
          if (data.bleMinIntervalMs != null) {
            setBleMinInterval(data.bleMinIntervalMs);
          }
        }
      }).catch(() => {});
    }

    conn.device.addEventListener("gattserverdisconnected", () => {
      clearActiveChar(); // Stop all pending BLE writes immediately
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
        <MicPanel char={char} currentColor={currentColor} sonosVolume={nowPlaying?.volume} sonosRtt={nowPlaying?.smoothedRtt} isPlaying={!nowPlaying || nowPlaying.playbackState !== "PLAYBACK_STATE_PAUSED"} durationMs={nowPlaying?.durationMs} getPosition={getPosition} energyCurve={energyCurve} recordedVolume={recordedVolume} savedAgcState={savedAgcState} bpm={bpm} beatGrid={beatGrid} sections={sections} drops={drops} trackName={nowPlaying?.trackName ?? null} artistName={nowPlaying?.artistName ?? null} onSaveEnergyCurve={saveCurve} onLiveStatus={handleLiveStatus} />
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
          style={{ background: 'hsl(var(--background) / 0.5)' }}
        >
          <div className="flex items-center gap-2">
            {connection ? (
              <>
                <div className="w-2.5 h-2.5 rounded-full animate-pulse" style={{ backgroundColor: isOn ? accent : "hsl(var(--muted-foreground))" }} />
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
              size="sm"
              onClick={toggleRole}
              className="rounded-full h-7 px-2.5 text-[10px] font-bold tracking-wide active:scale-90 transition-all duration-200 text-muted-foreground"
            >
              <Monitor className="w-3.5 h-3.5 mr-1" />
              Monitor
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleConnect(!!connection)}
              disabled={busy}
              className="rounded-full h-7 px-2.5 text-[10px] font-bold tracking-wide active:scale-90 transition-all duration-200"
              style={{ color: accent }}
            >
              <Bluetooth className="w-3.5 h-3.5 mr-1" />
              {connection ? 'Byt' : lastDevice ? lastDevice.name : 'Anslut'}
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
                <Button variant="ghost" size="icon" onClick={() => navigate('/calibrate')} className="rounded-full w-7 h-7 active:scale-90 transition-transform" style={{ color: accent }}>
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
          style={{ background: 'hsl(var(--background) / 0.5)' }}
        >
          <NowPlayingBar nowPlaying={nowPlaying} bpm={bpm} accentColor={currentColor} getPosition={getPosition} sections={sections} />
        </div>
      )}

      {/* Debug overlay */}
      <DebugOverlay
        smoothedRtt={smoothedRtt}
        autoDriftMs={getAutoSyncState().driftMs}
        palette={palette}
        paletteIndex={paletteIndexRef.current}
        sonosVolume={nowPlaying?.volume}
        bleConnected={!!connection}
        bleDeviceName={connection?.device?.name}
        bleReconnectStatus={bleReconnectStatus}
        tickToWriteMs={tickToWriteMs}
        bleMinIntervalMs={getBleMinInterval()}
        bleLatencyMs={activeCalibration.bleLatencyMs}
        chainLatencyMs={activeCalibration.chainLatencyMs}
        activeLookAheadMs={activeLookAheadMs}
        syncMode={hasCurve ? 'curve' : 'mic'}
        curveStatus={
          curveLoading ? 'loading'
          : !nowPlaying?.trackName ? 'none'
          : energyCurve ? 'saved'
          : 'recording'
        }
        curveTrackName={nowPlaying?.trackName ?? null}
        curveSamples={energyCurve?.length}
        deviceRole="master"
      />
    </div>
  );
};

export default Index;
