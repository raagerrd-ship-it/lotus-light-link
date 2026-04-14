

## Plan: Rensa duplicerad BLE-rättighetshantering från Lotus Light

### Bakgrund

Pi Control Center (PCC) ger redan `CAP_NET_RAW` + `CAP_NET_ADMIN` via systemd `AmbientCapabilities` till alla `node`-engine-komponenter. Det gäller Lotus Light sedan `managed: false` togs bort. De BLE-rättighetssteg som finns i Lotus Light's skript (bluetooth-grupp, polkit-regel) är alltså **dubbletter** som kan orsaka förvirring.

### Ändringar

#### 1. `pi/setup-lotus.sh` — Ta bort steg 6 (BLE-rättigheter)
- Ta bort hela bluetooth-grupp + polkit-sektionen (rad ~105-135)
- Dessa hanteras av PCC vid service-generering
- Behåll `rfkill unblock bluetooth` (rad ~98) — det är en HW-sak, inte rättigheter

#### 2. `pi/update-services.sh` — Ta bort BLE-rättighetssteg
- Ta bort bluetooth-grupp-check och polkit-installation (~rad 85-100)
- PCC hanterar capabilities vid tjänstestart

#### 3. `pi/uninstall-lotus.sh` — Ta bort BLE-rensning
- Ta bort steg 2 (polkit-regel + bluetooth-grupp, rad ~25-40)
- PCC rensar sina egna systemd-tjänster vid avinstallation

#### 4. `pi/src/nobleBle.ts` — Förbättra diagnostik (refaktorering)
- Logga tydligare vid `unauthorized` adapter-state: `"BLE unauthorized — kontrollera att PCC-tjänsten har AmbientCapabilities"`
- Logga adapter-state vid uppstart för snabbare felsökning

### Resultat
- Lotus Light förlitar sig helt på PCC för rättigheter — samma modell som Sonos Gateway
- Enklare skript, ingen duplicering
- Bättre felmeddelanden vid BLE-problem

