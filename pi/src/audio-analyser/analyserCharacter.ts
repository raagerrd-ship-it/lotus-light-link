/**  KARAKTÄRSPROFILEN (utbruten ur analyser.ts 2026-11-14). Anteckningar (kommentarerna som stod i koden): docs/analysator/analyserCharacter.md */
import type { Ser, CharacterOut } from "./analyserFack.js";
import { BS } from "./split.js";
const P = BS.character.profile;   // platserna i storblocket


function cl01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }

/** DET KARAKTÄREN LÄSER (workern). Inget annat går att nå. */
export interface CharacterReads {
  hop:      Ser<'L', 'hop', 'kickHit' | 'conf'>;
  spectrum: Ser<'L', 'spectrum', 'bandLvl' | 'bandOn'>;
  bass:     Ser<'L', 'bass', 'bassline'>;
}

export class CharacterProfile {
  private readonly h: CharacterReads['hop']; private readonly sp: CharacterReads['spectrum']; private readonly bo: CharacterReads['bass'];
  constructor(r: CharacterReads, private readonly o: CharacterOut) {   // läser: r, lämnar ut: o
    this.h = r.hop; this.sp = r.spectrum; this.bo = r.bass;
  }
  private aProf = 0;
  private profPunch = 0.4;   // KARAKTÄRSPROFIL
  private profBass = 0.5;
  private profBright = 0.3;
  private profBeat = 0.5;

  /** Utjämningens takt per hopp. */
  rates(dtHop: number): void { this.aProf = 1 - Math.exp(-dtHop / 8.0); }

  /** Karaktarsprofilen. */
  profileStep(): void {
    let bSum = 1e-6; for (let b = 0; b < 8; b++) bSum += this.sp.bandLvl[b];
    const bassW = (this.sp.bandLvl[0] + this.sp.bandLvl[1] + this.sp.bandLvl[2]) / bSum;
    const brightW = (this.sp.bandLvl[6] + this.sp.bandLvl[7]) / bSum;
    const punchNow = Math.min(1, (this.h.kickHit + this.sp.bandOn[5] + this.sp.bandOn[6]) * 0.6);
    const pr = this.aProf;
    this.profPunch += (punchNow - this.profPunch) * pr;
    this.profBass += (bassW - this.profBass) * pr;
    this.profBright += (brightW - this.profBright) * pr;
    this.profBeat += (this.h.conf - this.profBeat) * pr;
    this.o.profile.punch = cl01((this.profPunch - 0.05) / 0.40);
    this.o.profile.bass = cl01((this.profBass - 0.28) / 0.30);
    this.o.profile.bright = cl01((this.profBright - 0.14) / 0.19);
    this.o.profile.beat = cl01(this.profBeat);
    this.o.profile.bassline = this.bo.bassline;
  }

  /** Transporten: workern packar profilen i storblocket, huvudtråden packar upp. */
  pack(s: Float64Array): void { const p = this.o.profile; s[P.punch] = p.punch; s[P.bass] = p.bass; s[P.bright] = p.bright; s[P.beat] = p.beat; s[P.bassline] = p.bassline; }
  unpack(s: Float64Array): void { const p = this.o.profile; p.punch = s[P.punch]; p.bass = s[P.bass]; p.bright = s[P.bright]; p.beat = s[P.beat]; p.bassline = s[P.bassline]; }
}
