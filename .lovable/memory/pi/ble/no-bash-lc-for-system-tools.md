---
name: Använd inte bash -lc för system-CLI under systemd user-service
description: bash -lc startar login-shell med tom PATH under systemd user-service → hciconfig/rfkill etc hittas inte. Använd execSync direkt eller absoluta paths.
type: constraint
---
**Förbjudet:** `execFileSync('bash', ['-lc', 'hciconfig hci0 ...'], ...)` i Lotus engine-koden.

**Varför:** Systemd user-services körs med minimal env. När vi spawnar `bash -lc`:
1. bash startar som **login shell** → läser `/etc/profile`, `~/.bash_profile`
2. Under user-service är dessa ofta tomma eller saknar `/usr/bin` i PATH
3. `hciconfig` hittas inte → tom output eller "command not found"
4. Vår regex `/UP\s+RUNNING/` matchar inte → `isHci0Up()` returnerar `false`
5. Bug: UI heartbeat säger `hci0:UP` (använder `execSync` direkt) men connect-loggen säger `hci_up=false` (använde `bash -lc`)

**Bevis (2026-04-18):**
- `pi/src/ble/heartbeat.ts` använder `execSync('hciconfig hci0 2>&1', ...)` → fungerar
- `pi/src/ble/adapter.ts isHci0Up()` använde `execFileSync('bash', ['-lc', '...'])` → returnerade konstant `false` trots att adaptern var UP
- Connect failade på `hci_up=false` även när hci0 faktiskt var UP RUNNING

**Regel:**
1. Använd `execSync('cmd args 2>&1', { encoding: 'utf8', timeout })` direkt — det ärver Lotus-processens PATH (som har `/usr/bin`)
2. Om du måste ha shell-features (pipes, ||), använd `execSync('bash -c "..."')` UTAN `-l`
3. Eller använd absoluta paths: `execFileSync('/usr/bin/hciconfig', ['hci0'], ...)`

Build-tagg som etablerade fixen: `2026-04-18/ishci0up-no-bash-wrapper`.
