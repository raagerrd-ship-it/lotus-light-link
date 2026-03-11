import { useState, useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";

import NowPlayingBar from "@/components/NowPlayingBar";
import {
  connectBLEDOM, getLastDevice, autoReconnect,
  sendColor, sendBrightness, sendPower,
  type BLEConnection
} from "@/lib/bledom";
import { Power, Bluetooth, Zap, Loader2 } from "lucide-react";
import MicPanel from "@/components/MicPanel";
import { useSonosNowPlaying } from "@/hooks/useSonosNowPlaying";
import { extractDominantColor } from "@/lib/colorExtract";


const Index = () => {
  const [connection, setConnection] = useState<BLEConnection | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  
  const [error, setError] = useState<string | null>(null);
  const [currentColor, setCurrentColor] = useState<[number, number, number]>([255, 0, 0]);
  
  const [isOn, setIsOn] = useState(true);
  const [sonosBpm, setSonosBpm] = useState<number | null>(null);
  const [punchWhite, setPunchWhite] = useState(true);
  const [liveBpm, setLiveBpm] = useState<number | null>(null);
  const [showOverlay, setShowOverlay] = useState(true);
  const overlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-hide overlay after 3s, show on interaction
  const resetOverlayTimer = useCallback(() => {
    setShowOverlay(true);
    if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current);
    overlayTimerRef.current = setTimeout(() => setShowOverlay(false), 3000);
  }, []);

  useEffect(() => {
    if (connection) resetOverlayTimer();
    return () => { if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current); };
  }, [connection, resetOverlayTimer]);
  const lastBpmTrackRef = useRef<string | null>(null);
  const lastDevice = getLastDevice();
  const { nowPlaying } = useSonosNowPlaying();
  const lastArtUrlRef = useRef<string | null>(null);


  const setupDisconnectHandler = useCallback((conn: BLEConnection) => {
    const handleDisconnect = () => {
      setConnection(null);
      setReconnecting(false);
    };
    conn.device.addEventListener("gattserverdisconnected", handleDisconnect);
  }, []);

  const currentColorRef = useRef(currentColor);
  useEffect(() => { currentColorRef.current = currentColor; }, [currentColor]);

  const finishConnect = useCallback(async (conn: BLEConnection) => {
    setConnection(conn);
    setReconnecting(false);
    await sendPower(conn.characteristic, true);
    await sendBrightness(conn.characteristic, 100);
    const [r, g, b] = currentColorRef.current;
    await sendColor(conn.characteristic, r, g, b).catch(() => {});
    setupDisconnectHandler(conn);
  }, [setupDisconnectHandler]);

  // Auto-reconnect on mount via getDevices() + watchAdvertisements()
  useEffect(() => {
    if (connection) return;
    const saved = getLastDevice();
    if (!saved) return;

    setReconnecting(true);
    autoReconnect().then((conn) => {
      if (conn) {
        finishConnect(conn);
      } else {
        setReconnecting(false);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-extract color from Sonos album art
  useEffect(() => {
    const artUrl = nowPlaying?.albumArtUrl;
    if (!artUrl || artUrl === lastArtUrlRef.current) return;
    lastArtUrlRef.current = artUrl;

    extractDominantColor(artUrl).then((color) => {
      if (!color) return;
      setCurrentColor(color);
      if (connection && isOn) {
        sendColor(connection.characteristic, color[0], color[1], color[2]).catch(() => {});
      }
    });
  }, [nowPlaying?.albumArtUrl, connection, isOn]);

  // BPM lookup when track changes
  useEffect(() => {
    const track = nowPlaying?.trackName;
    const artist = nowPlaying?.artistName;
    const trackKey = `${track ?? ""}::${artist ?? ""}`;
    if (!track || trackKey === lastBpmTrackRef.current) return;
    lastBpmTrackRef.current = trackKey;

    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/bpm-lookup`;
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
      },
      body: JSON.stringify({ track, artist }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.bpm && data.bpm >= 40 && data.bpm <= 220) {
          console.log(`BPM lookup: ${track} → ${data.bpm} (${data.confidence})`);
          setSonosBpm(data.bpm);
        } else {
          setSonosBpm(null);
        }
      })
      .catch(() => setSonosBpm(null));
  }, [nowPlaying?.trackName, nowPlaying?.artistName]);

  const handleConnect = useCallback(async (scanAll = false) => {
    setConnecting(true);
    setError(null);
    try {
      const conn = await connectBLEDOM(scanAll);
      await finishConnect(conn);
    } catch (e: any) {
      setError(e.message || "Kunde inte ansluta");
    } finally {
      setConnecting(false);
    }
  }, [finishConnect]);

  const handleReconnect = useCallback(async () => {
    setReconnecting(true);
    setError(null);
    try {
      const conn = await connectBLEDOM(false);
      await finishConnect(conn);
    } catch (e: any) {
      setError(e.message || "Kunde inte återansluta");
    } finally {
      setReconnecting(false);
    }
  }, [finishConnect]);


  const handlePowerToggle = async () => {
    if (!connection) return;
    const next = !isOn;
    setIsOn(next);
    await sendPower(connection.characteristic, next).catch(() => {});
  };

  const [r, g, b] = currentColor;
  const accentColor = `rgb(${r}, ${g}, ${b})`;
  const bgGlow = `radial-gradient(ellipse at 50% 60%, rgba(${r},${g},${b},0.08) 0%, transparent 70%)`;
  const char = connection?.characteristic;

  // Compute progress fraction for NowPlayingBar
  const progressFraction = (() => {
    if (!nowPlaying?.positionMs || !nowPlaying?.durationMs || nowPlaying.durationMs <= 0) return 0;
    const elapsed = performance.now() - (nowPlaying.receivedAt ?? performance.now());
    const estimatedMs = nowPlaying.positionMs + elapsed;
    return Math.min(1, Math.max(0, estimatedMs / nowPlaying.durationMs));
  })();

  return (
    <div
      className="relative h-[100dvh] bg-background transition-all duration-700 overflow-hidden"
      style={{ backgroundImage: bgGlow }}
      onPointerMove={connection ? resetOverlayTimer : undefined}
      onPointerDown={connection ? resetOverlayTimer : undefined}
    >
      {/* MicPanel always visible */}
      <div className="absolute inset-0">
        <MicPanel
          char={char}
          currentColor={currentColor}
          externalBpm={sonosBpm}
          sonosPosition={nowPlaying?.positionMs != null ? { positionMs: nowPlaying.positionMs, receivedAt: nowPlaying.receivedAt } : null}
          durationMs={nowPlaying?.durationMs}
          punchWhite={punchWhite}
          onBpmChange={setLiveBpm}
        />
      </div>

      {/* Connection overlay */}
      {!connection && (
        <div className="absolute inset-0 z-30 flex items-center justify-center animate-fade-in" style={{ background: 'hsl(var(--background) / 0.82)' }}>
          <div className="flex flex-col items-center gap-4 text-center px-8">
            {reconnecting ? (
              <>
                <Loader2 className="w-8 h-8 animate-spin" style={{ color: accentColor }} />
                <p className="text-sm text-muted-foreground">
                  Återansluter{lastDevice ? ` till ${lastDevice.name}` : '…'}
                </p>
              </>
            ) : (
              <>
                <div
                  className="w-14 h-14 rounded-full border border-border flex items-center justify-center"
                  style={{ boxShadow: `0 0 24px rgba(${r},${g},${b},0.15)` }}
                >
                  <Bluetooth className="w-6 h-6" style={{ color: accentColor }} />
                </div>

                {lastDevice ? (
                  <Button
                    onClick={handleReconnect}
                    disabled={connecting}
                    className="text-sm px-6 py-2.5 rounded-full font-bold tracking-wide transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]"
                    style={{
                      backgroundColor: accentColor,
                      color: "#121212",
                      boxShadow: `0 0 20px rgba(${r},${g},${b},0.3)`,
                    }}
                  >
                    <Zap className="w-4 h-4 mr-1.5" />
                    {connecting ? "Söker…" : lastDevice.name}
                  </Button>
                ) : (
                  <Button
                    onClick={() => handleConnect(false)}
                    disabled={connecting}
                    className="text-sm px-6 py-2.5 rounded-full font-bold tracking-wide transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]"
                    style={{
                      backgroundColor: accentColor,
                      color: "#121212",
                      boxShadow: `0 0 20px rgba(${r},${g},${b},0.3)`,
                    }}
                  >
                    {connecting ? "Söker…" : "Anslut"}
                  </Button>
                )}

                <button
                  onClick={() => handleConnect(lastDevice ? false : true)}
                  disabled={connecting}
                  className="text-muted-foreground text-[10px] hover:text-foreground transition-colors disabled:opacity-50"
                >
                  {lastDevice ? "Ny enhet" : "Sök alla"}
                </button>

                {error && <p className="text-destructive text-xs">{error}</p>}
              </>
            )}
          </div>
        </div>
      )}

      {/* Overlay: compact header */}
      {connection && (
        <div
          className={`absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] transition-opacity duration-500 backdrop-blur-lg border-b border-white/5 ${showOverlay ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          style={{ background: 'hsl(var(--background) / 0.5)' }}
        >
          <div className="flex items-center gap-2">
            <div
              className="w-2.5 h-2.5 rounded-full animate-pulse"
              style={{ backgroundColor: isOn ? accentColor : "hsl(var(--muted-foreground))" }}
            />
            <span className="text-xs font-bold tracking-widest text-foreground/70 uppercase">
              {connection.device.name || "BLEDOM01"}
            </span>
          </div>

          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setPunchWhite(!punchWhite)}
              className="rounded-full w-7 h-7 active:scale-90 transition-transform"
              style={punchWhite ? { color: accentColor } : undefined}
            >
              <Zap className="w-3.5 h-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={handlePowerToggle}
              className="rounded-full w-7 h-7 active:scale-90 transition-transform"
              style={isOn ? { color: accentColor } : undefined}
            >
              <Power className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Overlay: now playing */}
      {connection && nowPlaying && nowPlaying.trackName && nowPlaying.playbackState !== "PLAYBACK_STATE_IDLE" && (
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