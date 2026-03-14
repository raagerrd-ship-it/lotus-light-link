
# Ta bort all låtsparning — behåll bara live mic-läge

## Vad som tas bort
- **Kurv-inspelning**: All logik i MicPanel som spelar in energikurvor och sparar dem till databasen
- **Kurv-uppspelning**: Hela "curve mode" i MicPanel (hasCurve-grenarna med brightness interpolation, section-baserade effekter, beat-synkade pulser från sparad data)
- **useSongEnergyCurve hook**: Hela filen — ingen DB-lookup eller sparning av kurvor
- **SongDetailChart**: Hela komponenten
- **SongCalibrationTab**: Hela komponenten (dynamik-kalibrering baserad på sparade kurvor)
- **ChainSyncTab**: Hela komponenten (synk-kalibrering baserad på sparade beat grids)
- **RecordedSongsTab** i Calibrate.tsx + "Inspelningar"-tabben
- **Låtlista i MonitorView**: Song list, delete, SongDetailChart-import
- **Edge functions**: `process-songs` och `analyze-sections` (server-side analys av sparade kurvor)
- **Latency slider** i Index.tsx (chainLatencyMs — bara relevant med sparade kurvor)
- **curveStatus** i debug overlay och live session

## Vad som behålls
- **Live mic-reaktivitet**: AGC, RMS → brightness, frequency bands → color modulation
- **Sonos now-playing**: Track info, album art, palette extraction
- **BLE-styrning**: Alla BLE-kommandon, reconnect, power toggle
- **NowPlayingBar**: Förenklad (utan sections/bpm/processing)
- **MonitorView**: Live session debug panel (utan låtlista)
- **Calibrate**: BLE-hastighetstest (tab 1) + kalibreringssliders (minBrightness, maxBrightness, dynamicDamping etc.)
- **DebugOverlay**: Förenklad (utan curveStatus, syncMode, chainLatencyMs)
- **Auto-sync** (bleLatencyMs-kompensation för mic-läge)

## Filer som tas bort helt
- `src/hooks/useSongEnergyCurve.ts`
- `src/components/SongDetailChart.tsx`
- `src/components/SongCalibrationTab.tsx`
- `src/components/ChainSyncTab.tsx`
- `supabase/functions/process-songs/index.ts`
- `supabase/functions/analyze-sections/index.ts`

## Filer som kan tas bort (bara används av curve mode)
- `src/lib/sectionLighting.ts`
- `src/lib/dropDetect.ts`
- `src/lib/songAnalysis.ts`
- `src/lib/energyInterpolate.ts`
- `src/lib/bpmEstimate.ts`
- `src/lib/autoCalibrate.ts`

## Filer som förenklas
- **MicPanel.tsx**: Ta bort alla curve-relat