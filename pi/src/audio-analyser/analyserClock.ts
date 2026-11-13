/**
 * TAKTMATNINGEN (utbruten ur index.ts 2026-10-10, ordagrant): fasprediktionstilliten, den löpande takten (10-19, ersatte kick-PLL:en och fasfoljaren), taktfasen
 * (ettan) och coasten som haller cfg.beat (ankare + bpm + konfidens) levande per hop. Samma kod i motorn OCH i bankarna -
 * matfalla 43: bankerna satte cfg.beat.anchorMs = fr.beatAnchorMs varje hop, sa ctx.beatFrac hoppade 0,00 -> 0,45 pa 27 ms per slag
 * (halverad effektklocka + ankarhopp) och takteffekternas toppar ritades aldrig i banken. Klockan ar Date.now() (banken byter den per hop).
 */
/* ANALYSATORNS KLOCKA (a7r entempo, ägaren 11-09: "allt skall ju ligga i analysatorn"): flyttad hit ur beatFeed.ts ORDAGRANT. Filen hör
 * till analysatorn (analyser.ts importerar den, samma delade fil i lotus) och drar inte in något motorspecifikt: loggbrytaren kopplas
 * in utifrån (setClockLog, DMX: beatFeed.ts -> quiet.ts), MIN_BEAT_CONFIDENCE/GRID_EARLY_MS bor här (beatClock.ts re-exporterar), cfg är
 * klockans eget utfall (ClockCfg = { beat, beatErr }, samma form som motorns cfg). Var klockan körs avgör profilen på ETT ställe
 * (sys.BEAT_FEED, se analyser.ts clockMode). */
import type { Frame } from "./analyser.js";
/** Klockans grind: under denna tillit räknas takten som osäker (hasBeat i beatClock.ts). */
export const MIN_BEAT_CONFIDENCE = 0.20;
/** TILLITEN TILL TAKTEN (2026-11-11, EN källa för båda systemen: frame.beatTrust; förr räknad i DMX effects.ts och i lotus piEngine).
 *  Klockans tillit över grinden (ramp MIN_BEAT_CONFIDENCE .. +0,37), nerdragen av ihållande fasfel (> SYNC_ERR_FRAC av ett slag) och
 *  utjämnad över TRUST_TAU_MS. Förr 0,06 per RENDERRUTA i DMX = 81 ms vid rastrets 200 Hz (bildfrekvensberoende); nu i tid, per hop. */
export const SYNC_ERR_FRAC = 0.2, TRUST_TAU_MS = 81;
export function trustStep(prev: number, conf: number, beatErr: number, dtMs: number): number {
  let raw = (conf - MIN_BEAT_CONFIDENCE) / 0.37; raw = raw > 0 ? (raw > 1 ? 1 : raw) : 0;
  const se = beatErr < 0 ? -beatErr : beatErr;
  if (se > SYNC_ERR_FRAC) { const m = 1 - (se - SYNC_ERR_FRAC) / SYNC_ERR_FRAC; raw *= m > 0 ? m : 0; }
  return dtMs > 0 ? prev + (raw - prev) * (1 - Math.exp(-dtMs / TRUST_TAU_MS)) : prev;
}
/** Effektklockan ligger så många ms före vikningstoppen (se beatClock.ts). */
export const GRID_EARLY_MS = 20;
let isLogOn: () => boolean = () => false;
/** Systemets loggbrytare (DMX: quiet.ts isLogOn) - analysatorn själv loggar inget utan den. */
export function setClockLog(f: () => boolean): void { isLogOn = f; }
/** Klockans utfall: rutnätet (ankare, bpm, tillit) och UI:ts fasfel. Motorns EngineConfig har samma två fält. */
export interface ClockCfg { beat?: { anchorMs: number; bpm: number; confidence?: number } | null; beatErr?: number }
type EngineConfig = ClockCfg;

// COAST: konfidensen dippar i breakdowns/brus men TEMPOT är oftast fortfarande rätt.
// Släpper vi gridet direkt hoppar effekterna till kick-drift och glider tillbaka när
// takten kommer igen. Vi håller därför gridet fri-rullande en stund innan vi ger upp.
const GRID_ON_CONF = 0.35;   // tydlig takt igen → coast avbryts
const GRID_COAST_MS = 4000;  // så länge håller vi gridet på svag konfidens

// TILLITEN = MÖNSTRET ÅTERKOMMER (natt 10-13, ägarens punkt 4 'taktsäkerhet', 'varje slag ska kännas'). Förr räknades en kick
// som bevis bara om den låg inom ±0,25 slag från gridets slag. Mätt på katalogkorpusen frozen6 (161 klipp, taktklockan mot
// facit, var 0,25 s): det måttet var SÄMRE än slumpen på att skilja rätt tempo från fel (AUC 0,43 - rätt klocka median 0,41,
// fel klocka 0,48), för ±0,25 slag täcker halva cirkeln (slumpkickar ger 0,5) och synkoperade mönster räknas som miss.
// I ladan (23 inspelningar, konsertReplay med MÄTFÄLLA 47+48 rättade) stod tilliten i cykeln 0,29/0,33/0,38 = träff-miss-miss
// 42 % av tiden: kickmönster med 3 kickar per 2 slag (314/416/315 ms vid 114,5 BPM) - exakt periodiska över 2 slag, klockan
// rätt, men 2 av 3 kickar 'av'. Nu räknas kicken som bevis om den ligger på slaget (som förr) ELLER om en kick kom exakt TVÅ
// SLAG tidigare (±6 % av slaget): då förutsäger gridets tempo mönstret, vilken plats i takten kicken än har. Korpusen: rätt
// klocka median 0,41 -> 0,95, fel klocka 0,48 -> 0,87 (AUC 0,43 -> 0,64: måttet gynnar inte längre fel tempo). Tempot rörs inte:
// Coastens tempo-nollning läser fortfarande fasträffarna (pllConf) - med det nya måttet
// även där nollades tempot mer sällan och korpusens klocka föll 81,5 -> 76,7 % (fel tidiga lås hölls kvar).
// DMX_TRUST_REPEAT=0 = gamla måttet (bit-identiskt).
const TRUST_REPEAT_BEATS = 2, TRUST_REPEAT_TOL = 0.06;
/** PROVRATTAR 2026-11-07 (dagkörningen; ladan 11-06: 'efter drop tog det 2-3 s innan den tydligt visade takten igen'): bara för bänken,
 *  osatt = dagens värden (json-identiskt). DMX_TRUST_UP = tillitens steg per kick UPPÅT (0,12 = som i dag, ned alltid 0,12);
 *  DMX_TRUST_LEAK_MS = hur fort tilliten läcker i ett break utan kickar (4000 = som i dag; längre = tilliten finns kvar när dropen kommer).
 *  DMX_BREAK_HOLD_MS/DMX_BREAK_RESTORE_MS (nattens förkastade patch prov/breakhold-20261107.patch) är åter inlagda som rattar för proven. */
const TRUST_UP = Number(process.env.DMX_TRUST_UP || '0.12'), TRUST_LEAK_MS = Number(process.env.DMX_TRUST_LEAK_MS || '4000');
/** LÖPANDE TAKT - RUTNÄTET PÅ LJUDETS SLAG (ägaren 10-19: 'allt i bakgrunden så snabbt som möjligt, effekten får info om exakta
 *  takten så snabbt det går'). Mätt i bänken (showTight --step 5, pop): kickbandets anslag (frame.onset.kick) är tydligt periodiskt, men
 *  rutnätets slag låg 40-160 ms fel och gled (tempo 1-1,5 BPM fel) - kick-PLL:en drar 10 % per kick och 'kick' fyrar på kylningens kant.
 *  Här viks de senaste ONSET_WIN_MS av kickbandets anslag (sedan 10-27 basens dB-stigning, se nedan) var ONSET_EVERY_MS på tempon kring det låsta (+-2,5 %), och rutnätet sätts DIREKT på
 *  toppen (fas + tempo, slagindex bevaras). Sökningen sker kring rutnätets eget tempo OCH analysatorns (nytt tempo/låt); utan tydlig
 *  topp (< ONSET_MIN_PEAK x medel) rullar rutnätet vidare som det är. Ersatte kick-PLL:en, TEMPO_PERSIST och fasföljaren (enda vägen). */
const ONSET_WIN_MS = 5000, ONSET_EVERY_MS = 250, ONSET_BINS = 48, ONSET_RING = 1024, ONSET_MIN_PEAK = 1.5;
/** BASENS STIGNING (STANDARD i ladan 10-27, ägaren: 'ser bra ut'; backup-tagg backup/fore-feed-rise-2026-10-27; gallop-felet i videon 10-26):
 *  onset.kick är klampad 0/1 (fynd 10-22) och mättar på hela bas-svallet i pumpande musik - vikningen lade då rutnätet där ettorna var
 *  tätast, mätt +120..170 ms efter kickens ansats (gallop: grupp A tändes +130 ms, B:s 0,75-slag på kicken). Nu viks basens (sub+kick,
 *  specAbs) STIGNING i dB över FEED_RISE_HOPS hop (omättad, toppar på ansatsen): gridet -32 ms (showLead före), taktKorpus 67,1 -> 83,2 %. */
const FEED_RISE_HOPS = 6;
/** TVÅ RUTNÄT (10-28) ÄR BORTA (r0 entempo): analysatorns skuggrutnät och dess resetTempo/resetBar finns inte längre - se update(). */
/** TAKTEN GENOM BREAKET (STANDARD 2026-11-08 = 20000, ladan 11-07 godkänt; förr opt-in DMX_BREAK_HOLD_MS, natt 2026-11-07; ladan 11-06: 'efter drop tog det 2-3 s innan den tydligt visade
 *  takten igen' - ws-loggen: analysatorns bpm 0 i 14,6 s av breaket, effektklockan nollades och låste 4,2 s efter dropen). Med > 0:
 *  (1) när analysatorns bpm blir 0 rullar effektklockans rutnät vidare på sitt tempo i högst så många ms (tilliten läcker som förr, så
 *  takteffekterna lugnar sig i breaket); kommer bpm tillbaka på ett annat tempo (inte samma oktav +-4 %) tas det nya som förr;
 *  (2) första kicken efter > 1,5 s utan kickar (dropen) som ligger inom +-0,25 slag: fasen sätts på kicken och tilliten tas upp till
 *  värdet före tystnaden (rutnätet hade redan rätt tempo). 0 = av (bit-identiskt). Bara effektklockan, inte analysatorns skuggrutnät. */
