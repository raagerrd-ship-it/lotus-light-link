import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import NowPlayingBar from "@/components/NowPlayingBar";
import {
  connectBLEDOM, getLastDevice, autoReconnect,
  sendColor, sendBrightness, sendPower, setActiveChar, getLastTickToWriteMs,
  setBleMinInterval,
  type BLEConnection, type BleReconnectStatus
} from "@/lib/bledom";
import { setBleConnection } from "@/lib/bleStore";
import { Power, Bluetooth, Loader2, Eye, EyeOff, Settings } from "lucide-react";
import MicPanel from "@/components/MicPanel";
import DebugOverlay from "@/components/DebugOverlay";
import { useSonosNowPlaying } from "@/hooks/useSonosNowPlaying";
import { useSongEnergyCurve } from "@/hooks/useSongEnergyCurve";
import { extractPalette } from "@/lib/colorExtract";
import {
  loadCalibrationFromCloud, setActiveDeviceName, saveCalibration,
  applyColorCalibration, getCalibration
} from "@/lib/lightCalibration";
const Index = () => {
  const navigate = useNavigate();
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

  const overlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastArtUrlRef = useRef<string | null>(null);
  const currentColorRef = useRef(currentColor);

  const [lastDevice] = useState(() => getLastDevice());
  const { nowPlaying, smoothedRtt, getPosition } = useSonosNowPlaying();

  // Energy curve: lookup saved curve for current track
  const trackKey = useMemo(() => {
    if (!nowPlaying?.trackName || !nowPlaying?.artistName) return null;
    return { trackName: nowPlaying.trackName, artistName: nowPlaying.artistName };
  }, [nowPlaying?.trackName, nowPlaying?.artistName]);
  const { curve: energyCurve, recordedVolume, savedAgcState, bpm, beatGrid, sections, drops, saveCurve } = useSongEnergyCurve(trackKey);

  useEffect(() => { currentColorRef.current = currentColor; }, [currentColor]);

  // Poll e2e latency metric
  useEffect(() => {
    const id = setInterval(() => setTickToWriteMs(getLastTickToWriteMs()), 500);
    return () => clearInterval(id);
  }, []);

  // Auto-hide overlay after 3s
  const resetOverlayTimer = useCallback(() => {
    setShowOverlay(true);
    if (!autoHide) return;
    if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current);
    overlayTimerRef.current = setTimeout(() => setShowOverlay(false), 3000);
  }, [autoHide]);

  useEffect(() => {
    if (connection) resetOverlayTimer();
    return () => { if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current); };
  }, [connection, resetOverlayTimer]);

  const finishConnect = useCallback(async (conn: BLEConnection) => {
    setConnection(conn);
    setBleConnection(conn);
    setBusy(false);
    setActiveChar(conn.characteristic);
    await sendPower(conn.characteristic, true);
    await sendBrightness(conn.characteristic, 100);

    // Apply color calibration to initial color
    const calibrated = applyColorCalibration(...currentColorRef.current);
    await sendColor(conn.characteristic, ...calibrated).catch(() => {});

    // Load calibration from cloud for this device
    const deviceName = conn.device?.name;
    if (deviceName) {
      setActiveDeviceName(deviceName);
      loadCalibrationFromCloud(deviceName).then((data) => {
        if (data) {
          saveCalibration(data.calibration, deviceName);
          if (data.bleMinIntervalMs != null) {
            setBleMinInterval(data.bleMinIntervalMs);
          }
          console.log('[Index] loaded cloud calibration for', deviceName, data);
        }
      }).catch(() => {});
    }

    conn.device.addEventListener("gattserverdisconnected", () => {
      setConnection(null);
      setBleConnection(null);
      setBleReconnectStatus({ attempt: 0, maxAttempts: 100, phase: 'waiting', targetName: conn.device?.name || undefined });
    });
  }, []);

  // Auto-reconnect whenever disconnected
  useEffect(() => {
    if (connection) return;
    const nav = navigator as any;
    if (!nav.bluetooth) return;
    if (!nav.bluetooth.getDevices) return;

    const ac = new AbortController();
    setBusy(true);
    setBleReconnectStatus({ attempt: 0, maxAttempts: 100, phase: 'getDevices' });
    autoReconnect(ac.signal, setBleReconnectStatus).then((conn) => {
      if (conn) {
        finishConnect(conn);
        setBleReconnectStatus({ attempt: 0, maxAttempts: 0, phase: 'done', targetName: conn.device?.name });
      } else {
        setBusy(false);
        setBleReconnectStatus(prev => prev?.phase === 'done' ? prev : { attempt: 0, maxAttempts: 0, phase: 'failed', error: 'Gav upp efter alla försök' });
      }
    });
    return () => ac.abort();
  }, [connection, finishConnect]);

  // Extract palette from album art
  useEffect(() => {
    const artUrl = nowPlaying?.albumArtUrl;
    if (!artUrl || artUrl === lastArtUrlRef.current) return;
    lastArtUrlRef.current = artUrl;
    // Run palette extraction off the critical path
    const run = () => {
      extractPalette(artUrl, 4).then((colors) => {
        if (colors.length === 0) return;
        setPalette(colors);
        paletteIndexRef.current = 0;
        setCurrentColor(colors[0]);
      });
    };
    if ('requestIdleCallback' in window) {
      (window as any).requestIdleCallback(run, { timeout: 500 });
    } else {
      setTimeout(run, 0);
    }
  }, [nowPlaying?.albumArtUrl]);

  const handleConnect = useCallback(async (scanAll = false) => {
    setBusy(true);
    setError(null);
    try {
      await finishConnect(await connectBLEDOM(scanAll));
    } catch (e: any) {
      setError(e.message || "Kunde inte ansluta");
      setBusy(false);
    }
  }, [finishConnect]);

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
        <MicPanel char={char} currentColor={currentColor} sonosVolume={nowPlaying?.volume} getPosition={getPosition} energyCurve={energyCurve} recordedVolume={recordedVolume} savedAgcState={savedAgcState} bpm={bpm} sections={sections} drops={drops} onSaveEnergyCurve={saveCurve} />
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
        autoDriftMs={0}
        palette={palette}
        paletteIndex={paletteIndexRef.current}
        sonosVolume={nowPlaying?.volume}
        bleConnected={!!connection}
        bleDeviceName={connection?.device?.name}
        bleReconnectStatus={bleReconnectStatus}
        tickToWriteMs={tickToWriteMs}
      />
    </div>
  );
};

export default Index;
