

## Problem

UI:t visar RGB `251,93,52` (orange) skickas till lampan vid 87 % brightness — men du ser vit. Det är inte att färgen blir vit i koden. Det är att vi just nu skalar färgen helt linjärt med brightness, vilket gör att alla tre LED-kanalerna i BLEDOM-strippen lyser samtidigt (R=251, G=93, B=52 → vid 87 % blir det ~196/73/41 PWM på R/G/B). Ögat blandar det till blekt vit/rosa eftersom blå- och grön-LEDarna fortfarande är på ~20–35 % duty.

Vi gjorde "punch-white" mjukare i förra steget — det gjorde inget eftersom den effekten bara aktiveras de sista procenten. Det riktiga problemet är hela mappningen.

## Vad jag föreslår

Två oberoende ändringar. Den första är hela poängen, den andra ger finkontroll.

### 1. Saturation-bevarande utgång (vit-rensning)

Innan brightness-skalningen drar vi bort den minsta kanalen från alla tre. Det är samma sak som att räkna ut "vit-andelen" och nolla den.

```text
m = min(R, G, B)
R' = R - m
G' = G - m
B' = B - m
```

För `(251, 93, 52)` → `m = 52` → `(199, 41, 0)`. Hue bevaras exakt; mättnaden går till 100 %; total ljusstyrka kompenseras av att vi skalar upp resultatet så att max-kanalen behåller sitt värde:

```text
boost = max(R, G, B) / max(R', G', B')   // = 251/199 ≈ 1.26
R'' = R' * boost  →  (251, 52, 0)
```

Resultat: ren mättad orange istället för "orange-vit". Vid alla brightness-nivåer.

Detta görs i `applyColorCalibrationFast` (eller i ett nytt steg precis efter), så hela pipen påverkas — både idle, active och keep-alive.

### 2. Saturation-slider per profil (default = 1.0 = full vit-rensning)

Ny calibration-parameter `saturation` (0.0 – 1.0):

- `0.0` = ingen vit-rensning (gammalt beteende, "blekt/vitnande")
- `1.0` = full vit-rensning enligt formeln ovan (default i Lugn/Normal/Party)

Implementation: blenda mellan input-RGB och vit-rensad RGB med `saturation` som mix-faktor. Användaren kan dra ner i Custom om hen vill ha den gamla pastell-känslan.

### 3. Defaults

| Profil | saturation |
|---|---|
| Lugn | 1.0 |
| Normal | 1.0 |
| Party | 1.0 |
| Custom | 1.0 |

(Alla på 1.0 — den gamla bleka mappningen var en bugg, inte en designval. Custom låter användaren backa.)

## Filer som ändras

- `pi/src/piEngine.ts`
  - Lägg till `saturation: number` i `LightCalibration`-typen + `DEFAULT_CAL` (= 1.0).
  - Modifiera `applyColorCalibrationFast` (rad 173–185) så den först kör vit-rensning enligt saturation-faktorn, sen lägger på offset/gamma som idag.
- `pi/src/configServer.ts`
  - Lägg till `saturation: 1.0` i alla DEFAULT_PROFILES + i schema/migration så befintliga profiler får default.
- `src/pages/PiMobile.tsx`
  - Lägg `saturation: 1.0` i PRESET_CALS.
  - Ny slider i Custom-vyn ("Färgmättnad" 0–100 %).
- `.lovable/memory/technical/lighting/saturation-mapping.md` (ny) — dokumentera vit-rensningen.
- `.lovable/memory/index.md` — ny one-liner.

## Vad jag medvetet INTE rör

- Punch-white (lämnas som den blev förra ändringen — graderad, default av).
- Brightness-gamma och dimming-LUT — fungerar korrekt; vit-rensningen sker innan.
- BLE-protokollet och paketformatet.
- Hue-väljaren.

## Förväntat resultat

Vid orange `(251, 93, 52)` skickas istället `(251, 52, 0)` till BLEDOM efter brightness-skalning. Blå-LED är helt av, grön kraftigt nerdragen → ögat ser mättad orange även vid 90 %+ brightness. När musiken är tyst (låg brightness) ser den fortfarande orange ut, bara svagare.

