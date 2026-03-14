

## Kritisk granskning av kalibreringssystemet

### Hittade problem

**1. KRITISK BUG: ChainSyncTab driver inte lampan**

ChainSyncTab förutsätter att lampan blinkar i takt med beats — men den har ingen rAF-loop som skickar BLE-kommandon. MicPanel (som driver lampan) finns bara på Index-sidan och unmountas när användaren navigerar till /calibrate. Användaren ser alltså en mörk lampa och har inget att tappa mot.

SongCalibrationTab har korrekt en egen preview-loop — ChainSyncTab behöver samma sak.

**2. bleLatencyMs (Latens-fliken) gör i princip inget**

Latens-fliken mäter screen↔lamp offset och sparar som `bleLatencyMs`. I MicPanel:
- **Curve mode**: `chainLatencyMs` används (korrekt)
- **Mic mode**: `bleLatencyMs` appliceras på `getSongPositionSec()`, men i mic-läge driver lampan från rå mic-RMS — inte från kurv-position. Look-ahead påverkar bara var inspelade samples tidsstämplas, inte lampans beteende.

Latens-fliken mäter alltså fel sak. Den synkar skärm mot lampa, men skärmen är aldrig del av ljuskedjan i produktion.

**3. Latens och Kedja överlappar — men mäter olika saker**

| Flik | Mäter | Används för |
|------|-------|-------------|
| Latens | Skärm ↔ Lampa (BLE + rendering) | Nästan inget i praktiken |
| Kedja | Sonos-timestamp → Lampa (hela kedjan) | Look-ahead i curve-mode |

`bleLatencyMs` borde ersättas av GATT-roundtrip (redan mätt automatiskt) om det behövs för recording-timestamps. Latens-fliken som separat steg är missvisande — den ger användaren intryck av att den kalibrerar något viktigt, men resultatet används knappt.

**4. dynamicDamping beräknas men kastas bort**

`runMultiSongCalibration` returnerar `dynamicDamping` men:
- Fältet finns inte i `LightCalibration`
- `SongCalibrationTab.handleSave()` sparar det aldrig
- MicPanel använder det aldrig

Antingen ta bort det eller implementera det fullt ut.

**5. Inget dubbelkalibreringsproblem (bra)**

chainLatencyMs och bleLatencyMs appliceras aldrig samtidigt — `hasCurve`-flaggan avgör vilken som används. Dock: om bleLatencyMs ändå inte gör nytta kan den tas bort som look-ahead helt.

### Förslag till åtgärder

1. **ChainSyncTab: lägg till BLE lamp-driving** — En rAF-loop som läser kurvan vid aktuell Sonos-position (UTAN chainLatencyMs-kompensation, eftersom vi mäter den) och skickar pulser till lampan. Utan detta är Kedja-kalibreringen oanvändbar.

2. **Ta bort eller omformulera Latens-fliken** — Antingen:
   - **Ta bort** den helt (GATT-roundtrip mäts redan automatiskt)
   - **Byt namn och syfte**: gör den till en "BLE-latens"-mätning som bara mäter GATT-transport och sparar det separat (inte som look-ahead)
   
   Rekommendation: ta bort som separat steg. Behåll GATT-roundtrip-mätningen som sker automatiskt i bakgrunden.

3. **Implementera eller ta bort dynamicDamping** — Lägg till i `LightCalibration` och applicera i MicPanels smoothing-loop, eller ta bort från `runMultiSongCalibration`.

4. **Uppdatera ordningen** — Ny ordning: `BLE → Kedja → Låt → Inspelningar` (3 steg istället för 4). Latens-fliken försvinner eller flyttas in som del av BLE-fliken.

