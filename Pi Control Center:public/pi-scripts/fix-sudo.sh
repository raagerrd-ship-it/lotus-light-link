#!/bin/bash
# fix-sudo.sh — Verifierar och reparerar sudo-relaterade filers ägare och permissions.
#
# OS-nivå reparation (inte tjänst-specifikt). Ägs av Pi Control Center och
# används av alla tjänster (Lotus, Cast Away, Brew Monitor) som behöver sudo
# för apt/systemctl/reboot.
#
# Användning:
#   - Lokalt på Pi:n:  bash /opt/pi-dashboard/public/pi-scripts/fix-sudo.sh
#   - Via curl:        curl -sL <PCC>/pi-scripts/fix-sudo.sh | bash
#   - Från en tjänst:  bash $PCC_DIR/public/pi-scripts/fix-sudo.sh
#
# Försöker reparera som root direkt, eller via pkexec om vi är vanlig användare.
# Skriver tydlig manuell fallback (su -c ...) om båda misslyckas.
#
# Kontrollerar:
#   - /etc/sudo.conf      root:root 644 (om filen finns)
#   - /usr/bin/sudo       root:root 4755 (setuid)
#   - /etc/sudoers        root:root 440
#   - /etc/sudoers.d/     root:root 750 (dir), 440 (filer)
#
# Exit-koder:
#   0 = allt OK eller alla problem reparerade
#   1 = problem hittades men kunde inte repareras

set -u

SUDO_FIX_NEEDED=false

# ─── Helper: verifiera och reparera ägare/mode för en path ─────
fix_perms() {
  # $1 = path, $2 = expected owner, $3 = expected mode
  local path="$1" exp_owner="$2" exp_mode="$3"
  [ -e "$path" ] || return 0
  local owner mode
  owner=$(stat -c '%U:%G' "$path" 2>/dev/null || echo "?")
  mode=$(stat -c '%a' "$path" 2>/dev/null || echo "?")
  if [ "$owner" = "$exp_owner" ] && [ "$mode" = "$exp_mode" ]; then
    echo "  ✓ $path OK ($exp_owner, $exp_mode)"
    return 0
  fi
  echo "  ⚠ $path har fel ägare/mode: $owner ($mode) — försöker reparera (förväntat: $exp_owner $exp_mode)"
  SUDO_FIX_NEEDED=true
  if [ "$(id -u)" = "0" ]; then
    chown "$exp_owner" "$path" && chmod "$exp_mode" "$path" && echo "  ✓ Fixade $path som root"
  elif command -v pkexec >/dev/null 2>&1; then
    pkexec sh -c "chown '$exp_owner' '$path' && chmod '$exp_mode' '$path'" \
      && echo "  ✓ Fixade $path via pkexec" \
      || echo "  ✗ pkexec misslyckades — kör manuellt: su -c \"chown $exp_owner $path && chmod $exp_mode $path\""
  else
    echo "  ✗ Kan inte reparera (kör inte som root och saknar pkexec)"
    echo "    Kör manuellt: su -c \"chown $exp_owner $path && chmod $exp_mode $path\""
  fi
  local new_owner new_mode
  new_owner=$(stat -c '%U:%G' "$path" 2>/dev/null || echo "?")
  new_mode=$(stat -c '%a' "$path" 2>/dev/null || echo "?")
  if [ "$new_owner" = "$exp_owner" ] && [ "$new_mode" = "$exp_mode" ]; then
    echo "  ✓ $path nu korrekt ($exp_owner, $exp_mode)"
    SUDO_FIX_NEEDED=false
  fi
}

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Sudo pre-flight check (Pi Control Center)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# /etc/sudo.conf — måste vara root:root 644 (om filen existerar)
if [ -f /etc/sudo.conf ]; then
  fix_perms /etc/sudo.conf root:root 644
else
  echo "  ℹ /etc/sudo.conf saknas — sudo använder kompilerade defaults (OK)"
fi

# /usr/bin/sudo — måste vara root:root 4755 (setuid)
SUDO_BIN=$(command -v sudo 2>/dev/null || echo /usr/bin/sudo)
if [ -f "$SUDO_BIN" ]; then
  fix_perms "$SUDO_BIN" root:root 4755
else
  echo "  ⚠ sudo-binären hittas inte ($SUDO_BIN) — installera med: apt install sudo"
fi

# /etc/sudoers — måste vara root:root 440
if [ -f /etc/sudoers ]; then
  fix_perms /etc/sudoers root:root 440
else
  echo "  ⚠ /etc/sudoers saknas — sudo kommer inte fungera"
fi

# /etc/sudoers.d/ — katalog 750, filer 440
if [ -d /etc/sudoers.d ]; then
  fix_perms /etc/sudoers.d root:root 750
  for f in /etc/sudoers.d/*; do
    [ -e "$f" ] || continue
    fix_perms "$f" root:root 440
  done
else
  echo "  ℹ /etc/sudoers.d/ saknas — endast /etc/sudoers används (OK)"
fi

# Snabbtest: går sudo att köra alls?
echo ""
if sudo -n true 2>/dev/null || sudo -v 2>/dev/null; then
  echo "  ✓ sudo fungerar"
  exit 0
elif [ "$SUDO_FIX_NEEDED" = true ]; then
  echo "  ⚠ sudo verkar fortfarande trasigt efter reparationsförsök"
  exit 1
else
  # Sudo kan vägra av andra skäl (lösenord krävs, ingen TTY, etc.) — inte vårt problem
  echo "  ℹ sudo fil-permissions OK (lösenordskrav/TTY kan blockera annars)"
  exit 0
fi
