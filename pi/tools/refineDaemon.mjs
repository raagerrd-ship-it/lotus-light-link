/**
 * REFINER — analyserar inspelade latar EN gang, pa Pi:n sjalv.
 *
 * VARFOR EN EGEN PROCESS: motorn ar realtid och far aldrig vanta pa natverk.
 * Kors med nice 19; ingen del av showen beror av den.
 *
 * VARFOR WAV:EN RADERAS: svaret vager nagra kB, ljudet 13 MB. 400 latar vore
 * 5 GB. En lat analyseras en gang i sitt liv och sedan racker svaret.
 *
 * OFFLINE AR ETT NORMALTILLSTAND. Ligger Pi:n som accesspunkt utan internet
 * ligger WAV:erna kvar och kon betas av nar den kommer at natet igen. Darfor
 * ocksa ett HART DISKTAK: ett langvarigt bortfall far aldrig fylla kortet och
 * stoppa inspelningen.
 */
import { readFileSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { SongStore } from "../dist/songStore.js";

const VERSION = "001b4137be6ac67bdc28cb5cffacf128b874f530258d033de23121e785cb7290";
const API = "https://api.replicate.com/v1";
const DIR = process.env.CORPUS_DIR || "/home/pi/corpus";
const STORE = process.env.SONG_STORE || "/var/lib/pi-control-center/apps/lotus-light/songs.json";
const TOKEN_FILE = process.env.REPLICATE_TOKEN_FILE || "/var/lib/pi-control-center/apps/lotus-light/replicate.token";
const IDLE_MS = 30000;
const RETRY_BASE_MS = 60000;
const RETRY_MAX_MS = 3600000;
const MAX_QUEUE_MB = 900;

// SKRIV TILL STDERR, INTE STDOUT. Node buffrar stdout nar den ar en pipe
// (journald), sa loggen kunde forsvinna helt medan tjansten korde -- och da ar
// man blind for vad den gor. stderr ar obuffrad.
const log = (m) => process.stderr.write("[refine] " + m + String.fromCharCode(10));
const token = () => (existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, "utf8").trim() : "");

const wavSeconds = (p) => {
  const d = readFileSync(p).subarray(0, 48);
  return d.readUInt32LE(40) / ((d.readUInt32LE(24) || 16000) * 2);
};

function manifest() {
  const m = new Map();
  const p = join(DIR, "manifest.tsv");
  if (!existsSync(p)) return m;
  for (const l of readFileSync(p, "utf8").split("\n").slice(1)) {
    const c = l.split("\t");
    // KOLUMN 8 = latposition (ms) dar inspelningen BORJADE. Utan den ar alla
    // tider i minnet relativa till INSPELNINGEN, inte till laten -- och
    // insamlaren startar nagra sekunder in (bytet upptacks med fordrojning).
    // En sektion markt "refrang vid 72 s" var da 72 s in i inspelningen, vilket
    // ar fel plats i laten. Aldre rader saknar kolumnen -> offset 0.
    if (c.length >= 6) m.set(c[5].trim(), { artist: c[1], title: c[2], offsetMs: Number(c[7] || 0) || 0 });
  }
  return m;
}

/** Modellens BPM-skalar ar grovre an dess egen slaglista. UPPMATT pa
 *  "A Bar Song (Tipsy)": skalaren sa 79, slagens median gav 81,1 — och det
 *  vikta facit ar 81. Anvand slagen nar de racker till. */
function bpmFromBeats(beats) {
  if (!Array.isArray(beats) || beats.length < 8) return null;
  const iv = [];
  for (let i = 1; i < beats.length; i++) iv.push(beats[i] - beats[i - 1]);
  iv.sort((a, b) => a - b);
  const med = iv[iv.length >> 1];
  return med > 0 ? 60 / med : null;
}

/**
 * DROPS ur ljudets EGEN energikurva, snappade till modellens taktettor.
 * En drop ar ett SKIFTE (tyst -> hogt), inte hog energi — darfor jamfors varje
 * fonster mot medianen av de narmaste sekunderna FORE, annars blir hela
 * refrangen en enda lang drop.
 */
