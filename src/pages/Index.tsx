import { useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import ColorCanvas from "@/components/ColorCanvas";
import MicPanel from "@/components/MicPanel";
import {
  connectBLEDOM, reconnectLastDevice, getLastDevice,
  sendColor, sendBrightness, sendPower, hsvToRgb,
  type BLEConnection
} from "@/lib/bledom";
import { Power, Bluetooth, Sun, Zap, Palette, Activity } from "lucide-react";

const Index = () => {
  const [connection, setConnection] = useState<BLEConnection | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentColor, setCurrentColor] = useState<[number, number, number]>([255, 255, 255]);
  const [brightness, setBrightness] = useState(80);
  const [isOn, setIsOn] = useState(true);
  const [activeTab, setActiveTab] = useState("color");
  const throttleRef = useRef<number>(0);
  const lastDevice = getLastDevice();

  const finishConnect = async (conn: BLEConnection) => {
    setConnection(conn);
    await sendPower(conn.characteristic, true);
    await sendBrightness(conn.characteristic, 80);
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

  const handleColorChange = useCallback(
    (_h: number, _s: number, r: number, g: number, b: number) => {
      setCurrentColor([r, g, b]);
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

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
        <TabsList className="mx-4 bg-secondary/50 shrink-0">
          <TabsTrigger value="color" className="flex-1 gap-1.5 text-sm">
            <Palette className="w-4 h-4" /> Färg
          </TabsTrigger>
          <TabsTrigger value="mic" className="flex-1 gap-1.5 text-sm">
            <Activity className="w-4 h-4" /> Baspuls
          </TabsTrigger>
        </TabsList>

        <TabsContent value="color" className="flex-1 min-h-0 px-4 pt-2 pb-0 mt-0">
          <ColorCanvas onColorChange={handleColorChange} />
        </TabsContent>

        <TabsContent value="mic" className="flex-1 min-h-0 px-4 pt-2 pb-0 mt-0">
          <MicPanel char={char} />
        </TabsContent>
      </Tabs>

      {/* Brightness zone */}
      <div className="px-6 py-4 shrink-0">
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
