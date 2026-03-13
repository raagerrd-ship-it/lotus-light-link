/**
 * Section-aware lighting parameters.
 * Given a section type, returns adjustments to brightness, kick behavior, and color modulation.
 */

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
}

const SECTION_PARAMS: Record<SongSection['type'], SectionLightingParams> = {
  intro:      { brightnessScale: 0.5,  kickEnabled: false, kickThreshold: 99, colorModStrength: 0.1, beatPulseStrength: 0.1 },
  verse:      { brightnessScale: 0.7,  kickEnabled: true,  kickThreshold: 97, colorModStrength: 0.2, beatPulseStrength: 0.3 },
  pre_chorus: { brightnessScale: 0.85, kickEnabled: true,  kickThreshold: 95, colorModStrength: 0.3, beatPulseStrength: 0.5 },
  chorus:     { brightnessScale: 1.0,  kickEnabled: true,  kickThreshold: 90, colorModStrength: 0.4, beatPulseStrength: 0.6 },
  bridge:     { brightnessScale: 0.6,  kickEnabled: false, kickThreshold: 99, colorModStrength: 0.3, beatPulseStrength: 0.2 },
  drop:       { brightnessScale: 1.0,  kickEnabled: true,  kickThreshold: 85, colorModStrength: 0.5, beatPulseStrength: 0.8 },
  build_up:   { brightnessScale: 0.8,  kickEnabled: true,  kickThreshold: 93, colorModStrength: 0.3, beatPulseStrength: 0.7 },
  break:      { brightnessScale: 0.3,  kickEnabled: false, kickThreshold: 99, colorModStrength: 0.1, beatPulseStrength: 0.1 },
  outro:      { brightnessScale: 0.4,  kickEnabled: false, kickThreshold: 99, colorModStrength: 0.1, beatPulseStrength: 0.1 },
};

const DEFAULT_PARAMS: SectionLightingParams = {
  brightnessScale: 1.0,
  kickEnabled: true,
  kickThreshold: 95,
  colorModStrength: 0.3,
  beatPulseStrength: 0.0,
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
 */
export function getSectionLighting(sections: SongSection[] | null, timeSec: number): SectionLightingParams {
  if (!sections || sections.length === 0) return DEFAULT_PARAMS;
  const section = getCurrentSection(sections, timeSec);
  if (!section) return DEFAULT_PARAMS;
  return SECTION_PARAMS[section.type] ?? DEFAULT_PARAMS;
}

/**
 * Calculate beat-synced brightness pulse.
 * Returns a value 0-1 representing the beat phase pulse intensity.
 */
export function beatPulse(timeSec: number, bpm: number): number {
  if (bpm <= 0) return 0;
  const phase = ((timeSec * bpm / 60) % 1);
  // Sharp attack, smooth decay (like a kick drum envelope)
  return Math.exp(-phase * 4);
}