/** RMS per 100 ms. Lagras i minnet (~7 kB for tre minuter) sa drops kan raknas
 *  om i efterhand utan att laten behover spelas in igen. */
/**
 * LANDMARKEN fran motorns sidofil.
 *
 * Motorn producerar dem LIVE, med samma FFT och samma bandgranser som sedan
 * matchar dem. Det ar med flit: en berakning har i refinern hade anvant en annan
 * transform och andra granser, och da matchar inte hasharna langre.
 *
 * Tiderna forskjuts hit till LATENS tidslinje med samma `off` som slag, delar
 * och drops — sa allt lagrat beskriver samma tid.
 */
function landmarks(wavFile, meta, off) {
  const slug = (meta.artist + " - " + meta.title).toLowerCase()
    .replace(/[åä]/g, "a").replace(/ö/g, "o")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 58);
  // Samma katalog som motorn skriver till — /home/pi ar skrivskyddat for den.
  const p = (process.env.LOTUS_LM_DIR || "/var/lib/pi-control-center/apps/lotus-light") + "/" + slug + ".lm.json";
  try {
    const d = JSON.parse(readFileSync(p, "utf8"));
    if (!Array.isArray(d.hash) || !Array.isArray(d.time) || d.hash.length !== d.time.length) return {};
    if (d.hash.length < 50) return {};
    const out = { lmHash: d.hash, lmTime: d.time.map((t) => t + off) };
    // MOTORNS energikurva gar fore refinerns egen: den ar i showens takt (20 ms)
    // i stallet for 100 ms, och kommer ur samma signalvag som realtidsvagen.
    if (Array.isArray(d.energy) && d.energy.length > 20 && d.energyStepMs > 0) {
      let mx = 0; for (const v of d.energy) if (v > mx) mx = v;
      if (mx > 0) {
        out.energy = d.energy.map((v) => Math.round((v / mx) * 255));
        out.energyStepMs = d.energyStepMs;
      }
    }
    try { unlinkSync(p); } catch {}
    log("landmarken: " + d.hash.length + " for " + meta.title);
    return out;
  } catch { return {}; }
}

export function energyCurve(wavPath) {
  const d = readFileSync(wavPath);
  const rate = d.readUInt32LE(24) || 16000;
  const n = (d.readUInt32LE(40) || 0) / 2;
  const W = Math.round(rate * 0.1);
  const nw = Math.floor(n / W);
  const e = new Float64Array(nw);
  for (let w = 0; w < nw; w++) {
    let sum = 0;
    for (let i = 0; i < W; i++) {
      const v = d.readInt16LE(44 + (w * W + i) * 2) / 32768;
      sum += v * v;
    }
    e[w] = Math.sqrt(sum / W);
  }
  return e;
}

/**
 * DROPS = SEKTIONSGRANSER, betygsatta av energin.
 *
 * VARFOR INTE TROSKLAR PA ENERGIN ENSAM: det provades och gav 26 drops pa
 * "Stora tuttar" (79 BPM) med 5-8 s mellanrum -- alltsa varannan takt, vilket
 * ar frasandning och inte struktur. Samtidigt fick "Dricker Vin" noll. Ett matt
 * som svanger sa mellan tva latar mater inte en stabil egenskap.
 *
 * MEN: nar dropsen raknades pa energi ensam lag de STARKASTE (0.54, 0.49, 0.45)
 * exakt pa modellens EGNA sektionsgranser. Modellen vet alltsa redan var
 * dropsen ar -- den kallar dem bara "chorus borjar har".
 *
 * Sa: kandidaterna kommer fran STRUKTUREN (dar modellen ar stark), och energin
 * far bara saga HUR MYCKET som hander vid varje grans. Antalet blir da bundet
 * av latens form -- en lat har 5-10 sektioner och kan aldrig fa 26 drops.
 */
