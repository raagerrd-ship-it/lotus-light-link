/**
 * OMOPTIMERING EFTER 100 ANROP (2026-10-17, skräpjakten). V8 optimerar annars om en deoptad funktion först efter 3000 anrop:
 * computeBpm (4 Hz) deoptas på sällsynta grenar och körde då otolkat i minuter (TurboFan 44 % av tiden, tools/skrap/optStat.mjs)
 * och boxade varje flyttal. Mätt på PC: DMX-motorn 450 -> 185 kB/s skräp, lotus-motorn (tools/skrap/engineReplay.mjs,
 * 4 ladan-inspelningar) 424 -> 215 kB/s; ljuset byte-identiskt. Samma inställning som i dmx-control. Flaggan läses vid varje tiering-beslut, så den
 * verkar även när den sätts efter start; den gäller hela processen (även analysatorns worker). Importeras FÖRST i index.ts så den
 * följer med deployen (dist/) utan att unit-filen eller heap.conf på Pi:n behöver ändras.
 */
import { setFlagsFromString } from "node:v8";
setFlagsFromString("--invocation-count-for-turbofan=100");
