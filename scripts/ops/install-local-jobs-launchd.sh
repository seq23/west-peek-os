#!/bin/bash
# INSTALL OR RELOAD THE LOCAL-JOB CLAIMER'S LAUNCHD JOB (22 Nov 2026, the Mac's day).
#
# The one way ventures.westpeek.os.local-jobs reaches ~/Library/LaunchAgents: writes $HOME into the
# repo's template (this repo is public, so the file carries __HOME__), checks it, and reloads it through
# ~/bin/launchd-reload, the Mac's one reloader. That never kills a running job: while the claimer is
# mid-job the reload is DEFERRED and `launchd-reload --pending` (tz-watch, hourly) applies it when the
# claimer is idle. Outside its window the claimer exits at once, so the reload lands within the hour.
#
#   npm run launchd:install:local-jobs
#
# Test overrides: LAUNCH_AGENTS_DIR, LAUNCHD_RELOAD, MAC_WINDOW_BIN, LAUNCHD_RELOAD_STATE, LAUNCHCTL.
set -euo pipefail
LABEL=ventures.westpeek.os.local-jobs
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$REPO/deployment/launchd/$LABEL.plist"
AGENTS="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
RELOAD="${LAUNCHD_RELOAD:-$HOME/bin/launchd-reload}"
GUARD="${MAC_WINDOW_BIN:-$HOME/bin/mac-window}"
STATE="${LAUNCHD_RELOAD_STATE:-$HOME/.local/state/launchd-reload}"
LCTL="${LAUNCHCTL:-launchctl}"
DEST="$AGENTS/$LABEL.plist"

[ -x "$GUARD" ] || { echo "NAMED STOP [MAC_WINDOW_MISSING] $GUARD is not here: the claimer would run unguarded, so nothing was installed"; exit 1; }
[ -x "$RELOAD" ] || { echo "NAMED STOP [LAUNCHD_RELOAD_MISSING] $RELOAD is not here; nothing was installed"; exit 1; }

TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
sed "s#__HOME__#$HOME#g" "$SRC" > "$TMP"
if grep -q "__HOME__" "$TMP" || ! plutil -lint "$TMP" >/dev/null 2>&1; then
  echo "NAMED STOP [PLIST_MALFORMED] $SRC did not render to a valid plist; nothing was installed"; exit 1
fi
grep -q "<string>$GUARD</string><string>run</string><string>LIGHT</string><string>$LABEL</string>" "$TMP" || {
  echo "NAMED STOP [UNGUARDED] the rendered plist does not run behind $GUARD run LIGHT $LABEL; nothing was installed"; exit 1; }

mkdir -p "$AGENTS"
if [ -f "$DEST" ] && cmp -s "$TMP" "$DEST"; then
  echo "OUTPUT install-local-jobs: $DEST already current"
  exit 0
fi
# launchd-reload rolls a failed load back to the last good file; its --seed keeps com.seq.* only, so keep ours.
if [ -f "$DEST" ] && [ ! -f "$STATE/good/$LABEL.plist" ] && "$LCTL" print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  mkdir -p "$STATE/good" && cp "$DEST" "$STATE/good/$LABEL.plist"
fi
cp "$TMP" "$DEST"
"$RELOAD" "$DEST"
echo "OUTPUT install-local-jobs: $DEST written (mac-window run LIGHT, 10:00 CT start); launchd-reload said the line above"