function dropsAtSections(e, parts, beatMs) {
  if (!e || !e.length || !parts || parts.length < 2) return [];
  const perBeat = Math.max(2, Math.round(beatMs / 100));
  const WIN = Math.max(perBeat * 4, 20);       // fyra slag, minst 2 s
  const med = (arr) => {
    const a = Array.from(arr).sort((x, y) => x - y);
    return a.length ? a[a.length >> 1] : 0;
  };
  const out = [];
  for (const p of parts) {
    const w = Math.round(p.t / 100);
    if (w - WIN < 0 || w + WIN >= e.length) continue;
    const before = med(e.subarray(Math.max(0, w - WIN), w));
    const after = med(e.subarray(w, w + WIN));
    if (before <= 1e-6) continue;
    const rise = after / before;
    // Bara gransen UPPAT ar en drop. En overgang till nagot tystare ar en
    // breakdown, och den ska inte fyra en ljusstot.
    if (rise < 1.25) continue;
    out.push({ t: p.t, s: Math.min(1, Math.round(((rise - 1.25) / 1.75) * 100) / 100), label: p.label });
  }
  return out;
}

async function analyse(wav, tok) {
  const auth = { Authorization: "Bearer " + tok };
  const body = new FormData();
  body.append("content", new Blob([readFileSync(wav)]), wav.split("/").pop());
  const up = await fetch(API + "/files", { method: "POST", headers: auth, body });
  if (!up.ok) throw new Error("uppladdning " + up.status);
  const fileUrl = (await up.json())?.urls?.get;
  if (!fileUrl) throw new Error("ingen fil-URL");
  const st = await fetch(API + "/predictions", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ version: VERSION, input: { music_input: fileUrl, visualize: false, sonify: false } }),
  });
  if (!st.ok) throw new Error("start " + st.status);
  let pred = await st.json();
  const deadline = Date.now() + 900000;
  while (pred.status === "starting" || pred.status === "processing") {
    if (Date.now() > deadline) throw new Error("tidsgrans");
    await new Promise((r) => setTimeout(r, 6000));
    pred = await (await fetch(pred.urls.get, { headers: auth })).json();
  }
  if (pred.status !== "succeeded") throw new Error("korning " + pred.status);
  const out = Array.isArray(pred.output) ? pred.output : [pred.output];
  const j = out.find((u) => typeof u === "string" && u.endsWith(".json")) || out[0];
  return await (await fetch(j)).json();
}

const store = new SongStore(STORE);
await store.load();
log("start — minnet har " + store.size + " latar");

