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

  // Auto-connecting screen
  if (reconnecting) {
    return (
      <div className="flex flex-col min-h-[100dvh] items-center justify-center bg-background p-8 animate-fade-in">
        <div className="flex flex-col items-center gap-6 text-center">
          <div className="relative">
            <div
              className="absolute inset-0 rounded-full animate-pulse"
              style={{ boxShadow: `0 0 40px rgba(${r},${g},${b},0.3), 0 0 80px rgba(${r},${g},${b},0.1)` }}
            />
            <Loader2 className="w-10 h-10 animate-spin" style={{ color: accentColor }} />
          </div>
          <div>
            <p className="text-lg font-medium text-foreground">Återansluter…</p>
            {lastDevice && (
              <p className="text-xs text-muted-foreground mt-1">{lastDevice.name}</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Connect screen
  if (!connection) {
    return (
      <div className="flex flex-col min-h-[100dvh] items-center justify-center bg-background p-8 animate-fade-in">
        <div className="flex flex-col items-center gap-10 max-w-sm text-center">
          <div className="relative">
            <div
              className="w-28 h-28 rounded-full border border-border flex items-center justify-center animate-pulse"
              style={{ boxShadow: `0 0 40px rgba(${r},${g},${b},0.2), 0 0 80px rgba(${r},${g},${b},0.08)` }}
            >
              <Bluetooth className="w-10 h-10" style={{ color: accentColor }} />
            </div>
          </div>

          <div>
            <h1 className="text-2xl font-bold tracking-[0.2em] uppercase mb-2">Ljusår</h1>
            <p className="text-muted-foreground text-sm">
              Anslut till din LED-slinga via Bluetooth
            </p>
          </div>

          {lastDevice ? (
            <Button
              onClick={handleReconnect}
              disabled={connecting || reconnecting}
              size="lg"
              className="text-lg px-10 py-6 rounded-full font-bold tracking-wide transition-all duration-300 w-full"
              style={!reconnecting ? {
                backgroundColor: accentColor,
                color: "#121212",
                boxShadow: `0 0 30px rgba(${r},${g},${b},0.3)`,
              } : undefined}
            >
              <Zap className="w-5 h-5 mr-2" />
              {reconnecting ? "Söker..." : lastDevice.name}
            </Button>
          ) : (
            <Button
              onClick={() => handleConnect(false)}
              disabled={connecting}
              size="lg"
              className="text-lg px-10 py-6 rounded-full font-bold tracking-wide transition-all duration-300 w-full"
              style={!connecting ? {
                backgroundColor: accentColor,
                color: "#121212",
                boxShadow: `0 0 30px rgba(${r},${g},${b},0.3)`,
              } : undefined}
            >
              {connecting ? "Söker..." : "VÄCK LJUS"}
            </Button>
          )}

          <button
            onClick={() => handleConnect(lastDevice ? false : true)}
            disabled={connecting || reconnecting}
            className="text-muted-foreground text-xs hover:text-foreground transition-colors disabled:opacity-50"
          >
            {lastDevice ? "Ny enhet" : "Sök alla enheter"}
          </button>

          {error && (
            <p className="text-destructive text-sm">{error}</p>
          )}
        </div>

        <p className="text-muted-foreground/50 text-[10px] absolute bottom-6 text-center leading-relaxed">
          Kräver Chrome på Android eller dator · Stäng Lotus Lantern först
        </p>
      </div>
    );
  }

  // Compute progress fraction for NowPlayingBar
  const progressFraction = (() => {
    if (!nowPlaying?.positionMs || !nowPlaying?.durationMs || nowPlaying.durationMs <= 0) return 0;
    const elapsed = performance.now() - (nowPlaying.receivedAt ?? performance.now());
    const estimatedMs = nowPlaying.positionMs + elapsed;
    return Math.min(1, Math.max(0, estimatedMs / nowPlaying.durationMs));
  })();

  // Main controller
   return (
    <div
      className="relative h-[100dvh] bg-background transition-all duration-700 overflow-hidden"
      style={{ backgroundImage: bgGlow }}
      onPointerMove={resetOverlayTimer}
      onPointerDown={resetOverlayTimer}
    >
      {/* Mic panel fills entire viewport */}
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

      {/* Overlay: compact header */}
      <div
        className={`absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-3 py-2 transition-opacity duration-500 backdrop-blur-lg ${showOverlay ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
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
            className="rounded-full w-7 h-7"
            style={punchWhite ? { color: accentColor } : undefined}
          >
            <Zap className="w-3.5 h-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={handlePowerToggle}
            className="rounded-full w-7 h-7"
            style={isOn ? { color: accentColor } : undefined}
          >
            <Power className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Overlay: now playing */}
      {nowPlaying && nowPlaying.trackName && nowPlaying.playbackState !== "PLAYBACK_STATE_IDLE" && (
        <div
          className={`absolute bottom-0 left-0 right-0 z-20 transition-opacity duration-500 backdrop-blur-lg ${showOverlay ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          style={{ background: 'hsl(var(--background) / 0.5)' }}
        >
          <NowPlayingBar nowPlaying={nowPlaying} bpm={liveBpm} accentColor={currentColor} progressFraction={progressFraction} />
        </div>
      )}
    </div>
  );
};

export default Index;