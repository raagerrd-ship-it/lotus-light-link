import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { sendScheduleOn, sendScheduleOff, WEEKDAYS } from "@/lib/bledom";

interface SchedulePanelProps {
  char: any;
}

const DAY_LABELS: { key: keyof typeof WEEKDAYS; label: string; short: string }[] = [
  { key: "monday", label: "Måndag", short: "Mån" },
  { key: "tuesday", label: "Tisdag", short: "Tis" },
  { key: "wednesday", label: "Onsdag", short: "Ons" },
  { key: "thursday", label: "Torsdag", short: "Tor" },
  { key: "friday", label: "Fredag", short: "Fre" },
  { key: "saturday", label: "Lördag", short: "Lör" },
  { key: "sunday", label: "Söndag", short: "Sön" },
];

export default function SchedulePanel({ char }: SchedulePanelProps) {
  const [onEnabled, setOnEnabled] = useState(false);
  const [offEnabled, setOffEnabled] = useState(false);
  const [onHour, setOnHour] = useState(7);
  const [onMinute, setOnMinute] = useState(0);
  const [offHour, setOffHour] = useState(23);
  const [offMinute, setOffMinute] = useState(0);
  const [onDays, setOnDays] = useState<Set<keyof typeof WEEKDAYS>>(new Set());
  const [offDays, setOffDays] = useState<Set<keyof typeof WEEKDAYS>>(new Set());

  const getDayMask = (days: Set<keyof typeof WEEKDAYS>) => {
    let mask = 0;
    days.forEach((d) => { mask |= WEEKDAYS[d]; });
    return mask;
  };

  const toggleDay = (set: Set<keyof typeof WEEKDAYS>, setFn: (s: Set<keyof typeof WEEKDAYS>) => void, day: keyof typeof WEEKDAYS) => {
    const next = new Set(set);
    if (next.has(day)) next.delete(day);
    else next.add(day);
    setFn(next);
  };

  const applyScheduleOn = async () => {
    if (!char) return;
    await sendScheduleOn(char, onHour, onMinute, getDayMask(onDays), onEnabled).catch(() => {});
  };

  const applyScheduleOff = async () => {
    if (!char) return;
    await sendScheduleOff(char, offHour, offMinute, getDayMask(offDays), offEnabled).catch(() => {});
  };

  const TimeInput = ({ hour, minute, setHour, setMinute }: { hour: number; minute: number; setHour: (h: number) => void; setMinute: (m: number) => void }) => (
    <div className="flex items-center gap-1">
      <input
        type="number"
        min={0}
        max={23}
        value={hour.toString().padStart(2, "0")}
        onChange={(e) => setHour(Math.max(0, Math.min(23, parseInt(e.target.value) || 0)))}
        className="w-12 h-10 rounded-md bg-secondary text-foreground text-center font-mono text-lg border border-border focus:outline-none focus:ring-1 focus:ring-ring"
      />
      <span className="text-lg font-bold text-muted-foreground">:</span>
      <input
        type="number"
        min={0}
        max={59}
        value={minute.toString().padStart(2, "0")}
        onChange={(e) => setMinute(Math.max(0, Math.min(59, parseInt(e.target.value) || 0)))}
        className="w-12 h-10 rounded-md bg-secondary text-foreground text-center font-mono text-lg border border-border focus:outline-none focus:ring-1 focus:ring-ring"
      />
    </div>
  );

  const DayPicker = ({ days, setDays }: { days: Set<keyof typeof WEEKDAYS>; setDays: (s: Set<keyof typeof WEEKDAYS>) => void }) => (
    <div className="flex gap-1.5 flex-wrap">
      {DAY_LABELS.map(({ key, short }) => (
        <button
          key={key}
          onClick={() => toggleDay(days, setDays, key)}
          className={`w-9 h-9 rounded-full text-xs font-bold transition-all ${
            days.has(key)
              ? "bg-foreground text-background"
              : "bg-secondary text-muted-foreground hover:text-foreground"
          }`}
        >
          {short.slice(0, 2)}
        </button>
      ))}
    </div>
  );

  return (
    <div className="flex flex-col gap-6 pb-4">
      {/* Schedule ON */}
      <div className="rounded-xl border border-border p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold">Tänd automatiskt</h3>
          <Switch checked={onEnabled} onCheckedChange={setOnEnabled} />
        </div>
        {onEnabled && (
          <div className="flex flex-col gap-3">
            <TimeInput hour={onHour} minute={onMinute} setHour={setOnHour} setMinute={setOnMinute} />
            <DayPicker days={onDays} setDays={setOnDays} />
            <Button size="sm" onClick={applyScheduleOn} className="self-start">
              Spara
            </Button>
          </div>
        )}
      </div>

      {/* Schedule OFF */}
      <div className="rounded-xl border border-border p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold">Släck automatiskt</h3>
          <Switch checked={offEnabled} onCheckedChange={setOffEnabled} />
        </div>
        {offEnabled && (
          <div className="flex flex-col gap-3">
            <TimeInput hour={offHour} minute={offMinute} setHour={setOffHour} setMinute={setOffMinute} />
            <DayPicker days={offDays} setDays={setOffDays} />
            <Button size="sm" onClick={applyScheduleOff} className="self-start">
              Spara
            </Button>
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground text-center">
        Scheman sparas i ljusslingans minne och fungerar även utan appen.
      </p>
    </div>
  );
}
