import { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { sendMicMode, sendMicEq, sendBrightness, MIC_EQ_MODES, MIC_EQ_LABELS, type MicEqKey } from "@/lib/bledom";
import { Mic, MicOff, Activity } from "lucide-react";

interface MicPanelProps {
  char: any;
}

type MicMode = "device" | "phone";

export default function MicPanel({ char }: MicPanelProps) {
  const [micOn, setMicOn] = useState(false);
  const [activeEq, setActiveEq] = useState<MicEqKey>("classic");
  const [mode, setMode] = useState<MicMode>("device");

  // Phone mic state
  const [phoneMicActive, setPhoneMicActive] = useState(false);
  const [volume, setVolume] = useState(0);
  const [sensitivity, setSensitivity] = useState(70);
  const [minBrightness, setMinBrightness] = useState(5);
  const [maxBrightness, setMaxBrightness] = useState(100);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const throttleRef = useRef<number>(0);

  const stopPhoneMic = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    audioContextRef.current?.close();
    audioContextRef.current = null;
    analyserRef.current = null;
    streamRef.current = null;
    setPhoneMicActive(false);
    setVolume(0);
  }, []);

  const startPhoneMic = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.5;
      source.connect(analyser);

      audioContextRef.current = ctx;
      analyserRef.current = analyser;
      streamRef.current = stream;
      setPhoneMicActive(true);
    } catch {
      // Mic access denied
    }
  }, []);

  // Audio loop – read volume and send brightness
  useEffect(() => {
    if (!phoneMicActive || !analyserRef.current || !char) return;

    const analyser = analyserRef.current;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    const loop = () => {
      analyser.getByteFrequencyData(dataArray);

      // RMS volume
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i] * dataArray[i];
      }
      const rms = Math.sqrt(sum / dataArray.length);
      const normalized = Math.min(1, (rms / 128) * (sensitivity / 50));
      setVolume(normalized);

      // Map to brightness range, throttle BLE writes to 50ms
      const now = Date.now();
      if (now - throttleRef.current >= 50) {
        throttleRef.current = now;
        const brightness = Math.round(minBrightness + normalized * (maxBrightness - minBrightness));
        sendBrightness(char, brightness).catch(() => {});
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [phoneMicActive, char, sensitivity, minBrightness, maxBrightness]);

  // Cleanup on unmount
  useEffect(() => stopPhoneMic, [stopPhoneMic]);

  const handleDeviceMicToggle = async (on: boolean) => {
    setMicOn(on);
    if (char) await sendMicMode(char, on).catch(() => {});
  };

  const handleEq = async (key: MicEqKey) => {
    setActiveEq(key);
    if (char) await sendMicEq(char, MIC_EQ_MODES[key]).catch(() => {});
  };

  const handlePhoneMicToggle = async (on: boolean) => {
    if (on) {
      // Make sure device mic is off
      if (micOn) {
        setMicOn(false);
        if (char) await sendMicMode(char, false).catch(() => {});
      }
      await startPhoneMic();
    } else {
      stopPhoneMic();
      // Restore brightness
      if (char) await sendBrightness(char, 80).catch(() => {});
    }
  };

  return (
    <div className="flex flex-col gap-6 px-4 pb-4 overflow-y-auto h-full">
      {/* Mode tabs */}
      <div className="flex gap-2">
        <Button
          variant={mode === "phone" ? "default" : "outline"}
          size="sm"
          className="flex-1"
          onClick={() => setMode("phone")}
        >
          <Activity className="w-3.5 h-3.5 mr-1.5" />
          Ljuspuls
        </Button>
        <Button
          variant={mode === "device" ? "default" : "outline"}
          size="sm"
          className="flex-1"
          onClick={() => setMode("device")}
        >
          <Mic className="w-3.5 h-3.5 mr-1.5" />
          Enhetens mikrofon
        </Button>
      </div>

      {mode === "phone" ? (
        <div className="flex flex-col items-center gap-6">
          {/* Volume visualizer */}
          <div
            className="w-32 h-32 rounded-full border-2 flex items-center justify-center transition-all duration-100"
            style={{
              borderColor: phoneMicActive ? "hsl(var(--foreground))" : "hsl(var(--border))",
              boxShadow: phoneMicActive ? `0 0 ${volume * 60}px ${volume * 20}px hsl(var(--foreground) / ${volume * 0.3})` : "none",
              transform: `scale(${1 + volume * 0.15})`,
            }}
          >
            <Activity
              className="w-12 h-12 transition-all"
              style={{ opacity: phoneMicActive ? 0.5 + volume * 0.5 : 0.3 }}
            />
          </div>

          {/* Toggle */}
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">Ljuspuls</span>
            <Switch checked={phoneMicActive} onCheckedChange={handlePhoneMicToggle} />
            <span className="text-sm font-bold">{phoneMicActive ? "PÅ" : "AV"}</span>
          </div>

          {phoneMicActive && (
            <div className="w-full max-w-xs flex flex-col gap-4">
              <div>
                <div className="flex justify-between mb-1">
                  <span className="text-xs text-muted-foreground">Känslighet</span>
                  <span className="text-xs font-mono text-muted-foreground">{sensitivity}%</span>
                </div>
                <Slider value={[sensitivity]} onValueChange={(v) => setSensitivity(v[0])} min={10} max={100} step={5} />
              </div>
              <div>
                <div className="flex justify-between mb-1">
                  <span className="text-xs text-muted-foreground">Min ljusstyrka</span>
                  <span className="text-xs font-mono text-muted-foreground">{minBrightness}%</span>
                </div>
                <Slider value={[minBrightness]} onValueChange={(v) => setMinBrightness(v[0])} min={0} max={50} step={5} />
              </div>
              <div>
                <div className="flex justify-between mb-1">
                  <span className="text-xs text-muted-foreground">Max ljusstyrka</span>
                  <span className="text-xs font-mono text-muted-foreground">{maxBrightness}%</span>
                </div>
                <Slider value={[maxBrightness]} onValueChange={(v) => setMaxBrightness(v[0])} min={50} max={100} step={5} />
              </div>
            </div>
          )}

          <p className="text-xs text-muted-foreground text-center max-w-xs">
            {phoneMicActive
              ? "Ljusstyrkan pulserar med musiken – din valda färg behålls"
              : "Använder telefonens mikrofon för att styra ljusstyrkan efter musiken. Färgen du valt behålls."
            }
          </p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-6">
          <div className={`w-32 h-32 rounded-full border-2 flex items-center justify-center transition-all duration-300 ${
            micOn ? "border-foreground" : "border-border"
          }`}>
            {micOn
              ? <Mic className="w-12 h-12 text-foreground" />
              : <MicOff className="w-12 h-12 text-muted-foreground" />
            }
          </div>

          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">Ljudreaktion</span>
            <Switch checked={micOn} onCheckedChange={handleDeviceMicToggle} />
            <span className="text-sm font-bold">{micOn ? "PÅ" : "AV"}</span>
          </div>

          {micOn && (
            <div className="w-full max-w-xs">
              <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3 text-center">
                Visualisering
              </h3>
              <div className="grid grid-cols-2 gap-2">
                {(Object.keys(MIC_EQ_MODES) as MicEqKey[]).map((key) => (
                  <Button
                    key={key}
                    variant={activeEq === key ? "default" : "outline"}
                    size="sm"
                    onClick={() => handleEq(key)}
                  >
                    {MIC_EQ_LABELS[key]}
                  </Button>
                ))}
              </div>
            </div>
          )}

          <p className="text-xs text-muted-foreground text-center max-w-xs">
            {micOn
              ? "Ljusslingan reagerar på ljud via dess inbyggda mikrofon – både färg och ljusstyrka ändras"
              : "Använder ljusslingans inbyggda mikrofon. Både färg och ljusstyrka styrs av enheten."
            }
          </p>
        </div>
      )}
    </div>
  );
}
