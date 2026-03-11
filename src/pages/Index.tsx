import { useState, useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import NowPlayingBar from "@/components/NowPlayingBar";
import {
  connectBLEDOM, reconnectLastDevice, getLastDevice,
  sendColor, sendBrightness, sendPower,
  type BLEConnection
} from "@/lib/bledom";
import { Power, Bluetooth, Zap, Loader2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
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
  const [autoConnecting, setAutoConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentColor, setCurrentColor] = useState<[number, number, number]>([255, 0, 0]);
  const [selectedColorIdx, setSelectedColorIdx] = useState("0");
  const [isOn, setIsOn] = useState(true);
  const retryCountRef = useRef(0);
  const [sonosColor, setSonosColor] = useState<[number, number, number] | null>(null);
  const [sonosBpm, setSonosBpm] = useState<number | null>(null);
  const [punchWhite, setPunchWhite] = useState(true);
  const [liveBpm, setLiveBpm] = useState<number | null>(null);
  const lastBpmTrackRef = useRef<string | null>(null);
  const lastDevice = getLastDevice();
  const { nowPlaying } = useSonosNowPlaying();
  const lastArtUrlRef = useRef<string | null>(null);

  const doReconnect = async (): Promise<BLEConnection | null> => {
    try {
      return await reconnectLastDevice();
    } catch {
      return null;
    }
  };

  const setupDisconnectHandler = useCallback((conn: BLEConnection) => {
    const handleDisconnect = async () => {
      setConnection(null);
      for (let i = 0; i < 3; i++) {
        retryCountRef.current = i + 1;
        setReconnecting(true);
        await new Promise(res => setTimeout(res, 2000));
        const retry = await doReconnect();
        if (retry) {
          retryCountRef.current = 0;
          setConnection(retry);
          setReconnecting(false);
          await sendPower(retry.characteristic, true).catch(() => {});
          await sendBrightness(retry.characteristic, 100).catch(() => {});
          setupDisconnectHandler(retry);
          return;
        }
      }
      setReconnecting(false);
      retryCountRef.current = 0;
    };
    conn.device.addEventListener("gattserverdisconnected", handleDisconnect);
  }, []);

  const finishConnect = useCallback(async (conn: BLEConnection) => {
    retryCountRef.current = 0;
    setConnection(conn);
    setAutoConnecting(false);
    setReconnecting(false);
    await sendPower(conn.characteristic, true);
    await sendBrightness(conn.characteristic, 100);
    const [r, g, b] = currentColor;
    await sendColor(conn.characteristic, r, g, b).catch(() => {});
    setupDisconnectHandler(conn);
  }, [currentColor, setupDisconnectHandler]);

  // Auto-reconnect on mount
  useEffect(() => {
    const saved = getLastDevice();
    if (!saved) return;
    let cancelled = false;
    setAutoConnecting(true);
    doReconnect().then(conn => {
      if (cancelled) return;
      if (conn) {
        finishConnect(conn);
      } else {
        setAutoConnecting(false);
      }
    });
    return () => { cancelled = true; };
  }, []);

  // Auto-extract color from Sonos album art
  useEffect(() => {
    const artUrl = nowPlaying?.albumArtUrl;
    if (!artUrl || artUrl === lastArtUrlRef.current) return;
    lastArtUrlRef.current = artUrl;

    extractDominantColor(artUrl).then((color) => {
      if (!color) return;
      setSonosColor(color);
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

  const handleConnect = async (scanAll = false) => {
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
  };

  const handleReconnect = async () => {
    setReconnecting(true);
    setError(null);
    try {
      // First try silent reconnect; fallback opens chooser if needed
      let conn = await reconnectLastDevice();
      if (!conn) {
        conn = await connectBLEDOM(false).catch(() => null);
      }

      if (conn) {
        await finishConnect(conn);
      } else {
        setError("Kunde inte återansluta. Prova 'Ny enhet'.");
      }
    } catch (e: any) {
      setError(e.message || "Kunde inte återansluta");
    } finally {
      setReconnecting(false);
    }
  };

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
  if (autoConnecting || reconnecting) {
    return (
      <div className="flex flex-col min-h-[100dvh] items-center justify-center bg-background p-8">
        <div className="flex flex-col items-center gap-6 text-center">
          <Loader2 className="w-10 h-10 text-muted-foreground animate-spin" />
          <div>
            <p className="text-lg font-medium text-foreground">
              {reconnecting ? "Återansluter..." : `Ansluter till ${lastDevice?.name ?? "enhet"}...`}
            </p>
            {reconnecting && retryCountRef.current > 0 && (
              <p className="text-sm text-muted-foreground mt-1">
                Försök {retryCountRef.current} av 3
              </p>
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
            <div className="w-28 h-28 rounded-full border border-border flex items-center justify-center">
              <Bluetooth className="w-10 h-10 text-muted-foreground" />
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
      className="flex flex-col min-h-[100dvh] bg-background transition-all duration-700"
      style={{ backgroundImage: bgGlow }}
    >
      {/* Top zone */}
      <div className="flex items-center justify-between px-4 py-3 shrink-0">
        <div className="flex items-center gap-3">
          <div
            className="w-3 h-3 rounded-full animate-pulse"
            style={{ backgroundColor: isOn ? accentColor : "hsl(var(--muted-foreground))" }}
          />
          <span className="text-sm font-bold tracking-widest text-foreground uppercase">
            {connection.device.name || "BLEDOM01"}
          </span>
        </div>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox
              checked={punchWhite}
              onCheckedChange={(v) => setPunchWhite(!!v)}
            />
            <span className="text-xs text-muted-foreground">Vit kick</span>
          </label>
          <Button
            variant="ghost"
            size="icon"
            onClick={handlePowerToggle}
            className="rounded-full"
            style={isOn ? { color: accentColor } : undefined}
          >
            <Power className="w-5 h-5" />
          </Button>
        </div>
      </div>

      {/* Now playing from Sonos */}
      {nowPlaying && nowPlaying.trackName && nowPlaying.playbackState !== "PLAYBACK_STATE_IDLE" && (
        <NowPlayingBar nowPlaying={nowPlaying} accentColor={accentColor} bpm={liveBpm} />
      )}

      {/* Mic panel takes remaining space */}
      <div className="flex-1 min-h-0">
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
    </div>
  );
};

export default Index;