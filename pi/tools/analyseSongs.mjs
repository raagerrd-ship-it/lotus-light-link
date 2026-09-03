/**
 * Fyller latminnet genom att skicka inspelade latar till all-in-one-modellen
 * (sakemin/all-in-one-music-structure-analyzer, ISMIR 2023) via Replicate.
 *
 * En lat analyseras EN gang i sitt liv. Resultatet ar tempot som MUSIKEN gar i,
 * inte vikt till analysatorns [80,160) -- det ar hela poangen med att gora det
 * i efterhand.
 *
 *   node tools/analyseSongs.mjs <korpuskatalog> [--limit N] [--dry]
 *
 * Nyckeln (token) lases fran REPLICATE_TOKEN eller filen som pekas ut av
 * REPLICATE_TOKEN_FILE. Den skrivs ALDRIG ut.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { SongStore } from "../dist/songStore.js";

const VERSION = "001b4137be6ac67bdc28cb5cffacf128b874f530258d033de23121e785cb7290";
const API = "https://api.replicate.com/v1";

const DIR = process.argv[2] || "corpus";
const LIMIT = Number((process.argv.find((a) => a.startsWith("--limit=")) || "").split("=")[1] || 8);
const DRY = process.argv.includes("--dry");
const STORE = process.env.SONG_STORE || "songs.json";

const tokenFile = process.env.REPLICATE_TOKEN_FILE;
const TOKEN = process.env.REPLICATE_TOKEN
  || (tokenFile && existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "");
if (!TOKEN && !DRY) { console.error("  ingen token (REPLICATE_TOKEN eller REPLICATE_TOKEN_FILE)"); process.exit(2); }
const auth = { Authorization: `Bearer ${TOKEN}` };

const store = new SongStore(STORE);
await store.load();
console.log(`  minnet har ${store.size} latar innan`);

// En rad per lat: forsta inspelningen racker. Fler ar samma inspelning igen.
const man = join(DIR, "manifest.tsv");
if (!existsSync(man)) { console.error(`  saknar ${man}`); process.exit(2); }
const wavSeconds = (p) => {
  const d = readFileSync(p, { encoding: null }).subarray(0, 48);
  return d.readUInt32LE(40) / (d.readUInt32LE(28) || 96000);
};

const jobs = new Map();
for (const line of readFileSync(man, "utf8").split("\n").slice(1)) {
  const c = line.split("\t");
  if (c.length < 6) continue;
  const [, artist, title] = c;
  const wav = join(DIR, c[5].trim());
  if (!artist || !title || !existsSync(wav)) continue;
  // ANALYSERA OM NAR MER LJUD FINNS. Ett 40-sekundersklipp ger ratt TEMPO men
  // vardelosa sektioner -- klippet AR introt. Nar hela laten spelats in maste den
  // darfor fa gaa om, annars fastnar minnet pa den forsta magra analysen.
  // Tolerans 10 s sa smaskillnader mellan tva inspelningar inte triggar omkorning.
  const have = store.lookup(artist, title);
  if (have) {
    let sec = 0;
    try { sec = wavSeconds(wav); } catch { /* trasig fil -> hoppa */ continue; }
    if (sec <= (have.analysedSeconds || 0) + 10) continue;
  }
  const key = artist + "|" + title;
  // Valj den STORSTA inspelningen av laten -- mest ljud, bast analys.
  const prev = jobs.get(key);
  if (!prev || statSync(wav).size > statSync(prev.wav).size) jobs.set(key, { artist, title, wav });
}
const list = [...jobs.values()].slice(0, LIMIT);
console.log(`  ${jobs.size} oanalyserade latar, kor ${list.length}${DRY ? " (torrkorning)" : ""}`);
if (DRY) { for (const j of list) console.log("    " + j.artist + " – " + j.title); process.exit(0); }



async function analyse(wav) {
  const body = new FormData();
  body.append("content", new Blob([readFileSync(wav)]), basename(wav));
  const up = await fetch(`${API}/files`, { method: "POST", headers: auth, body });
  if (!up.ok) throw new Error(`uppladdning ${up.status}`);
  const fileUrl = (await up.json())?.urls?.get;
  if (!fileUrl) throw new Error("uppladdningen gav ingen URL");

  const st = await fetch(`${API}/predictions`, {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ version: VERSION, input: { music_input: fileUrl, visualize: false, sonify: false } }),
  });
  if (!st.ok) throw new Error(`start ${st.status}`);
  let pred = await st.json();
  const deadline = Date.now() + 900000;
  while (pred.status === "starting" || pred.status === "processing") {
    if (Date.now() > deadline) throw new Error("tidsgrans");
    await new Promise((r) => setTimeout(r, 6000));
    const p = await fetch(pred.urls.get, { headers: auth });
    pred = await p.json();
  }
  if (pred.status !== "succeeded") throw new Error(`korning ${pred.status}`);
  const out = Array.isArray(pred.output) ? pred.output : [pred.output];
  const jsonUrl = out.find((u) => typeof u === "string" && u.endsWith(".json")) || out[0];
  return await (await fetch(jsonUrl)).json();
}

