---
name: Heap-tak 96MB + swappiness 10 (watchdog-frysningar)
description: Engine-heap måste vara 96MB (inte 224) på Pi Zero 2W med 416MB RAM. Högt heap-tak → RSS växer 60→110MB → swap-in-storm vid full GC → 8s event-loop-frys → watchdog-restart. Kräver även vm.swappiness=10.
type: constraint
---
**Symptom:** `watchdog-stuck`-restarter vid uptime 3 min–16 h, alltid vid RSS ~100–114 MB, alltid tillbaka till ~60 MB efter omstart. Ingen BLE/mic-flapp i subsystem-transitions. Ingen CPU-brist (motorn har egen ledig kärna) — fler kärnor hjälper INTE.

**Orsak:** `--max-old-space-size=224` på en Pi med 416 MB RAM → V8 skjuter upp full GC → RSS växer → systemet swappar → full GC måste röra alla sidor → swap-in-storm → tick fryser 8 s → watchdog.

**Ingen äkta läcka i koden:** hot path (analyser/alsaMic/piEngine) är förallokerad, restartLog (MAX_ENTRIES=50) och subsystem-transitions är trimmade. Växten är V8-heap-lathet + JSON-churn från UI-pollning.

**Fix (i repo, överlever update):**
- `pi/setup-lotus.sh` + `pi/services.json`: `--max-old-space-size=96 --max-semi-space-size=4`
- `/etc/sysctl.d/90-lotus-swappiness.conf`: `vm.swappiness=10` (skrivs av setup-lotus.sh)
- MemoryMax/MemoryHigh (320M/240M) rörs inte — de gäller RSS, inte heap.

Om OOM uppstår med 96: bumpa till 112–128, aldrig tillbaka till 224.
