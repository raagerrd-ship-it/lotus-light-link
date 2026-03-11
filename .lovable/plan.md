

# Förbättra synkronisering

## Nuvarande problem

Synkningen mellan sektionsdata (drops, vers/refräng) och musiken har tre svagheter:

1. **Okänd nätverkslatens**: `receivedAt` sätts vid svar, men positionMs rapporterades av Sonos *innan* nätverks-RTT. Klockan driftar uppåt.
2. **AI-sektioner är ungefärliga**: Gemini gissar tidpunkter, inte sample-exakta.
3. **Ingen kalibrering**: Ingen mekanism att justera offset manuellt eller automatiskt.

## Plan

### 1. RTT-kompensation i useSonosNowPlaying

Mät round-trip time på varje watchdog-fetch och subtrahera halva RTT från positionMs:

```
const t0 = performance.now();
const res = await fetch(...);
const rtt = performance.now() - t0;
// positionMs ska kompenseras: den rapporterades rtt/2 ms sedan
positionMs = s.positionMillis + rtt / 2;
receivedAt = performance.now();
```

Detta ger ~50-150ms bättre precision beroende på nätverkslatens.

### 2. Glidande medelvärde av RTT

Filtrera bort spikar med exponentiellt glidande medelvärde (EMA):

```
smoothedRtt = smoothedRtt * 0.7 + measuredRtt * 0.3;
```

### 3. Manuell offset-justering

Lägg till en liten offset-parameter (default 0) som adderas till currentSec-beräkningen. Exponeras som en setting (t.ex. via long-press på Zap-ikonen) med +/- 50ms steg. Sparas i localStorage.

### 4. Bredare drop-lookahead

Öka `getUpcomingDrop` lookahead från 100ms till `100ms + smoothedRtt/2` för att kompensera BLE-latens + nätverkslatens.

## Filer som ändras

1. **`src/hooks/useSonosNowPlaying.ts`** — RTT-mätning och kompensation i fetchApi
2. **`src/components/MicPanel.tsx`** — Läs offset från ref, justera currentSec, dynamisk lookahead
3. **`src/pages/Index.tsx`** — Offset-state + UI för manuell justering (minimal, t.ex. popup vid long-press)
4. **`src/lib/songSections.ts`** — Uppdatera getUpcomingDrop signature för dynamisk lookahead

