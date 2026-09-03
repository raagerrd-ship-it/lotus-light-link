/**
 * SHOW-RENDERARE — gör om en analyserad låt till en FÄRDIG ljussekvens.
 *
 * Ägaren, om och om igen tills jag förstod: "en analyserad och justerad
 * inspelning ska vara helt klar — bara behövas synk och sen skickas till output."
 *
 * Det är rätt, och det är den enda formuleringen som blir enkel. Allt annat är
 * halvmesyrer: så länge ljuset RÄKNAS UT varje ram finns det kodvägar där micens
 * energigrind, tystnadsgrind, PLL-drift och dubbelräknade uppbyggnad kan
 * förstöra det — och de gjorde det, tre gånger.
 *
 * Här renderas hela låten EN gång till en array. Vid uppspelning slår motorn upp
 * positionen och läser ett tal. Det finns ingenting kvar att förstöra.
 *
 * ── Varför rendera i motorn och inte i refinern ───────────────────────────
 * Analysen (slag, sektioner, drops, energikurva) är RÅVARA och dyr att skaffa —
 * den lagras. Renderingen är PRESENTATION och gratis — den görs om vid varje
 * låtstart. Så kan showens uttryck ändras utan att en enda låt behöver spelas in
 * på nytt.
 */

/** Rasterupplösning. 20 ms = 50 Hz, klart tätare än BLE-takten (~53 Hz men jitter). */
export const SHOW_STEP_MS = 20;

export interface ShowSource {
  bpm: number;
  beats?: number[];
  beatPositions?: number[];
  downbeats?: number[];
  parts?: Array<{ t: number; label: string }>;
  drops?: Array<{ t: number; s: number }>;
  energy?: number[];          // 0..255, 100 ms-raster
  analysedSeconds: number;
  /** Energikurvans steg i ms. Saknas den ar kurvan gammal (100 ms). */
  energyStepMs?: number;
  /**
   * Latposition dar INSPELNINGEN borjade.
   *
   * ALLT ANNAT (beats, downbeats, parts, drops) ar redan forskjutet till LATENS
   * tidslinje av refinern — men energikurvan ar det INTE, den ar indexerad fran
   * inspelningens borjan. Utan den har kompenseringen laser showen energin fran
   * fel stalle: uppmatt 9 s fel pa "Djungelvral - Remix" (recordedFrom=9000).
   *
   * Felet var osynligt for `clockErrorMs`, som bara mater klockans konsekvens med
   * sig sjalv. Det syntes forst nar den lagrade kurvan korskorrelerades mot vad
   * micen faktiskt hor.
   */
  recordedFromMs?: number;
}

export interface ShowParams {
  /** Ljusgolv i procent — lampan ska aldrig vara helt släckt under en låt. */
  floorPct: number;
  /** Hur djupt slaget får modulera, 0..1. */
  beatDepth: number;
  /** Extra djup på taktettan. */
  barAccent: number;
  /** Hur snabbt pulsen klingar av, i andel av ett slag. */
  decayBeats: number;
}

export const DEFAULT_SHOW: ShowParams = {
  floorPct: 18,
  beatDepth: 0.62,
  barAccent: 1.35,
  decayBeats: 0.8,
};

/**
 * STRUKTUREN SÄTTER NIVÅN — energin får bara röra sig INOM den.
 *
 * UPPMÄTT PROBLEM med den tidigare formen (`shape × sektionsskala`): energin
 * dominerade och åt upp skalningen. I "När du vill" fick refrängen snitt 36 mot
 * versernas 40 — alltså MÖRKARE än versen. En refräng med komprimerad mix blev
 * dimmare än en gles vers. Det är ingen show, det är en VU-mätare med etiketter
 * påklistrade.
 *
 * Nu ger varje sektion ett BAND. Energin väljer position inom bandet, men kan
 * aldrig ta en refräng under en vers. En refräng är ljus för att den ÄR en
 * refräng — precis som i en programmerad liveshow.
 */
const SECTION: Record<string, { lo: number; hi: number; pulse: number }> = {
  // Vidare spann an en realtidsmotor vagar. Den maste hedga eftersom den inte
  // vet vad som kommer — en komponerad show vet, och kan darfor ga riktigt lagt
  // utan risk att missa nasta hojdpunkt.
  // Intro och outro sanks kraftigt. UPPMATT brist: NOLL procent av latens tid
  // under 25 %, mot rekommenderade 8-10. Utan ihallande morker finns ingenting
  // att bygga kontrast MED, och da blir refrangen bara "en niva" i stallet for
  // en hojdpunkt. Korta morkerblixtar racker inte — de ar nagra sekunder totalt.
  intro:  { lo: 0.06, hi: 0.30, pulse: 0.40 },
  verse:  { lo: 0.30, hi: 0.58, pulse: 0.70 },
  // Refrangen sanks fran 0.78-1.00: den lag konstant i taket och da betyder
  // taket ingenting. UPPMATT: 22-41 % av latens tid over 85 %, mot rekommenderade
  // 15-20. Nu bor den ~84 och toppen reserveras for anslag och drops.
  chorus: { lo: 0.66, hi: 0.94, pulse: 1.00 },
  bridge: { lo: 0.14, hi: 0.42, pulse: 0.50 },
  break:  { lo: 0.06, hi: 0.22, pulse: 0.18 },   // ett lugnt parti ska VARA lugnt
  inst:   { lo: 0.52, hi: 0.80, pulse: 0.85 },
  solo:   { lo: 0.58, hi: 0.88, pulse: 0.92 },
  outro:  { lo: 0.05, hi: 0.28, pulse: 0.40 },
};

