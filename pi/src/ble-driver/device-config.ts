/**
 * Hårdkodad mål-enhet — vi fokuserar på att få EN lampa att fungera.
 * Sök-UI och manuella MAC-fält är bortrensade i denna iteration; allt
 * scan/connect-flöde matchar enbart denna enhet.
 *
 * Adressformat:
 *   - mac           "BE:67:00:15:09:41"  (människo-läsbart)
 *   - addressLower  "be:67:00:15:09:41"  (jämförelse mot peripheral.address)
 *   - idNoColon     "be67001509 41" → "be6700150941" (jämförelse mot peripheral.id)
 */
export const HARDCODED_DEVICE = {
  name: 'ELK-BLEDOM01',
  mac: 'BE:67:00:15:09:41',
  addressLower: 'be:67:00:15:09:41',
  idNoColon: 'be6700150941',
} as const;

export function matchesHardcoded(peripheral: { id?: string; address?: string }): boolean {
  const addr = (peripheral.address ?? '').toLowerCase();
  const id = (peripheral.id ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
  return addr === HARDCODED_DEVICE.addressLower || id === HARDCODED_DEVICE.idNoColon;
}