let backoff = 0;
let lastBeat = 0;
for (;;) {
  const tok = token();
  const man = manifest();
  const wavs = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".wav")) : [];

  // DISKTAK. Aldst forst: en gammal lat kommer igen senare an en ny, sa den
  // kostar minst att slanga. Kon far aldrig vaxa forbi taket.
  const byAge = wavs
    .map((f) => {
      const p = join(DIR, f);
      const s = statSync(p);
      return { f, p, t: s.mtimeMs, mb: s.size / 1048576 };
    })
    .sort((a, b) => a.t - b.t);
  let mb = byAge.reduce((s, w) => s + w.mb, 0);
  while (mb > MAX_QUEUE_MB && byAge.length) {
    const old = byAge.shift();
    try {
      unlinkSync(old.p);
      mb -= old.mb;
      log("disktak: slangde " + old.f);
    } catch { break; }
  }

  // HJARTSLAG: utan den gar det inte att skilja "inget att gora" fran "hangd".
  const now = Date.now();
  if (now - lastBeat > 120000) {
    lastBeat = now;
    log("vaken — " + byAge.length + " wav i kon, " + man.size + " manifestrader, " +
        store.size + " latar i minnet" + (token() ? "" : ", INGEN NYCKEL"));
  }

  let did = false;
  for (const w of byAge) {
    const meta = man.get(w.f);
    if (!meta) {
      // WAV utan manifestrad: insamlaren skriver raden EFTER filen, sa det har
      // ar normalt i nagra sekunder. Men blir det bestaende ar nagot fel.
      if (now - w.t > 120000) log("hoppar " + w.f + ": ingen manifestrad");
      continue;
    }
    let sec = 0;
    try { sec = wavSeconds(w.p); } catch { try { unlinkSync(w.p); } catch {} continue; }
    const have = store.lookup(meta.artist, meta.title);
    // ANALYSERA OM BARA nar det finns mer ljud an forra gangen: ett kort klipp
    // ger ratt TEMPO men vardelosa sektioner (klippet AR introt).
    // SAKNAS LANDMARKEN analyseras laten om en gang, aven om ljudet inte ar
    // langre an forra gangen.
    //
    // Att bara klistra in landmarkena i den gamla posten gar INTE: landmarken
    // och showinnehall maste dela SAMMA inspelningsoffset for att offsetens fel
    // ska ta ut sig. En ny inspelning har en annan (och numera exakt) offset an
    // den gamla analysen, sa de skulle beskriva olika tidslinjer.
    const needsLandmarks = have && (!(have.lmHash && have.lmHash.length > 50) || !have.energyStepMs);
    if (have && !needsLandmarks && sec <= (have.analysedSeconds || 0) + 10) {
      try { unlinkSync(w.p); } catch {}
      continue;
    }
    if (!tok) break;   // ingen nyckel an: lat filerna ligga kvar

    try {
      const res = await analyse(w.p, tok);
      const fromBeats = bpmFromBeats(res.beats);
      const bpm = fromBeats ?? Number(res.bpm);
      if (!(bpm > 0)) throw new Error("inget bpm i svaret");
      // ALLA tider forskjuts till LATENS tidslinje, inte inspelningens.
      const off = meta.offsetMs || 0;
      const downbeats = (res.downbeats || []).map((x) => Math.round(x * 1000) + off);
      const parts = [];
      for (const s of res.segments || []) {
        const label = String(s.label || "").toLowerCase();
        if (!label || label === "start" || label === "end") continue;
        if (parts.length && parts[parts.length - 1].label === label) continue;
        parts.push({ t: Math.round(s.start * 1000) + off, label });
      }
      // Energikurvan raknas EN gang och lagras — dels for dropsen nu, dels sa de
      // kan raknas om i efterhand nar detektorn forbattras, utan ny inspelning.
      let drops, energy;
      try {
        const e = energyCurve(w.p);
        const beatMs = 60000 / bpm;
        // parts ar redan forskjutna med off -> rakna i inspelningens tid och
        // flytta ut svaret, precis som for allt annat.
        drops = dropsAtSections(e, parts.map((p) => ({ t: p.t - off, label: p.label })), beatMs)
          .map((d) => ({ t: d.t + off, s: d.s }));
        // 0-255 racker gott och halften sa stor fil som flyttal.
        let mx = 0; for (let i = 0; i < e.length; i++) if (e[i] > mx) mx = e[i];
        energy = mx > 0 ? Array.from(e, (v) => Math.round((v / mx) * 255)) : undefined;
        // (skrivs over av motorns finare kurva nedan om den finns)
      } catch { drops = undefined; energy = undefined; }
      store.put({
        artist: meta.artist,
        title: meta.title,
        bpm: Math.round(bpm * 10) / 10,
        bpmSource: fromBeats ? "allin1-beats" : "allin1-bpm",
        beats: (res.beats || []).map((x) => Math.round(x * 1000) + off),
        /** Latposition dar inspelningen borjade. 0 = fran latens start. */
        recordedFromMs: off,
        beatPositions: Array.isArray(res.beat_positions) ? res.beat_positions.slice() : undefined,
        downbeats,
        parts: parts.length ? parts : undefined,
        drops, energy,
        // EFTER `energy`, med flit: motorns kurva ligger i showens takt och ska
        // vinna over refinerns egen 100 ms-version ur WAV-filen.
        ...landmarks(w.f, meta, off),
        analysedSeconds: Math.round(sec),
        analysedAt: new Date().toISOString().slice(0, 10),
      });
      await store.save();
      try { unlinkSync(w.p); } catch {}
      log("OK " + Math.round(bpm) + " BPM, " + (drops?.length ?? 0) + " drops, " +
          parts.length + " sektioner — " + meta.artist + " – " + meta.title);
      backoff = 0;
      did = true;
      break;   // en i taget, snallt mot Pi:n
    } catch (e) {
      backoff = backoff ? Math.min(backoff * 2, RETRY_MAX_MS) : RETRY_BASE_MS;
      log("FEL " + e.message + " — nytt forsok om " + Math.round(backoff / 1000) + " s");
      await new Promise((r) => setTimeout(r, backoff));
      did = true;
      break;
    }
  }
  if (!did) await new Promise((r) => setTimeout(r, IDLE_MS));
}
