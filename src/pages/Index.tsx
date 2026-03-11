import { useState, useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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

const PRESET_COLORS: { label: string; rgb: [number, number, number] }[] = [
  { label: "Röd", rgb: [255, 0, 0] },
  { label: "Grön", rgb: [0, 255, 0] },
  { label: "Blå", rgb: [0, 0, 255] },
  { label: "Gul", rgb: [255, 255, 0] },
  { label: "Cyan", rgb: [0, 255, 255] },
  { label: "Magenta", rgb: [255, 0, 255] },
  { label: "Orange", rgb: [255, 120, 0] },
  { label: "Rosa", rgb: [255, 60, 120] },
  { label: "Lila", rgb: [140, 0, 255] },
  { label: "Varmvit", rgb: [255, 200, 120] },
  { label: "Kallvit", rgb: [200, 220, 255] },
  { label: "Vit", rgb: [255, 255, 255] },
];

const Index = () => {
  const [connection, setConnection] = useState<BLEConnection | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  
  const [error, setError] = useState<string | null>(null);
  const [currentColor, setCurrentColor] = useState<[number, number, number]>([255, 0, 0]);
  const [selectedColorIdx, setSelectedColorIdx] = useState("0");
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

  const handleColorSelect = useCallback((value: string) => {
    setSelectedColorIdx(value);
    const preset = PRESET_COLORS[parseInt(value)];
    if (!preset) return;
    const [r, g, b] = preset.rgb;
    setCurrentColor([r, g, b]);
    if (connection && isOn) {
      sendColor(connection.characteristic, r, g, b).catch(() => {});
    }
  }, [connection, isOn]);

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
      <div className="flex flex-col min-h-[100dvh] items-center justify-center bg-background p-8">
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
      <div className="flex flex-col min-h-[100dvh] items-center justify-center bg-background p-8">
        <div className="flex flex-col items-center gap-8 max-w-sm text-center">
          <div className="relative">
            <div
              className="w-28 h-28 rounded-full border border-border flex items-center justify-center animate-pulse"
              style={{ boxShadow: `0 0 40px rgba(${r},${g},${b},0.2), 0 0 80px rgba(${r},${g},${b},0.08)` }}
            >
              <Bluetooth className="w-10 h-10" style={{ color: accentColor }} />
            </div>
          </div>

          <div>
            <h1 className="text-3xl font-bold tracking-tight mb-2">Ljusår</h1>
            <p className="text-muted-foreground text-sm">
              Anslut till din LED-slinga via Bluetooth
            </p>
          </div>

          {/* Fallback color setting */}
          <div className="w-full">
            <label className="text-xs text-muted-foreground mb-2 block text-left">Startfärg</label>
            <Select value={selectedColorIdx} onValueChange={handleColorSelect}>
              <SelectTrigger className="w-full bg-secondary/50 border-border">
                <div className="flex items-center gap-3">
                  <div
                    className="w-4 h-4 rounded-full shrink-0 border border-border"
                    style={{ backgroundColor: accentColor }}
                  />
                  <SelectValue placeholder="Välj färg" />
                </div>
              </SelectTrigger>
              <SelectContent>
                {PRESET_COLORS.map((c, i) => (
                  <SelectItem key={i} value={String(i)}>
                    <div className="flex items-center gap-3">
                      <div
                        className="w-4 h-4 rounded-full shrink-0 border border-border"
                        style={{ backgroundColor: `rgb(${c.rgb[0]}, ${c.rgb[1]}, ${c.rgb[2]})` }}
                      />
                      {c.label}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {lastDevice && (
            <Button
              onClick={handleReconnect}
              disabled={connecting || reconnecting}
              size="lg"
              className="text-lg px-10 py-6 rounded-full font-bold tracking-wide transition-all duration-300"
              style={!reconnecting ? {
                backgroundColor: accentColor,
                color: "#121212",
                boxShadow: `0 0 30px rgba(${r},${g},${b},0.3)`,
              } : undefined}
            >
              <Zap className="w-5 h-5 mr-2" />
              {reconnecting ? "Söker..." : lastDevice.name}
            </Button>
          )}

          <Button
            onClick={() => handleConnect(false)}
            disabled={connecting || reconnecting}
            size={lastDevice ? "sm" : "lg"}
            variant={lastDevice ? "outline" : "default"}
            className={lastDevice
              ? "rounded-full"
              : "text-lg px-10 py-6 rounded-full font-bold tracking-wide transition-all duration-300"
            }
            style={!lastDevice && !connecting ? {
              backgroundColor: accentColor,
              color: "#121212",
              boxShadow: `0 0 30px rgba(${r},${g},${b},0.3)`,
            } : undefined}
          >
            {connecting ? "Söker..." : lastDevice ? "Ny enhet" : "VÄCK LJUS"}
          </Button>

          <Button
            onClick={() => handleConnect(true)}
            disabled={connecting || reconnecting}
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
          >
            Sök alla enheter
          </Button>

          {error && (
            <p className="text-destructive text-sm">{error}</p>
          )}

          <p className="text-muted-foreground text-xs mt-4 leading-relaxed">
            Kräver Chrome på Android eller dator.
            <br />
            Stäng Lotus Lantern-appen innan du ansluter.
          </p>
        </div>
      </div>
    );
  }

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
        className={`absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-3 py-2 transition-opacity duration-500 ${showOverlay ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        style={{ background: 'linear-gradient(to bottom, hsl(var(--background) / 0.7) 0%, transparent 100%)' }}
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

        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <Checkbox
              checked={punchWhite}
              onCheckedChange={(v) => setPunchWhite(!!v)}
              className="w-3.5 h-3.5"
            />
            <span className="text-[10px] text-muted-foreground">Vit kick</span>
          </label>
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
          className={`absolute bottom-0 left-0 right-0 z-20 transition-opacity duration-500 ${showOverlay ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          style={{ background: 'linear-gradient(to top, hsl(var(--background) / 0.7) 0%, transparent 100%)' }}
        >
          <NowPlayingBar nowPlaying={nowPlaying} bpm={liveBpm} />
        </div>
      )}
    </div>
  );
};

export default Index;