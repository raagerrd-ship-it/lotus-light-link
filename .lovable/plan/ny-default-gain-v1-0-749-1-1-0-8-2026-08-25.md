# Ny default-gain (v1.0.749): 1.1 / 0.8

Percentil-AGC:n (mål 0.75) gjorde ljus-vägen hetare, så de gamla fallback-punkterna 2.2/1.6 pinnar lampan i taket vid en fresh install eller när inget sparat gain finns.

## Ändring

- `pi/src/alsaMic.ts`: fallback-punkterna blir `point1 {vol: 15, gain: 1.1}` och `point2 {vol: 50, gain: 0.8}` (rad 508–509).
- Version i `pi/package.json` bumpas till `1.0.749`.
- Memory `pi/audio/percentile-agc.md`: uppdatera de dokumenterade gain-punkterna till 1.1/0.8 med den uppmätta motiveringen (full 0–100 % span, 7 % pinnat, 0 % klipp, analysator 0.47 snitt).

Inget annat rörs: `lightScale 0.95`, `dropFlashMs 320`, `brightnessFloor 25`, AGC, tapp-isolering, knä, drop och BLE står kvar oförändrade.

## Notering

Redan sparade punkter i `gain-cal-points` / aktiv profil laddas fortfarande före fallbacken vid uppstart, så en Pi som redan är kalibrerad behåller sina värden. Vill du att uppdateringen ska skriva över befintligt sparat gain också, säg till — då lägger jag till en engångsmigrering.
