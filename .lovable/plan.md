

# Per-enhet: RGB vs Brightness-only läge

## Koncept

Varje ansluten BLE-enhet får en konfiguration som bestämmer om den styrs med fullständig RGB-färg eller enbart brightness (vitt ljus, dimmat). Detta är relevant för lampor som inte har RGB-stöd — de ska bara få brightness-paketet.

## Datamodell

Utöka `BLEConnection` med enhetsmetadata:

```typescript
export type DeviceMode = 'rgb' | 'brightness';

export interface BLEConnection {
  device: any;
  characteristic: any;
  mode: DeviceMode; // default 'rgb'
}
```

Spara per-enhet i localStorage keyed på `device.id` så inställningen överlever reconnects.

## Ändringar

### 1. `bledom.ts` — Två char-sets
Istället för en enda `_chars`-set, håll en `Map<char, DeviceMode>`. I `sendToBLE`:
- **RGB-enheter**: Skicka färgpaketet (nuvarande beteende)
- **Brightness-enheter**: Skicka brightness-paketet (`0x7e 0x04 0x01 <bright> ...`) med vitt ljus

### 2. `bleStore.ts` — Mode i connection-objektet
`addBleConnection` tar emot mode. `BLEConnection` utökas med `mode`-fält.

### 3. UI (`Index.tsx`) — Toggle per enhet
Vid enhetsnamnet i headern, en liten ikon/toggle för att växla RGB ↔ Brightness. Sparas i localStorage per device-id. Default: RGB.

### 4. `lightEngine.ts` — Skicka mode vid addChar
`addChar(char, mode)` registrerar mode i bledom-lagret.

## Scope
- 4 filer: `bledom.ts`, `bleStore.ts`, `lightEngine.ts`, `Index.tsx`
- Barrel export i `index.ts` uppdateras med `DeviceMode`-typen

