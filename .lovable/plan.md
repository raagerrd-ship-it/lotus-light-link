
Du vill se pipeline-bockrutorna uppdelade per system: **BLE-motor** (infrastruktur), **Lampa** (BLE-anslutning till specifik enhet), **Mikrofon** (ALSA), **Sonos** (gateway-anslutning), istället för en enda lång lista.

## Plan

### 1. `pi/src/configServer.ts` — gruppera pipeline + lägg till mic/sonos-steg
- Lägg till `group` på varje pipeline-steg: `'engine' | 'lamp' | 'mic' | 'sonos'`.
- Existerande BLE-steg: `caps`, `hci-socket`, `rfkill`, `hci-up`, `noble-state`, `noble-raw-reference`, `force-mutation`, `noble-guard-patch`, `adapter-effective` → `group: 'engine'`.
- `saved-device`, `connected` → `group: 'lamp'`.
- Nya **mic**-steg (läs från engine/alsaMic-runtime som redan är attached via `attachConfigRuntime`):
  - `mic-device` (vald ALSA-enhet finns)
  - `mic-running` (mic samplar — `engine.getLastFrameAt()` eller mic-status)
- Nya **sonos**-steg (läs från sonosPoller):
  - `sonos-gateway` (baseUrl konfigurerad)
  - `sonos-reachable` (senaste poll lyckades)

### 2. `src/pages/PiMobile.tsx` — rendera grupperat
- I diagnostikpanelen: gruppera `pipeline`-arrayen efter `group`-fältet.
- Rendera 4 sektioner med rubriker: "BLE-motor", "Lampa", "Mikrofon", "Sonos".
- Backwards-compat: steg utan `group` hamnar i "BLE-motor".

### Filer
- `pi/src/configServer.ts` — utöka pipeline med group + mic/sonos-steg
- `src/pages/PiMobile.tsx` — gruppera rendering
