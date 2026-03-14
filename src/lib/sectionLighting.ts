/**
 * Section-aware lighting parameters.
 * Given a section type, returns adjustments to brightness, kick behavior, and color modulation.
 */

import type { DynamicRange, Transition } from "./songAnalysis";

export interface SongSection {
  start: number;
  end: number;
  type: 'intro' | 'verse' | 'pre_chorus' | 'chorus' | 'bridge' | 'drop' | 'build_up' | 'break' | 'outro';
  intensity: number;
}

export interface SectionLightingParams {
  brightnessScale: number;    // multiplier for max brightness (0-1)
  kickEnabled: boolean;       // whether white kicks are allowed
  kickThreshold: number;      // override kick detection sensitivity
  colorModStrength: number;   // frequency-based color modulation strength
  beatPulseStrength: number;  // how much BPM pulsing affects brightness
  strobeOnBeat: boolean;      // trigger strobe flashes on each beat (drops)
}

export interface TransitionParams {
  active: boolean;
  type: 'hard' | 'fade';
  crossfadeMs: number;
  progress: number;   // 0-1 how far into the crossfade we are
}

const SECTION_PARAMS: Record<SongSection['type'], SectionLightingParams> = {
  intro:      { brightnessScale: 0.15, kickEnabled: false, kickThreshold: 99, colorModStrength: 0.1, beatPulseStrength: 0.1,  strobeOnBeat: false },
  verse:      { brightnessScale: 0.50, kickEnabled: true,  kickThreshold: 97, colorModStrength: 0.2, beatPulseStrength: 0.3,  strobeOnBeat: false },
  pre_chorus: { brightnessScale: 0.75, kickEnabled: true,  kickThreshold: 95, colorModStrength: 0.3, beatPulseStrength: 0.5,  strobeOnBeat: false },
  chorus:     { brightnessScale: 1.0,  kickEnabled: true,  kickThreshold: 88, colorModStrength: 0.4, beatPulseStrength: 0.8,  strobeOnBeat: false },
  bridge:     { brightnessScale: 0.4,  kickEnabled: false, kickThreshold: 99, colorModStrength: 0.3, beatPulseStrength: 0.2,  strobeOnBeat: false },
  drop:       { brightnessScale: 1.0,  kickEnabled: true,  kickThreshold: 85, colorModStrength: 0.5, beatPulseStrength: 1.0,  strobeOnBeat: true  },
  build_up:   { brightnessScale: 0.7,  kickEnabled: true,  kickThreshold: 93, colorModStrength: 0.3, beatPulseStrength: 0.7,  strobeOnBeat: false },
  break:      { brightnessScale: 0.10, kickEnabled: false, kickThreshold: 99, colorModStrength: 0.1, beatPulseStrength: 0.05, strobeOnBeat: false },
  outro:      { brightnessScale: 0.15, kickEnabled: false, kickThreshold: 99, colorModStrength: 0.1, beatPulseStrength: 0.1,  strobeOnBeat: false },
};

const DEFAULT_PARAMS: SectionLightingParams = {
  brightnessScale: 1.0,
  kickEnabled: true,
  kickThreshold: 95,
  colorModStrength: 0.3,
  beatPulseStrength: 0.0,
  strobeOnBeat: false,
};

/**
 * Find the current section at a given time position.
 */
export function getCurrentSection(sections: SongSection[], timeSec: number): SongSection | null {
  for (const s of sections) {
    if (timeSec >= s.start && timeSec < s.end) return s;
  }
  return null;
}

/**
 * Get lighting parameters for the current position.
 * When dynamicRange is provided, brightnessScale is normalized using P90.
 */
export function getSectionLighting(
  sections: SongSection[] | null,
  timeSec: number,
  dynamicRange?: DynamicRange | null,
): SectionLightingParams {
  if (!sections || sections.length === 0) {
    return dynamicRange ? applyDynamicRange(DEFAULT_PARAMS, dynamicRange) : DEFAULT_PARAMS;
  }
  const section = getCurrentSection(sections, timeSec);
  if (!section) {
    return dynamicRange ? applyDynamicRange(DEFAULT_PARAMS, dynamicRange) : DEFAULT_PARAMS;
  }
  const base = SECTION_PARAMS[section.type] ?? DEFAULT_PARAMS;
  return dynamicRange ? applyDynamicRange(base, dynamicRange) : base;
}

/**
 * Apply dynamic range normalization to brightness scale.
 * Uses P90/peak ratio to ensure quiet songs still get full brightness range.
 */
function applyDynamicRange(params: SectionLightingParams, dr: DynamicRange): SectionLightingParams {
  if (dr.peak <= 0 || dr.p90 <= 0) return params;
  // If P90 is far below peak, the song has lots of dynamic range — use as-is
  // If P90 is close to peak, the song is compressed — reduce base brightness slightly
  const compressionRatio = dr.p90 / dr.peak;
  // Scale: compressed songs (ratio > 0.8) get slightly reduced base, dynamic songs untouched
  const adjustment = compressionRatio > 0.8 ? 1.0 - (compressionRatio - 0.8) * 0.5 : 1.0;
  return {
    ...params,
    brightnessScale: Math.min(1, params.brightnessScale * adjustment),
  };
}

/**
 * Get transition parameters at the current time position.
 */
export function getTransitionParams(transitions: Transition[] | null, timeSec: number): TransitionParams {
  if (!transitions || transitions.length === 0) {
    return { active: false, type: 'fade', crossfadeMs: 200, progress: 1 };
  }

  for (const tr of transitions) {
    const durSec = tr.crossfadeMs / 1000;
    const halfBefore = durSec * 0.3; // 30% of crossfade before transition point
    const halfAfter = durSec * 0.7;  // 70% after

    if (timeSec >= tr.time - halfBefore && timeSec < tr.time + halfAfter) {
      const elapsed = timeSec - (tr.time - halfBefore);
      const progress = Math.min(1, elapsed / durSec);
      return {
        active: true,
        type: tr.type,
        crossfadeMs: tr.crossfadeMs,
        progress,
      };
    }
  }

  return { active: false, type: 'fade', crossfadeMs: 200, progress: 1 };
}

/**
 * Calculate beat-synced brightness pulse.
 * Returns a value 0-1 representing the beat phase pulse intensity.
 * When beatStrength is provided, modulates the pulse intensity per-beat.
 */
export function beatPulse(timeSec: number, bpm: number, beatStrength?: number): number {
  if (bpm <= 0) return 0;
  const phase = ((timeSec * bpm / 60) % 1);
  // Sharp attack, smooth decay (like a kick drum envelope)
  const base = Math.exp(-phase * 4);
  // Modulate by beat strength if available (downbeats stronger)
  const strength = beatStrength != null ? (0.5 + beatStrength * 0.5) : 1;
  return base * strength;
}

/**
 * Get the beat strength for the current time from the beat strengths array.
 */
export function getCurrentBeatStrength(
  beatStrengths: number[] | null,
  beatTimes: number[] | null,
  timeSec: number,
): number | undefined {
  if (!beatStrengths || !beatTimes || beatStrengths.length === 0) return undefined;

  // Find the nearest beat
  let closest = 0;
  let minDist = Math.abs(beatTimes[0] - timeSec);
  for (let i = 1; i < beatTimes.length; i++) {
    const dist = Math.abs(beatTimes[i] - timeSec);
    if (dist < minDist) {
      minDist = dist;
      closest = i;
    }
    if (beatTimes[i] > timeSec + 0.1) break; // early exit
  }

  return minDist < 0.15 ? beatStrengths[closest] : undefined;
}