const BREAK_HOLD_MS = 20000;   // r0: hållet = klockan rullar alltid vidare (analysatorns bpm 0 finns inte längre); kvar som (2):s fönster
//   // STANDARD 2026-11-08 (ladan 11-07: godkänt; backup-tagg backup/fore-tio-standard-20261108); förr opt-in DMX_BREAK_HOLD_MS
const BREAK_RESTORE_MS = Number(process.env.DMX_BREAK_RESTORE_MS ?? String(BREAK_HOLD_MS));   // (2) för sig (prov: hållet av, bara dropens upptag)
/** ETTAN I EFFEKTKLOCKANS RUTNÄT (a5, arenan tvavagar 2026-11-08). Förr flyttades effektklockan med analysatorns barShift, men den
 *  räknas mot ANALYSATORNS rutnät (TVÅ RUTNÄT, skuggan) - de två rutnätens slagindex skiljer ett godtyckligt antal slag, så ettan
 *  satt rätt bara när skillnaden råkade vara hela takter (testDownbeat-signalen: 23 % rätt, slumpen 25 %). Nu har effektklockan
 *  en EGEN taktmodell i den långsamma vägen: fyra hypoteser (taktens fyra platser i rutnätets slagindex) körs parallellt med långt
 *  minne (BAR_DECAY per slag, ~25 takter). Varje slag mäts i fönstret BAR_WIN0..BAR_WIN1 slag runt rutnätets slag: basens (sub+kick)
 *  linjära stigning (tyngsta slaget = ettan), basgångens stigning (specAbs.bass: basnoten byts på ettan) och virveln/diskanten
 *  (backbeat på 2 och 4 talar MOT platsen). Platsens andel av varje särdrag summeras; vinner en annan plats med marginalen BAR_MARGIN
 *  efter minst BAR_MIN slag blir den ettan. Ettan läggs bara i det PUBLICERADE ankaret (cfg.beat = inre rutnät + barOff hela slag):
 *  rutnätets egen sökning (onsetStep, vikningen mot ankaret) körs på det inre ankaret precis som förr, så tempo och fas är
 *  oförändrade - en flyttad etta stör aldrig vikningen. */
const BAR_DECAY = 0.99, BAR_MIN = 16, BAR_MARGIN = 0.06, BAR_W_BASS = 0.5, BAR_W_BACK = 0.5, BAR_WIN0 = -0.2, BAR_WIN1 = 0.3, BAR_RISE_HOPS = 6;
/** HELA TEMPOOMRÅDET (2026-10-30, ägaren: 'få rutnätet att ha rätt tempo'): effektklockans andra sökcentrum var analysatorns bpm, som
 *  i en mix står fel länge efter ett låtbyte (tempoMix: rätt 63 %, icke-harmoniskt fel 20 %, lås median 6 s). Nu viks basens stigning
 *  över ALLA tempon 80-160 (1 %-steg, ett tempo var FULL_EVERY:e hop = ett varv per 0,6 s, minst FULL_MIN_N värden = 3 s ljud); vinnaren
 *  och dess harmoniska syskon (FULL_SIBLINGS) döms sedan på basens topp x virvelns/diskantens topp (2/3- och 4/3-felen i shuffle) och
 *  domarens val blir andra sökcentrum (utan topp: analysatorns bpm som förr). Aldrig oktavbyte (80-160 rymmer både slaget och halvslaget:
 *  en låt på 160 hoppade annars 160 <-> 80), och ett tempo kring andra centrum måste slå klockans eget med FULL_MARGIN (annars hoppar
 *  klockan mellan harmoniska tvillingar). tempoMix --all (161 klipp, 99 min): klockan rätt 75,8 -> 84,5 %, lås efter låtbyte median
 *  5,1 -> 2,8 s, rätt inom 5 s 78 -> 127/161, aldrig rätt 9 -> 2, tempohopp inom låt 0,90 -> 0,57/min. taktKorpus (161 klipp var för
 *  sig): klockan 81,7 -> 91,3 %, tempobyten 1,29 -> 1,20/klipp. Provat och förkastat: marginal 1 (1,23 hopp/min, gridfasen på kvällen
 *  10-21 95 -> 27 %) och 1,25 (0,95/min, 72 %), bekräftelse två varv, 0,5 %-steg (längre varv), HMM-utjämning av varvets vinnare
 *  (sämre), samma tempo till analysatorns rutnät (sektion upp 2,6 -> 4,1 s, som 10-29). Analysatorns rutnät orört. */
/** EN TEMPOSÖKNING (arena tvavagar a1, 2026-11-08; ersätter HELA TEMPOOMRÅDET 10-30 + andra sökcentrumets skanning + klockans egen
 *  vandring): ETT ackumulerat tempogram i långsamma vägen som klockan läser. Förr sökte tre saker tempo var för sig - helsökningen
 *  (70 tempon à 1 %, ett varv utan minne, vinnaren flackade 97/145/84/126 mellan varven), andra sökcentrumet (+-2,5 % kring den) och
 *  klockans egen skanning (+-2,5 % kring sitt tempo var 250 ms, kunde vandra 122 -> 143 på 5 s). Nu: TG_K hypoteser på ett CIRKULÄRT
 *  log-rutnät över en oktav (80 * 2^(k/TG_K), 0,5 %-steg, 80 och 160 är grannar), TG_PER_HOP per hop (ett varv per ~0,37 s). Poängen per
 *  hypotes = BASENS vikning x VIRVELNS/DISKANTENS vikning, var och en (topp + värdet ett halvslag efter toppen) / 2 / medel: halvslaget
 *  (åttondelarna) är beviset som skiljer slaget från 2/3- och 4/3-fantomerna (en fantom har ingen topp mitt emellan sina slag). Poängen
 *  EMA:as per hypotes (TG_A per varv), vinnaren = tempogrammets topp (parabel i log-rutnätet), klämd till [80, 160). Klockan skannar
 *  sedan bara fint kring vinnaren (+-1,25 % i 0,25 %-steg) för fas och fintempo. Offline på basens signaler (a1/ev.mjs, 50 klipp + mixen):
 *  rätt tempo 88,9 -> 99,0 % (klipp) och 88,5 -> 97,8 % (mix), tempobyten i mixen 66 -> 2 (bara basens vikning: 89 / 88 %). */
/** KRONAN (r0): en annan topp måste slå det regerande tempots poäng med så mycket (r0/verktyg: 1,3 och 1,4 gav ned_s 2,80, 1,35 1,90 - kniveggen). */
const TG_HOLD = 1.35;
const TG_SIB = [Math.round(Math.log2(4 / 3) * 139), Math.round(Math.log2(3 / 2) * 139)];   // 4:3 och 3:2 i rutnätets steg (TG_K = 139 per oktav)
const TG_SNAP = 0.03, TG_EDGE = 1.03, TG_OCT_UP = 0.85, TG_OCT_DN = 0.4, TG_OCT_A = 0.1;
/** EN KÄLLA (r0): analysatorns kickgrind på klockans inre rutnät + denna fasta, mätta offset (a1 entempo: analysatorns kickar ligger
 *  median +30..+65 ms efter rise-rutnätet på 6 fönster ur övningens lång-filer). */
const KICK_PHASE_MS = 45;
/** a8r (ladan-provet 11-08, punkt 3): rutnätet 5 ms tidigare utöver GRID_EARLY_MS, ljusets försprång orört -> ljuset 5 ms tidigare. */
const TG_GRID_EXTRA_MS = 5;   // oktavkanten +-3 %; övre oktaven bara om analysatorns bpm ligger nära den (>= 148); fullt fönster (~4,8 s)
/** TEMPOGRAMMETS FÖNSTER OCH MINNE (a2r entempo): 3,5 s och 0,4 per varv (förr 5 s / 0,21 = ONSET_WIN_MS). Efter en låtskarv tog
 *  toppen ~4 s att byta (förra låten fyllde fönstret och minnet), mätt på 10 låtpar (a2r/verktyg/par.mjs): lås median 4,1 -> 2,4 s;
 *  M1 (--mat, snabbt läge när fasträffarna < 0,7 = i praktiken alltid i pop): mix_las 3,49 -> 2,10, mix_hopp 0,10 -> 0,03, låtgränsen 9 -> 11 av 15. */
/** TVÅ MINNEN I SAMMA SÖKNING (a2f entempo): tempogrammet bär ett LÅNGSAMT minne (5 s / 0,21 = r0: stabil topp -> fasen, gridfel
 *  r0 15,2 mot a2r 22,1 ms) och ett SNABBT (3,5 s / 0,4 = a2r: låser om på ~2 s efter en skarv). Klockans tempo är alltid det
 *  långsammas topp; pekar det snabba på ett annat tempo (> TG_SW_STEPS steg, se TEMPOHOPPEN) TG_SW_N varv i följd ersätter
 *  det snabba minnet det långsamma, så toppen byter direkt; tills det långsamma fönstret är fullt (kallstart, relock vid låtgräns) styr
 *  det snabba (a2f M1 utan det: upp_s 1,35 -> 2,85 = lang1021-skiftet 2,3 s efter låtgränsen). Samma hypoteser, samma poäng - två EMA:er.
 *  TEMPOHOPPEN (2026-11-10, lotus i källaren: 125 -> 82-86 -> 125 inom sekunder, tilliten på golvet; backup-tagg backup/fore-tempohopp-20261110):
 *  bytet krävde förr bara att det snabba pekade ANNANSTANS två varv (0,74 s); kronans marginal gällde bara exakta 4:3/3:2-syskon (±1 %).
 *  Det snabba minnet (3,5 s) följer fills och breaks, och fantomerna ligger ofta 1,38-1,46 x eller 1-3 % bredvid 3:2: 359 av 528 tempobyten
 *  i 128 min ljud kom den vägen, de flesta studsade tillbaka. Nu måste det snabba minnets topp slå det regerande tempots poäng i samma
 *  minne med TG_HOLD (kronan) för ALLA tempon. En ny låt utan låtgräns klarar det: förra låtens poäng dör ur det snabba fönstret på ~3 s.
 *  Mätt (tools/natt/tempohopp-2026-11-10.md): utflykter (tempot lämnar och kommer tillbaka inom 15 s) 1,45 -> 1,00/min, tid i utflykt 4,6 -> 2,9 %. */
