import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

interface EnergySample {
  t: number;
  rawRms: number;
  kick?: boolean;
  lo?: number;
  mid?: number;
  hi?: number;
}

interface SongSection {
  start: number;
  end: number;
  type: string;
}

interface Drop {
  t?: number;
  time?: number;
  buildStart?: number;
}

interface BrightnessSample {
  t: number;
  pct: number;
}

interface SongDetailData {
  energy_curve: EnergySample[] | null;
  brightness_curve: BrightnessSample[] | null;
  sections: SongSection[] | null;
  drops: Drop[] | null;
  bpm: number | null;
  recorded_volume: number | null;
}

const SECTION_COLORS: Record<string, string> = {
  intro: '#6366f1',
  verse: '#3b82f6',
  pre_chorus: '#8b5cf6',
  chorus: '#f59e0b',
  bridge: '#14b8a6',
  drop: '#ef4444',
  build_up: '#f97316',
  break: '#64748b',
  outro: '#6366f1',
};

const SECTION_LABELS: Record<string, string> = {
  intro: 'Intro', verse: 'Vers', pre_chorus: 'Pre-chorus',
  chorus: 'Refräng', bridge: 'Bridge', drop: 'Drop',
  build_up: 'Build-up', break: 'Break', outro: 'Outro',
};

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function SongDetailChart({ songId }: { songId: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [data, setData] = useState<SongDetailData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    supabase
      .from("song_analysis")
      .select("energy_curve, brightness_curve, sections, drops, bpm, recorded_volume")
      .eq("id", songId)
      .single()
      .then(({ data: d }) => {
        if (d) setData(d as any);
        setLoading(false);
      });
  }, [songId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data) return;

    const curve = data.energy_curve as EnergySample[] | null;
    const sections = data.sections as SongSection[] | null;
    const drops = data.drops as Drop[] | null;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = 'hsl(0 0% 5%)';
    ctx.fillRect(0, 0, w, h);

    if (!curve || curve.length < 2) {
      ctx.fillStyle = 'hsl(0 0% 40%)';
      ctx.font = '11px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('Ingen energikurva sparad', w / 2, h / 2);
      return;
    }

    const maxT = curve[curve.length - 1].t;
    const chartTop = 4;
    const chartBottom = h - 20;
    const chartH = chartBottom - chartTop;
    const sectionBarH = 14;
    const sectionBarTop = chartBottom + 2;
    const values = curve.map(s => s.rawRms);
    const peakVal = Math.max(...values, 0.001);

    const tToX = (t: number) => (t / maxT) * w;
    const valToY = (v: number) => chartBottom - Math.min(1, v / peakVal) * chartH;

    // Draw sections as colored bars
    if (sections && sections.length > 0) {
      for (const sec of sections) {
        const x1 = tToX(sec.start);
        const x2 = tToX(sec.end);
        const color = SECTION_COLORS[sec.type] || '#475569';
        // Background band on chart
        ctx.fillStyle = color + '15';
        ctx.fillRect(x1, chartTop, x2 - x1, chartH);
        // Section bar
        ctx.fillStyle = color + '90';
        ctx.fillRect(x1, sectionBarTop, x2 - x1, sectionBarH);
        // Label
        if (x2 - x1 > 30) {
          ctx.fillStyle = '#ffffffcc';
          ctx.font = '8px system-ui';
          ctx.textAlign = 'center';
          ctx.fillText(SECTION_LABELS[sec.type] ?? sec.type, (x1 + x2) / 2, sectionBarTop + 10);
        }
      }
    }

    // Draw drops as vertical lines
    if (drops && drops.length > 0) {
      for (const drop of drops) {
        const x = tToX(drop.time);
        ctx.strokeStyle = '#ef444480';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, chartTop);
        ctx.lineTo(x, chartBottom);
        ctx.stroke();
        ctx.setLineDash([]);
        // Build-up arrow
        if (drop.buildStart != null) {
          const bx = tToX(drop.buildStart);
          ctx.fillStyle = '#f9731640';
          ctx.beginPath();
          ctx.moveTo(bx, chartBottom);
          ctx.lineTo(x, chartBottom);
          ctx.lineTo(x, chartTop + chartH * 0.3);
          ctx.closePath();
          ctx.fill();
        }
      }
    }

    // Draw energy curve
    ctx.beginPath();
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 1;
    for (let i = 0; i < curve.length; i++) {
      const x = tToX(curve[i].t);
      const y = valToY(values[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Fill under curve
    const lastX = tToX(curve[curve.length - 1].t);
    ctx.lineTo(lastX, chartBottom);
    ctx.lineTo(tToX(curve[0].t), chartBottom);
    ctx.closePath();
    ctx.fillStyle = '#22d3ee12';
    ctx.fill();

    // Draw kick markers
    for (const s of curve) {
      if (s.kick) {
        const x = tToX(s.t);
        const y = valToY(s.rawRms);
        ctx.fillStyle = '#fbbf24';
        ctx.beginPath();
        ctx.arc(x, y, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Time labels
    ctx.fillStyle = '#ffffff50';
    ctx.font = '8px system-ui';
    ctx.textAlign = 'center';
    const step = maxT > 180 ? 60 : 30;
    for (let t = 0; t <= maxT; t += step) {
      const x = tToX(t);
      ctx.fillText(formatDuration(t), x, chartBottom - 2);
    }
  }, [data]);

  if (loading) {
    return <div className="py-3 text-center text-[10px] text-muted-foreground">Laddar…</div>;
  }

  if (!data) {
    return <div className="py-3 text-center text-[10px] text-muted-foreground">Kunde inte ladda data</div>;
  }

  const curve = data.energy_curve as EnergySample[] | null;
  const sections = data.sections as SongSection[] | null;
  const drops = data.drops as Drop[] | null;
  const duration = curve && curve.length > 1 ? curve[curve.length - 1].t : 0;

  return (
    <div className="space-y-1.5 pb-1">
      {/* Canvas chart */}
      <canvas
        ref={canvasRef}
        className="w-full rounded-md"
        style={{ height: sections ? 160 : 120 }}
      />

      {/* Stats row */}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[9px] font-mono text-muted-foreground px-0.5">
        {duration > 0 && <span>{formatDuration(duration)}</span>}
        {curve && <span>{curve.length} samples</span>}
        {data.bpm && <span>{data.bpm} BPM</span>}
        {data.recorded_volume != null && <span>Vol {data.recorded_volume}</span>}
        {sections && <span>{sections.length} sektioner</span>}
        {drops && drops.length > 0 && <span>{drops.length} drops</span>}
      </div>
    </div>
  );
}
