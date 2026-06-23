/**
 * Mål-enhet för lampdrivern. Default är projektets BLEDOM-lampa men kan
 * sättas om via setDeviceConfig() när drivern återanvänds i andra projekt.
 *
 * Adressformat:
 *   - mac           "BE:67:00:15:09:41"  (människo-läsbart)
 *   - addressLower  "be:67:00:15:09:41"  (jämförelse mot peripheral.address)
 *   - idNoColon     "be6700150941"       (jämförelse mot peripheral.id)
 */
export interface LampDevice {
  name: string;
  mac: string;
}

function derive(mac: string): { addressLower: string; idNoColon: string } {
  const addressLower = mac.toLowerCase();
  return { addressLower, idNoColon: addressLower.replace(/[^0-9a-f]/g, '') };
}

const DEFAULT_MAC = 'BE:67:00:15:09:41';

// Muteras in-place av setDeviceConfig() — connect.ts läser fälten vid call-time.
export const HARDCODED_DEVICE: { name: string; mac: string; addressLower: string; idNoColon: string } = {
  name: 'ELK-BLEDOM01',
  mac: DEFAULT_MAC,
  ...derive(DEFAULT_MAC),
};

export function setDeviceConfig(device: LampDevice): void {
  HARDCODED_DEVICE.name = device.name;
  HARDCODED_DEVICE.mac = device.mac;
  const d = derive(device.mac);
  HARDCODED_DEVICE.addressLower = d.addressLower;
  HARDCODED_DEVICE.idNoColon = d.idNoColon;
}

export function matchesHardcoded(peripheral: { id?: string; address?: string }): boolean {
  const addr = (peripheral.address ?? '').toLowerCase();
  const id = (peripheral.id ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
  return addr === HARDCODED_DEVICE.addressLower || id === HARDCODED_DEVICE.idNoColon;
}