const TG_WIN_MS = 5000, TG_FULL_N = 900, TG_FWIN_MS = 3500, TG_FFULL_N = 630, TG_FA = 0.4, TG_SW_STEPS = 6, TG_SW_N = 2;
/** HÅLLEN TOLKNING EFTER SÄKER LÅSNING (arena klocka2 k4, 2026-11-12; bygger på prov/flerhypotes-fh1-20261110.patch). Klockan har två
 *  lägen. START (tgR < 0: kallstart, efter låtgräns, tystnad eller ett bevisat byte): dagens snabba väg oförändrad (två minnen, kronan).
 *  När tempogrammets val stått på samma hypotes (+-2 steg) OCH över brustaket i TG_LOCK_N varv i följd (~3 s = 1-2 takter) är låsningen
 *  SÄKER och hypotesen blir REGENT (tgR). HÅLLET: alla TG_K hypoteser följs med var sin bevissumma (tgD); varvets bevis = log av poängen i
 *  det korta fönstret (bästa av grannarna +-TG_NB) minus BRUSTAKET (varvets median + TG_NOISE). Utmanarna summerar sitt bevis från ett
 *  golv = TG_SW_P + TG_SW_G x regentens HÄLSA (EMA av dess överskott); regenten byts först när en utmanares summa gått om = bevis över
 *  flera varv (takter), inte en enstaka topp i ett fill. Ett bevisat byte är en NY tolkning/låt: tempogrammet sås ur varvets poäng och
 *  klockan går tillbaka till START tills nästa säkra låsning. Mätning av bevis över tid, ingen utjämning av det publicerade tempot. */
const TG_NOISE = 0.6, TG_NB = 2, TG_SW_P = 1, TG_SW_G = 2, TG_HL_A = 0.5, TG_LOCK_N = 8, TG_LA = 0.04, TG_KNOWN = 0.5, SCAN_HOLD = 1.06;
/** LÅTENS MINNE (2026-11-13, ägaren: "lös källarväxlingen med Sonos låtgräns"). När värden har en SÄKER låtgräns (an.boundSure: lotus
 *  spelar ett Sonos-spår som är EN låt) är allt mellan två låtgränser samma låt, och ett nytt tempo utan låtgräns är en annan läsning av
 *  den - inte en ny låt. Då blir det långa minnet (tgAccL) LÅTENS: medelvärdet av varje varvs poäng sedan låtgränsen, med horisonten
 *  1 / TG_SONG_A varv (~60 s) i stället för ~9 s, och när det hört lika länge som sin gamla horisont (1 / TG_LA varv) väljer DET tempot.
 *  Hållet, kronan och de två minnena vilar - de finns för att skilja ny låt från samma, och det har låtgränsen redan sagt. Fintempo,
 *  oktavkant, topprösten och vittnet går som förr. Utan säker låtgräns (DMX, mixar, radio, tv) är allt som förut.
 *  HORISONTEN är skyddsnätet: en låt som verkligen byter tempo (eller en mix som värden tagit för en låt) följs efter 30-45 s i stället
 *  för aldrig (megamixen som EN låt: fel tempo 294 av 600 s utan horisont, 120 s med 60 s, 72 s med 30 s).
 *  Mätt på källarklippen med Sonos-låtbytena inlagda (11 klipp, 27 min, byten > 4 % utanför låtgräns): alla 2,06 -> 0,60 /min, de 7 som
 *  återskapar växlingen 3,34 -> 0,85 (30 s: 1,16; 120 s: 0,67; utan horisont: 0,73). Lotus 126 låtar: 117 rätt = oförändrat. */
const TG_SONG_A = 1 / 160;
/** a3 TOPPRÖSTEN (se peakVote): syskonen, faktor, varv i följd; oktaven under kanten (se tgStep). */
const HV_R = [4 / 3, 3 / 4, 3 / 2, 2 / 3, 5 / 4, 4 / 5], HV_K = 1.25, HV_N = 5, HV_AGE = 30, TG_OCT_LO = 79.6, TG_OCT_LO_N = 8;
/** TAKTENS SJÄLVLIKHET - ett andra vittne (arena klocka2dmx J1, 2026-11-13). Tempogrammet frågar 'ligger energin PÅ slaget?'. Vittnet
 *  frågar 'upprepar sig MÖNSTRET när det flyttas 2 och 4 slag?': korrelationen mellan ansatsserien och sig själv förskjuten 2 resp. 4 slag
 *  av kandidatens tempo, över PW_WIN_MS, basens stigning och diskanten var för sig (fyra tal, summan -4..4). Rätt tempo upprepar sig på
 *  båda (virveln på 2 och 4, basgången per takt); 4/3-fantomens '2 slag' är 1,5 riktiga slag, 3/2-fantomens '4 slag' är 2,67.
 *  Vittnet dömer bara mellan klockans tempo och dess SYSKON (4/3, 3/4, 3/2, 2/3), och bara när domen är TYDLIG: den enes mönster finns
 *  (>= PW_MIN) och är TG_HOLD gånger tydligare än den andres. Sond (joker-sond/analys.py A4, övningsmixen 2230 fönster): tydligt för rätt
 *  tempo 68,0 %, tydligt för ett syskon 0,04 % (1 fönster), otydligt 32 %; i de 51 fönster där vikningen har fel: 24 tydligt rätt, 0 fel.
 *  (1) VETO: vill varvets val byta till ett syskon och vittnet är tydligt för regenten står regenten kvar - men bara om regentens mönster
 *      också finns i fönstrets senare halva (en ny låt i syskonförhållande, övningsmixen 152 -> 102: då är det borta och bytet går som förr).
 *  (2) RÄTTNING: är vittnet tydligt för ett syskon mot klockans tempo HV_N varv i följd, och tempogrammet inte är säkert på regenten
 *      (syskonet inom kronans marginal TG_HOLD i det långsamma minnet), byter klockan dit.
 *  Efter ett tempobyte som INTE är ett syskonbyte (ny låt, låtgräns, kallstart) tiger vittnet i PW_WIN_MS - fönstret rymmer förra takten. */
const PW_RING = 4096, PW_WIN_MS = 10000, PW_MIN = 0.5, PW_Q = [4 / 3, 3 / 4, 3 / 2, 2 / 3];
const TG_K = 139, TG_STEP = Math.pow(2, 1 / TG_K), TG_PER_HOP = 1, TG_A = 0.21, TG_MIN_N = 300, TG_FINE = 0.0025, TG_HALF = ONSET_BINS >> 1;

/**
 * FAS-PREDIKTIONSTILLIT — landar verkliga trumslag dar rutnatet pastar?
 *
 * Tempogrammets peak-to-mean (`frame.bpmConfidence`) matte fel sak for det har
 * andamalet. Tva invandningar, bada mekaniska:
 *   1. Harmonikerna pa 2L och 3L lyfter medelvardet i namnaren och SANKER
 *      darmed konfidensen — precis nar takten ar som tydligast.
 *   2. Hjartslaget behover inte veta hur spetsigt tempogrammet ar, utan om
 *      rutnatet FORUTSAGER slagen. Det ar en annan fraga.
 * Den fragan ar redan nastan besvarad: PLL:en raknar fasfelet per kick.
 *
 * Bevaras: i ett lugnt parti kommer inga kickar, bevisen slutar komma, tilliten
 * lacker ner och pulsen drar sig undan — samma beteende som forut, men nu med
 * en principiell grund i stallet for som biprodukt av ett tempogram.
 */
/** EN FAS OCH EN ETTA FÖR BÅDA (klocka r0 = a4:s fas och etta): ramens fasfält är klockans PUBLICERADE rutnät (samma ankare som
 *  DMX:s cfg.beat), aldrig en egen fasanalys. beatPhaseMs = det publicerade ankaret minus offsetMs (lotus GRID_PHASE_OFFSET_MS, 0 i bänken);
 *  beatPhaseConf = 1 + tillit (= lotusbank --fas klocka). Mätt i lotusbank r0 mot a8:s 'senaste slaget <= nu' + 1/(1 - tillit):
 *  följare raw 0,96 (23 ms, n 343) / f1-f3 0,98 mot 0,83 (22 ms, n 403) / 0,85; fasen (0,84/15/257) lika. barShift (a4) = klockans
 *  etta (taktmodellen, DMX ettan 100 %) i slagindex för systemets EGET rutnät `ref` (lotus: motorns _beat via setBeatGrid;
 *  (idx + barShift) % 4 === 0 = ettan), räknat på klockans slag närmast nu; -1 innan taktmodellen dömt en etta. Ersätter analysatorns
 *  kick-taktfas (barAcc). */
export function publishPhase(f: { beatPhaseMs: number; beatPhaseConf: number; barShift: number }, b: ClockCfg["beat"], barKnown: boolean,
  ref: { anchorMs: number; bpm: number } | null | undefined, now: number, offsetMs: number): void {
  if (!b || !(b.bpm > 40)) { f.beatPhaseMs = 0; f.beatPhaseConf = 0; f.barShift = -1; return; }
  const per = 60000 / b.bpm, j = Math.floor((now - b.anchorMs) / per);
  f.beatPhaseMs = b.anchorMs - offsetMs; f.beatPhaseConf = 1 / Math.max(0.05, 1 - (b.confidence ?? 0));   // a8f D4: lotus on/anti-skala (1 = ingen information) - halvslagsflytten (PHASE_FLIP_CONF 2,0) nås vid tillit >= 0,5
  if (!barKnown) { f.barShift = -1; return; }
  const r = ref && ref.bpm > 40 && Math.abs(ref.bpm / b.bpm - 1) < 0.04 ? ref : b;
  const ir = Math.round((b.anchorMs + j * per - r.anchorMs) / (60000 / r.bpm));   // klockans senaste slag i ref-rutnätets index
  f.barShift = (((((j % 4) + 4) % 4) - ir) % 4 + 4) % 4;   // ettan = ir - (j mod 4) i ref-index -> (idx + barShift) % 4 === 0 där
}

