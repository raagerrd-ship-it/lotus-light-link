

## Sync-diagnostikläge: Mic vs Sparad kurva sida vid sida

### Problem
Vi vet inte exakt var tidsförskjutningen mellan den sparade brightness-kurvan och verkligheten ligger. Behöver ett visuellt jämförelseverktyg.

### Lösning
Lägg till ett **"Sync Debug"-läge** som kör parallellt med normal uppspelning. När en redan inspelad låt spelas:

1. **Dubbelt intensitetsdiagram** — Nuvarande canvas delas i övre och undre halva:
   - **Övre**: Baked brightness curve (lookup via `interpolateBrightness` vid `posSec`)
   - **Undre**: Live mic RMS (samma AGC-pipeline som mic-mode)
   - Samma tidsaxel, scrollar synkront

2. **Realtids offset-indikator** — Visar beräknad tidsförskjutning genom att korskorrelera de senaste ~3 sekundernas mic-onsets med curve-onsets. Visas som `Δt: +6.2s` i debug-overlay.

3. **Aktivering** — Ny toggle i debug-overlay: "Sync diag" som sätter en ref. När aktiv körs mic AGC-pipelinen parallellt med curve-lookup (normalt hoppar vi över mic-beräkning i curve-mode).

### Tekniska detaljer

**`src/components/MicPanel.tsx`**:
- Ny ref `syncDiagRef` (boolean) + `micPctHistoryRef` (number[]) + `curvePctHistoryRef` (number[])
- I tick-loopens curve-mode: om syncDiag är på, kör ÄVEN mic AGC-pipeline och spara `micPct`
- Spara båda till separata historik-arrayer (senaste 120 samples)
- Skicka båda till en ny `drawSyncChart`-funktion

**`src/lib/drawChart.ts`**:
- Ny funktion `drawSyncChart(canvas, micHistory, curveHistory, len)` som ritar två linjer — grön för curve, orange för mic — i samma canvas

**`src/components/DebugOverlay.tsx`**:
- Ny klickbar "Sync"-knapp som togglar `syncDiag` via callback
- Visa korskorrelerings-offset (beräknad i MicPanel) som `Δt: ±Xms`

**Korskorrelering** (enkel variant i MicPanel):
- Buffra senaste 3s av mic-onsets och curve brightness-toppar
- Skifta mic-buffern ±500 samples och hitta bästa match → offset i ms