/**
 * LATENS BAGE. Samma sektionstyp ska vaxa genom laten — sista refrangen storre
 * an den forsta. En realtidsmotor kan inte veta att en refrang ar den SISTA;
 * en komponerad show vet det, och det ar precis den sortens dramaturgi som
 * skiljer en programmerad show fran en som foljer.
 */
const ARC_LIFT = 0.16;
/**
 * EN NORMALLANG LATDEL. Anvands bara som referens for att bedoma om en del ar
 * onaturligt lang.
 */
const SECTION_REF_MS = 20000;
/** Hur lagt latens oppning borjar innan den stiger till forsta delens niva. */
const OPENING_LOW = 0.35;
/**
 * Hur mycket bandet far vidgas for en overlang del.
 *
 * UPPMATT PROBLEM pa "Dricker Vin": Replicate gav bara fyra sektionsgranser pa
 * 149 s, varav en "chorus" som lopte 84 s -> 157 s. Bandet 0.66-0.94 holl da
 * hela lastens sista 73 sekunder mellan 87 och 97 -- en VAGG AV LJUS utan
 * andning, uppbyggnad eller lugn. Median for hela laten blev 69 och den var
 * mork under 1 % av tiden.
 *
 * Etiketten ar fortfarande sann -- det ar en refrang -- men pa 73 sekunder
 * beskriver den inte langre EN sak. Da ska energikurvan, som har 100 ms
 * upplosning, fa mer att saga till om.
 *
 * Delens MITT ligger kvar dar etiketten sager: en lang refrang ar fortfarande
 * ljusare an en lang vers. Det ar bara SPRIDNINGEN kring mitten som vaxer, sa
 * "refrang ljusare an vers" (som en tidigare rattning slog fast) haller.
 */
const SECTION_WIDEN_MAX = 1.6;
/**
 * Hur hart en overlang dels MITT dras mot latens mittlage, per gang den ar
 * langre an SECTION_REF_MS.
 *
 * Att bara vidga bandet racker inte. En refrangs mitt ligger pa 0.80, sa en
 * symmetrisk vidgning slar i taket uppat och kan inte skapa nagot morker nedat:
 * "Dricker Vin" lag kvar pa median 65 och var mork 1 % av tiden aven efter
 * vidgningen.
 *
 * Skalet ar musikaliskt, inte tekniskt: EN TOPP SOM VARAR HALVA LATEN AR INGEN
 * TOPP. Nar en enda etikett galler i over en minut beskriver den ett helt
 * lat-avsnitt, inte ett hojdparti, och ska inte hallas pa hojdpartiets niva.
 *
 * Korta och normallanga delar rors inte alls -- dar ar etiketten precis.
 */
const SECTION_MID_PULL = 0.15;
const SECTION_MID_PULL_MAX = 0.45;
/**
 * ETIKETTEN FORESLAR, ENERGIN AVGOR.
 *
 * UPPMATT pa tre latar, och etiketten hade fel i alla tre:
 *   "Vad gor du med mig"  tre `intro` MITT i laten, 55-61 % energi -- alltsa
 *                         samma som verserna -- men bandmitt 18 %. Showen
 *                         slacktes i 29 s at gangen medan musiken gick for
 *                         fullt.
 *   "Bara Du Ler"         EN `intro` som varade 149 s, hela laten, 51 % energi.
 *                         Hela laten dimmades.
 *   "Dricker Vin"         `chorus` med LAGRE energi (39 %) an versen (43 %),
 *                         men bandmitt 80 % mot versens 44 %. Ljusvaggen lag
 *                         pa latens TYSTASTE parti.
 *
 * Replicates etikettvokabular racker inte till: den aterkommande lagenergidelen
 * blir "intro" for att inget battre finns. Bandtabellen forstorar sedan felet.
 *
 * LOSNINGEN ar en RANGPARNING, inte en blandning. Etiketterna far bestamma
 * vilken UPPSATTNING nivaer laten ska ha -- tva ljusa, fyra morka, och sa
 * vidare -- och energin far bestamma VEM som far vilken. Latens starkaste
 * avsnitt tar den ljusaste nivan etiketterna bad om, det svagaste tar den
 * morkaste.
 *
 * Varfor inte bara vaga ihop etikett och energi: det provades. Avsnittens
 * ihallande energi ligger tatt (uppmatt 39-61 % av toppen aven pa latar med
 * tydliga lugna partier), sa en energistyrd mitt drog ihop hela showen mot
 * mitten -- p5 klattrade till 30-42 och morkret forsvann. Rangparningen behaller
 * kontrasten EXAKT och rattar anda felmarkningen, eftersom nivauppsattningen ar
 * oforandrad och bara omfordelas.
 *
 * Etiketten far fortsatt bestamma bandets BREDD, pulsdjupet och fargtvatten,
 * dar den ar palitlig.
 *
 * Detta krockar inte med den tidigare rattningen "sektioner ger BAND, energin
 * placerar INOM bandet". Den gallde ogonblick-till-ogonblick inuti ett avsnitt
 * och galler fortfarande.
 */
