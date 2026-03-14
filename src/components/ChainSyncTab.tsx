import { useState, useCallback, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Play, Square, Check, RefreshCw, AlertTriangle } from "lucide-react";
import { useSonosNowPlaying } from "@/hooks/useSonosNowPlaying";
import { useSongEnergyCurve } from "@/hooks/useSongEnergyCurve";
import { nearestBeat } from "@/lib/bpmEstimate";
import { getBleConnection } from "@/lib/bleStore";

// BLE command buffers for sub-step B
const LATENCY_COLOR_BUF = new Uint8Array([0x7e, 0x07, 0x05, 0x03, 255, 255, 255, 0x00, 0xef]);
const LATENCY_BRIGHT_ON = new Uint8Array([0x7e, 0x04, 0x01, 100, 0x01, 0xff, 0x00, 0x00, 0xef]);
const LATENCY_BRIGHT_OFF = new Uint8Array([0x7e, 0x04, 0x01, 0, 0x01, 0xff, 0x00, 0x00, 0xef]);

const BLE_CMD_GAP = 1;
const FLASHES_PER_ROUND = 3;
const MAX_ROUNDS = 8;

interface ChainSyncTabProps {
  onSave: (chainLatencyMs: number) => void;
  currentChainLatencyMs: number;
}

type SubStep = 'a' | 'b';

