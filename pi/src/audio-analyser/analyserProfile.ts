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
  // DMX:S PROFIL (agaren 11-10 i kallaren: 'kor analysatorn med DMX:s profil'; backup-tagg backup/fore-dmxprofil-20261110):
  // sys/bare = dmx-control pi-dmx/engine/src/analyserProfile.ts rad for rad (kommentarerna dar). Enda undantaget ar BEAT_FEED:
  // lotus motor matar inte taktvagen (hopLane.feed) - utan BEAT_FEED matar analysatorn klockan sjalv (analyser.ts clockMode/hopSelf).
  // Lotus-Pi:ns analysator-drop-ins (SECTION_REPEAT, DROP_*, TEMPO_*, KICK_*, GRID_PHASE_OFFSET_MS) togs bort samtidigt.
  sys: {
    KICK_COOLDOWN: '0',
    KICK_EFLOOR: '0.006',
    TEMPO_LAGMAX: 'full',
    SECTION_AGG: 'hop',
    SECTION_SCORE_F32: '1',
    SIL_CLEAR_PENDING: '1',
    ANALYSER_SPLIT: 'worker',
    GHOST_WAIT: '1',
    SUBH_GUARD: '1',
    SECTION_HINT_LOWCONF: '0',
    SECTION_RUN: '5',
    SECTION_RUN_IN: '3',
    SECTION_CARRY: '40',
    SECTION_BODY_HIGH: '2000',
    SECTION_BODY_HIGH_DB: '2',
    FAST_BANDS: '1',
    SECTION_WIN: '2',
    SECTION_EARLY_DB: '1.5',
  },
  bare: {
    BODY_GONE_MIN_MS: '2000',
    BODY_RISE_DB: '20',
    DROP_QUALITY_DB: '3',
    DROP_RISE_LOW_DB: '20',
    MINI_SPACING_MS: '1',
    DROP_UNDERPEAK_MIN: '1.5',
    OCT_UP: '12',
    SUBH_MULT: '8',
  },
};
