#!/usr/bin/env bash
# Install the real CSS candidate side by side, with an isolated empty profile.
# Never replace the normal HandCash binary, launcher, or wallet data.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$HOME/Applications/handcash-alpha-$STAMP"
PROFILE="$HOME/.local/share/handcash-alpha-profile"
DESKTOP="$HOME/.local/share/applications/handcash-alpha.desktop"
if [[ -e "$DESKTOP" ]]; then
  echo "Refusing to overwrite existing candidate launcher: $DESKTOP" >&2
  exit 1
fi
BIN="$ROOT/native-desktop/target/debug/handcash-aeon"
[[ -x "$BIN" ]] || { echo "Build handcash-aeon first" >&2; exit 1; }
mkdir -m 700 "$DEST"
install -m 755 "$BIN" "$DEST/handcash-aeon"
mkdir -p "$PROFILE/config" "$PROFILE/data" "$PROFILE/state" "$(dirname "$DESKTOP")"
chmod 700 "$PROFILE" "$PROFILE/config" "$PROFILE/data" "$PROFILE/state"
cat > "$DEST/launch" <<'LAUNCH'
#!/usr/bin/env bash
set -euo pipefail
PROFILE="$HOME/.local/share/handcash-alpha-profile"
export XDG_CONFIG_HOME="$PROFILE/config"
export XDG_DATA_HOME="$PROFILE/data"
export XDG_STATE_HOME="$PROFILE/state"
export HANDCASH_USER_DATA="$PROFILE/data/HandCashDesktopNative"
exec "$(dirname "$0")/handcash-aeon" "$@"
LAUNCH
chmod 755 "$DEST/launch"
cat > "$DESKTOP" <<DESKTOP_ENTRY
[Desktop Entry]
Type=Application
Name=HandCash Alpha
Comment=Experimental HandCash Alpha; isolated profile, renderer parity not yet verified
Exec="$DEST/launch"
Icon=wallet
Terminal=false
Categories=Finance;
StartupNotify=true
DESKTOP_ENTRY
chmod 644 "$DESKTOP"
sha256sum "$BIN" "$DEST/handcash-aeon"
printf 'Installed: %s\nLauncher: %s\nProfile: %s\nNormal HandCash is unchanged.\n' "$DEST" "$DESKTOP" "$PROFILE"