/** Modellens BPM-skalar ar grovre an dess egen slaglista. UPPMATT pa
 *  "A Bar Song (Tipsy)": skalaren sa 79, slagens median gav 81,1 -- och det
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
 * DROPS ur ljudets egen energikurva, snappade till modellens taktettor.
 *
 * En drop ar inte "hog energi" utan ett SKIFTE: tyst -> hogt. Darfor jamfors
 * varje fonster mot medianen av de narmaste sekunderna FORE, inte mot latens
 * medelvarde -- annars blir hela refrangen en enda lang drop.
 *
 * Snappningen till downbeat ar viktig: en drop som fyras mellan tva nedslag
 * kanns som ett misstag aven om energin stamde.
 */
function findDrops(wavPath, downbeatsMs) {
  const d = readFileSync(wavPath);
  const rate = d.readUInt32LE(24) || 16000;
  const n = (d.readUInt32LE(40) || 0) / 2;
  if (n < rate * 20) return [];
  const W = Math.round(rate * 0.1);              // 100 ms
  const nw = Math.floor(n / W);
  const e = new Float64Array(nw);
  for (let w = 0; w < nw; w++) {
    let sum = 0;
    for (let i = 0; i < W; i++) { const v = d.readInt16LE(44 + (w * W + i) * 2) / 32768; sum += v * v; }
    e[w] = Math.sqrt(sum / W);
  }
  const BACK = 30;                                // 3 s historik
  const cand = [];
  const scratch = new Float64Array(BACK);
  for (let w = BACK; w < nw - 2; w++) {
    for (let k = 0; k < BACK; k++) scratch[k] = e[w - BACK + k];
    const sorted = Array.from(scratch).sort((a, b) => a - b);
    const before = sorted[sorted.length >> 1];
    const after = Math.max(e[w], e[w + 1], e[w + 2]);
    if (before <= 1e-6) continue;
    const rise = after / before;
    if (rise >= 1.8 && after > 0.05) cand.push({ t: w * 100, rise });
  }
  // En drop per handelse: slask allt inom 4 s efter en starkare.
  cand.sort((a, b) => b.rise - a.rise);
  const kept = [];
  for (const c of cand) {
    if (kept.some((k) => Math.abs(k.t - c.t) < 4000)) continue;
    kept.push(c);
  }
  // Snappa till narmaste taktetta inom 400 ms.
  const out = [];
  for (const k of kept) {
    let t = k.t;
    if (downbeatsMs && downbeatsMs.length) {
      let best = null, bd = 1e9;
      for (const db of downbeatsMs) { const dd = Math.abs(db - k.t); if (dd < bd) { bd = dd; best = db; } }
      if (best != null && bd <= 400) t = best;
    }
    out.push({ t, s: Math.min(1, Math.round(((k.rise - 1.8) / 2.2) * 100) / 100) });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

let ok = 0, fail = 0;
for (const j of list) {
  try {
    const res = await analyse(j.wav);
    const fromBeats = bpmFromBeats(res.beats);
    const bpm = fromBeats ?? Number(res.bpm);
    if (!(bpm > 0)) throw new Error("inget bpm i svaret");
    const parts = [];
    for (const s of res.segments || []) {
      const label = String(s.label || "").toLowerCase();
      if (!label || label === "start" || label === "end") continue;
      if (parts.length && parts[parts.length - 1].label === label) continue;  // sla ihop grannar
      parts.push({ t: Math.round(s.start * 1000), label });
    }
    store.put({
      artist: j.artist, title: j.title,
      bpm: Math.round(bpm * 10) / 10,
      bpmSource: fromBeats ? "allin1-beats" : "allin1-bpm",
      beats: (res.beats || []).map((x) => Math.round(x * 1000)),
      beatPositions: Array.isArray(res.beat_positions) ? res.beat_positions.slice() : undefined,
      downbeats: (res.downbeats || []).map((x) => Math.round(x * 1000)),
      drops: (() => { try { return findDrops(j.wav, (res.downbeats || []).map((x) => Math.round(x * 1000))); } catch { return undefined; } })(),
      parts: parts.length ? parts : undefined,
      analysedSeconds: Math.round(wavSeconds(j.wav)),
      analysedAt: new Date().toISOString().slice(0, 10),
    });
    await store.save();
    ok++;
    const dr = store.lookup(j.artist, j.title)?.drops?.length ?? 0;
    console.log(`  OK   ${String(Math.round(bpm)).padStart(3)} BPM  ${String(dr).padStart(2)} drops  ${(parts.map((p) => p.label).join("/") || "(inga sektioner)").padEnd(28)} ${j.artist} – ${j.title}`);
  } catch (e) {
    fail++;
    console.log(`  FEL  ${e.message}  ${j.artist} – ${j.title}`);
  }
}
console.log(`\n  klart: ${ok} analyserade, ${fail} fel. Minnet har nu ${store.size} latar.`);
