---
name: Color saturation / vit-rensning
description: applyColorCalibrationFast drar bort min(R,G,B) (vit-andelen) och boostar tillbaka peak innan offset/gamma. Bevarar hue, eliminerar pastell-vitnande på BLEDOM. Styrs av cal.saturation 0-1, default 1.0 i alla profiler.
type: feature
---
**Problem:** BLEDOM-stripper med linjär RGB-skalning blandar alla tre LED-kanaler samtidigt. Vid en orange `(251,93,52)` är blå/grön på 20-35% duty och ögat ser blekt vit/rosa istället för mättad orange — särskilt vid hög brightness.

**Lösning (`applyColorCalibrationFast` i `pi/src/piEngine.ts`):** Innan offset/gamma:
1. `m = min(R,G,B)` — vit-andelen.
2. Subtrahera `m` från alla kanaler.
3. Boosta resultatet med `peak/peak2` så peak-kanalen behåller sitt värde.
4. Blenda mellan original (`sat=0`) och vit-rensad (`sat=1`) via `cal.saturation`.

**Exempel:** `(251,93,52)` → m=52 → `(199,41,0)` → boost 251/199 ≈ 1.26 → `(251,52,0)`. Blå helt av, grön kraftigt nerdragen, hue exakt bevarad.

**Default `saturation: 1.0`** i alla 4 profiler (Lugn/Normal/Party/Custom). Custom kan dra ner via slider "Färgmättnad" 0-100% om pastell-look önskas.

**Order i pipen:** Vit-rensning sker FÖRE offset/gamma och brightness-skalning, så hela kedjan (idle, active, keep-alive) påverkas konsekvent.

**Påverkar inte:** punch-white (graderad övergång lämnad orörd), brightness-gamma/dimming-LUT, BLE-protokoll, hue-väljaren.
