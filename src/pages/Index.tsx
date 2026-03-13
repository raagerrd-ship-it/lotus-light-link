import { useState, useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import NowPlayingBar from "@/components/NowPlayingBar";
import {
  connectBLEDOM, getLastDevice, autoReconnect,
  sendColor, sendBrightness, sendPower,
  type BLEConnection
} from "@/lib/bledom";
import { Power, Bluetooth, Zap, Loader2, Eye, EyeOff, Activity, Crosshair } from "lucide-react";
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
  const [showDebug, setShowDebug] = useState(false);
  const [agcEnabled, setAgcEnabled] = useState(() => localStorage.getItem("agcEnabled") !== "false");
  const [manualGain, setManualGain] = useState(() => {
    const stored = localStorage.getItem("manualGain");
    return stored ? parseFloat(stored) : 5;
  });
  const [calibration, setCalibration] = useState<{ volume: number; gain: number } | null>(() => {
    try {
      const stored = localStorage.getItem("gainCalibration");
      return stored ? JSON.parse(stored) : null;
    } catch { return null; }
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
    if (!nav.bluetooth?.getDevices) return;

    const ac = new AbortController();
    setBusy(true);
    autoReconnect(ac.signal).then((conn) => {
      if (conn) finishConnect(conn);
      else setBusy(false);
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

  const progressFraction = (() => {
    if (!nowPlaying?.positionMs || !nowPlaying?.durationMs || nowPlaying.durationMs <= 0) return 0;
    const elapsed = performance.now() - (nowPlaying.receivedAt ?? performance.now());
    return Math.min(1, Math.max(0, (nowPlaying.positionMs + elapsed) / nowPlaying.durationMs));
  })();

  return (
    <div
      className="relative h-[100dvh] bg-background overflow-hidden"
      style={{ backgroundImage: `radial-gradient(ellipse at 50% 60%, rgba(${r},${g},${b},0.08) 0%, transparent 70%)` }}
      onPointerMove={connection ? resetOverlayTimer : undefined}
      onPointerDown={connection ? resetOverlayTimer : undefined}
      onClick={(e) => { if (e.detail === 3) setShowDebug(prev => !prev); }}
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
            onSectionChange={handleSectionChange}
            agcEnabled={agcEnabled}
            manualGain={manualGain}
            sonosVolume={nowPlaying?.volume ?? null}
            calibration={calibration}
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
          gainMode={calibration ? 'cal' : agcEnabled ? 'agc' : 'manual'}
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
                    const next = !agcEnabled;
                    setAgcEnabled(next);
                    localStorage.setItem("agcEnabled", String(next));
                  }}
                  className={`rounded-full w-7 h-7 active:scale-90 transition-all duration-200 ${agcEnabled ? 'ring-1 ring-offset-1 ring-offset-background' : 'opacity-40'}`}
                  style={agcEnabled ? { color: accent, '--tw-ring-color': accent } as React.CSSProperties : undefined}
                  title={`AGC — ${agcEnabled ? 'PÅ' : 'AV'}`}
                >
                  <Activity className="w-3.5 h-3.5" style={agcEnabled ? { filter: `drop-shadow(0 0 4px ${accent})` } : undefined} />
                </Button>
                {!agcEnabled && nowPlaying?.volume != null && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      if (calibration) {
                        setCalibration(null);
                        localStorage.removeItem("gainCalibration");
                        return;
                      }
                      const vol = nowPlaying?.volume;
                      if (vol == null) return;
                      const cal = { volume: vol, gain: manualGain };
                      setCalibration(cal);
                      localStorage.setItem("gainCalibration", JSON.stringify(cal));
                    }}
                    className={`rounded-full w-7 h-7 active:scale-90 transition-all duration-200 ${calibration ? 'ring-1 ring-offset-1 ring-offset-background' : 'opacity-40'}`}
                    style={calibration ? { color: accent, '--tw-ring-color': accent } as React.CSSProperties : undefined}
                    title={calibration ? `Kalibrerad vid ${calibration.volume}%` : 'Kalibrera'}
                  >
                    <Crosshair className="w-3.5 h-3.5" style={calibration ? { filter: `drop-shadow(0 0 4px ${accent})` } : undefined} />
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

      {/* Gain slider (visible when AGC off) */}
      {connection && !agcEnabled && showOverlay && (
        <div
          className="absolute top-12 left-0 right-0 z-20 flex items-center gap-3 px-4 py-2 transition-opacity duration-500 backdrop-blur-lg"
          style={{ background: 'hsl(var(--background) / 0.5)' }}
        >
          <span className="text-[10px] text-muted-foreground font-mono w-8 shrink-0">
            {manualGain.toFixed(1)}×
          </span>
          <input
            type="range"
            min="0.5"
            max="20"
            step="0.5"
            value={manualGain}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              setManualGain(v);
              localStorage.setItem("manualGain", String(v));
            }}
            className="flex-1 h-1 accent-current"
            style={{ color: accent }}
          />
          {calibration && (
            <button
              onClick={() => {
                setCalibration(null);
                localStorage.removeItem("gainCalibration");
              }}
              className="text-[9px] text-muted-foreground hover:text-foreground"
            >
              Rensa
            </button>
          )}
        </div>
      )}

      {/* Now playing */}
      {connection && nowPlaying?.trackName && nowPlaying.playbackState !== "PLAYBACK_STATE_IDLE" && (
        <div
          className={`absolute bottom-0 left-0 right-0 z-20 pb-[env(safe-area-inset-bottom)] transition-opacity duration-500 backdrop-blur-lg border-t border-white/5 ${showOverlay ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          style={{ background: 'hsl(var(--background) / 0.5)' }}
        >
          <NowPlayingBar nowPlaying={nowPlaying} bpm={liveBpm} accentColor={currentColor} progressFraction={progressFraction} />
        </div>
      )}
    </div>
  );
};

export default Index;
