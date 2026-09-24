/**
 * ANALYSATORPROFIL — LOTUS. En fil per system bredvid den gemensamma analyser.ts (som ar samma byte i
 * lotus-light-link och dmx-control). Har, och bara har, skiljer sig systemen: env-prefixet och de
 * standardvarden dar systemen i dag har OLIKA standard. Env vinner alltid over profilen.
 *
 * `sys`  = rattar med systemprefix (lases som LOTUS_<namn>, alias DMX_<namn>).
 * `bare` = rattar utan prefix (lases som de heter).
 *
 * Varje rad ar ett MATT beteende (paritetsbanken bevisar att analysatorn med denna profil ger exakt
 * samma ramar som lotus analysator fore sammanslagningen). Att andra en rad ar att andra lotus beteende.
 */
export interface AnalyserProfile {
  envPrefix: 'LOTUS_' | 'DMX_';
  sys: Record<string, string>;
  bare: Record<string, string>;
}

export const PROFILE: AnalyserProfile = {
  envPrefix: 'LOTUS_',
  sys: {
    KICK_COOLDOWN: '170',        // DMX: 0 = tempoanpassad (0,6 slag, minst 170 ms)
    KICK_EFLOOR: '0.06',         // DMX: 0.006
    TEMPO_LAGMAX: 'half',        // DMX: 'full' (lag upp till N-1)
    SECTION_AGG: 'env',          // DMX: 'hop'
    SECTION_SCORE_F32: '0',      // DMX: '1'
    SECTION_W_HIGH: '0',         // DMX: '1.0'
    SIL_CLEAR_PENDING: '0',      // DMX: '1'
  },
  bare: {
    BPM_MIN: '80',               // DMX: 100 (ladan satter BPM_MIN=80 i tempo.conf)
  },
};
