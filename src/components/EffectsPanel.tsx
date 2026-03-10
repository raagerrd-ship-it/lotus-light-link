import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { EFFECTS, EFFECT_LABELS, sendEffect, sendEffectSpeed, type EffectKey } from "@/lib/bledom";

interface EffectsPanelProps {
  char: any;
}

const EFFECT_GROUPS = {
  "Tona": ["crossfade_rgb", "crossfade_rgbycmw", "crossfade_rg", "crossfade_rb", "crossfade_gb", "crossfade_red", "crossfade_green", "crossfade_blue", "crossfade_yellow", "crossfade_cyan", "crossfade_magenta", "crossfade_white"] as EffectKey[],
  "Hoppa": ["jump_rgb", "jump_rgbycmw"] as EffectKey[],
  "Blinka": ["blink_rgbycmw", "blink_red", "blink_green", "blink_blue", "blink_yellow", "blink_cyan", "blink_magenta", "blink_white"] as EffectKey[],
};

const EFFECT_COLORS: Partial<Record<EffectKey, string>> = {
  crossfade_red: "hsl(0 80% 50%)", blink_red: "hsl(0 80% 50%)",
  crossfade_green: "hsl(120 60% 40%)", blink_green: "hsl(120 60% 40%)",
  crossfade_blue: "hsl(220 80% 55%)", blink_blue: "hsl(220 80% 55%)",
  crossfade_yellow: "hsl(50 90% 50%)", blink_yellow: "hsl(50 90% 50%)",
  crossfade_cyan: "hsl(180 70% 45%)", blink_cyan: "hsl(180 70% 45%)",
  crossfade_magenta: "hsl(300 70% 50%)", blink_magenta: "hsl(300 70% 50%)",
  crossfade_white: "hsl(0 0% 80%)", blink_white: "hsl(0 0% 80%)",
};

export default function EffectsPanel({ char }: EffectsPanelProps) {
  const [activeEffect, setActiveEffect] = useState<EffectKey | null>(null);
  const [speed, setSpeed] = useState(50);

  const handleEffect = async (key: EffectKey) => {
    setActiveEffect(key);
    if (char) {
      await sendEffect(char, EFFECTS[key]).catch(() => {});
    }
  };

  const handleSpeedChange = (value: number[]) => {
    const val = value[0];
    setSpeed(val);
    if (char) {
      sendEffectSpeed(char, val).catch(() => {});
    }
  };

  return (
    <div className="flex flex-col gap-5 pb-4">
      {Object.entries(EFFECT_GROUPS).map(([group, keys]) => (
        <div key={group}>
          <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-2">{group}</h3>
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
            {keys.map((key) => (
              <Button
                key={key}
                variant={activeEffect === key ? "default" : "outline"}
                size="sm"
                className="text-xs h-9 transition-all"
                style={activeEffect === key && EFFECT_COLORS[key]
                  ? { backgroundColor: EFFECT_COLORS[key], borderColor: EFFECT_COLORS[key], color: "#121212" }
                  : EFFECT_COLORS[key]
                    ? { borderColor: EFFECT_COLORS[key], color: EFFECT_COLORS[key] }
                    : undefined
                }
                onClick={() => handleEffect(key)}
              >
                {EFFECT_LABELS[key]}
              </Button>
            ))}
          </div>
        </div>
      ))}

      <div>
        <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-2">Hastighet</h3>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">Långsam</span>
          <Slider
            value={[speed]}
            onValueChange={handleSpeedChange}
            min={0}
            max={100}
            step={1}
            className="flex-1"
          />
          <span className="text-xs text-muted-foreground">Snabb</span>
        </div>
      </div>
    </div>
  );
}
