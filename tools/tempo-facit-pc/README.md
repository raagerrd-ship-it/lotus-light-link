# tempo-facit-pc — facit ur ljudet (2026-09-19)

PC:n **hämtar** 30 s-snuttar (48 kHz mono, samma ljud som analysatorn får) från Pi:n, räknar tempo i
efterhand och skriver facit tillbaka i Pi:ns katalogcache. Inga portar öppnas, ingen PC-adress på Pi:n.

- Pi: vid låtbyte +10 s fångar motorn 30 s (`startRawCapture(30, titel, fullRate=true)`) till
  `<PCC_DATA_DIR>/snippets/`, kö max 30. Routes: `GET /api/tempo/snippets`, `GET /api/tempo/snippet?key=`,
  `PUT /api/tempo/facit`, `GET /api/tempo/cache`. Snutten raderas när facit kommit.
- PC: `tempo_facit.py [http://192.168.1.174:3051] [--once]` pollar var 20 s. Autostart: `tempo_facit.bat`
  via Startup-mappen (`LotusTempoFacit.cmd`). Logg: `tempo_facit.log`. Venv: `.venv` (librosa 1.0, numba).

**Tempot väljs på evidens, inte på trackerns prior.** Klicktest (kick 80 Hz + hi-hat): librosas
`beat_track` med default-prior gav 168 → 112,5 (2/3), 86 → 114,8 (4/3), 172 → 114,8 (2/3) och la slagen
på hi-hatsen vid 123 — samma fällor som förra sessionens egna autokorrelationer. Därför: tempogrammets
topp-6 kandidater, varje kandidat pinnas (`bpm=`), slagen läggs ut, **bas-onset (< 220 Hz) mäts på slagen**
— fantomer träffar kickarna bara varannan/var tredje gång och förlorar. Oktav ×2 avgörs av halvslagstestet i
basbandet (halvkvot ≥ 0,6, tak 200). Resultat på syntetiskt test: 6/6 (92, 123, 168, 86 m. 16-delar, 172,
110 m. kick varannan). Allt (kandidater med slagpoäng, halvkvot, conf) följer med i cacheraden så reglerna
kan granskas mot analysatorn. Analysatorn är gemensam med pi-dmx: det som bevisas här ska in i analysatorn.
