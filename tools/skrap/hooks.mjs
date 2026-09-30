const FAKE_NOBLE = new URL('./fakeNoble.mjs', import.meta.url).href;
const FAKE_HCI = new URL('./fakeHci.mjs', import.meta.url).href;
const FAKE_ALSA = new URL('./fakeAlsa.mjs', import.meta.url).href;
export async function resolve(specifier, context, next) {
  if (specifier === '@stoprocent/noble') return { url: FAKE_NOBLE, shortCircuit: true };
  if (/vendor\/alsa-capture\/index\.js$/.test(specifier) || specifier === 'alsa-capture') return { url: FAKE_ALSA, shortCircuit: true };
  if (/adapter-hci-check\.js$/.test(specifier)) return { url: FAKE_HCI, shortCircuit: true };
  return next(specifier, context);
}
