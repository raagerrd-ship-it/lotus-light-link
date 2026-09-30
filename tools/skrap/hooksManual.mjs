const A = new URL('./manualAlsa.mjs', import.meta.url).href;
export async function resolve(s, c, n) { if (/vendor\/alsa-capture\/index\.js$/.test(s)) return { url: A, shortCircuit: true }; return n(s, c); }
