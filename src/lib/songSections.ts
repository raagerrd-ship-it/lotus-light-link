// Types and helpers for song section analysis

export interface SongSection {
  type: "intro" | "verse" | "pre-chorus" | "chorus" | "bridge" | "drop" | "breakdown" | "outro";
  startSec: number;
  endSec: number;
  energy: number;
}

export interface SongAnalysis {
  bpm: number | null;
  sections: SongSection[];
  drops: number[];
  key: string | null;
}

/** Get the current section based on elapsed seconds */
export function getCurrentSection(sections: SongSection[], currentSec: number): SongSection | null {
  return sections.find(s => currentSec >= s.startSec && currentSec < s.endSec) ?? null;
}

/** Section-based brightness multiplier and behavior */
export interface SectionBehavior {
  maxBrightness: number;   // 0-1, caps the brightness output
  punchWhiteOverride: boolean | null; // null = use user setting
  breathingMode: boolean;  // slow sine-wave breathing instead of beat-reactive
  beatReactivity: number;  // 0-1, how much beats affect brightness
}

export function getSectionBehavior(section: SongSection | null): SectionBehavior {
  if (!section) {
    return { maxBrightness: 1, punchWhiteOverride: null, breathingMode: false, beatReactivity: 1 };
  }

  switch (section.type) {
    case "intro":
    case "outro":
      return {
        maxBrightness: 0.6 + section.energy * 0.4,
        punchWhiteOverride: null,
        breathingMode: section.energy < 0.3,
        beatReactivity: 0.7,
      };
    case "verse":
      return {
        maxBrightness: 1,
        punchWhiteOverride: null,
        breathingMode: false,
        beatReactivity: 1,
      };
    case "pre-chorus":
      return {
        maxBrightness: 1,
        punchWhiteOverride: null,
        breathingMode: false,
        beatReactivity: 1,
      };
    case "chorus":
    case "drop":
      return {
        maxBrightness: 1,
        punchWhiteOverride: true,
        breathingMode: false,
        beatReactivity: 1,
      };
    case "bridge":
    case "breakdown":
      return {
        maxBrightness: 0.7 + section.energy * 0.3,
        punchWhiteOverride: null,
        breathingMode: section.energy < 0.3,
        beatReactivity: 0.7,
      };
    default:
      return { maxBrightness: 1, punchWhiteOverride: null, breathingMode: false, beatReactivity: 1 };
  }
}

/** Check if a drop is about to happen within the given lookahead window */
export function getUpcomingDrop(drops: number[], currentSec: number, lookaheadSec: number = 0.1): number | null {
  for (const d of drops) {
    const diff = d - currentSec;
    if (diff > 0 && diff <= lookaheadSec) return d;
  }
  return null;
}