/** Under sa liten energiskillnad mellan avsnitten sager energin ingenting. */
const E_SPREAD_MIN = 0.08;
/**
 * Under sa fa avsnitt sager rangordningen ingenting: med tva delar hamnar den
 * ena alltid i botten och den andra i toppen, oavsett hur lika de later.
 */
const E_MIN_PARTS = 3;
   // hur mycket den sista instansen lyfts over den forsta
const SECTION_DEFAULT = { lo: 0.45, hi: 0.85, pulse: 0.8 };

// UPPBYGGNAD. Langre och djupare an tidigare: det ar har showen tjanar in sin
// existens. Ljuset SJUNKER forst och stiger sedan mot dropen — utan dippen
// marks ingen uppbyggnad, for ogat ser bara forandring.
const BUILD_MS = 7000;     // ~6 takter i 120 BPM
const BUILD_DIP = 0.70;    // djup dipp: mork nog att dropen ska kannas
const BUILD_TOP = 0.45;    // och tydligt over normalnivan precis fore
const DROP_DECAY_MS = 700;
/** Sjalva traffen. En drop ska vara en HANDELSE, inte en knuff. */
const DROP_HIT = 0.85;

/**
 * PULSEN FAR ALDRIG ATA SEKTIONSKONTRASTEN.
 * Amplituden begransas till halva bandets bredd. Utan taket svanger pulsen
 * 38-100 % av basnivan, och da hamnar en refrangs botten under en vers topp —
 * hela strukturen jag byggt upp forsvinner i modulationen.
 */
const PULSE_MAX_OF_BAND = 0.5;
/**
 * Hur brett fonster energikurvan medelvardesbildas over.
 *
 * Den ar lagrad i 100 ms-steg och innehaller varje trumslag. Anvands den ratt av
 * konkurrerar den med slagpulsen om samma uttryck — och vinner, for den ror sig
 * over hela sektionsbandet medan pulsen ar klampad till halva. Ett fonster kring
 * en halv takt lamnar kvar formen men slatar bort slagen.
 */
const ENERGY_SMOOTH_MS = 60;
/**
 * Motorns egna envelope-konstanter, hamtade fran kalibreringen sa showen far
 * EXAKT samma kansla som realtidsvagen.
 *   attackAlpha 1     -> omedelbar attack, dampad av lowSoftFloor vid lag energi
 *   releaseAlpha 0.396 -> logaritmiskt fall, ~7 % av log-avstandet per steg
 */
const RELEASE_ALPHA = 0.396;
const LOW_SOFT_FLOOR = 0.3;

/**
 * PULSTAKT EFTER TEMPO. Att pulsa varje slag i en snabb lat lasar som FLIMMER,
 * inte rytm: under ~250 ms synlig envelope medelvardesbildar ogat bort det
 * (Talbot-Plateau). Och i en ballad blir varje slag mekaniskt.
 *   < 100 BPM   taktettan
 *   100-128     backbeat, slag 2 och 4
 *   > 128       varannat slag
 */
/**
 * HUR MYCKET varje slag far pulsera — och det avgors av VAR I TAKTEN det
 * ligger, aldrig av dess nummer i listan.
 *
 * VARFOR ALLA SLAG, inte bara ettan och trean: showen ska vara RIKARE an
 * realtidsvagen, annars finns ingen anledning att spela in. Realtid reagerar pa
 * varje anslag i musiken. Nar showen bara pulserade pa halva slagen — och
 * energikurvan dessutom jamnades ut for att inte konkurrera med pulsen — hade
 * den MINDRE information an realtid, och da kan den omojligt se battre ut.
 * Agarens dom: "realtid ar mycket mjukare och mer synkat och snyggt".
 *
 * Nu artikulerar showen varje slag, men VIKTAT: ettan starkast, trean nast,
 * tvaan och fyran latta. Det ger tathet utan att bli en jamn stroboskop-takt,
 * och taktens form hors i ljuset.
 *
 * UPPMATT PROBLEM med den tidigare grinden: over 128 BPM avgjorde `beatIdx % 2`
 * vilka slag som pulserade, alltsa listans PARITET. Tva latar i samma tempo fick
 * motsatt utfall — "Status behov" pulserade pa 1 och 3, "Vad gor du med mig" pa
 * 2 och 4. Ljuset var da som MORKAST pa det slag man foljer.
 */
