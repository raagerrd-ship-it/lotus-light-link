import { useState, useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import NowPlayingBar from "@/components/NowPlayingBar";
import {
  connectBLEDOM, getLastDevice, autoReconnect,
  sendColor, sendBrightness, sendPower,
  type BLEConnection, type BleReconnectStatus
} from "@/lib/bledom";
import { Power, Bluetooth, Zap, Loader2, Eye, EyeOff, Activity, Volume2, SlidersHorizontal, Crosshair } from "lucide-react";
import MicPanel from "@/components/MicPanel";
import { useSonosNowPlaying } from "@/hooks/useSonosNowPlaying";
import { extractPalette } from "@/lib/colorExtract";
import DebugOverlay from "@/components/DebugOverlay";
import type { SongSection } from "@/lib/songSections";

const Index = () => {
  const [connection, setConnection] = useState<BLEConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentColor, setCurrentColor] = useState<[number, number, number]>([255, 0, 0]);
  const [palette, setPalette] = useState<[number, number, number][]>([]);
  const paletteIndexRef = useRef(0);
  const [isOn, setIsOn] = useState(true);
  const [sonosBpm, setSonosBpm] = useState<number | null>(null);
  const [punchWhite, setPunchWhite] = useState(true);
  const [liveBpm, setLiveBpm] = useState<number | null>(null);
  const [showOverlay, setShowOverlay] = useState(true);
  const [autoHide, setAutoHide] = useState(() => localStorage.getItem("autoHide") !== "false");
  const [songSections, setSongSections] = useState<SongSection[]>([]);
  const [songDrops, setSongDrops] = useState<number[]>([]);
  const [autoDriftMs, setAutoDriftMs] = useState(0);
  const [currentSection, setCurrentSection] = useState<SongSection | null>(null);
  const [showDebug] = useState(true);
  const [bleReconnectStatus, setBleReconnectStatus] = useState<BleReconnectStatus | null>(null);
  const [gainMode, setGainMode] = useState<'agc' | 'vol' | 'manual'>(() => {
    const stored = localStorage.getItem("gainMode");
    return (stored === 'agc' || stored === 'vol' || stored === 'manual') ? stored : 'agc';
  });
  const [volCalibration, setVolCalibration] = useState<{ volume: number; gain: number } | null>(() => {
    try { const s = localStorage.getItem("volCalibration"); return s ? JSON.parse(s) : null; } catch { return null; }
  });
  const [dynamicDamping, setDynamicDamping] = useState(() => {
    const stored = localStorage.getItem("dynamicDamping");
    return stored ? parseFloat(stored) : 1.0;
  });

  const overlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastBpmTrackRef = useRef<string | null>(null);
  const lastPrefetchKeyRef = useRef<string | null>(null);
  const lastArtUrlRef = useRef<string | null>(null);
  const currentColorRef = useRef(currentColor);

  const lastDevice = getLastDevice();
  const { nowPlaying, smoothedRtt, getPosition } = useSonosNowPlaying();

  useEffect(() => { currentColorRef.current = currentColor; }, [currentColor]);

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
    setBusy(false);
    await sendPower(conn.characteristic, true);
    await sendBrightness(conn.characteristic, 100);
    const [r, g, b] = currentColorRef.current;
    await sendColor(conn.characteristic, r, g, b).catch(() => {});
    conn.device.addEventListener("gattserverdisconnected", () => {
      setConnection(null);
    });
  }, []);

  // Auto-reconnect on mount — keeps retrying in background
  useEffect(() => {
    if (connection) return;
    const nav = navigator as any;
    if (!nav.bluetooth) {
      setBleReconnectStatus({ attempt: 0, maxAttempts: 0, phase: 'failed', error: 'Web Bluetooth API saknas' });
      return;
    }
    if (!nav.bluetooth.getDevices) {
      setBleReconnectStatus({ attempt: 0, maxAttempts: 0, phase: 'failed', error: 'getDevices() stöds ej' });
      return;
    }

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Extract palette from album art
  useEffect(() => {
    const artUrl = nowPlaying?.albumArtUrl;
    if (!artUrl || artUrl === lastArtUrlRef.current) return;
    lastArtUrlRef.current = artUrl;
    extractPalette(artUrl, 4).then((colors) => {
      if (colors.length === 0) return;
      setPalette(colors);
      paletteIndexRef.current = 0;
      setCurrentColor(colors[0]);
      if (connection && isOn) {
        sendColor(connection.characteristic, ...colors[0]).catch(() => {});
      }
    });
  }, [nowPlaying?.albumArtUrl, connection, isOn]);

  // Song analysis on track change (replaces bpm-lookup)
  useEffect(() => {
    const { trackName: track, artistName: artist } = nowPlaying ?? {};
    const key = `${track ?? ""}::${artist ?? ""}`;
    if (!track || key === lastBpmTrackRef.current) return;
    lastBpmTrackRef.current = key;
    setSongSections([]);
    setSongDrops([]);

    fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/song-analysis`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
      },
      body: JSON.stringify({ track, artist }),
    })
      .then((r) => r.json())
      .then((d) => {
        console.log("[song-analysis]", d);
        setSonosBpm(d.bpm >= 40 && d.bpm <= 220 ? d.bpm : null);
        setSongSections(Array.isArray(d.sections) ? d.sections : []);
        setSongDrops(Array.isArray(d.drops) ? d.drops : []);
      })
      .catch(() => {
        setSonosBpm(null);
        setSongSections([]);
        setSongDrops([]);
      });
  }, [nowPlaying?.trackName, nowPlaying?.artistName]);

  // Pre-fetch next track's analysis (fire-and-forget)
  useEffect(() => {
    const nextTrack = nowPlaying?.nextTrackName;
    const nextArtist = nowPlaying?.nextArtistName;
    const key = `${nextTrack ?? ""}::${nextArtist ?? ""}`;
    if (!nextTrack || key === lastPrefetchKeyRef.current) return;
    lastPrefetchKeyRef.current = key;

    fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/song-analysis`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
      },
      body: JSON.stringify({ track: nextTrack, artist: nextArtist }),
    }).catch(() => {}); // fire-and-forget, result cached in DB
  }, [nowPlaying?.nextTrackName, nowPlaying?.nextArtistName]);

  // Rotate palette color on section change
  const handleSectionChange = useCallback((section: SongSection | null) => {
    setCurrentSection(section);
    if (palette.length > 1 && section) {
      paletteIndexRef.current = (paletteIndexRef.current + 1) % palette.length;
      const nextColor = palette[paletteIndexRef.current];
      setCurrentColor(nextColor);
      // BLE color fade is handled by MicPanel's interpolation loop
    }
  }, [palette]);

  // Auto-sync drift (reported from MicPanel for debug display only)
  const handleSyncDrift = useCallback((offsetMs: number) => {
    setAutoDriftMs(offsetMs);
  }, []);

  // Listen for vol-calibrate-result from MicPanel
  useEffect(() => {
    const handler = (e: Event) => {
      const cal = (e as CustomEvent).detail as { volume: number; gain: number };
      setVolCalibration(cal);
      localStorage.setItem("volCalibration", JSON.stringify(cal));
      console.log("[vol-calibrate]", cal);
    };
    window.addEventListener('vol-calibrate-result', handler);
    return () => window.removeEventListener('vol-calibrate-result', handler);
  }, []);

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
            <MicPanel
            char={char}
            currentColor={currentColor}
            externalBpm={sonosBpm}
            sonosPosition={nowPlaying?.positionMs != null ? { positionMs: nowPlaying.positionMs, receivedAt: nowPlaying.receivedAt } : null}
            getPosition={getPosition}
            durationMs={nowPlaying?.durationMs}
            punchWhite={punchWhite}
            onBpmChange={setLiveBpm}
            songSections={songSections}
            songDrops={songDrops}
            syncOffsetMs={autoDriftMs}
            smoothedRtt={smoothedRtt}
            onSyncDriftMs={handleSyncDrift}
            gainMode={gainMode}
            sonosVolume={nowPlaying?.volume}
            volCalibration={volCalibration}
            maxBrightness={100}
            dynamicDamping={dynamicDamping}
          />
      </div>

      {showDebug && (
        <DebugOverlay
          smoothedRtt={smoothedRtt}
          autoDriftMs={autoDriftMs}
          currentSection={currentSection}
          palette={palette}
          paletteIndex={paletteIndexRef.current}
          source={nowPlaying?.source}
          sonosVolume={nowPlaying?.volume}
          gainMode={gainMode}
          volCalibrationVol={volCalibration?.volume}
          liveBpm={liveBpm}
          maxBrightness={100}
          dynamicDamping={dynamicDamping}
          bleConnected={!!connection}
          bleDeviceName={connection?.device?.name}
          bleReconnectStatus={bleReconnectStatus}
        />
      )}

      {/* Connection overlay — only when busy auto-connecting */}
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

      {/* Header — always visible */}
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
                    const modes: Array<'agc' | 'vol' | 'manual'> = ['agc', 'vol', 'manual'];
                    const next = modes[(modes.indexOf(gainMode) + 1) % modes.length];
                    setGainMode(next);
                    localStorage.setItem("gainMode", next);
                  }}
                  className={`rounded-full w-7 h-7 active:scale-90 transition-all duration-200 ${gainMode !== 'manual' ? 'ring-1 ring-offset-1 ring-offset-background' : 'opacity-40'}`}
                  style={gainMode !== 'manual' ? { color: accent, '--tw-ring-color': accent } as React.CSSProperties : undefined}
                  title={`Gain: ${gainMode.toUpperCase()}`}
                >
                  {gainMode === 'agc' && <Activity className="w-3.5 h-3.5" style={{ filter: `drop-shadow(0 0 4px ${accent})` }} />}
                  {gainMode === 'vol' && <Volume2 className="w-3.5 h-3.5" style={{ filter: `drop-shadow(0 0 4px ${accent})` }} />}
                  {gainMode === 'manual' && <SlidersHorizontal className="w-3.5 h-3.5" />}
                </Button>
                {gainMode === 'vol' && nowPlaying?.volume != null && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      // Capture current AGC average as gain reference at current Sonos volume
                      const cal = { volume: nowPlaying.volume!, gain: 0.35 / Math.max(0.0001, 0.01) };
                      // We need agcAvg from MicPanel — use a rough proxy: store current state
                      // Actually read from a ref isn't possible here, so use a reasonable default
                      // The MicPanel always updates agcAvg, so we capture a snapshot via a custom event
                      const detail = { volume: nowPlaying.volume! };
                      const evt = new CustomEvent('vol-calibrate', { detail });
                      window.dispatchEvent(evt);
                    }}
                    className="rounded-full w-7 h-7 active:scale-90 transition-all duration-200"
                    style={{ color: accent }}
                    title="Kalibrera vid nuvarande volym"
                  >
                    <Crosshair className="w-3.5 h-3.5" />
                  </Button>
                )}
                
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setPunchWhite(!punchWhite)}
                  className={`rounded-full w-7 h-7 active:scale-90 transition-all duration-200 ${punchWhite ? 'ring-1 ring-offset-1 ring-offset-background' : 'opacity-40'}`}
                  style={punchWhite ? { color: accent, '--tw-ring-color': accent } as React.CSSProperties : undefined}
                  title={`Punch white — ${punchWhite ? 'PÅ' : 'AV'}`}
                >
                  <Zap className="w-3.5 h-3.5" style={punchWhite ? { filter: `drop-shadow(0 0 4px ${accent})` } : undefined} />
                </Button>
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
                  title={autoHide ? "Auto-hide on" : "Auto-hide off"}
                >
                  {autoHide ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </Button>
                <Button variant="ghost" size="icon" onClick={handlePowerToggle} className="rounded-full w-7 h-7 active:scale-90 transition-transform" style={isOn ? { color: accent } : undefined}>
                  <Power className="w-4 h-4" />
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Damping slider */}
      {connection && showOverlay && (
        <div
          className="absolute top-12 left-0 right-0 z-20 flex items-center gap-3 px-4 py-2 transition-opacity duration-500 backdrop-blur-lg"
          style={{ background: 'hsl(var(--background) / 0.5)' }}
        >
          <span className="text-[10px] text-muted-foreground font-mono w-14 shrink-0">
            Dämpa {dynamicDamping.toFixed(1)}x
          </span>
          <input
            type="range"
            min="1.0"
            max="3.0"
            step="0.1"
            value={dynamicDamping}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              setDynamicDamping(v);
              localStorage.setItem("dynamicDamping", String(v));
            }}
            className="flex-1 h-1 accent-current"
            style={{ color: accent }}
          />
        </div>
      )}

      {/* Now playing */}
      {connection && nowPlaying?.trackName && nowPlaying.playbackState !== "PLAYBACK_STATE_IDLE" && (
        <div
          className={`absolute bottom-0 left-0 right-0 z-20 pb-[env(safe-area-inset-bottom)] transition-opacity duration-500 backdrop-blur-lg border-t border-white/5 ${showOverlay ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          style={{ background: 'hsl(var(--background) / 0.5)' }}
        >
          <NowPlayingBar nowPlaying={nowPlaying} bpm={liveBpm} accentColor={currentColor} getPosition={getPosition} />
        </div>
      )}
    </div>
  );
};

export default Index;
