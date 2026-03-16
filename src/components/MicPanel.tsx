import { useEffect, useRef } from "react";
import { LightEngine, type TickData } from "@/lib/engine/lightEngine";
import { drawIntensityChart, type ChartSample, resetChartScaler } from "@/lib/ui/drawChart";
import { pushChartSample, getChartSamples } from "@/lib/ui/chartStore";
import { setPipelineTimings } from "@/lib/ui/pipelineTimings";

interface MicPanelProps {
  char?: BluetoothRemoteGATTCharacteristic;
  currentColor: [number, number, number];
  sonosVolume?: number;
  isPlaying?: boolean;
  trackName?: string | null;
  historyLen?: number;
  tickMs?: number;
  onLiveStatus?: (status: { brightness: number; color: [number, number, number]; bassLevel: number; midHiLevel: number; bleSentColor?: [number, number, number]; bleSentBright?: number; bleColorSource?: 'normal' | 'idle'; micRms?: number; isPlayingState?: boolean; isPunch?: boolean }) => void;
}

const HISTORY_LEN = 120;

const MicPanel = ({ char, currentColor, sonosVolume, isPlaying = true, trackName, historyLen: historyLenProp, tickMs = 125, onLiveStatus }: MicPanelProps) => {
  const effectiveHistoryLen = historyLenProp ?? HISTORY_LEN;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<LightEngine | null>(null);
  const samplesRef = useRef<ChartSample[]>([]);
  const rafIdRef = useRef(0);
  const lastSampleTimeRef = useRef(0);
  const onLiveStatusRef = useRef(onLiveStatus);

  // Keep callback ref fresh
  useEffect(() => { onLiveStatusRef.current = onLiveStatus; }, [onLiveStatus]);

  // ── Sync props to engine ──
  useEffect(() => { engineRef.current?.setChar(char ?? null); }, [char]);
  useEffect(() => { engineRef.current?.setColor(currentColor); }, [currentColor]);
  useEffect(() => { engineRef.current?.setVolume(sonosVolume); }, [sonosVolume]);
  useEffect(() => { engineRef.current?.setPlaying(isPlaying); }, [isPlaying]);
  const lastTrackRef = useRef(trackName);
  useEffect(() => {
    if (trackName && trackName !== lastTrackRef.current) {
      lastTrackRef.current = trackName;
      engineRef.current?.resetSmoothing();
    }
  }, [trackName]);
  useEffect(() => { engineRef.current?.setTickMs(tickMs); }, [tickMs]);

  // ── Chart rendering via rAF ──
  useEffect(() => {
    const drawLoop = (now: number) => {
      const canvas = canvasRef.current;
      if (canvas) {
        const elapsed = now - lastSampleTimeRef.current;
        const scrollFraction = Math.min(1, elapsed / tickMs);
        drawIntensityChart(canvas, samplesRef.current, effectiveHistoryLen, scrollFraction);
      }
      rafIdRef.current = requestAnimationFrame(drawLoop);
    };
    rafIdRef.current = requestAnimationFrame(drawLoop);
    return () => cancelAnimationFrame(rafIdRef.current);
  }, [tickMs]);

  // ── Main engine lifecycle ──
  useEffect(() => {
    const engine = new LightEngine();
    engineRef.current = engine;

    // Apply initial props
    engine.setColor(currentColor);
    engine.setVolume(sonosVolume);
    engine.setPlaying(isPlaying);
    engine.setTickMs(tickMs);
    if (char) engine.setChar(char);
    if (trackName) { lastTrackRef.current = trackName; }

    // Listen for ticks → update chart + forward status
    const unsub = engine.onTick((data: TickData) => {
      const base = data.baseColor;
      const sample: ChartSample = {
        pct: data.brightness,
        r: Math.max(data.color[0], 20), g: Math.max(data.color[1], 20), b: Math.max(data.color[2], 20),
        rawPct: data.rawEnergyPct,
        baseR: base[0], baseG: base[1], baseB: base[2],
      };
      samplesRef.current.push(sample);
      lastSampleTimeRef.current = performance.now();
      pushChartSample(sample);
      if (samplesRef.current.length > effectiveHistoryLen) {
        samplesRef.current = samplesRef.current.slice(-effectiveHistoryLen);
      }

      setPipelineTimings(data.timings);

      onLiveStatusRef.current?.({
        brightness: data.brightness,
        color: data.color,
        bassLevel: data.bassLevel,
        midHiLevel: data.midHiLevel,
        bleSentColor: data.baseColor,
        bleSentBright: data.brightness,
        bleColorSource: data.bleColorSource,
        micRms: data.micRms,
        isPlayingState: data.isPlaying,
        isPunch: data.isPunch,
      });
    });

    engine.start();

    return () => {
      unsub();
      engine.stop();
      resetChartScaler();
    };
  }, []);

  // ── Canvas resize ──
  useEffect(() => {
    const resize = () => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;
      canvas.width = container.clientWidth * devicePixelRatio;
      canvas.height = container.clientHeight * devicePixelRatio;
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  return (
    <div className="absolute inset-0" ref={containerRef}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ opacity: 0.9 }}
      />
    </div>
  );
};

export default MicPanel;