export class BeatFeed {
  private trustSm = 0; private trustAt = 0;   // dirigenternas tillit (trustStep), stegad sist i update
  onBeatRate = 0;          // andel kickar med |fasfel| < 0.25 (coasten; tilliten utan TRUST_REPEAT)
  repeatRate = 0;          // TRUST_REPEAT: andel kickar på slaget ELLER som upprepar en kick två slag tidigare (tilliten)
  pllKicks = 0;            // hur mycket bevis fasprediktionen faktiskt vilar pa
  private lastTrustLog = 0;
  private lastPllKickMs = 0;
  private readonly kickRing = new Float64Array(64); private kickRingPos = 0; private kickRingN = 0; private kickRingLast = 0;
  private gridWeakSince = 0;       // ms-tidpunkt då konfidensen föll under grinden (0 = stark)
  private gridCoasting = false;
  // LÖPANDE TAKT: ring med (tid, onset.kick) per hop + vikningens arbetsytor (inga allokeringar per hop)
  private readonly onT = new Float64Array(ONSET_RING); private readonly onV = new Float32Array(ONSET_RING); private readonly hiV = new Float32Array(ONSET_RING); private hiPrev = 0; private onPos = 0; private onN = 0; private onHalf = false; private onPrev = 0;
  private readonly foldS = new Float64Array(ONSET_BINS); private readonly foldN = new Float64Array(ONSET_BINS); private onNext = 0;
  onsetFixes = 0;
  private readonly riseDb = new Float64Array(FEED_RISE_HOPS); private risePos = 0;
  // HELA TEMPOOMRÅDET: egna vikningsytor, varvets bästa och förra varvets vinnare (fullBpm = andra sökcentrum, 0 = ingen topp)
  private readonly fullS = new Float64Array(ONSET_BINS); private readonly fullN = new Float64Array(ONSET_BINS);
  private readonly tgAcc = new Float64Array(TG_K).fill(-1); private readonly tgH = new Float64Array(ONSET_BINS); private tgK = 0; private tgN = 0;
  private readonly tgAccF = new Float64Array(TG_K).fill(-1); private tgSw = 0; tgSwitches = 0;   // TVÅ MINNEN (a2f)
  // HÅLLEN TOLKNING (k4): varvets poäng (tgF), dess log med grannar (tgW), sorteringsyta (tgQ), bevissumman (tgD), regenten (tgR, -1 = START), hälsan, låsräknaren
  private readonly tgF = new Float64Array(TG_K); private readonly tgW = new Float64Array(TG_K); private readonly tgQ = new Float64Array(TG_K);
  private sure = false;   // LÅTENS MINNE: värdens låtgräns är säker (an.boundSure)
  private readonly tgD = new Float64Array(TG_K); private tgR = -1; private tgHl = 0; private tgLk = 0; private tgLkK = -1;
  private readonly tgAccL = new Float64Array(TG_K).fill(-1); private tgLN = 0;   // k4b (lånat av k2b): långt minne (~10 s) - har låten hört tempot?
  /** EN TEMPOSÖKNING: tempogrammets vinnare (0 = ingen topp än) - klockans skanningscentrum. */
  tempoBpm = 0;
  /** TEMPOTS TYDLIGHET 0..1 (t1f): 1 - näst bästa tempohypotesens poäng / vinnarens, x 3, tak 1 (se tgStep). */
  tgClear = 1;
  private hvRun = 0; hvSwitches = 0; private hvAge = 0; private hvVoted = false; private hvKeep = 0; private hvEver = false; private octLoN = 0; private hvT0 = 0; private hvBest = 0;   // a3 TOPPRÖSTEN (hvEver: D1, rösten har bytt sedan låset)
  // TAKTENS SJÄLVLIKHET (J1): egen ring (bas, diskant, tid), fönstret (antal, ms per värde), rättningens kandidat och varv i följd, tystnad till
  private readonly pwE = new Float32Array(PW_RING); private readonly pwH = new Float32Array(PW_RING); private readonly pwT = new Float64Array(PW_RING); private pwPos = 0; private pwN = 0;
  private pwWn = 0; private pwDt = 0; private pwCand = 0; private pwRun = 0; private pwQuietAt = 0; pwVetos = 0; pwFixes = 0;
  private tgHalfR = 0; octR = 0; private octN = 0; private octHi = false;   // OKTAVKANTEN (r0): halvslagskvotens EMA och läget
  private goodOn = 0; private goodRep = 0; private goodAt = 0;   // TAKTEN GENOM BREAKET
  // ETTAN (a5): fyra platsers särdrag (inre slagindex & 3), pågående slagets max, linjära ringar för stigningen, publicerat ankare
  private readonly barK = new Float64Array(4); private readonly barL = new Float64Array(4); private readonly barB = new Float64Array(4);
  private barN = 0; private barIdx = NaN; private bK = 0; private bL = 0; private bB = 0; private barOff = 0; barShifts = 0;
  private readonly linK = new Float64Array(BAR_RISE_HOPS); private readonly linL = new Float64Array(BAR_RISE_HOPS); private linPos = 0;
  private innerAnchor = 0; private innerBpm = 0; private innerValid = false;
  /** EN KÄLLA (r0 entempo): analysatorns rutnät (kickgrinden) = klockans INRE rutnät + KICK_PHASE_MS; null = grinden öppen (klockan i coast). */
  private readonly anaGrid = { anchorMs: 0, bpm: 0, confidence: 0 };
  private boundSeen = 0;
  /** Det cfg analysatorn ska byggas med: en grund kopia (analysatorns rutnät sätts via setClockGrid i update, aldrig i motorns cfg.beat). */
  /** EN ETTA (a4): har taktmodellen dömt en etta (minst BAR_MIN slag sedan start/låtgräns)? */
  barKnown(): boolean { return this.barN >= BAR_MIN; }
  static analyserCfg<T extends object>(cfg: T): T { return { ...cfg, beat: null }; }

  private foldMean(k: number): number { const q = (k + ONSET_BINS) % ONSET_BINS; return this.foldN[q] ? this.foldS[q] / this.foldN[q] : 0; }

  // Sökningen sprids över hoppen: ETT tempo per hop (Pi Zero: hela sökningen i ett anrop = 2 ms på PC:n, ~20 ms på Pi:n = stopp i slingan).
  private scanStep = 0.005; private scanC = 99; private scanEnd = 0; private scanRef = 0; private scanNow = 0; private scanC0 = 0;
  private bestScore = 0; private bestBpm = 0; private bestPh = 0; private scanFar = 0;

  /** LÖPANDE TAKT: ett hop av sökningen - vik ringen (fönstret före sökningens start) på nästa tempo; sist läggs rutnätet på toppen. */
  private onsetStep(cfg: EngineConfig, now: number): void {
    const beat = cfg.beat; if (!beat || beat.bpm <= 0) { this.scanC = 99; return; }
    if (this.scanC > this.scanEnd) {   // ingen sökning pågår
      if (now < this.onNext) return;
      this.onNext = now + ONSET_EVERY_MS;
      this.scanRef = beat.anchorMs; this.scanNow = now;
      // k4b BLIPPEN ÖVERHOPPAD: förra sökningens eget tempo låg utanför TG_SNAP från tempogrammets och togs inte (scanFar, se nedan). Den här
      // sökningen görs precis som den hade gjorts om det tagits - samma tidpunkt, samma centrum - så rutnätet efteråt är detsamma som förr.
      const cb = this.scanFar > 0 ? this.scanFar : beat.bpm; this.scanFar = 0;
      if (this.tempoBpm > 0 && Math.abs(cb / this.tempoBpm - 1) > TG_SNAP) { this.scanC0 = this.tempoBpm; this.scanStep = TG_FINE; this.scanEnd = 5; }   // EN TEMPOSÖKNING: klockan utanför tempogrammets topp -> dit
      else if (this.tempoBpm > 0) { this.scanC0 = cb; this.scanStep = 0.005; this.scanEnd = 5; }   // inom: klockans egen skanning som förr (fas, fintempo; a2r M2: kring tempogrammets topp gav ettan 100 -> 93, gridfel 15 -> 26 ms)
      else { this.scanC0 = beat.bpm; this.scanStep = 0.005; this.scanEnd = 5; }   // tempogrammet nollat (låtgräns): kring klockans tempo (inget andra sökcentrum - EN KÄLLA)

      this.scanC = -5; this.bestScore = 0;
    }
    const c = this.scanC++, ref = this.scanRef;
    const bpm = this.scanC0 * (1 + c * this.scanStep), bm = 60000 / bpm;
    this.foldS.fill(0); this.foldN.fill(0);
    let tot = 0, n = 0;
    for (let i = 0; i < this.onN; i++) {
      const j = (this.onPos - 1 - i + ONSET_RING) % ONSET_RING, t = this.onT[j];
      if (t > this.scanNow) continue;   // kom in efter sökningens start
      if (this.scanNow - t > ONSET_WIN_MS) break;
      const r = (t - ref) % bm, b = Math.floor(((r < 0 ? r + bm : r) / bm) * ONSET_BINS) % ONSET_BINS;
      this.foldS[b] += this.onV[j]; this.foldN[b]++; tot += this.onV[j]; n++;
    }
    if (n >= 100 && tot > 0) {
      const mean = tot / n; let mx = 0, mb = 0;
      for (let b = 0; b < ONSET_BINS; b++) { const v = this.foldN[b] ? this.foldS[b] / this.foldN[b] : 0; if (v > mx) { mx = v; mb = b; } }
      // k4b FINTEMPOTS KRONA: i klockans egen sökning (0,5 %-steg kring sitt tempo) måste ett granntempo passa ansatserna SCAN_HOLD bättre än det
      // tempo klockan har - annars växlar två lika bra grannar varannan sökning (114,0 <-> 114,6) utan att musiken ändrats. Samma princip som KRONAN.
      const score = (mx / mean) * (c === 0 && this.scanStep === 0.005 ? SCAN_HOLD : 1);
      if (score > this.bestScore) {
        const a = this.foldMean(mb - 1), cc = this.foldMean(mb), d = this.foldMean(mb + 1), den = a - 2 * cc + d;   // parabel genom toppen
        const off = den < 0 ? 0.5 * (a - d) / den : 0;
        this.bestScore = score; this.bestBpm = bpm; this.bestPh = (mb + 0.5 + off) / ONSET_BINS;
      }
    }
    if (c < this.scanEnd || this.bestScore < ONSET_MIN_PEAK) return;
    // nytt tempo med bevarat slagindex + fas, sedan fasen direkt på toppen (toppen låg på bestPh räknat från sökningens ankare)
    if (this.tempoBpm > 0) this.bestBpm = Math.min(159.9, Math.max(80, this.bestBpm));   // samma oktavfönster som tempogrammet
    // k4b BLIPPEN ÖVERHOPPAD (k4:s skanningsspärr i ny form; jokern mätte 45 av 59 utflykter som sådana): klockans egen sökning (+-2,5 % kring
    // sitt tempo, som självt får ligga 3 % från tempogrammets) kunde ta ett tempo 3-5 % från tempogrammets topp; nästa sökning 250 ms senare
    // hämtade det tillbaka = en 'blipp' på 0,2-0,4 s. Ett sådant tempo tas inte: rutnätet rullar orört till nästa ordinarie sökning, som görs
    // som om det tagits. (Stryka kandidaterna: hämtningen uteblev, lotus fasmedian 0,91 -> 0,90. Hämta genast: sökningarnas tidpunkter flyttas.)
    if (this.tempoBpm > 0 && Math.abs(this.bestBpm / this.tempoBpm - 1) > TG_SNAP) { this.scanFar = this.bestBpm; return; }
    const oldMs = 60000 / beat.bpm, idx = Math.floor((now - beat.anchorMs) / oldMs), fr = (now - beat.anchorMs) / oldMs - idx;
    const nb = 60000 / this.bestBpm;
    beat.bpm = this.bestBpm; beat.anchorMs = now - (idx + fr) * nb;
    // (a8r:s barReset vid > 3 % tempohopp borttagen, a4 entempo: klockan drar inga egna slutsatser om låtbyte - det gör låtgränsen)
    const shift = ((((beat.anchorMs - ref) % nb) + nb) % nb) / nb;   // nya ankarets fas mot sökningens ankare
    let err = this.bestPh - shift; err -= Math.round(err);
    beat.anchorMs += err * nb;
    this.onsetFixes++;
  }

