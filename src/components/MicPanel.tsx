import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { sendMicMode, sendMicEq, MIC_EQ_MODES, MIC_EQ_LABELS, type MicEqKey } from "@/lib/bledom";
import { Mic, MicOff } from "lucide-react";

interface MicPanelProps {
  char: any;
}

export default function MicPanel({ char }: MicPanelProps) {
  const [micOn, setMicOn] = useState(false);
  const [activeEq, setActiveEq] = useState<MicEqKey>("classic");

  const handleMicToggle = async (on: boolean) => {
    setMicOn(on);
    if (char) {
      await sendMicMode(char, on).catch(() => {});
    }
  };

  const handleEq = async (key: MicEqKey) => {
    setActiveEq(key);
    if (char) {
      await sendMicEq(char, MIC_EQ_MODES[key]).catch(() => {});
    }
  };

  return (
    <div className="flex flex-col items-center justify-center h-full gap-8 px-4">
      {/* Mic icon */}
      <div className={`w-32 h-32 rounded-full border-2 flex items-center justify-center transition-all duration-300 ${
        micOn ? "border-foreground" : "border-border"
      }`}>
        {micOn
          ? <Mic className="w-12 h-12 text-foreground" />
          : <MicOff className="w-12 h-12 text-muted-foreground" />
        }
      </div>

      {/* Toggle */}
      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">Ljudreaktion</span>
        <Switch checked={micOn} onCheckedChange={handleMicToggle} />
        <span className="text-sm font-bold">{micOn ? "PÅ" : "AV"}</span>
      </div>

      {/* EQ modes */}
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
          ? "Ljusslingan reagerar nu på ljud via dess inbyggda mikrofon"
          : "Aktivera för att ljusslingan ska reagera på ljud och musik"
        }
      </p>
    </div>
  );
}
