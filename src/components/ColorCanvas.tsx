import { useRef, useCallback, useEffect, useState } from "react";
import { hsvToRgb } from "@/lib/bledom";

interface ColorCanvasProps {
  onColorChange: (h: number, s: number, r: number, g: number, b: number) => void;
}

export default function ColorCanvas({ onColorChange }: ColorCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDrawn, setIsDrawn] = useState(false);
  const [marker, setMarker] = useState<{ x: number; y: number } | null>(null);

  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const { width, height } = canvas;

    // Draw hue-saturation gradient
    for (let x = 0; x < width; x++) {
      const hue = (x / width) * 360;
      for (let y = 0; y < height; y++) {
        const saturation = 1 - y / height;
        const [r, g, b] = hsvToRgb(hue, saturation, 1);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(x, y, 1, 1);
      }
    }
    setIsDrawn(true);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const resize = () => {
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
      drawCanvas();
    };

    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [drawCanvas]);

  const handleInteraction = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(clientX - rect.left, rect.width - 1));
      const y = Math.max(0, Math.min(clientY - rect.top, rect.height - 1));

      const hue = (x / rect.width) * 360;
      const saturation = 1 - y / rect.height;
      const [r, g, b] = hsvToRgb(hue, saturation, 1);

      setMarker({ x, y });
      onColorChange(hue, saturation, r, g, b);
    },
    [onColorChange]
  );

  const handlePointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    handleInteraction(e.clientX, e.clientY);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (e.buttons > 0) {
      handleInteraction(e.clientX, e.clientY);
    }
  };

  return (
    <div ref={containerRef} className="relative w-full h-full rounded-xl overflow-hidden border border-border">
      <canvas
        ref={canvasRef}
        className="w-full h-full touch-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
      />
      {marker && (
        <div
          className="absolute pointer-events-none w-7 h-7 rounded-full border-2 border-foreground shadow-lg"
          style={{
            left: marker.x - 14,
            top: marker.y - 14,
            boxShadow: "0 0 12px rgba(0,0,0,0.6)",
          }}
        />
      )}
      {!isDrawn && (
        <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
          Laddar...
        </div>
      )}
    </div>
  );
}