  /** EN TEMPOSÖKNING: hypotesens poäng = basens x diskantens (topp + halvslaget efter toppen) / 2 / medel, en gemensam vikning av
   *  ringen (fönstret ONSET_WIN_MS bakåt från now). 0 = för lite ljud. */
  private tgScore(bpm: number, now: number, win = TG_WIN_MS): number {
    // Poängen beror inte på fasen: ringens värden ligger med jämn takt (vartannat hop), så fasen stegas fram med en addition per värde
    // i stället för t % period på väggklockan (3 x billigare; i realtid är ringens Date.now() dessutom ryckig - hoppens takt är exakt).
    const S = this.fullS, N = this.fullN, Hs = this.tgH, oT = this.onT, oV = this.onV, oH = this.hiV; S.fill(0); N.fill(0); Hs.fill(0);
    let lo = 0, hi = this.onN;   // n = antal värden inom fönstret (tiderna växer i ringen: binärsökning i st f att räkna)
    while (lo < hi) { const m = (lo + hi) >> 1; if (now - oT[(this.onPos - 1 - m + 2 * ONSET_RING) % ONSET_RING] > win) hi = m; else lo = m + 1; }
    const n = lo;
    if (n < TG_MIN_N) { this.tgN = n; return 0; }
    const jo = (this.onPos - n + 2 * ONSET_RING) % ONSET_RING; let j = jo;
    const dt = (oT[(this.onPos + ONSET_RING - 1) % ONSET_RING] - oT[jo]) / (n - 1), step = (dt * bpm / 60000) * ONSET_BINS;
    let tot = 0, totH = 0, ph = 0;
    for (let i = 0; i < n; i++) {
      const b = ph | 0, v = oV[j], h = oH[j];
      S[b] += v; Hs[b] += h; N[b]++; tot += v; totH += h;
      ph += step; if (ph >= ONSET_BINS) ph -= ONSET_BINS;
      j = j === ONSET_RING - 1 ? 0 : j + 1;
    }
    this.tgN = n;
    if (tot <= 0 || totH <= 0) return 0;
    let mx = 0, mb = 0, hx = 0, hb = 0;
    for (let b = 0; b < ONSET_BINS; b++) { if (!N[b]) continue; const v = S[b] / N[b], h = Hs[b] / N[b]; if (v > mx) { mx = v; mb = b; } if (h > hx) { hx = h; hb = b; } }
    const q = (mb + TG_HALF) % ONSET_BINS, qh = (hb + TG_HALF) % ONSET_BINS;
    this.tgHalfR = mx > 0 && N[q] ? S[q] / N[q] / mx : 0;
    const fb = (mx + (N[q] ? S[q] / N[q] : 0)) / 2 / (tot / n), fh = (hx + (N[qh] ? Hs[qh] / N[qh] : 0)) / 2 / (totH / n);
    return fb * fh;
  }