function beatWeight(bpm: number, posInBar: number): number {
  // Under 100 BPM ar slagen sa glesa att alla far full vikt.
  if (bpm < 100) return posInBar === 1 ? 1 : 0.75;
  if (posInBar === 1) return 1;
  if (posInBar === 3) return 0.85;
  return 0.55;
}

/**
 * FRASERING. Musik ar byggd i 4-, 8- och 16-taktersfraser, och ogat lasar
 * riktning ur dem aven nar det inte kan benamna dem.
 *   - en ramp over atta takter ger rorelse utan att rora sektionsbandet
 *   - takt 8 far en "turnaround": en dipp som gor att nasta fras kanns som en start
 */
/**
 * MORKRET FORE. Ett kort nastan-svart precis fore en refrang eller drop.
 *
 * Det ar den enskilt starkaste gesten en programmerad show har och den enda som
 * ar helt omojlig i realtid: den kraver att man VET att hojdpunkten kommer.
 * UPPMATT brist: noll procent av latens tid under 25 %, mot rekommenderade 8-10.
 * Utan morker finns ingenting att bygga kontrast MED — taket blir bara en niva.
 */
const BLACKOUT_MS = 320;      // hur lange det ar nastan slackt
const BLACKOUT_LEVEL = 0.04;  // hur lagt
const BLACKOUT_IN_MS = 180;   // mjuk vag ner sa det inte klipper

const PHRASE_BARS = 8;
const PHRASE_RAMP = 0.10;      // +10 % over frasen
const TURNAROUND_DIP = 0.22;   // hur djupt sista takten dippar

/**
 * FÄRG PER SEKTIONSTYP.
 *
 * Paletten kommer från ALBUMOMSLAGET via Sonos-gatewayen — den är alltså redan
 * smakfull och låtspecifik. Men motorn använde bara `palette[0]`; tre av fyra
 * färger låg oanvända.
 *
 * En programmerad show byter inte färg hur som helst: samma sektionstyp ska ha
 * SAMMA färg genom hela låten, så att örat och ögat lär sig att "den här färgen
 * betyder refräng". Byte sker bara vid sektionsgränser — aldrig mitt i en fras.
 *
 * Index är in i palettens fyra platser. Refrängen får plats 0 (omslagets
 * dominerande färg), verserna plats 1, lugna delar plats 2, och 3 sparas som
 * kontrast för drops.
 */
// UPPMATT PROBLEM med palettplatser: albumomslaget ger ofta bara TVA distinkta
// farger. En riktig palett sag ut sa har: [[255,0,57],[141,105,253],[255,0,57],
// [255,0,57]] — tre av fyra identiska. Da far intro och refrang samma farg och
// hela iden faller.
//
// Battre, och det ar ocksa hur en ljusdesigner faktiskt arbetar: HALL HUEN,
// andra MATTNADEN. En vers ar djupt mattad och lasar intimt; en refrang
// avmattas mot vitt och "oppnar upp". Det fungerar aven med EN enda farg i
// paletten, och undviker diskoteksblinket som kommer av hue-byten.
//
// Varde = hur mycket fargen dras mot vitt, 0..255 (0 = full farg).
const SECTION_WASH: Record<string, number> = {
  chorus: 105,   // oppnar upp, storst och ljusast
  solo:    85,
  inst:    45,
  verse:    0,   // djup, mattad — showens "home look"
  bridge:  25,
  intro:   15,
  outro:   15,
  break:    0,
};
/** Dropens utropstecken: nastan vitt, mycket kort. */
const DROP_WASH = 200;
/** Hur länge dropens kontrastfärg håller i sig. Kort — den är ett utropstecken. */
const DROP_COLOR_MS = 1200;

export interface RenderedShow {
  /** Ljusstyrka 0-100 per SHOW_STEP_MS. */
  pct: Uint8Array;
  /** Avmattning mot vitt, 0-255, per SHOW_STEP_MS. */
  color: Uint8Array;
}

/**
 * Rendera hela showen. Returnerar ljusstyrka i procent per SHOW_STEP_MS.
 *
 * Ingenting här läser mikrofonen. Allt kommer ur analysen.
 */
