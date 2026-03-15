import { useState, useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import CalibrationOverlay from "@/components/CalibrationOverlay";
import { Button } from "@/components/ui/button";
import NowPlayingBar from "@/components/NowPlayingBar";
import {
  connectBLEDOM, getLastDevice, autoReconnect,
  sendPower, setActiveChar, clearActiveChar,
  sendHardwareBrightness,
  type BLEConnection, type BleReconnectStatus
} from "@/lib/bledom";
import { setBleConnection } from "@/lib/bleStore";
import { Power, Bluetooth, Loader2, Eye, EyeOff, Settings, Bug } from "lucide-react";
import MicPanel from "@/components/MicPanel";
import DebugOverlay from "@/components/DebugOverlay";
import { useSonosNowPlaying } from "@/hooks/useSonosNowPlaying";
import { extractPalette } from "@/lib/colorExtract";
import {
  loadCalibrationFromCloud, setActiveDeviceName, saveCalibration,
  getCalibration
} from "@/lib/lightCalibration";
import { debugData } from "@/lib/debugStore";

const Index = () => {
  const navigate = useNavigate();
  const [connection, setConnection] = useState<BLEConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentColor, setCurrentColor] = useState<[number, number, number]>([255, 80, 0]);
  const [isOn, setIsOn] = useState(true);
  const [showOverlay, setShowOverlay] = useState(true);
  const [showDebug, setShowDebug] = useState(() => localStorage.getItem("showDebug") !== "false");
  const [autoHide, setAutoHide] = useState(() => localStorage.getItem("autoHide") !== "false");
  const [bleReconnectStatus, setBleReconnectStatus] = useState<BleReconnectStatus | null>(null);
  const [activeCalibration, setActiveCalibration] = useState(getCalibration);
  const [showCalibration, setShowCalibration] = useState(() => new URLSearchParams(window.location.search).has('cal'));
  const tickMs = 125;

  const overlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastArtUrlRef = useRef<string | null>(null);
  const currentColorRef = useRef(currentColor);

  const [lastDevice] = useState(() => getLastDevice());
  const { nowPlaying, smoothedRtt, getPosition } = useSonosNowPlaying();

  useEffect(() => { currentColorRef.current = currentColor; }, [currentColor]);

  // Keep debugStore in sync
  useEffect(() => {
    debugData.bleConnected = !!connection;
    debugData.bleDeviceName = connection?.device?.name ?? null;
  }, [connection]);

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
  }, []);

  // Live status callback from MicPanel
  const handleLiveStatus = useCallback((status: { brightness: number; color: [number, number, number]; bassLevel: number; midHiLevel: number; bleSentColor?: [number, number, number]; bleSentBright?: number; bleColorSource?: 'normal' | 'idle'; micRms?: number; isPlayingState?: boolean }) => {
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

  const finishConnect = async (conn: BLEConnection) => {
    setConnection(conn);
    setBleConnection(conn);
    setBusy(false);
    setActiveChar(conn.characteristic);
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
      <div className="absolute inset-0" style={{ bottom: nowPlaying?.trackName && nowPlaying.playbackState !== "PLAYBACK_STATE_IDLE" ? '4.5rem' : 0 }}>
        <MicPanel char={char} currentColor={currentColor} sonosVolume={nowPlaying?.volume} isPlaying={!!nowPlaying?.trackName && nowPlaying.playbackState === "PLAYBACK_STATE_PLAYING"} tickMs={tickMs} onLiveStatus={handleLiveStatus} />
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

      {/* Calibration overlay */}
      {showCalibration && (
        <CalibrationOverlay
          onClose={() => setShowCalibration(false)}
          onCalibrationChange={(cal) => setActiveCalibration(cal)}
        />
      )}

      {showDebug && <DebugOverlay />}
    </div>
  );
};

export default Index;
