
## Plan: Flytta fix-sudo.sh till PCC och städa upp Lotus

### Steg 1: Prompt att klistra in i Pi Control Center

Kopiera följande text och skicka som meddelande i PCC-projektet:

---

**Skapa `public/pi-scripts/fix-sudo.sh` — OS-nivå sudo-health-reparation**

Lotus (och framöver Cast Away, Brew Monitor) förlitar sig på att PCC äger sudo-health på Pi:n. Skapa scriptet `public/pi-scripts/fix-sudo.sh` med följande innehåll, gör det körbart (`chmod +x`), och anropa det tidigt i `first-boot-setup.sh` (innan första `apt`-anropet) så att sudo garanterat fungerar.

Scriptet ska:
- Verifiera och reparera ägare/permissions för:
  - `/etc/sudo.conf` → `root:root` `644` (om filen finns)
  - `/usr/bin/sudo` → `root:root` `4755` (setuid)
  - `/etc/sudoers` → `root:root` `440`
  - `/etc/sudoers.d/` → `root:root` `750` (dir), `440` (filer)
- Försöka reparera som root direkt, eller via `pkexec` om vanlig användare
- Skriva manuell fallback (`su -c "..."`) om båda misslyckas
- Exit 0 om OK eller reparerat, exit 1 om kvarstående problem

Innehållet är förberett som artifact: `fix-sudo.sh` (se nedan).

Lotus har redan en thin wrapper i `pi/scripts/fix-sudo.sh` som letar efter scriptet på dessa sökvägar (i ordning):
1. `/opt/pi-dashboard/public/pi-scripts/fix-sudo.sh`
2. `/var/www/pi-dashboard/pi-scripts/fix-sudo.sh`
3. `/var/www/html/pi-scripts/fix-sudo.sh`

Bekräfta att PCC installerar `pi-scripts/` till en av dessa sökvägar — annars uppdatera Lotus-wrappern.

---

### Steg 2: Producera scriptet som nedladdningsbar artifact

Skapa `/mnt/documents/fix-sudo.sh` med exakt samma innehåll som ligger i `Pi Control Center:public/pi-scripts/fix-sudo.sh` idag, så du kan ladda ner och bifoga/klistra in i PCC-prompten.

### Steg 3: Städa Lotus

Efter att du bekräftat att filen finns i PCC:
- Ta bort `Pi Control Center:public/pi-scripts/fix-sudo.sh` från detta projekt (felplacerad — ligger i Lotus-repot under en mapp som heter "Pi Control Center", inte i det faktiska PCC-projektet).
- Behåll `pi/scripts/fix-sudo.sh` (thin wrapper) — den ska vara kvar enligt vald flyttstrategi.
- Behåll `.lovable/memory/pi/deployment/fix-sudo-ownership.md` — dokumenterar ägarskapet.

### Frågor

Innan jag kör steg 2+3, bekräfta:
1. Vill du att jag städar bort den felplacerade filen **direkt efter** att artifact är genererad, eller **väntar** tills du bekräftat att PCC-projektet har tagit emot den?
