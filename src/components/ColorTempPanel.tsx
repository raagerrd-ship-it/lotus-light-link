import { useState } from "react";
import { Slider } from "@/components/ui/slider";
import { sendColorTemp } from "@/lib/bledom";

interface ColorTempPanelProps {
  char: any;
}

export default function ColorTempPanel({ char }: ColorTempPanelProps) {
  const [warmth, setWarmth] = useState(50);

  const handleChange = (value: number[]) => {
    const val = value[0];
    setWarmth(val);
    if (char) {
      sendColorTemp(char, val).catch(() => {});
    }
  };

  // Visual gradient from cool to warm
  const coolColor = "hsl(210 60% 70%)";
  const warmColor = "hsl(35 90% 60%)";
  const currentColor = warmth > 50
    ? `hsl(${35 + (210 - 35) * (1 - warmth / 100)} ${60 + 30 * (warmth / 100)}% ${60 + 10 * (1 - warmth / 100)}%)`
    : `hsl(${210 - (210 - 35) * (warmth / 100)} ${60 + 30 * (1 - warmth / 100)}% ${60 + 10 * (warmth / 100)}%)`;

  return (
    <div className="flex flex-col items-center justify-center h-full gap-8 px-4">
      {/* Visual indicator */}
      <div
        className="w-40 h-40 rounded-full transition-all duration-500 shadow-lg"
        style={{
          background: `radial-gradient(circle, ${currentColor}, transparent)`,
          boxShadow: `0 0 60px ${currentColor}`,
        }}
      />

      <div className="w-full max-w-md">
        <div
          className="h-3 rounded-full mb-4"
          style={{
            background: `linear-gradient(to right, ${coolColor}, hsl(0 0% 100%), ${warmColor})`,
          }}
        />
        <Slider
          value={[warmth]}
          onValueChange={handleChange}
          min={0}
          max={100}
          step={1}
        />
        <div className="flex justify-between mt-2">
          <span className="text-xs text-muted-foreground">Kallvit 6500K</span>
          <span className="text-sm font-mono text-foreground">
            {Math.round(6500 - warmth * 38)}K
          </span>
          <span className="text-xs text-muted-foreground">Varmvit 2700K</span>
        </div>
      </div>
    </div>
  );
}
