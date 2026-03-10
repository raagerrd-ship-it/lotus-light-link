import { useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import ColorCanvas from "@/components/ColorCanvas";
import { connectBLEDOM, sendColor, sendBrightness, sendPower, hsvToRgb, type BLEConnection } from "@/lib/bledom";
import { Power, Bluetooth, Sun } from "lucide-react";

const Index = () => {
  const [connection, setConnection] = useState<BLEConnection | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentColor, setCurrentColor] = useState<[number, number, number]>([255, 255, 255]);
  const [brightness, setBrightness] = useState(80);
  const [isOn, setIsOn] = useState(true);
  const throttleRef = useRef<number>(0);

  const handleConnect = async (scanAll = false) => {
    setConnecting(true);
    setError(null);
    try {
      const conn = await connectBLEDOM(scanAll);
      setConnection(conn);
      await sendPower(conn.characteristic, true);
      await sendBrightness(conn.characteristic, 80);

      conn.device.addEventListener("gattserverdisconnected", () => {
        setConnection(null);
      });
    } catch (e: any) {
      setError(e.message || "Kunde inte ansluta");
    } finally {
      setConnecting(false);
    }
  };

  const handleColorChange = useCallback(
    (_h: number, _s: number, r: number, g: number, b: number) => {
      setCurrentColor([r, g, b]);

      // Throttle BLE writes to ~30ms
      const now = Date.now();
      if (now - throttleRef.current < 30) return;
      throttleRef.current = now;

      if (connection && isOn) {
        sendColor(connection.characteristic, r, g, b).catch(() => {});
      }
    },
    [connection, isOn]
  );

  const handleBrightnessChange = useCallback(
    (value: number[]) => {
      const val = value[0];
      setBrightness(val);
      if (connection && isOn) {
        sendBrightness(connection.characteristic, val).catch(() => {});
      }
    },
    [connection, isOn]
  );

  const handlePowerToggle = async () => {
    if (!connection) return;
    const next = !isOn;
    setIsOn(next);
    await sendPower(connection.characteristic, next).catch(() => {});
  };

  const [r, g, b] = currentColor;
  const accentColor = `rgb(${r}, ${g}, ${b})`;
  const bgGlow = `radial-gradient(ellipse at 50% 60%, rgba(${r},${g},${b},0.08) 0%, transparent 70%)`;

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

          <Button
            onClick={handleConnect}
            disabled={connecting}
            size="lg"
            className="text-lg px-10 py-6 rounded-full font-bold tracking-wide transition-all duration-300"
            style={!connecting ? {
              backgroundColor: accentColor,
              color: "#121212",
              boxShadow: `0 0 30px rgba(${r},${g},${b},0.3)`,
            } : undefined}
          >
            {connecting ? "Söker..." : "VÄCK LJUS"}
          </Button>

          {error && (
            <p className="text-destructive text-sm">{error}</p>
          )}

          <p className="text-muted-foreground text-xs mt-4 leading-relaxed">
            Kräver Chrome på Android eller dator.
            <br />
            Se till att Bluetooth är aktiverat.
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
      <div className="flex items-center justify-between px-6 py-4 shrink-0">
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

      {/* Color canvas zone */}
      <div className="flex-1 px-4 pb-2 min-h-0">
        <ColorCanvas onColorChange={handleColorChange} />
      </div>

      {/* Brightness zone */}
      <div className="px-6 py-6 shrink-0">
        <div className="flex items-center gap-4">
          <Sun className="w-4 h-4 text-muted-foreground shrink-0" />
          <Slider
            value={[brightness]}
            onValueChange={handleBrightnessChange}
            min={0}
            max={100}
            step={1}
            className="flex-1"
          />
          <span className="text-xs text-muted-foreground w-8 text-right font-mono">
            {brightness}%
          </span>
        </div>
      </div>
    </div>
  );
};

export default Index;
