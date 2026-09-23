/**
 * KONTRAKT: ANALYS → DIRIGENT → HEART-BEAT/ENERGI → OUTPUT (2026-09-23, ägarens arkitektur).
 *
 *   INPUT      ALSA / aux / codec → 375 Hz-hop med ljudklocka.
 *   ANALYS     delad, snabb + långsam (audio-analyser/): takt (grid + fas), nivå/energi, kick, drop, sektion + minne + förutsägelse.
 *              Det enda lagret som lär sig (mot facit på PC:n).
 *   DIRIGENT   väljer VAD som visas: BLE en effekt ("uniform"), DMX många. Producerar bara AVSIKT (Intent) — per lampa färg och
 *              relativ intensitet 0–1, plus vilka globala modulatorer effekten vill ha (ModulateFlags). Dirigenten får skriva över
 *              effektens standardflaggor (t.ex. tvinga energi i ett lugnt parti, stänga pulsen när takten är otillförlitlig).
 *   HEART-BEAT / ENERGI (heartbeat.ts) vet inget om lampor. Räknar två GLOBALA signaler per tick i normerade enheter:
 *              pulse   0–1  kurvan ur taktklockan (prediktiv: toppar på beat + kedjans latens), djup efter tillit;
 *              ceiling 0–1  energitaket ur nivå + refrängreferens (levelVsHighDb) + uppbyggnad + drop-envelope.
 *              Effekterna får läsa samma råvaror (kickEnv, energy, buildUp) som i dag; den GLOBALA envelopen läggs efter dirigenten.
 *   OUTPUT     komposition + allt som rör hårdvaran:  ljus_i = kal_i( level_i × (energy ? ceiling : 1) × (pulse ? pulse : 1) ),
 *              golv/max per lampa, gamma, sedan kodning (BLE-paket på radions raster, DMX-ram 40 Hz). Kalibreringen bor HÄR.
 *
 * "Skippa" betyder skippa: en effekt med energy=false får full kalibrerad skala — output håller den ändå inom golv/max.
 * Bänkbart per lager: heart-beat mäts mot ljudet oavsett effekt (ceilR för taket, on-beat för pulsen), effekterna på
 * likhet/variation, output mot lampan (klapp + video).
 */

/** Vilka globala modulatorer som ska appliceras på avsikten. Effekten deklarerar sin standard, dirigenten kan skriva över. */
export interface ModulateFlags {
  /** false = taket (energin) ignoreras: strobe, fyrverkeri, drop-blixt, kalibreringsläge. */
  energy: boolean;
  /** false = pulsen ignoreras: statiska svep, andrum, vågbrytare. */
  pulse: boolean;
}

/** En lampas avsikt: färg + relativ intensitet 0–1 (aldrig absolut nivå — den bor i output via kalibreringen). */
export interface LampIntent { rgb: [number, number, number]; level: number; }

/** Dirigentens/effektens utdata per tick. BLE: en lampa (hela remsan). DMX: en per fixtur. */
export interface Intent { lamps: LampIntent[]; modulate: ModulateFlags; }

/** Heart-beat/energi-lagrets utdata per tick, globalt, normerat. */
export interface Envelope {
  /** Energitaket 0–1 (nivå × sektionsreferens × uppbyggnad, drop lyfter mot 1). */
  ceiling: number;
  /** Pulsen 0–1 vid paketets visningsögonblick (prediktiv), redan viktad med tillit och sektionens pulsvikt. */
  pulse: number;
}

/** Komposition i OUTPUT (före kalibrering): avsikt × valda modulatorer. Ren funktion, ingen hårdvara. */
export function composeLamp(level: number, env: Envelope, m: ModulateFlags): number {
  let v = level;
  if (m.energy) v *= env.ceiling;
  if (m.pulse) v *= env.pulse;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
