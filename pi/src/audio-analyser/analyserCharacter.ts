/**  KARAKTÄRSPROFILEN (utbruten ur analyser.ts 2026-11-14). Anteckningar (kommentarerna som stod i koden): docs/analysator/analyserCharacter.md */
import { type Analyser } from "./analyser.js";


function cl01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }

export class CharacterProfile {
  a: Analyser;   // analysatorn som äger den här delen
  constructor(a: Analyser) {
    this.a = a;
  }
  outProfile = { punch: 0.4, bass: 0.5, bright: 0.3, beat: 0.5, bassline: 0 };   // karaktärsprofil
  aProf = 0;
  private profPunch = 0.4;   // KARAKTÄRSPROFIL
  private profBass = 0.5;
  private profBright = 0.3;
  private profBeat = 0.5;

  /** Karaktarsprofilen. */
  profileStep(): void {
    let bSum = 1e-6; for (let b = 0; b < 8; b++) bSum += this.a.bandLvl[b];
    const bassW = (this.a.bandLvl[0] + this.a.bandLvl[1] + this.a.bandLvl[2]) / bSum;
    const brightW = (this.a.bandLvl[6] + this.a.bandLvl[7]) / bSum;
    const punchNow = Math.min(1, (this.a.f.hop.kickHit + this.a.bandOn[5] + this.a.bandOn[6]) * 0.6);
    const pr = this.aProf;
    this.profPunch += (punchNow - this.profPunch) * pr;
    this.profBass += (bassW - this.profBass) * pr;
    this.profBright += (brightW - this.profBright) * pr;
    this.profBeat += (this.a.f.hop.conf - this.profBeat) * pr;
    this.outProfile.punch = cl01((this.profPunch - 0.05) / 0.40);
    this.outProfile.bass = cl01((this.profBass - 0.28) / 0.30);
    this.outProfile.bright = cl01((this.profBright - 0.14) / 0.19);
    this.outProfile.beat = cl01(this.profBeat);
    this.outProfile.bassline = this.a.profBassline;
  }
}