export function renderShow(src: ShowSource, p: ShowParams = DEFAULT_SHOW): Uint8Array {
  const recFrom = src.recordedFromMs || 0;
  // Showen ska tacka HELA laten, inte bara inspelningen: den borjar vid 0 och
  // slutar dar inspelningen slutade. Tiden fore recFrom har ingen data och far
  // en lugn grundniva — det ar latens forsta sekunder, oftast tystnad eller intro.
  const durMs = Math.max(1000, recFrom + (src.analysedSeconds || 0) * 1000);
  const n = Math.ceil(durMs / SHOW_STEP_MS) + 1;
  const out = new Uint8Array(n);
  const col = new Uint8Array(n);
  lastColor = col;

  // ── Energikurvan → form 0..1 ────────────────────────────────────────────
  // Referens ur låtens EGEN fördelning: 95-percentilen, inte maxvärdet. Ett
  // enda anslag ska inte definiera vad "fullt" betyder.
  const e = src.energy;
  let ref = 0;
  if (e && e.length > 20) {
    const srt = [...e].sort((a, b) => a - b);
    ref = srt[Math.floor(srt.length * 0.95)] || 0;
  }

  // ── Sektionsnivåer, normaliserade mot låtens topp ───────────────────────
  // En låt vars enda etikett är `intro` ska INTE dimmas — tabellen beskriver
  // förhållandet mellan delarna, inte absoluta nivåer. (Det felet dämpade en
  // hel låt permanent innan det upptäcktes.)
  const parts = src.parts ?? [];
  let mHi = 0, mP = 0;
  for (const q of parts) {
    const sp = SECTION[q.label] ?? SECTION_DEFAULT;
    if (sp.hi > mHi) mHi = sp.hi;
    if (sp.pulse > mP) mP = sp.pulse;
  }
  // En låt vars enda etikett är `intro` ska INTE dimmas — tabellen beskriver
  // förhållandet MELLAN delarna, inte absoluta nivåer.
  const normS = mHi > 0 ? 1 / mHi : 1;
  const normP = mP > 0 ? 1 / mP : 1;

  // Energins fördelning per SEKTIONSTYP, så "hög energi" betyder högt FÖR DEN
  // DELEN. Annars mäts en tyst vers mot refrängens nivå och ligger i botten.
  // Nyare inspelningar lagras i showens egen takt; aldre i 100 ms.
  const eStep = src.energyStepMs && src.energyStepMs > 0 ? src.energyStepMs : 100;
  const eAt = (t: number): number => {
    if (!e || !ref) return 0.5;
    // Energikurvan ar indexerad fran INSPELNINGENS borjan -> dra bort offseten.
    const fi = (t - recFrom) / eStep, i0 = Math.floor(fi);
    if (i0 < 0 || i0 >= e.length) return 0.5;
    // Medelvarde over ENERGY_SMOOTH_MS: energikurvan innehaller trummorna, och
    // lat man den bara takten OCKSA blir den utsmetade versionen av varje slag
    // starkare an sjalva pulsen. Da stiger ljuset lange fore slaget och faller
    // efter det — uppmatt 13 enheters stigning mot 34 enheters fall, sa ogat
    // laser FALLET som handelsen. Agarens ord: "kor takten nar den fadar ner".
    //
    // Energin ska bara den LANGSAMMA formen; takten ar pulsens jobb.
    const half = ENERGY_SMOOTH_MS / (2 * eStep);
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, Math.round(fi - half)); j <= Math.min(e.length - 1, Math.round(fi + half)); j++) { sum += e[j]; cnt++; }
    const v = (cnt ? sum / cnt : e[i0]) / ref;
    const db = 20 * Math.log10(Math.max(v, 1e-4));
    return Math.min(1, Math.max(0, (db + 12) / 12));
  };

  // ── Slagen ──────────────────────────────────────────────────────────────
  // MINNETS EGNA SLAGTIDER om de finns. De är det enda som är exakt känt —
  // ett jämnt BPM-rutnät är en approximation av dem, aldrig tvärtom.
  const beats = src.beats && src.beats.length > 4 ? src.beats : null;
  const beatMs = src.bpm > 0 ? 60000 / src.bpm : 500;
  const decayMs = Math.max(60, beatMs * p.decayBeats);
  const isDownbeat = (i: number) =>
    src.beatPositions && src.beatPositions[i] === 1;

  const drops = src.drops ?? [];

  // Tidpunkter som fortjanar ett morker fore sig: varje drop, och varje
  // sektionsgrans in i en refrang (aven nar energin inte gjorde den till drop).
  const bigMoments: number[] = [];
  for (const d0 of drops) bigMoments.push(d0.t);
  for (const q of parts) if (q.label === 'chorus' || q.label === 'solo') bigMoments.push(q.t);
  bigMoments.sort((x, y) => x - y);
  // Sla ihop de som ligger nara varandra — ett morker racker.
  const moments: number[] = [];
  for (const m of bigMoments) if (!moments.length || m - moments[moments.length - 1] > 3000) moments.push(m);
  let mi = 0;

  // Per sektionstyp: medianenergi, så bandet kan fyllas RELATIVT den delen.
  const typeMid = new Map<string, number>();
  {
    const acc = new Map<string, number[]>();
    for (let i = 0; i < parts.length; i++) {
      const t0 = parts[i].t, t1 = i + 1 < parts.length ? parts[i + 1].t : durMs;
      const arr = acc.get(parts[i].label) ?? [];
      for (let t = t0; t < t1; t += 200) arr.push(eAt(t));
      acc.set(parts[i].label, arr);
    }
    for (const [k, arr] of acc) {
      if (!arr.length) continue;
      arr.sort((x, y) => x - y);
      typeMid.set(k, arr[arr.length >> 1]);
    }
  }

  // Per AVSNITT (inte per etikett): medianenergi. Se midByRank.
  // Fargtvatten foljer SAMMA omfordelning som ljusnivan. Annars kan ett morkt
  // avsnitt fa full mattnad for att etiketten rakar heta "chorus" -- ljuset och
  // fargen skulle beratta olika saker om samma takt.
  let washByRank: number[] | null = null;

  const midByRank: number[] | null = (() => {
    if (parts.length < E_MIN_PARTS) return null;
    const mid = new Array<number>(parts.length).fill(0.5);
    for (let i = 0; i < parts.length; i++) {
      const t0 = parts[i].t, t1 = i + 1 < parts.length ? parts[i + 1].t : durMs;
      const arr: number[] = [];
      for (let t = t0; t < t1; t += 200) arr.push(eAt(t));
      if (arr.length) { arr.sort((x, y) => x - y); mid[i] = arr[arr.length >> 1]; }
    }
    let elo = Infinity, ehi = -Infinity;
    for (const v of mid) { if (v < elo) elo = v; if (v > ehi) ehi = v; }
    if (ehi - elo < E_SPREAD_MIN) return null;   // energin skiljer dem inte at

    // VIKTAT EFTER SPELTID, inte antal avsnitt.
    //
    // En rak parning avsnitt-for-avsnitt lat en 1-SEKUNDS outro lagga beslag pa
    // latens ljusaste niva medan den 72 s langa delen fick den morkaste:
    // "Dricker Vin" nadde da bara 66 som p95 och lag aldrig over 85 %. Nivaerna
    // ska fordelas over TID, sa att den niva som galler lange ocksa upptar en
    // stor del av fordelningen.
    const dur = parts.map((q, i) => Math.max(1, (i + 1 < parts.length ? parts[i + 1].t : durMs) - q.t));
    const total = dur.reduce((a2, b2) => a2 + b2, 0);

    // Nivauppsattningen, sorterad, med sin speltid — ger en trappa over 0..1.
    const byCentre = parts.map((q, i) => {
      const sp = SECTION[q.label] ?? SECTION_DEFAULT;
      return { c: ((sp.lo + sp.hi) / 2) * normS, d: dur[i] };
    }).sort((a2, b2) => a2.c - b2.c);
    const edge: number[] = []; const val: number[] = [];
    let acc = 0;
    for (const x of byCentre) { acc += x.d; edge.push(acc / total); val.push(x.c); }
    const centreAt = (f: number): number => {
      for (let i = 0; i < edge.length; i++) if (f <= edge[i]) return val[i];
      return val[val.length - 1];
    };

    // Avsnitten i energiordning, var och en placerad vid mitten av sin egen
    // tidsandel. Stabil sortering: lika energi behaller ordningen i laten.
    const order = parts.map((_, i) => i).sort((a2, b2) => (mid[a2] - mid[b2]) || (a2 - b2));
    const out = new Array<number>(parts.length).fill(0.5);

    // Samma trappa, byggd av latens egna tvattvarden.
    const byWash = parts.map((q, i) => ({ w: SECTION_WASH[q.label] ?? 20, d: dur[i] }))
      .sort((a2, b2) => a2.w - b2.w);
    const wEdge: number[] = []; const wVal: number[] = [];
    let wAcc = 0;
    for (const x of byWash) { wAcc += x.d; wEdge.push(wAcc / total); wVal.push(x.w); }
    const washAt = (f: number): number => {
      for (let i = 0; i < wEdge.length; i++) if (f <= wEdge[i]) return wVal[i];
      return wVal[wVal.length - 1];
    };
    const wOut = new Array<number>(parts.length).fill(20);

    let seen = 0;
    for (const i of order) {
      const f = (seen + dur[i] / 2) / total;
      out[i] = centreAt(f);
      wOut[i] = washAt(f);
      seen += dur[i];
    }
    washByRank = wOut;
    return out;
  })();

  // Vilken instans i ordningen varje sektion ar, och hur manga det finns totalt.
  const seenType = new Map<string, number>();
  const totalType = new Map<string, number>();
  for (const q of parts) totalType.set(q.label, (totalType.get(q.label) ?? 0) + 1);
  const arcOf = new Array<number>(parts.length).fill(0);
  for (let i = 0; i < parts.length; i++) {
    const n0 = (seenType.get(parts[i].label) ?? 0);
    seenType.set(parts[i].label, n0 + 1);
    const tot = totalType.get(parts[i].label) ?? 1;
    arcOf[i] = tot > 1 ? n0 / (tot - 1) : 1;    // 0 forsta, 1 sista
  }

  let bi = 0;          // index i beats
  let pi = 0;          // index i parts
  let di = 0;          // index i drops
  let secLo = SECTION_DEFAULT.lo, secHi = SECTION_DEFAULT.hi, secP = 1, secMid = 0.5;
  let secCol = 0;
  let wash = 0;
  /** Realtidens heartbeat-envelope, kord over den inspelade energin. */
  let env = 0;
  let dropColorUntil = -1;
  let dropBoost = 0;

  for (let k = 0; k < n; k++) {
    const t = k * SHOW_STEP_MS;

    // sektion
    // `|| pi === 0`: showen tacker aven latens borjan FORE inspelningsstart, och
    // dar finns ingen etikett. Utan detta blev de sekunderna platt mellanljus ur
    // SECTION_DEFAULT — och med en inspelning som borjar 45 s in i laten hade det
    // blivit 45 s av ingenting. Latens oppning liknar rimligen dess forsta
    // markta del, sa den far galla bakat.
    while (pi < parts.length && (parts[pi].t <= t || pi === 0)) {
      const sp = SECTION[parts[pi].label] ?? SECTION_DEFAULT;
      // Bagen: senare instanser av samma typ lyfts.
      const arc = 1 + ARC_LIFT * arcOf[pi];
      let lo = sp.lo * normS * arc;
      let hi = sp.hi * normS * arc;
      // Overlang del -> vidare band kring OFORANDRAD mitt. Korta delar rors inte.
      // Mitten flyttas till den ENERGIRANKADE positionen; etiketten behaller
      // sin andel och hela bandets BREDD.
      if (midByRank) {
        // Etiketterna bestammer VILKA nivaer laten ska ha, energin bestammer VEM
        // som far vilken. Se midByRank.
        const half = (hi - lo) / 2;
        const want = midByRank[pi];
        lo = want - half; hi = want + half;
      }
      const nextT = pi + 1 < parts.length ? parts[pi + 1].t : durMs;
      const widen = Math.min(SECTION_WIDEN_MAX, Math.max(1, Math.sqrt((nextT - parts[pi].t) / SECTION_REF_MS)));
      if (widen > 1) {
        const ratio = (nextT - parts[pi].t) / SECTION_REF_MS;
        const pull = Math.min(SECTION_MID_PULL_MAX, (ratio - 1) * SECTION_MID_PULL);
        let mid = (lo + hi) / 2;
        // ENKELRIKTAD med flit: bara NEDAT. En lang LJUS del ar en topp som
        // overlevt sig sjalv och ska ge efter. En lang LUGN del ar daremot
        // musikaliskt akta -- och just det morkret ar vad en show byggs upp
        // ifran. Att dra aven den mot mitten tog bort andningen: "Bara Du Ler"
        // gick fran 25 % till 2 % tid under 25 % ljus nar dragningen gick at
        // bada hallen.
        const target = 0.5 * normS * arc;
        if (mid > target) mid += (target - mid) * pull;
        const half = ((hi - lo) / 2) * widen;
        lo = mid - half; hi = mid + half;
      }
      secLo = Math.min(1, Math.max(0, lo));
      secHi = Math.min(1, Math.max(0, hi));
      secP = Math.min(1, sp.pulse * normP);
      secMid = typeMid.get(parts[pi].label) ?? 0.5;
      secCol = washByRank ? washByRank[pi] : (SECTION_WASH[parts[pi].label] ?? 20);
      pi++;
    }

    // Energin RELATIVT sektionens egen median -> position i bandet.
    // Halva bandet vid medianenergi, kanterna vid ±0.25 därifrån.
    // ── REALTIDENS ENVELOPE, over den INSPELADE energin ────────────────────
    //
    // Agarens dom efter att ha jamfort: "mjukheten i heart-beat i realtid ar
    // perfekt... ar energinivan som ar lite for konstant i realtid".
    //
    // Alltsa: behall realtidens KANSLA, ratta det den ar dalig pa. Darfor kor
    // showen exakt samma envelope som motorn — snabb attack, LOGARITMISK
    // release — fast over den inspelade energikurvan i stallet for live-
    // signalen. Den logaritmiska releasen ar hela hemligheten: ljuset faller med
    // konstant FORHALLANDE per steg, och det lasar ogat som jamnt.
    //
    // Att kora den offline ger tva saker realtid inte kan: inget mikrofonbrus
    // och inga falska slag (energikurvan ar ren), och kannedom om framtiden.
    const shapeRaw = eAt(t);
    if (shapeRaw < env) {
      const a = 1 - Math.pow(1 - RELEASE_ALPHA, SHOW_STEP_MS / 125);
      const c = env < 1e-4 ? 1e-4 : env;
      const tgt = shapeRaw < 1e-4 ? 1e-4 : shapeRaw;
      env = c * Math.pow(tgt / c, a);
    } else {
      const softK = LOW_SOFT_FLOOR + (1 - LOW_SOFT_FLOOR) * Math.min(1, shapeRaw / 0.5);
      env += softK * (shapeRaw - env);      // attackAlpha = 1 → full snap
    }

    // Ingen egen slagpuls langre: den INSPELADE energin innehaller redan varje
    // anslag, och envelopen ovan ger den realtidens form. En puls ovanpa skulle
    // beskriva samma sak en gang till, och de tva konkurrerade — uppmatt syntes
    // slagpulsen knappt mot energins egen rorelse.
    let barPos = 0, barNo = 0;
    if (beats) {
      while (bi + 1 < beats.length && beats[bi + 1] <= t) bi++;
      barPos = (src.beatPositions && src.beatPositions[bi]) || ((bi % 4) + 1);
      barNo = Math.floor(bi / 4);
    } else {
      const idx = Math.floor(t / beatMs);
      barPos = (idx % 4) + 1;
      barNo = Math.floor(idx / 4);
    }

    // FRASERING: ramp over atta takter + turnaround pa den sista.
    const barInPhrase = ((barNo % PHRASE_BARS) + PHRASE_BARS) % PHRASE_BARS;
    let phrase = 1 + PHRASE_RAMP * (barInPhrase / (PHRASE_BARS - 1));
    if (barInPhrase === PHRASE_BARS - 1 && barPos >= 3) {
      // Sista takten, andra halvan: dipp sa nasta fras kanns som en start.
      phrase *= 1 - TURNAROUND_DIP;
    }

    // drops: förvarning (dipp + stigning) och själva träffen
    while (di < drops.length && drops[di].t <= t) {
      // En drop ar en HANDELSE. Golvet DROP_HIT gor att aven en svag
      // sektionsgrans blir ett tydligt anslag — det ar showens skiljetecken.
      dropBoost = Math.max(dropBoost, DROP_HIT * (0.6 + 0.4 * (drops[di].s ?? 0.5)));
      dropColorUntil = t + DROP_COLOR_MS;
      di++;
    }
    dropBoost *= Math.exp(-SHOW_STEP_MS / DROP_DECAY_MS);
    if (dropBoost < 0.005) dropBoost = 0;

    let build = 1;
    if (di < drops.length) {
      const dt = drops[di].t - t;
      if (dt > 0 && dt < BUILD_MS) {
        const u = 1 - dt / BUILD_MS;
        const s = drops[di].s ?? 0.5;
        build = 1 - BUILD_DIP * s * (1 - u) + BUILD_TOP * s * (u * u);
      }
    }

    // sammansättning — samma multiplikativa kedja som realtidsvägen, så
    // uttrycket känns igen, men varje term kommer ur analysen.
    // Pulsen som ABSOLUT amplitud, begransad till halva bandet.
    // SEKTIONEN SKALAR NIVAN — det ar det enda realtid inte kan.
    //
    // Realtid mappar sin envelope till samma omrade hela laten igenom, sa en
    // vers och en refrang far samma toppar. Agaren: "energinivan ar lite for
    // konstant i realtid". Har multipliceras envelopen med sektionens niva, sa
    // refrangens toppar ligger over versens utan att formen inuti andras.
    const secGain = secHi;
    let form = env * secGain * build * phrase;

    // MORKRET FORE hojdpunkten. Laggs sist och multiplicerar ner allt — den ska
    // vinna over sektionsband, fras och puls, for det ar hela dess poang.
    while (mi < moments.length && moments[mi] < t - 100) mi++;
    if (mi < moments.length) {
      const dt2 = moments[mi] - t;
      if (dt2 >= 0 && dt2 <= BLACKOUT_MS + BLACKOUT_IN_MS) {
        let f = 1;
        if (dt2 <= BLACKOUT_MS) {
          f = BLACKOUT_LEVEL;
        } else {
          // mjuk vag ner mot morkret
          const u2 = (dt2 - BLACKOUT_MS) / BLACKOUT_IN_MS;   // 1 -> 0 mot morkret
          f = BLACKOUT_LEVEL + (1 - BLACKOUT_LEVEL) * u2;
        }
        form *= f;
      }
    }
    if (dropBoost > 0) form += dropBoost * (1 - form);
    // LATENS OPPNING, fore inspelningens borjan. Dar finns varken energikurva
    // eller slag, sa formen skulle annars sta helt stilla tills inspelningen
    // borjar — ljuset reagerar inte pa nagot alls de forsta sekunderna, vilket
    // lasar som ett fel. En stigning gor samma tystnad till en avsikt, precis
    // som en show som tanks upp nar laten borjar.
    if (recFrom > 0 && t < recFrom) form *= OPENING_LOW + (1 - OPENING_LOW) * (t / recFrom);
    if (form > 1) form = 1; else if (form < 0) form = 0;

    const pct = p.floorPct + form * (100 - p.floorPct);
    out[k] = Math.round(Math.min(100, Math.max(0, pct)));
    // Avmattningen glider mjukt mellan sektioner — ett hue-hopp lasar som fel
    // aven nar tidpunkten ar ratt, och det galler mattnad lika mycket.
    const wTarget = t < dropColorUntil ? DROP_WASH : secCol;
    wash += (wTarget - wash) * (SHOW_STEP_MS / (t < dropColorUntil ? 120 : 1500));
    col[k] = Math.round(Math.min(255, Math.max(0, wash)));
  }

  return out;
}

/** Färgspåret från senaste renderShow. Enkelt så anropsstället slipper ändras. */
let lastColor: Uint8Array | null = null;
export function lastRenderedColors(): Uint8Array | null { return lastColor; }