export default function ChainSyncTab({ onSave, currentChainLatencyMs }: ChainSyncTabProps) {
  const [subStep, setSubStep] = useState<SubStep>('a');
  const [resultA, setResultA] = useState<number | null>(null);
  const [resultB, setResultB] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);

  const bleConn = getBleConnection();
  const totalLatency = (resultA ?? 0) + (resultB ?? 0);

  const handleSave = useCallback(() => {
    onSave(totalLatency);
    setSaved(true);
  }, [totalLatency, onSave]);

  const reset = useCallback(() => {
    setResultA(null);
    setResultB(null);
    setSaved(false);
    setSubStep('a');
  }, []);

  return (
    <div className="space-y-4">
      {/* Overview */}
      <div className="bg-secondary/50 border border-border/30 rounded-lg px-3 py-2.5">
        <p className="text-xs text-foreground/90 leading-relaxed">
          <span className="font-bold">Två steg:</span>{' '}
          <span className="text-primary font-medium">A)</span> Mät fördröjning Sonos → dator genom att tappa i takt med hörbara beats.{' '}
          <span className="text-primary font-medium">B)</span> Mät fördröjning dator → lampa genom att synka skärmblinkar med lampan.
        </p>
        <p className="text-[10px] text-muted-foreground mt-1.5">
          Total kedjelatens = A + B. Används som look-ahead för att kompensera fördröjningen.
        </p>
      </div>

      {/* Sub-step selector */}
      <div className="flex gap-1">
        <button
          onClick={() => setSubStep('a')}
          className={`px-3 py-1.5 rounded-full text-[11px] font-bold tracking-wide transition-colors flex items-center gap-1 ${
            subStep === 'a'
              ? 'bg-primary text-primary-foreground'
              : 'bg-secondary text-secondary-foreground hover:bg-accent'
          }`}
        >
          {resultA != null && subStep !== 'a' && <span className="text-[9px]">✓</span>}
          A. Sonos → Dator
        </button>
        <button
          onClick={() => setSubStep('b')}
          className={`px-3 py-1.5 rounded-full text-[11px] font-bold tracking-wide transition-colors flex items-center gap-1 ${
            subStep === 'b'
              ? 'bg-primary text-primary-foreground'
              : 'bg-secondary text-secondary-foreground hover:bg-accent'
          }`}
        >
          {resultB != null && subStep !== 'b' && <span className="text-[9px]">✓</span>}
          B. Dator → Lampa
        </button>
      </div>

      {subStep === 'a' && (
        <SubStepA
          onResult={(ms) => { setResultA(ms); setSubStep('b'); }}
          currentResult={resultA}
        />
      )}

      {subStep === 'b' && (
        <SubStepB
          conn={bleConn}
          onResult={setResultB}
          currentResult={resultB}
        />
      )}

      {/* Summary & save */}
      {(resultA != null || resultB != null) && (
        <div className="border-t border-border/20 pt-3 space-y-2">
          <p className="text-[10px] font-bold text-foreground/70">Sammanfattning</p>
          <div className="text-[10px] font-mono space-y-0.5">
            <div className="flex justify-between">
              <span>A. Sonos → Dator</span>
              <span>{resultA != null ? `${resultA}ms` : '—'}</span>
            </div>
            <div className="flex justify-between">
              <span>B. Dator → Lampa</span>
              <span>{resultB != null ? `${resultB}ms` : '—'}</span>
            </div>
            <div className="flex justify-between font-bold border-t border-border/20 pt-1">
              <span>Total kedjelatens</span>
              <span className="text-primary">{totalLatency}ms</span>
            </div>
          </div>

          {saved ? (
            <div className="bg-primary/15 border border-primary/30 rounded-lg px-3 py-2.5 flex items-center gap-2">
              <Check className="w-4 h-4 text-primary shrink-0" />
              <div>
                <p className="text-xs font-bold text-primary">Sparat!</p>
                <p className="text-[10px] text-primary/70">Kedjelatens {totalLatency}ms sparad.</p>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSave} disabled={resultA == null || resultB == null} className="text-xs gap-1 flex-1">
                <Check className="w-3.5 h-3.5" /> Spara {totalLatency}ms
              </Button>
              <Button size="sm" variant="secondary" onClick={reset} className="text-xs gap-1">
                <RefreshCw className="w-3 h-3" /> Börja om
              </Button>
            </div>
          )}

          {saved && (
            <Button size="sm" variant="secondary" onClick={reset} className="text-xs gap-1 w-full">
              <RefreshCw className="w-3 h-3" /> Kalibrera om
            </Button>
          )}
        </div>
      )}

      {/* Current saved value */}
      {currentChainLatencyMs !== 0 && resultA == null && resultB == null && (
        <div className="bg-primary/5 border border-primary/15 rounded-lg px-3 py-2 flex items-center justify-between">
          <div>
            <p className="text-[10px] text-muted-foreground">Sparad kedjelatens</p>
            <p className="text-xs font-mono font-bold text-foreground">{currentChainLatencyMs}ms</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ==========================================
// SUB-STEP A: Sonos → Dator (tap to beats)
// ==========================================

function SubStepA({ onResult, currentResult }: { onResult: (ms: number) => void; currentResult: number | null }) {
  const { nowPlaying, getPosition } = useSonosNowPlaying();
  const track = nowPlaying?.trackName && nowPlaying?.artistName
    ? { trackName: nowPlaying.trackName, artistName: nowPlaying.artistName }
    : null;
  const { beatGrid, bpm } = useSongEnergyCurve(track);

  const [phase, setPhase] = useState<'idle' | 'tapping' | 'done'>('idle');
  const [taps, setTaps] = useState<number[]>([]);
  const [offsets, setOffsets] = useState<number[]>([]);
  const [result, setResult] = useState<number | null>(currentResult);

  const isPlaying = nowPlaying?.playbackState?.includes('PLAYING');
  const hasBeats = beatGrid && beatGrid.beats.length > 10;

  const missingSonos = !isPlaying;
  const missingBeats = isPlaying && !hasBeats;
  const ready = !missingSonos && hasBeats;

  const getSongPosSec = useCallback((): number | null => {
    const pos = getPosition();
    if (!pos) return null;
    const elapsed = performance.now() - pos.receivedAt;
    return (pos.positionMs + elapsed) / 1000;
  }, [getPosition]);

  const startTapping = useCallback(() => {
    setPhase('tapping');
    setTaps([]);
    setOffsets([]);
    setResult(null);
  }, []);

  const finishTapping = useCallback((offs: number[]) => {
    if (offs.length < 4) { setPhase('idle'); return; }
    const mean = offs.reduce((a, b) => a + b, 0) / offs.length;
    const std = Math.sqrt(offs.reduce((a, b) => a + (b - mean) ** 2, 0) / offs.length);
    const filtered = std > 0 ? offs.filter(o => Math.abs(o - mean) <= 2 * std) : offs;
    const finalMean = filtered.length > 0
      ? filtered.reduce((a, b) => a + b, 0) / filtered.length
      : mean;
    const r = Math.round(finalMean);
    setResult(r);
    setPhase('done');
  }, []);

  const handleTap = useCallback(() => {
    if (phase !== 'tapping') return;
    const posSec = getSongPosSec();
    if (posSec == null || !hasBeats) return;
    const nearBeat = nearestBeat(beatGrid!.beats, posSec);
    if (nearBeat == null) return;
    const offsetMs = (posSec - nearBeat) * 1000;
    if (Math.abs(offsetMs) > 500) return;
    const newTaps = [...taps, posSec];
    const newOffsets = [...offsets, offsetMs];
    setTaps(newTaps);
    setOffsets(newOffsets);
    if (newTaps.length >= 16) finishTapping(newOffsets);
  }, [phase, getSongPosSec, hasBeats, beatGrid, taps, offsets, finishTapping]);

  const stopTapping = useCallback(() => {
    finishTapping(offsets);
  }, [offsets, finishTapping]);

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground leading-relaxed">
        Lyssna på musiken och tappa på skärmen varje gång du hör ett beat.
        Skillnaden mot låtens beat-grid visar hur mycket Sonos-positionen avviker.
      </p>

      {/* Prerequisites */}
      <div className="space-y-1">
        <ChecklistItem
          done={!missingSonos}
          label="Sonos spelar musik"
          detail={missingSonos ? "Starta en låt på Sonos" : nowPlaying?.trackName ?? "Spelar"}
        />
        <ChecklistItem
          done={hasBeats ?? false}
          label="Beat grid finns"
          detail={missingBeats ? "Denna låt saknar inspelad beat-grid" : hasBeats ? `${beatGrid!.beats.length} beats (${bpm} BPM)` : "Väntar…"}
          warning={missingBeats ?? false}
        />
      </div>

      {phase === 'idle' && (
        <Button size="sm" onClick={startTapping} disabled={!ready} className="gap-1.5 text-xs w-full">
          <Play className="w-3.5 h-3.5" /> Tappa i takt med musiken
        </Button>
      )}

      {phase === 'tapping' && (
        <div className="space-y-3">
          <button
            onClick={handleTap}
            className="w-full py-14 bg-primary/20 border-2 border-primary/40 rounded-xl text-center active:bg-primary/40 active:scale-[0.98] transition-all touch-manipulation select-none"
          >
            <p className="text-2xl font-black text-primary">TAP</p>
            <p className="text-xs text-muted-foreground mt-2">Tryck varje gång du hör ett beat</p>
            <div className="mt-3 flex justify-center gap-1">
              {Array.from({ length: Math.min(16, Math.max(4, taps.length + 1)) }).map((_, i) => (
                <span key={i} className={`w-2 h-2 rounded-full transition-colors ${
                  i < taps.length ? 'bg-primary' : i < 4 ? 'bg-muted-foreground/30' : 'bg-muted-foreground/10'
                }`} />
              ))}
            </div>
            <p className="text-[10px] font-mono text-foreground/40 mt-2">
              {taps.length}/16 taps {taps.length < 4 ? `(minst ${4 - taps.length} till)` : '— tryck Stoppa när du är nöjd'}
            </p>
          </button>

          <Button size="sm" variant="secondary" onClick={stopTapping} disabled={taps.length < 4} className="gap-1 text-xs w-full">
            <Square className="w-3 h-3" /> Stoppa ({taps.length} taps)
          </Button>

          {offsets.length > 0 && (
            <div className="text-[10px] font-mono text-muted-foreground flex flex-wrap gap-x-2">
              {offsets.slice(-8).map((o, i) => (
                <span key={i} className={Math.abs(o) > 300 ? 'text-yellow-400' : ''}>
                  {o > 0 ? '+' : ''}{o.toFixed(0)}ms
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {phase === 'done' && result != null && (
        <div className="space-y-2">
          <div className="bg-primary/10 border border-primary/20 rounded-lg px-3 py-2">
            <p className="text-xs font-bold text-primary">
              Sonos → Dator: <span className="font-mono">{result}ms</span>
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Baserat på {offsets.length} taps.{' '}
              {result > 0 ? 'Sonos-positionen släpar.' : result < 0 ? 'Sonos-positionen är före.' : 'Perfekt synk!'}
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => onResult(result)} className="text-xs gap-1 flex-1">
              <Check className="w-3.5 h-3.5" /> Använd {result}ms → Gå till steg B
            </Button>
            <Button size="sm" variant="secondary" onClick={startTapping} className="text-xs gap-1">
              <RefreshCw className="w-3 h-3" /> Om
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ==========================================
// SUB-STEP B: Dator → Lampa (screen flash alignment)
// ==========================================

function SubStepB({ conn, onResult, currentResult }: { conn: any; onResult: (ms: number) => void; currentResult: number | null }) {
  const [phase, setPhase] = useState<'idle' | 'waiting' | 'asking' | 'done'>('idle');
  const [offset, setOffset] = useState(0);
  const [low, setLow] = useState(0);
  const [high, setHigh] = useState(300);
  const [round, setRound] = useState(0);
  const [history, setHistory] = useState<{ offset: number; answer: string }[]>([]);
  const [result, setResult] = useState<number | null>(currentResult);
  const [screenFlash, setScreenFlash] = useState(false);
  const [gattRoundtrip, setGattRoundtrip] = useState<number | null>(null);

  // Measure GATT roundtrip on mount
  useEffect(() => {
    if (!conn?.characteristic) return;
    const char = conn.characteristic as BluetoothRemoteGATTCharacteristic;
    (async () => {
      try {
        const times: number[] = [];
        for (let i = 0; i < 5; i++) {
          const t0 = performance.now();
          await char.writeValueWithoutResponse(LATENCY_BRIGHT_OFF as any);
          times.push(performance.now() - t0);
          await new Promise(r => setTimeout(r, 50));
        }
        times.sort((a, b) => a - b);
        setGattRoundtrip(Math.round(times[Math.floor(times.length / 2)]));
      } catch {}
    })();
  }, [conn?.characteristic]);

  const doFlashes = useCallback(async (offsetMs: number) => {
    if (!conn?.characteristic) return;
    const char = conn.characteristic as BluetoothRemoteGATTCharacteristic;

    await char.writeValueWithoutResponse(LATENCY_BRIGHT_OFF as any);
    await new Promise(r => setTimeout(r, 600));
    await new Promise(r => setTimeout(r, 800 + Math.random() * 1200));

    for (let i = 0; i < FLASHES_PER_ROUND; i++) {
      // Send BLE flash
      await char.writeValueWithoutResponse(LATENCY_COLOR_BUF as any);
      await new Promise(r => setTimeout(r, BLE_CMD_GAP));
      await char.writeValueWithoutResponse(LATENCY_BRIGHT_ON as any);

      // Screen flash delayed by offset
      setTimeout(() => { setScreenFlash(true); setTimeout(() => setScreenFlash(false), 100); }, Math.max(0, offsetMs));

      await new Promise(r => setTimeout(r, 100));
      await char.writeValueWithoutResponse(LATENCY_BRIGHT_OFF as any);

      if (i < FLASHES_PER_ROUND - 1) {
        await new Promise(r => setTimeout(r, 900));
      }
    }
  }, [conn]);

  const start = useCallback(async () => {
    const lo = 0, hi = 300;
    const mid = gattRoundtrip != null ? Math.min(hi, Math.max(lo, gattRoundtrip * 3)) : Math.round((lo + hi) / 2);
    setLow(lo); setHigh(hi); setOffset(mid);
    setRound(1); setHistory([]); setResult(null);
    setPhase('waiting');
    await doFlashes(mid);
    setPhase('asking');
  }, [doFlashes, gattRoundtrip]);

  const answer = useCallback(async (ans: 'before' | 'sync' | 'after') => {
    const newHistory = [...history, { offset, answer: ans }];
    setHistory(newHistory);

    if (ans === 'sync' || round >= MAX_ROUNDS || Math.abs(high - low) <= 5) {
      setResult(offset);
      setPhase('done');
      onResult(offset);
      if (conn?.characteristic) {
        try { await conn.characteristic.writeValueWithoutResponse(LATENCY_BRIGHT_OFF as any); } catch {}
      }
      return;
    }

    let nLow = low, nHigh = high;
    if (ans === 'before') nHigh = offset; else nLow = offset;
    const nMid = Math.round((nLow + nHigh) / 2);

    setLow(nLow); setHigh(nHigh); setOffset(nMid); setRound(round + 1);
    setPhase('waiting');
    await doFlashes(nMid);
    setPhase('asking');
  }, [history, offset, round, low, high, doFlashes, conn, onResult]);

  const missingBle = !conn?.characteristic;

  return (
    <div className="space-y-3">
      {screenFlash && <div className="fixed inset-0 z-[100] bg-white pointer-events-none" />}

      <p className="text-xs text-muted-foreground leading-relaxed">
        Skärmen och lampan blinkar {FLASHES_PER_ROUND} gånger. Svara om lampan blinkar före, efter eller samtidigt som skärmen.
        Binärsökning hittar rätt offset på ~{MAX_ROUNDS} rundor.
      </p>

      <ChecklistItem
        done={!missingBle}
        label="BLE-lampa ansluten"
        detail={missingBle ? "Gå tillbaka och anslut lampan" : conn?.device?.name ?? "Ansluten"}
      />

      {gattRoundtrip != null && (
        <p className="text-[10px] text-muted-foreground font-mono">GATT roundtrip: {gattRoundtrip}ms</p>
      )}

      {phase === 'idle' && (
        <Button size="sm" onClick={start} disabled={missingBle} className="gap-1.5 text-xs w-full">
          <Play className="w-3.5 h-3.5" /> Starta — skärm vs lampa
        </Button>
      )}

      {phase === 'waiting' && (
        <div className="text-center py-6">
          <p className="text-sm text-muted-foreground animate-pulse">Titta på lampan och skärmen…</p>
          <p className="text-[10px] text-muted-foreground mt-1 font-mono">
            Runda {round}/{MAX_ROUNDS} — offset {offset}ms [{low}–{high}]
          </p>
        </div>
      )}

      {phase === 'asking' && (
        <div className="text-center py-4 space-y-3">
          <p className="text-sm font-medium text-foreground">Lampan vs skärmen?</p>
          <p className="text-[10px] text-muted-foreground font-mono">
            Runda {round}/{MAX_ROUNDS} — offset {offset}ms
          </p>
          <div className="flex gap-2 justify-center">
            <Button size="sm" variant="secondary" onClick={() => answer('before')} className="px-3 text-xs">
              ← Lampan före
            </Button>
            <Button size="sm" onClick={() => answer('sync')} className="px-4 text-xs">
              ✓ Synkad!
            </Button>
            <Button size="sm" variant="secondary" onClick={() => answer('after')} className="px-3 text-xs">
              Lampan efter →
            </Button>
          </div>
        </div>
      )}

      {phase === 'done' && result != null && (
        <div className="bg-primary/10 border border-primary/20 rounded-lg px-3 py-2">
          <p className="text-xs font-bold text-primary">
            Dator → Lampa: <span className="font-mono">{result}ms</span>
          </p>
          <Button size="sm" variant="secondary" onClick={() => { setPhase('idle'); setHistory([]); }} className="text-xs mt-1.5 gap-1">
            <RefreshCw className="w-3 h-3" /> Kör igen
          </Button>
        </div>
      )}

      {history.length > 0 && (
        <div className="text-[10px] font-mono text-muted-foreground">
          {history.map((h, i) => (
            <span key={i} className="mr-2">
              {h.offset}ms:{h.answer === 'sync' ? '✓' : h.answer === 'before' ? '←' : '→'}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ==========================================
// Shared checklist item
// ==========================================

function ChecklistItem({ done, label, detail, warning = false }: { done: boolean; label: string; detail: string; warning?: boolean }) {
  return (
    <div className="flex items-start gap-2">
      <span className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 mt-0.5 text-[8px] ${
        done ? 'bg-primary/20 text-primary' : warning ? 'bg-yellow-500/20 text-yellow-400' : 'bg-muted-foreground/10 text-muted-foreground/40'
      }`}>
        {done ? '✓' : warning ? '!' : '○'}
      </span>
      <div className="min-w-0">
        <p className={`text-[11px] font-medium ${done ? 'text-foreground' : 'text-muted-foreground'}`}>{label}</p>
        <p className={`text-[10px] ${done ? 'text-muted-foreground' : warning ? 'text-yellow-400/80' : 'text-muted-foreground/60'}`}>{detail}</p>
      </div>
    </div>
  );
}
