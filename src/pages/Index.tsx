import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import MicPanel from "@/components/MicPanel";
import {
  connectBLEDOM, reconnectLastDevice, getLastDevice,
  sendColor, sendBrightness, sendPower,
  type BLEConnection
} from "@/lib/bledom";
import { Power, Bluetooth, Zap } from "lucide-react";

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
  const lastDevice = getLastDevice();

  const finishConnect = async (conn: BLEConnection) => {
    setConnection(conn);
    await sendPower(conn.characteristic, true);
    await sendBrightness(conn.characteristic, 100);
    // Send initial color
    const [r, g, b] = currentColor;
    await sendColor(conn.characteristic, r, g, b).catch(() => {});
    conn.device.addEventListener("gattserverdisconnected", () => {
      setConnection(null);
    });
  };

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
      const conn = await reconnectLastDevice();
      if (conn) {
        await finishConnect(conn);
      } else {
        setError("Kunde inte hitta enheten. Prova 'VÄCK LJUS' istället.");
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

      {/* Color selector */}
      <div className="px-4 pb-3 shrink-0">
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

      {/* Mic panel takes remaining space */}
      <div className="flex-1 min-h-0">
        <MicPanel char={char} currentColor={currentColor} />
      </div>
    </div>
  );
};

export default Index;