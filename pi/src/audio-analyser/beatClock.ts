/**
 * TAKTKLOCKAN — en sanning om var i takten vi är.
 *
 * ⚠️  MIRROR — master: DMX Control / pi-dmx/engine/src/beatClock.ts.
 * Enda skillnaden här: `Beat` lever i piEngine i stället för i EngineConfig.
 *
 * Tempot kommer från analysatorn (`frame.bpm`), fasen knuffas löpande mot faktiska
 * trumslag av PLL:en i piEngine (18 % av felet per kick).
 *
 * LEAD: ljus är trögare än ljud — och en BLE-lampa har dessutom ~40–60 ms
 * skrivlatens. En konsument som behöver tid på sig ber om sitt eget försprång
 * i stället för att räkna om fasen själv. Klockan äger matematiken; varje
 * konsument äger sitt försprång.
 */

export interface Beat {
  /** Väggklocka (ms) för ett taktslag — PLL:ens stabila fasreferens. */
  anchorMs: number;
  bpm: number;
  /** 0..1 från tempomätningen. Saknas den antas takten opålitlig. */
  confidence?: number;
}

/** Under detta räknas takten som opålitlig — bättre ingen takt än en som sitter fel.
 *  Konsumenter som `hasBeat` säger nej till faller tillbaka på VERKLIGA kicks. */
export const MIN_BEAT_CONFIDENCE = 0.20;

/** Är takten låst OCH pålitlig? Konfidensgrinden bor HÄR, inte hos konsumenterna. */
export function hasBeat(beat: Beat | null | undefined): beat is Beat {
  return !!beat && beat.bpm > 40 && (beat.confidence ?? 0) >= MIN_BEAT_CONFIDENCE;
}

/** Taktperioden i ms. Faller tillbaka på 500 ms (120 BPM) när ingen takt är låst. */
export function beatMs(beat: Beat | null | undefined): number {
  return hasBeat(beat) ? 60000 / beat.bpm : 500;
}

/**
 * Var i takten är vi? 0 = precis på slaget, 0,5 = mitt emellan.
 * @param leadMs försprång: hur långt FÖRE slaget anroparen vill ligga.
 */
export function beatPhase(beat: Beat | null | undefined, nowMs: number, leadMs = 0): number {
  if (!hasBeat(beat)) return 0;
  const ms = 60000 / beat.bpm;
  const since = nowMs - beat.anchorMs + leadMs;
  return (((since % ms) + ms) % ms) / ms;
}

/** Löpande taktnummer sedan ankaret — diskret flank per taktslag. */
export function beatIndex(beat: Beat | null | undefined, nowMs: number): number {
  if (!hasBeat(beat)) return 0;
  return Math.floor((nowMs - beat.anchorMs) / (60000 / beat.bpm));
}

/** Millisekunder kvar till nästa slag (med valfritt försprång). */
export function nextBeatIn(beat: Beat | null | undefined, nowMs: number, leadMs = 0): number {
  const ms = beatMs(beat);
  return (1 - beatPhase(beat, nowMs, leadMs)) * ms;
}
