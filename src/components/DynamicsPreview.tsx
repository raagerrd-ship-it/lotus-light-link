import { useRef, useState, useCallback, useEffect } from "react";
import { Mic, MicOff, Hand } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DEFAULT_CALIBRATION, type LightCalibration } from "@/lib/lightCalibration";
import { sendBrightness } from "@/lib/bledom";

interface DynamicsPreviewProps {
  cal: LightCalibration;
  bleChar?: any;
}

/** Simulate attack/release EMA for a given energy sequence */
function applyEma(energy: number, prev: number, attack: number, release: number): number {
  const alpha = energy > prev ? attack : release;
  return prev + (energy - prev) * alpha;
}

function applyDamping(pct: number, damping: number): number {
  if (damping <= 1) return pct;
  return 100 * Math.pow(pct / 100, damping);
}

function clampPct(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(val)));
}

export default function DynamicsPreview({ cal, bleChar }: DynamicsPreviewProps) {
  const [mode, setMode] = useState<'tap' | 'mic'>('tap');
  const [micActive, setMicActive] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);

  // EMA state for current and default
  const emaCurRef = useRef(cal.minBrightness);
  const emaDefRef = useRef(DEFAULT_CALIBRATION.minBrightness);
  // Raw energy input (0–100)
  const energyRef = useRef(0);

  // Tap state
  const tapDecayRef = useRef(0);
  const lastTapRef = useRef(0);

  const handleTap = useCallback(() => {
    energyRef.current = 100;
    tapDecayRef.current = performance.now();
    lastTapRef.current = performance.now();
  }, []);

  // Start mic
  const startMic = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext({ latencyHint: "interactive", sampleRate: 8000 });
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0;
      source.connect(analyser);
      streamRef.current = stream;
      ctxRef.current = ctx;
      analyserRef.current = analyser;
      setMicActive(true);
    } catch {}
  }, []);

  const stopMic = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    ctxRef.current?.close();
    streamRef.current = null;
    ctxRef.current = null;
    analyserRef.current = null;
    setMicActive(false);
  }, []);

  // Animation loop
  useEffect(() => {
    const td = new Uint8Array(64);
    let agcAvg = 0.01;

    const loop = () => {
      const canvas = canvasRef.current;
      if (!canvas) { rafRef.current = requestAnimationFrame(loop); return; }
      const c = canvas.getContext('2d');
      if (!c) { rafRef.current = requestAnimationFrame(loop); return; }

      // Get energy
      let rawEnergy: number;
      if (mode === 'mic' && analyserRef.current) {
        analyserRef.current.getByteTimeDomainData(td);
        let sum = 0, max = 0;
        for (let i = 0; i < td.length; i++) {
          const v = (td[i] - 128) / 128;
          sum += v * v;
          const a = Math.abs(v);
          if (a > max) max = a;
        }
        const rms = Math.sqrt(sum / td.length);
        const raw = rms * 0.3 + max * 0.7;
        if (raw > 0.01) agcAvg += (raw - agcAvg) * 0.03;
        const gain = agcAvg > 0.0001 ? 0.35 / agcAvg : 1;
        rawEnergy = Math.min(100, raw * Math.min(gain, 30) * 100);
      } else {
        // Tap decay
        const elapsed = performance.now() - tapDecayRef.current;
        rawEnergy = elapsed < 800 ? energyRef.current * Math.pow(Math.max(0, 1 - elapsed / 800), 1.5) : 0;
      }

      // Apply EMA with current calibration
      emaCurRef.current = applyEma(rawEnergy, emaCurRef.current, cal.attackAlpha, cal.releaseAlpha);
      let pctCur = applyDamping(emaCurRef.current, cal.dynamicDamping);
      pctCur = clampPct(pctCur, cal.minBrightness, cal.maxBrightness);

      // Apply EMA with default calibration
      emaDefRef.current = applyEma(rawEnergy, emaDefRef.current, DEFAULT_CALIBRATION.attackAlpha, DEFAULT_CALIBRATION.releaseAlpha);
      let pctDef = applyDamping(emaDefRef.current, DEFAULT_CALIBRATION.dynamicDamping);
      pctDef = clampPct(pctDef, DEFAULT_CALIBRATION.minBrightness, DEFAULT_CALIBRATION.maxBrightness);

      // Send to BLE
      if (bleChar) {
        sendBrightness(bleChar, pctCur).catch(() => {});
      }

      // Draw
      const W = canvas.width;
      const H = canvas.height;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== canvas.offsetWidth * dpr) {
        canvas.width = canvas.offsetWidth * dpr;
        canvas.height = canvas.offsetHeight * dpr;
      }

      c.clearRect(0, 0, W, H);

      const barW = W * 0.38;
      const gap = W * 0.06;
      const x1 = W / 2 - barW - gap / 2;
      const x2 = W / 2 + gap / 2;
      const barH = H - 30 * dpr;
      const y0 = 10 * dpr;

      // Default bar (dimmer)
      const hDef = (pctDef / 100) * barH;
      c.fillStyle = 'hsla(0, 0%, 45%, 0.3)';
      c.fillRect(x1, y0, barW, barH);
      c.fillStyle = 'hsla(0, 0%, 60%, 0.6)';
      c.fillRect(x1, y0 + barH - hDef, barW, hDef);

      // Current bar (bright)
      const hCur = (pctCur / 100) * barH;
      c.fillStyle = 'hsla(0, 0%, 45%, 0.3)';
      c.fillRect(x2, y0, barW, barH);
      c.fillStyle = 'hsla(142, 70%, 50%, 0.7)';
      c.fillRect(x2, y0 + barH - hCur, barW, hCur);

      // Labels
      c.fillStyle = 'hsla(0, 0%, 70%, 0.8)';
      c.font = `${10 * dpr}px monospace`;
      c.textAlign = 'center';
      c.fillText('Default', x1 + barW / 2, y0 + barH + 16 * dpr);
      c.fillText('Din', x2 + barW / 2, y0 + barH + 16 * dpr);

      // Percentage labels on bars
      c.fillStyle = 'hsla(0, 0%, 92%, 0.9)';
      c.font = `bold ${12 * dpr}px monospace`;
      c.fillText(`${pctDef}%`, x1 + barW / 2, y0 + barH - hDef - 6 * dpr);
      c.fillText(`${pctCur}%`, x2 + barW / 2, y0 + barH - hCur - 6 * dpr);

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(rafRef.current);
    };
  }, [mode, cal]);

  // Cleanup mic on unmount
  useEffect(() => () => stopMic(), [stopMic]);

  return (
    <div className="mb-4">
      {/* Mode toggle */}
      <div className="flex items-center gap-2 mb-2">
        <Button
          variant={mode === 'tap' ? 'default' : 'outline'}
          size="sm"
          className="text-xs gap-1 h-7"
          onClick={() => { setMode('tap'); if (micActive) stopMic(); }}
        >
          <Hand className="w-3 h-3" /> Tap
        </Button>
        <Button
          variant={mode === 'mic' ? 'default' : 'outline'}
          size="sm"
          className="text-xs gap-1 h-7"
          onClick={() => { setMode('mic'); if (!micActive) startMic(); }}
        >
          {micActive ? <Mic className="w-3 h-3" /> : <MicOff className="w-3 h-3" />} Mikrofon
        </Button>
        <span className="text-[9px] text-muted-foreground font-mono ml-auto">före / efter</span>
      </div>

      {/* Tap target + canvas */}
      <div className="relative">
        <canvas
          ref={canvasRef}
          className="w-full rounded-lg border border-border/30"
          style={{ height: 120, touchAction: 'none' }}
          onPointerDown={mode === 'tap' ? handleTap : undefined}
        />
        {mode === 'tap' && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span className="text-xs text-muted-foreground/40 font-mono">tryck för beat</span>
          </div>
        )}
      </div>
    </div>
  );
}
