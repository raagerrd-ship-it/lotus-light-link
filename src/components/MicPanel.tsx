import { useEffect, useRef } from "react";
import { LightEngine, DEFAULT_TICK_MS, type TickData } from "@/lib/engine/lightEngine";
import { drawIntensityChart, type ChartSample, resetChartScaler } from "@/lib/ui/drawChart";
import { pushChartSample, getChartSamples, clearChartSamples } from "@/lib/ui/chartStore";
import { setPipelineTimings } from "@/lib/ui/pipelineTimings";
import { debugData } from "@/lib/ui/debugStore";

interface MicPanelProps {
  char?: BluetoothRemoteGATTCharacteristic;
  currentColor: [number, number, number];
  palette?: [number, number, number][];
  sonosVolume?: number;
  isPlaying?: boolean;
  trackName?: string | null;
  historyLen?: number;
  tickMs?: number;
  chartEnabled?: boolean;
  onLiveStatus?: (status: { brightness: number; color: [number, number, number]; bassLevel: number; midHiLevel: number; bleSentColor?: [number, number, number]; bleSentBright?: number; bleColorSource?: 'normal' | 'idle'; micRms?: number; isPlayingState?: boolean; isPunch?: boolean }) => void;
}

const HISTORY_LEN = 64; // ~8s at 8Hz, fewer visible points

const MicPanel = ({ char, currentColor, palette, sonosVolume, isPlaying = true, trackName, historyLen: historyLenProp, tickMs = DEFAULT_TICK_MS, chartEnabled = true, onLiveStatus }: MicPanelProps) => {
  const effectiveHistoryLen = historyLenProp ?? HISTORY_LEN;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<LightEngine | null>(null);
  // samplesRef removed — single ring buffer in chartStore
  const rafIdRef = useRef(0);
  const lastSampleTimeRef = useRef(0);
  const onLiveStatusRef = useRef(onLiveStatus);
  const lastBleCountRef = useRef(0);

  // Keep callback ref fresh
  useEffect(() => { onLiveStatusRef.current = onLiveStatus; }, [onLiveStatus]);

  // ── Sync props to engine ──
  useEffect(() => { engineRef.current?.setChar(char ?? null); }, [char]);
  useEffect(() => { engineRef.current?.setColor(currentColor); }, [currentColor]);
  useEffect(() => { engineRef.current?.setPalette(palette ?? []); }, [palette]);
  useEffect(() => { engineRef.current?.setVolume(sonosVolume); }, [sonosVolume]);
  useEffect(() => { engineRef.current?.setPlaying(isPlaying); }, [isPlaying]);
  const lastTrackRef = useRef(trackName);
  useEffect(() => {
    if (trackName && trackName !== lastTrackRef.current) {
      lastTrackRef.current = trackName;
      // Reset engine smoothing + AGC
      engineRef.current?.resetSmoothing();
      // Clear chart ring buffer + peak scaler
      clearChartSamples();
      resetChartScaler();
      // Reset all debug counters
      debugData.bleSentCount = 0;
      debugData.bleSkipDeltaCount = 0;
      debugData.bleSkipThrottleCount = 0;
      debugData.bleSkipBusyCount = 0;
      debugData.bleWriteLatMs = 0;
      debugData.bleWriteLatAvgMs = 0;
      debugData.pipelineTotalMs = 0;
      debugData.pipelineBleMs = 0;
    }
  }, [trackName]);
  useEffect(() => { engineRef.current?.setTickMs(tickMs); debugData.tickMs = tickMs; }, [tickMs]);

  // ── Chart rendering via rAF (skip when chart disabled) ──
  const chartEnabledRef = useRef(chartEnabled);
  useEffect(() => { chartEnabledRef.current = chartEnabled; }, [chartEnabled]);

  useEffect(() => {
    const FRAME_MS = 1000 / 30; // 30fps cap
    let lastFrame = 0;
    const drawLoop = (now: number) => {
      rafIdRef.current = requestAnimationFrame(drawLoop);
      if (!chartEnabledRef.current) return;
      if (now - lastFrame < FRAME_MS) return;
      lastFrame = now;
      const canvas = canvasRef.current;
      if (canvas) {
        const elapsed = now - lastSampleTimeRef.current;
        const scrollFraction = Math.min(1, elapsed / tickMs);
        drawIntensityChart(canvas, getChartSamples(effectiveHistoryLen), effectiveHistoryLen, scrollFraction);
      }
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
      pushChartSample(sample);
      lastSampleTimeRef.current = performance.now();

      setPipelineTimings(data.timings);
      // Only update pipeline display when a BLE write actually happened this tick
      const currentSent = debugData.bleSentCount;
      if (currentSent !== lastBleCountRef.current) {
        lastBleCountRef.current = currentSent;
        debugData.pipelineTotalMs = data.timings.totalTickMs;
        debugData.pipelineBleMs = debugData.bleWriteLatMs;
      }

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
      engine.destroy();
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
