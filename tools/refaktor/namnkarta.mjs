// RAMFÄLTENS NYA NAMN (flytten steg 23, 2026-11-22): gammalt -> nytt. Proven döper om referensens (äldre byggens) toppfält med den här kartan.
export const NAMN = new Map([
  ['beatAnchorMs', 'kickAnchorMs'], ['buildStartCount', 'dropBuildCount'], ['buildProg', 'sectionBuildProg'],
  ['levelVsHighDb', 'sectionLevelVsHighDb'], ['inZone', 'levelInZone'], ['breaking', 'levelBreaking'],
]);
// Ramfält som togs bort (steg 24, ägaren 11-22: "Om det är gammalt för test så ta bort"): proven hoppar över dem när referensen har dem.
export const BORT = new Set(['levelRaw', 'dropRiseDb', 'repeatSection']);
