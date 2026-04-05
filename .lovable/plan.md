

## Uppdatera planen med fasad installation

Ändra rubrikerna och lägg till en kort notis om att Pi #1 installeras först, Pi #2 veckor senare. Ingen BLE-konflikt finns eftersom RAPT Pill-scanning bara körs på Pi #2.

### Ändring i `.lovable/plan.md`

**Rad 192–203** — uppdatera rubrikerna:

```text
### Fas 1: Pi #1 (när hårdvaran anländer)
1. `pi/` headless runtime i Lotus Light Link
2. `setup-lotus.sh` — install-script
3. systemd-tjänster

### Fas 2: Pi #2 (veckor efter Pi #1)
1. Lokal tjänst: SPI-läsning (MAX31865) + GPIO-styrning (HW-281)
2. Migrera kylstyrningslogik från RAPT API → lokal GPIO
3. BLE-scanner för RAPT Pill
4. Chromium kiosk-läge för 7" skärm
5. `setup-brew.sh` — install-script
6. systemd-tjänster
```

Pi #1 har ingen RAPT Pill-scanning, så den är helt självständig — ingen koppling till Pi #2 krävs.