  /** EN TEMPOSÖKNING: TG_PER_HOP hypoteser per hop in i tempogrammet; sist i varvet blir toppen klockans centrum. */
  private tgStep(now: number): void {
    const acc = this.tgAcc;
    for (let r = 0; r < TG_PER_HOP; r++) {
      const k = this.tgK, bk0 = 80 * Math.pow(TG_STEP, k), accF = this.tgAccF;
      const sf = this.tgScore(bk0, now, TG_FWIN_MS);   // snabba minnet först (tgN/tgHalfR ska vara det långsammas efteråt)
      this.tgF[k] = sf;
      if (sf > 0) accF[k] = accF[k] < 0 || this.tgN < TG_FFULL_N ? sf : accF[k] + TG_FA * (sf - accF[k]);
      const s = this.tgScore(bk0, now);
      if (s > 0) acc[k] = acc[k] < 0 || this.tgN < TG_FULL_N ? s : acc[k] + TG_A * (s - acc[k]);   // minne först när fönstret är fullt (kort fönster = brusig, långsam-gynnad poäng)
      if (s > 0) { const L = this.tgAccL; L[k] = L[k] < 0 ? s : L[k] + (this.tgLN * TG_LA < 1 ? 1 / (this.tgLN + 1) : this.sure ? Math.max(1 / (this.tgLN + 1), TG_SONG_A) : TG_LA) * (s - L[k]); if (k === TG_K - 1) this.tgLN++; }
      if (++this.tgK < TG_K) continue;
      this.tgK = 0;
      // HÅLLEN TOLKNING (k4): varvets bevis mot brustaket; med en regent avgör bevissumman bytet
      const F = this.tgF, W = this.tgW, Q = this.tgQ, D = this.tgD;
      let any = false, nc = 0;
      for (let i = 0; i < TG_K; i++) { Q[i] = F[i] > 0 ? Math.log(F[i]) : 0; if (F[i] > 0) any = true; }
      if (any) {
        for (let i = 0; i < TG_K; i++) { let v = Q[i]; for (let d = 1; d <= TG_NB; d++) { const a = Q[(i + d) % TG_K], b = Q[(i + TG_K - d) % TG_K]; if (a > v) v = a; if (b > v) v = b; } W[i] = v; }
        Q.sort(); nc = Q[TG_K >> 1] + TG_NOISE;
      }
      const song = this.sure && this.tgLN * TG_LA >= 1;   // LÅTENS MINNE väljer: ingen regent, inget snabbt byte
      if (song) { this.tgR = -1; this.tgLk = 0; this.tgLkK = -1; this.tgSw = 0; }
      if (this.tgR >= 0 && any) {
        const r0 = this.tgR, e = Math.max(0, W[r0] - nc); let nk = r0, mx = 0;
        this.tgHl += TG_HL_A * (e - this.tgHl); D[r0] += e; mx = D[r0];
        const fl = -(TG_SW_P + TG_SW_G * this.tgHl);
        for (let i = 0; i < TG_K; i++) { if (i === r0) continue; const d = Math.max(D[i], fl) + W[i] - nc; D[i] = d; if (d > mx) { mx = d; nk = i; } }
        for (let i = 0; i < TG_K; i++) D[i] -= mx;
        const d0 = Math.abs(nk - r0);
        if (Math.min(d0, TG_K - d0) > 2) {   // bevisat byte: ny tolkning -> tempogrammet sås ur varvets poäng, START-läget tar vid
          for (let i = 0; i < TG_K; i++) if (F[i] > 0) { acc[i] = F[i]; accF[i] = F[i]; }
          this.tgR = -1; this.tgLk = 0; this.tgLkK = -1; this.tgSw = 0; this.tgSwitches++;
        } else this.tgR = nk;
      }
      if (this.tgR >= 0) {
        // k4b (lånat av k2b) NY LÅT ELLER SAMMA? Snabba minnets byte prövas som förr (TG_HOLD i TG_SW_N varv), men tas bara om utmanarens tempo är
        // OKÄNT för det långa minnet (< TG_KNOWN x regentens poäng där) = nytt material, inte en annan läsning av samma låt. Då går allt som
        // förr och START-läget tar vid. En KÄND utmanare (hörd i låten) måste vinna på bevissumman ovan.
        const r = this.tgR, L = this.tgAccL; let fk = -1, fv = 0; for (let i = 0; i < TG_K; i++) if (accF[i] > fv) { fv = accF[i]; fk = i; }
        const d0 = fk < 0 ? 0 : Math.abs(fk - r), dd = Math.min(d0, TG_K - d0);
        const fc = Math.max(accF[r], accF[(r + 1) % TG_K], accF[(r + TG_K - 1) % TG_K]);
        if (fk >= 0 && dd > TG_SW_STEPS && fv >= fc * TG_HOLD) {
          if (++this.tgSw >= TG_SW_N) {
            let lf = 0, lr = 0; for (let d = -2; d <= 2; d++) { const a = L[(fk + d + TG_K) % TG_K], b = L[(r + d + TG_K) % TG_K]; if (a > lf) lf = a; if (b > lr) lr = b; }
            if (lf < TG_KNOWN * lr) { acc.set(accF); this.tgSwitches++; this.tgR = -1; this.tgLk = 0; this.tgLkK = -1; }
            this.tgSw = 0;
          }
        } else this.tgSw = 0;
      }
      const held = this.tgR >= 0, A = song ? this.tgAccL : acc;
      if (held || song) { /* regenten håller / låtens minne väljer */ }
      else if (this.tgN < TG_FULL_N) acc.set(accF);   // TVÅ MINNEN: tills det långsamma fönstret är fullt (kallstart, efter relock) styr det snabba
      else if (this.tempoBpm > 0) {   // TVÅ MINNEN: det snabba pekar på ett annat tempo -> det ersätter det långsamma
        let fk = -1, fv = 0; for (let i = 0; i < TG_K; i++) if (accF[i] > fv) { fv = accF[i]; fk = i; }
        const kc0 = ((Math.round(Math.log(this.tempoBpm / 80) / Math.log(TG_STEP)) % TG_K) + TG_K) % TG_K;
        const d0 = fk < 0 ? 0 : ((fk - kc0) % TG_K + TG_K) % TG_K, dd = Math.min(d0, TG_K - d0);
        const fc = Math.max(accF[kc0], accF[(kc0 + 1) % TG_K], accF[(kc0 + TG_K - 1) % TG_K]);   // det regerande tempots poäng i det snabba
        // TEMPOHOPPEN (11-10): kronans marginal mot ALLA tempon, inte bara syskonen
        if (fk >= 0 && dd > TG_SW_STEPS && fv >= fc * TG_HOLD) { if (++this.tgSw >= TG_SW_N) { acc.set(accF); this.tgSw = 0; this.tgSwitches++; } } else this.tgSw = 0;
      }
      let bk = -1, bv = 0;
      if (held) { bk = this.tgR; bv = acc[bk]; for (let d = -2, c0 = bk; d <= 2; d++) { const j = (c0 + d + TG_K) % TG_K; if (acc[j] > bv) { bv = acc[j]; bk = j; } } if (!(bv > 0)) bk = -1; }   // fintempot: det långsamma minnets topp kring regenten
      else for (let i = 0; i < TG_K; i++) if (A[i] > bv) { bv = A[i]; bk = i; }
      if (bk < 0) { this.tempoBpm = 0; return; }
      // TEMPOTS TYDLIGHET (t1f): marginalen till NÄST BÄSTA tempohypotes = högsta andra lokala toppen i varvets tempogram (mer än
      // 2 steg från vinnaren, så toppens egen flank räknas inte). Ett enda tydligt tempo -> 1; två lika starka (96 <-> 128,
      // tempot vandrar) -> 0. Två tredjedelar av vinnarens poäng eller mindre = full tydlighet. Läses av tilliten (updateInner).
      // (lang1021/lang1011 i f0: tydliga partier 2:a/bästa 0,24-0,50, låtskarvar och vandrande tempo 0,85-0,99.)
      { let sv = 0;
        for (let i = 0; i < TG_K; i++) { const v = A[i], dd = Math.abs(i - bk), d = dd < TG_K - dd ? dd : TG_K - dd;
          if (d > 2 && v > sv && v >= A[(i + 1) % TG_K] && v >= A[(i + TG_K - 1) % TG_K]) sv = v; }
        this.tgClear = Math.max(0, Math.min(1, 3 * (1 - sv / bv))); }
      // KRONAN (r0): det regerande tempot behåller toppen tills en annan hypotes slår det med TG_HOLD (lang1011 490-570 s: 96 <-> 128 = 4:3
      // varannat varv, kickspärren och grinden bytte med -> sektionerna). Bara om det regerande tempots egen poäng finns (> 0).
      if (!held && !song && this.tempoBpm > 0) {
        const kc = ((Math.round(Math.log(this.tempoBpm / 80) / Math.log(TG_STEP)) % TG_K) + TG_K) % TG_K, cv = Math.max(acc[kc], acc[(kc + 1) % TG_K], acc[(kc + TG_K - 1) % TG_K]);
        // bara mot ett HARMONISKT syskon (4:3, 3:2 åt båda hållen, i det cirkulära oktavrutnätet): ett annat tempo (ny låt utan låtgräns) tas som förr
        const d = ((bk - kc) % TG_K + TG_K) % TG_K, sib = TG_SIB.some((q) => Math.abs(d - q) <= 2 || Math.abs(d - (TG_K - q)) <= 2);
        if (sib && cv > 0 && bv < cv * TG_HOLD) { this.tgLk = 0; this.tempoBpm = this.pwJudge(this.tempoBpm, now); return; }
      }
      if (!held && !song) {   // SÄKER LÅSNING: samma hypotes (+-2 steg), över brustaket, fullt fönster, TG_LOCK_N varv i följd -> regent
        const dl = Math.abs(bk - this.tgLkK), same = this.tgLkK >= 0 && Math.min(dl, TG_K - dl) <= 2;
        const e = any ? W[bk] - nc : 0;
        this.tgLk = same && e > 0 && this.tgN >= TG_FULL_N ? this.tgLk + 1 : 0; this.tgLkK = bk;
        if (this.tgLk >= TG_LOCK_N) { this.tgR = bk; this.tgLk = 0; D.fill(0); this.tgHl = e; }
      }
      const a = A[(bk + TG_K - 1) % TG_K], c = A[(bk + 1) % TG_K], den = a - 2 * bv + c;   // parabel i log-rutnätet (cirkulärt)
      const off = a >= 0 && c >= 0 && den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0;
      let t = 80 * Math.pow(TG_STEP, bk + off);
      // OKTAVKANTEN: 80 och 160 är grannar i det cirkulära rutnätet, och vikningen kan inte skilja dem (halvslagsbeviset gynnar 80).
      // Nära kanten avgör analysatorns oktav (lang1021 = 160: rutnätet på 80 missade varannan ansats; Cody Johnson = 80, analysatorn 104-116).
      // EN KÄLLA (r0): oktaven avgörs av klockans egen vikning (analysatorns tempo finns inte längre): ligger basens stigning lika starkt
      // mitt emellan 80-slagen som på dem är pulsen 160 (lang1021: varannan ansats), annars 80 (backbeat: virveln, inte basen, på 2 och 4).
      if (!(t < 80 * TG_EDGE || t > 160 / TG_EDGE)) this.octLoN = 0;
      if (t < 80 * TG_EDGE || t > 160 / TG_EDGE) { const lo = t < 120 ? t : t / 2; this.tgScore(lo, now);
        this.octLoN = lo < TG_OCT_LO ? this.octLoN + 1 : 0;   // D2: halvslaget under kanten i TG_OCT_LO_N varv i följd
        // brusigt per varv (lang1021 0,5-1,0, Cody Johnson 0,1-0,9): EMA ~3,7 s + hysteres (upp >= TG_OCT_UP, ned < TG_OCT_DN), startläget ur första varvet
        this.octR = this.octN++ === 0 ? this.tgHalfR : this.octR + TG_OCT_A * (this.tgHalfR - this.octR);
        if (this.octN === 1) this.octHi = this.octR >= TG_OCT_UP; else if (this.octHi ? this.octR < TG_OCT_DN : this.octR >= TG_OCT_UP) this.octHi = !this.octHi;
        // a3 OKTAVEN UNDER KANTEN: båda bänkarnas facit (och lotus BPM_MIN/MAX) bor i [80, 160) - ett slag under 80 finns inte, så ligger
        // halvslaget tydligt under kanten (< TG_OCT_LO) är pulsen dubbla (lotus 503: 20 'dubbla' 155-159 -> klockan 80,0 = klämd 78,x).
        t = this.octHi || this.octLoN >= TG_OCT_LO_N ? 2 * lo : lo; }
      { const r0 = this.tempoBpm, pc = Math.min(159.9, Math.max(80, this.peakVote(t, now))), pj = this.pwJudge(pc, now); this.tempoBpm = pj;
        // dmx-1b: vittnets RÄTTNING flyttar också k4b:s regent (annars drar regenten tillbaka klockan nästa varv)
        if (pj !== pc && pj !== r0 && this.tgR >= 0) { this.tgR = ((Math.round(Math.log(pj / 80) / Math.log(TG_STEP)) % TG_K) + TG_K) % TG_K; this.tgD.fill(0); } }
      return;
    }
  }
  /** a3 TOPPRÖSTEN (EN KLOCKA FÖR BÅDA, sammanslagningen av tempovalet - båda signalerna röstar). Tempogrammet (B, rise-vikningen) dömer
   *  varje tempo på (topp + HALVSLAGET) / 2: halvslaget fäller 4/3- och 3/2-fantomerna (ingen topp mitt emellan), men GYNNAR 3/4-fantomen:
   *  på 3/4 av tempot landar de riktiga slagen på fyra jämnt fördelade faser (0, 1/4, 1/2, 3/4), så både toppen och halvslaget har slag.
   *  Lotus 503: klockan föll på 3/4 i 21 låtar där A (kickvikningen: alignScore/UP43, slagets topp och träffar) hade rätt - Klaas Cambodia
   *  130 -> 97,6 (basens topp 5,7-6,4 x medel på 130 mot 4,7-5,0 på 97,5, diskanten 7,7 mot 6,9). KICKVIKNINGENS RÖST = bara TOPPEN:
   *  basens topp/medel x diskantens topp/medel på samma ring. Uttalad kvotlogik: syskonen 4:3, 3:4, 3:2, 2:3, 5:4, 4:5 (vikta in i
   *  [80, 160)) är alla icke-heltalskvoter - de riktiga slagen sprids på 3-8 faser där, så toppen späds ut åt BÅDA hållen (oktaven och
   *  undertoner ingår inte: där späds toppen inte). Ett syskon tar över tempogrammets val om dess topp-poäng är minst HV_K x valets i HV_N
   *  varv i följd; det regerande tempot har samma faktor (hysteres). Täta ansatser ger lika toppar = tempogrammet står kvar. */
  private peakVote(t0: number, now: number): number {
    const open = this.hvAge++ < HV_AGE;   // tempovalet: bara i låsets första HV_AGE varv (kallstart, efter låtgräns/tystnad)
    if (!open) {   // inne i låten: tempoKLASSEN som valdes i fönstret står kvar mot ett syskon tills syskonets topp är HV_K x högre
      if (this.hvAge === HV_AGE + 1) this.hvKeep = this.hvEver ? this.tempoBpm : 0;   // D1: klasslåset bara om rösten faktiskt bytt i fönstret
      const k = this.hvKeep;
      if (k > 0 && Math.abs(t0 / k - 1) >= 0.02) {
        let sib = false; for (let i = 0; i < HV_R.length; i++) { let c = t0 * HV_R[i]; while (c >= 160) c /= 2; while (c < 80) c *= 2; if (Math.abs(c / k - 1) < 0.02) sib = true; }
        if (sib && this.peakScore(k, now) * HV_K >= this.peakScore(t0, now)) return k;
        this.hvKeep = 0;
      }
      if (!this.hvVoted) return t0;
    }
    const p0 = this.peakScore(t0, now); if (!(p0 > 0)) { this.hvRun = 0; this.hvVoted = false; return t0; }
    const cur = this.tempoBpm; let best = t0, bs = p0 * HV_K;
    for (let i = 0; i < HV_R.length; i++) {
      let c = t0 * HV_R[i]; while (c >= 160) c /= 2; while (c < 80) c *= 2;
      const v = this.peakScore(c, now) * (this.hvEver && cur > 0 && Math.abs(c / cur - 1) < 0.02 ? HV_K : 1);   // D1: hysteresen bara efter ett röstbyte
      if (v > bs) { bs = v; best = c; }
    }
    if (best === t0) { this.hvRun = 0; this.hvVoted = false; return t0; }
    if (this.hvEver && cur > 0 && Math.abs(best / cur - 1) < 0.02) { this.hvRun = 0; return best; }   // redan bytt: står kvar (även efter fönstret)
    // D3: samma tempogramval OCH samma syskon i alla HV_N varv (övergångar där tempogrammet vandrar röstar inte)
    if (this.hvRun > 0 && (Math.abs(t0 / this.hvT0 - 1) >= 0.02 || Math.abs(best / this.hvBest - 1) >= 0.02)) this.hvRun = 0;
    this.hvT0 = t0; this.hvBest = best;
    if (open && ++this.hvRun >= HV_N) { this.hvRun = 0; this.hvSwitches++; this.hvVoted = true; this.hvEver = true; return best; }
    if (!open) this.hvVoted = false;
    return t0;
  }
  /** Topp-poängen på bpm: ringens basstigning och diskant (fönstret TG_WIN_MS) viks som i tgScore; basens topp/medel x diskantens
   *  topp/medel (utan halvslaget). 0 = för lite ljud. */
  private peakScore(bpm: number, now: number): number {
    const S = this.fullS, N = this.fullN, Hs = this.tgH, oT = this.onT, oV = this.onV, oH = this.hiV; S.fill(0); N.fill(0); Hs.fill(0);
    let lo = 0, hi = this.onN;
    while (lo < hi) { const m = (lo + hi) >> 1; if (now - oT[(this.onPos - 1 - m + 2 * ONSET_RING) % ONSET_RING] > TG_WIN_MS) hi = m; else lo = m + 1; }
    const n = lo; if (n < TG_MIN_N) return 0;
    const jo = (this.onPos - n + 2 * ONSET_RING) % ONSET_RING;
    const dt = (oT[(this.onPos + ONSET_RING - 1) % ONSET_RING] - oT[jo]) / (n - 1), step = (dt * bpm / 60000) * ONSET_BINS;
    let j = jo, ph = 0, tot = 0, totH = 0;
    for (let i = 0; i < n; i++) { const b = ph | 0, v = oV[j], h = oH[j]; S[b] += v; Hs[b] += h; N[b]++; tot += v; totH += h; ph += step; if (ph >= ONSET_BINS) ph -= ONSET_BINS; j = j === ONSET_RING - 1 ? 0 : j + 1; }
    if (tot <= 0 || totH <= 0) return 0;
    let mx = 0, hx = 0;
    for (let b = 0; b < ONSET_BINS; b++) { if (!N[b]) continue; const v = S[b] / N[b], h = Hs[b] / N[b]; if (v > mx) mx = v; if (h > hx) hx = h; }
    return (mx / (tot / n)) * (hx / (totH / n));
  }
  /** Är a ett syskon till b (4/3, 3/4, 3/2, 2/3, oktaven bortvikt, +-TG_SNAP)? */
  private pwSib(a: number, b: number): boolean {
    for (let i = 0; i < PW_Q.length; i++) { let c = b * PW_Q[i]; while (c >= 160) c /= 2; while (c < 80) c *= 2; if (Math.abs(a / c - 1) <= TG_SNAP) return true; }
    return false;
  }
  /** Seriens likhet med sig själv `lag` värden bort, över fönstret pwWn (Pearson). */
  private pwCorr(x: Float32Array, lag: number): number {
    const n = this.pwWn, m = n - lag; if (m < 200) return 0;
    const M = PW_RING - 1, j0 = this.pwPos - n + 2 * PW_RING; let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let i = 0; i < m; i++) { const a = x[(j0 + i) & M], b = x[(j0 + i + lag) & M]; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; }
    const va = saa - sa * sa / m, vb = sbb - sb * sb / m;
    return va > 0 && vb > 0 ? (sab - sa * sb / m) / Math.sqrt(va * vb) : 0;
  }
  /** Långsamma minnets poäng kring bpm (+-2 steg, cirkulärt). */
  private pwAt(bpm: number): number { const acc = this.tgAcc, k = ((Math.round(Math.log(bpm / 80) / Math.log(TG_STEP)) % TG_K) + TG_K) % TG_K; let v = 0; for (let i = -2; i <= 2; i++) { const x = acc[(k + i + TG_K) % TG_K]; if (x > v) v = x; } return v; }
  /** Mönstrets självlikhet 2 och 4 slag bort på tempot bpm, bas + diskant. */
  private pwSim(bpm: number): number {
    const l2 = Math.round(120000 / bpm / this.pwDt), l4 = Math.round(240000 / bpm / this.pwDt);
    return this.pwCorr(this.pwE, l2) + this.pwCorr(this.pwE, l4) + this.pwCorr(this.pwH, l2) + this.pwCorr(this.pwH, l4);
  }
  /** TAKTENS SJÄLVLIKHET (se PW_RING): varvets val `cand` mot regenten -> klockans tempo. */
  private pwJudge(cand: number, now: number): number {
    const reg = this.tempoBpm;
    if (!(reg > 0)) { this.pwQuietAt = now + PW_WIN_MS; this.pwRun = 0; return cand; }
    const moved = Math.abs(cand / reg - 1) > TG_SNAP, sib = moved && this.pwSib(cand, reg);
    if (moved && !sib) { this.pwQuietAt = now + PW_WIN_MS; this.pwRun = 0; return cand; }   // ny takt som inte är en annan läsning: som förr, vittnet tiger
    if (now < this.pwQuietAt) return cand;
    // fönstret: de senaste PW_WIN_MS i ringen
    const M = PW_RING - 1; let lo = 0, hi = this.pwN;
    while (lo < hi) { const m = (lo + hi) >> 1; if (now - this.pwT[(this.pwPos - 1 - m + 2 * PW_RING) & M] > PW_WIN_MS) hi = m; else lo = m + 1; }
    if (lo < 1000) return cand;
    this.pwWn = lo; this.pwDt = (this.pwT[(this.pwPos - 1 + PW_RING) & M] - this.pwT[(this.pwPos - lo + 2 * PW_RING) & M]) / (lo - 1); if (!(this.pwDt > 0)) return cand;
    const sR = this.pwSim(reg);
    if (sib) {   // (1) VETO: tempogrammet vill till ett syskon
      const sC = this.pwSim(cand);
      if (sR >= PW_MIN && sR > (sC > 0 ? sC * TG_HOLD : 0)) {
        this.pwWn = lo >> 1; const sN = this.pwSim(reg);   // ... och mönstret finns kvar i fönstrets SENARE halva (en ny låt i syskonförhållande: borta)
        if (sN >= PW_MIN) { this.pwVetos++; this.pwRun = 0; return reg; }
      }
      this.pwRun = 0; return cand;
    }
    // (2) RÄTTNING: klockan står (cand = regenten, fintempot följer); är ett syskons mönster tydligt mot dess eget?
    let bs = 0, bb = 0;
    for (let i = 0; i < PW_Q.length; i++) { let c = cand * PW_Q[i]; while (c >= 160) c /= 2; while (c < 80) c *= 2; const v = this.pwSim(c); if (v > bs) { bs = v; bb = c; } }
    if (bs >= PW_MIN && bs > (sR > 0 ? sR * TG_HOLD : 0) && this.pwAt(bb) * TG_HOLD >= this.pwAt(cand)) {   // tydligt mönster OCH tempogrammet är inte säkert på regenten
      if (this.pwRun > 0 && Math.abs(bb / this.pwCand - 1) <= TG_SNAP) this.pwRun++; else { this.pwCand = bb; this.pwRun = 1; }
      if (this.pwRun >= HV_N) { this.pwRun = 0; this.pwFixes++; return bb; }
    } else this.pwRun = 0;
    return cand;
  }
  private tgReset(): void { this.pwN = 0; this.pwRun = 0; this.tgAcc.fill(-1); this.tgAccF.fill(-1); this.tgSw = 0; this.tgR = -1; this.tgLk = 0; this.tgLkK = -1; this.tgHl = 0; this.tgAccL.fill(-1); this.tgLN = 0; this.tgK = 0; this.tempoBpm = 0; this.octN = 0; this.hvRun = 0; this.hvAge = 0; this.hvVoted = false; this.hvKeep = 0; this.hvEver = false; }

  /** Kom en tidigare kick (ringen, före denna) lag ms före t, inom ±tol? (TRUST_REPEAT) */
  private kickRepeats(t: number, lag: number, tol: number): boolean {
    const want = t - lag;
    for (let i = 0; i < this.kickRingN; i++) {
      const k = this.kickRing[(this.kickRingPos - 1 - i + 64) & 63];
      if (k < want - tol) return false;
      if (Math.abs(k - want) < tol) return true;
    }
    return false;
  }

  private barReset(): void { this.barK.fill(0); this.barL.fill(0); this.barB.fill(0); this.barN = 0; this.barIdx = NaN; this.barOff = 0; }

  /** ETTAN (se BAR_DECAY): ett hop av effektklockans taktmodell, på det inre rutnätet. */
  private barStep(frame: Frame, beat: NonNullable<EngineConfig["beat"]>, now: number): void {
    const sa = frame.specAbs, p = this.linPos, k = (sa?.sub ?? 0) + (sa?.kick ?? 0), l = sa?.bass ?? 0;
    const rk = k - this.linK[p], rl = l - this.linL[p]; this.linK[p] = k; this.linL[p] = l; this.linPos = (p + 1) % BAR_RISE_HOPS;
    if (!(beat.bpm > 40)) return;
    const pos = (now - beat.anchorMs) / (60000 / beat.bpm), idx = Math.floor(pos - BAR_WIN0);
    if (idx !== this.barIdx) {
      if (idx === this.barIdx + 1) this.barCommit();
      this.barIdx = idx; this.bK = 0; this.bL = 0; this.bB = 0;
    }
    if (pos - idx <= BAR_WIN1) {
      if (rk > this.bK) this.bK = rk;
      if (rl > this.bL) this.bL = rl;
      const hb = (frame.onset?.highMid ?? 0) + (frame.onset?.treble ?? 0); if (hb > this.bB) this.bB = hb;
    }
  }

  /** Slaget barIdx är färdigmätt: bokför det på sin plats och döm de fyra hypoteserna (vinnaren med marginal blir ettan). */
  private barCommit(): void {
    const K = this.barK, L = this.barL, B = this.barB, slot = ((this.barIdx % 4) + 4) % 4;
    for (let i = 0; i < 4; i++) { K[i] *= BAR_DECAY; L[i] *= BAR_DECAY; B[i] *= BAR_DECAY; }
    K[slot] += this.bK; L[slot] += this.bL; B[slot] += this.bB;
    if (this.barN < 1000) this.barN++;
    if (this.barN < BAR_MIN) return;
    const sK = K[0] + K[1] + K[2] + K[3], sL = L[0] + L[1] + L[2] + L[3], sB = B[0] + B[1] + B[2] + B[3];
    if (!(sK > 0)) return;
    let bi = 0, best = -1e9, second = -1e9;
    for (let i = 0; i < 4; i++) {
      const v = K[i] / sK + (sL > 0 ? BAR_W_BASS * L[i] / sL : 0) - (sB > 0 ? BAR_W_BACK * B[i] / sB : 0);
      if (v > best) { second = best; best = v; bi = i; } else if (v > second) second = v;
    }
    if (bi !== this.barOff && best - second >= BAR_MARGIN) { this.barOff = bi; this.barShifts++; }
  }

  /** LÅTGRÄNSEN (a4 entempo): den ENDA signalen om låtbyte. Klockan fortsätter (inget mörker), men det som tillhör förra låten
   *  släpps: tempogrammet (nästa varv tar nya låtens poäng direkt ur ringen), taktmodellen (ettan börjar om) och upptagets minne
   *  av förra låtens tillit. */
  private relock(): void {
    // a1r: ettan som gällde läggs in i det inre ankaret före taktmodellens omstart, så det PUBLICERADE rutnätet (och effekternas
    // takträknare) inte backar barOff slag vid låtgränsen. Förr: barOff -> 0 flyttade ankaret 1-3 slag bakåt mitt i skarven och
    // räknaren stod still lika länge. Nya låtens etta tas sedan av taktmodellen som vanligt.
    if (this.innerValid && this.innerBpm > 0) this.innerAnchor += this.barOff * (60000 / this.innerBpm);
    this.tgReset(); this.barReset(); this.goodRep = 0; this.goodOn = 0; this.onNext = 0;
  }

  /** EN KÄLLA (r0 entempo, ägaren 11-09: "allt skall ju ligga i analysatorn"): ETT hop av analysatorns klocka i dess långsamma väg.
   *  Klockan är den ENDA temposökningen: tempogrammet (tgStep) startar och håller tempot själv, rutnätet (onsetStep) sätter fas och
   *  fintempo, taktmodellen (barStep) ettan, och tilliten = andelen kickar rutnätet förutsäger (repeatRate). Analysatorn har ingen egen
   *  tempovikning längre: den får klockans tempo/tillit (cfg.beat, se Analyser.setClock) och för kickgrinden klockans INRE rutnät +
   *  KICK_PHASE_MS - eller null när klockan är i COAST (fasträffarna svaga): då står grinden öppen och kickspärren är 170 ms, som när
   *  skuggrutnätets återställning förr nollade analysatorns tempo (a1/a8: det var det som höll sektionerna snabba). Låtgränsen
   *  (an.trackBoundaries) är klockans enda låtbytessignal, och an.boundSure säger om den är säker (LÅTENS MINNE); tystnad (an.quietMs > 10 s) släpper klockan. `now` = hoppets klocka. */
  update(frame: Frame, cfg: EngineConfig, an: { resetTempo(): void; resetBar(): void; setClockGrid?(g: EngineConfig["beat"]): void; trackBoundaries?: number; quietMs?: number; boundSure?: boolean; setClock?(bpm: number, conf: number): void }, now = Date.now()): void {
    this.sure = !!an.boundSure;
    const nb = an.trackBoundaries ?? 0;
    if (nb !== this.boundSeen) { this.boundSeen = nb; this.relock(); }
    if (cfg.beat && this.innerValid) { cfg.beat.anchorMs = this.innerAnchor; cfg.beat.bpm = this.innerBpm; }   // ETTAN: matningen räknar på det inre ankaret
    this.updateInner(frame, cfg, now, an.quietMs ?? 0);
    const b = cfg.beat;
    if (b) {
      this.innerAnchor = b.anchorMs; this.innerBpm = b.bpm; this.innerValid = true;
      const g = this.anaGrid; g.anchorMs = b.anchorMs + KICK_PHASE_MS; g.bpm = b.bpm; g.confidence = b.confidence ?? 0;
      an.setClockGrid?.(this.gridWeakSince === 0 ? g as EngineConfig["beat"] : null);   // COAST/BREAK = öppen grind (skuggans bpm 0 som transform av klockan)   // COAST = öppen grind
      b.anchorMs += this.barOff * (60000 / b.bpm) - GRID_EARLY_MS - TG_GRID_EXTRA_MS;
    } else { this.innerValid = false; an.setClockGrid?.(null); }
    frame.bpm = b ? b.bpm : 0; frame.bpmConfidence = b ? (b.confidence ?? 0) : 0;   // EN TILLIT: ramen bär klockans tal
    an.setClock?.(frame.bpm, frame.bpmConfidence);   // odelad väg: analysatorn direkt (taktvägen: HopLaneFast.feed)
    // EN TILLIT TILL DIRIGENTERNA (11-11): stegas här så varje väg som matar klockan direkt får den (taktvägen: HopLaneFast.feed på motorns tråd)
    { const dt = this.trustAt > 0 ? now - this.trustAt : 0; this.trustAt = now; frame.beatTrust = this.trustSm = trustStep(this.trustSm, frame.bpmConfidence, cfg.beatErr ?? 0, dt > 250 ? 250 : dt); }
  }

  private updateInner(frame: Frame, cfg: EngineConfig, now: number, quietMs: number): void {
    // TILLITEN KOMMER FRAN FASPREDIKTIONEN. Coast: utan kickar finns inga nya bevis, sa tilliten lacker ner over ~4 s.
    if (cfg.beat && this.lastPllKickMs) {
      const quiet = now - this.lastPllKickMs;
      if (quiet > 1500) {
        this.onBeatRate *= Math.max(0, 1 - (quiet - 1500) / TRUST_LEAK_MS);
        this.repeatRate *= Math.max(0, 1 - (quiet - 1500) / TRUST_LEAK_MS);
        if (quiet > 8000) this.pllKicks = 0;
      }
    }
    if (now - this.lastTrustLog > 4000) { this.lastTrustLog = now; if (isLogOn()) console.log(`[tillit] mönster ${this.repeatRate.toFixed(2)} · fasträff ${this.onBeatRate.toFixed(2)} · bpm ${cfg.beat ? cfg.beat.bpm.toFixed(1) : 0}`); }
    // EN TILLIT (a6 entempo): tilliten = repeatRate från första kicken; coasten vilar på fasträffarna (0 innan 12 kickar = coast).
    const pllConf = this.pllKicks >= 12 ? this.onBeatRate : 0;
    // TYSTNAD (förr analysatorns F_SIL10 -> bpm 0): efter 10 s tystnad släpps klockan helt. Pauser < 10 s rullar klockan vidare.
    if (quietMs > 10000) {
      if (cfg.beat || this.onN > 0) { this.barReset(); cfg.beat = null; cfg.beatErr = 0; this.onN = 0; this.scanC = 99; this.tgReset(); }
      return;
    }
    const beat0 = cfg.beat;
    // TILLITEN: landar kickarna på rutnätets slag? (tidsstämpeln är slagets egen, frame.kickAtMs)
    if (frame.kickAtMs > 0 && beat0) {
      const beatMs = 60000 / beat0.bpm;
      const ph = ((((frame.kickAtMs - beat0.anchorMs) % beatMs) + beatMs) % beatMs) / beatMs;
      const err = ph < 0.5 ? ph : ph - 1;
      const onBeat = Math.abs(err) < 0.25;
      if (BREAK_RESTORE_MS > 0) {   // TAKTEN GENOM BREAKET (2): dropens kick tar upp rutnätet direkt
        const quiet = this.lastPllKickMs ? now - this.lastPllKickMs : 0;
        if (quiet > 1500 && onBeat && this.goodRep > 0 && now - this.goodAt < BREAK_RESTORE_MS + 1500) {
          beat0.anchorMs += err * beatMs;
          this.onBeatRate = Math.max(this.onBeatRate, this.goodOn); this.repeatRate = Math.max(this.repeatRate, this.goodRep);
          if (this.pllKicks < 12) this.pllKicks = 12;
        }
      }
      if (onBeat) cfg.beatErr = (cfg.beatErr ?? 0) * 0.85 + err * 0.15;   // UI: ihållande fasfel
      { const x = onBeat ? 1 : 0; this.onBeatRate += (x - this.onBeatRate) * (x > this.onBeatRate ? TRUST_UP : 0.12); }
      { const x = onBeat || this.kickRepeats(frame.kickAtMs, TRUST_REPEAT_BEATS * beatMs, TRUST_REPEAT_TOL * beatMs) ? 1 : 0; this.repeatRate += (x - this.repeatRate) * (x > this.repeatRate ? TRUST_UP : 0.12); }
      this.lastPllKickMs = now;
      if (this.pllKicks < 40) this.pllKicks++;
      if (BREAK_RESTORE_MS > 0 && this.pllKicks >= 12) { this.goodOn = this.onBeatRate; this.goodRep = this.repeatRate; this.goodAt = this.lastPllKickMs; }
    }
    if (frame.kickAtMs > 0 && frame.kickAtMs !== this.kickRingLast) { this.kickRingLast = frame.kickAtMs; this.kickRing[this.kickRingPos] = frame.kickAtMs; this.kickRingPos = (this.kickRingPos + 1) & 63; if (this.kickRingN < 64) this.kickRingN++; }
    {   // ringen + vikningen (basens stigning i dB mot FEED_RISE_HOPS hop sedan; var 2:a hop in i ringen, max av de två)
      const sa = frame.specAbs, db = 20 * Math.log10((sa?.sub ?? 0) + (sa?.kick ?? 0) + 1e-7);
      const old = this.riseDb[this.risePos]; this.riseDb[this.risePos] = db; this.risePos = (this.risePos + 1) % FEED_RISE_HOPS;
      const ok = old !== 0 && db > old ? db - old : 0;
      const hi = (frame.onset?.highMid ?? 0) + (frame.onset?.treble ?? 0);
      if (this.onHalf) { this.onT[this.onPos] = now; this.onV[this.onPos] = ok > this.onPrev ? ok : this.onPrev; this.hiV[this.onPos] = hi > this.hiPrev ? hi : this.hiPrev; this.pwT[this.pwPos] = now; this.pwE[this.pwPos] = this.onV[this.onPos]; this.pwH[this.pwPos] = this.hiV[this.onPos]; this.pwPos = (this.pwPos + 1) & (PW_RING - 1); if (this.pwN < PW_RING) this.pwN++;
        this.onPos = (this.onPos + 1) % ONSET_RING; if (this.onN < ONSET_RING) this.onN++; }
      this.onPrev = ok; this.hiPrev = hi; this.onHalf = !this.onHalf;
      this.tgStep(now);
      // KALLSTART (förr analysatorns första lås): klockan föds på tempogrammets första topp, fasen på senaste kicken; onsetStep lägger
      // sedan rutnätet på vikningens topp inom 250 ms.
      if (!cfg.beat && this.tempoBpm > 0) cfg.beat = { anchorMs: frame.beatAnchorMs || now, bpm: this.tempoBpm, confidence: 0 };
      this.onsetStep(cfg, now);
    }
    // (analysatorns barShift flyttar inte längre klockan: ETTAN är klockans egen taktmodell - en etta, inte två)
    if (cfg.beat) this.barStep(frame, cfg.beat, now);
    if (cfg.beat) {
      // COAST på fasträffarna: svaga -> rutnätet rullar vidare GRID_COAST_MS med tilliten golvad, sedan släpps golvet.
      if (pllConf >= GRID_ON_CONF) { this.gridWeakSince = 0; this.gridCoasting = false; }
      else if (pllConf < MIN_BEAT_CONFIDENCE) {
        if (this.gridWeakSince === 0) { this.gridWeakSince = now; this.gridCoasting = true; }
        else if (now - this.gridWeakSince >= GRID_COAST_MS) { this.gridCoasting = false; this.gridWeakSince = now; }
      }
      // EN TILLIT SOM MÅTT (t1f): andelen kickar rutnätet förutsäger (repeatRate) x tempots tydlighet (tgClear). Förr bara
      // repeatRate, som mättade på 1,00 även när tempogrammet hade två nästan lika starka tempon (konsertReplay: 1,00 vid VARJE manusval).
      const live = this.repeatRate * this.tgClear;
      cfg.beat.confidence = this.gridCoasting ? Math.max(live, MIN_BEAT_CONFIDENCE) : live;
    }
  }
}


