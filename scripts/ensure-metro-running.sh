#!/bin/sh
# Xcode scheme pre-action (Debug LaunchAction only): makes sure Metro is up
# on $RCT_METRO_PORT *before* Xcode is allowed to launch the app, so Debug
# builds never hit "No script URL provided". Does nothing to Release/Archive
# builds (this pre-action is only wired into the Debug LaunchAction).
#
# This is called by ios/start-dev-services.sh (the Debug pre-action Xcode
# actually invokes) after it confirms the local backend is reachable on
# :8787, so this script only needs to worry about Metro on :8081.
#
# CANONICAL COPY: this file is the version-controlled source of truth.
# The copy Xcode actually runs lives at ios/ensure-metro-running.sh, and
# ios/ is a generated, gitignored directory (Expo Continuous Native
# Generation) — a clean `expo prebuild`/`expo prebuild --clean` wipes it,
# including this script, ios/start-dev-services.sh, and the scheme's
# pre-action XML. If that happens, re-copy this file and
# scripts/start-dev-services.sh to ios/ (chmod +x both), and re-add the
# "Ensure dev services are running" Run Script pre-action to the Debug
# LaunchAction in ios/ShapeRunr.xcodeproj/xcshareddata/xcschemes/ShapeRunr.xcscheme,
# invoking "$PROJECT_DIR/start-dev-services.sh" with build settings
# provided from the ShapeRunr target (EnvironmentBuildable), exactly as it
# is today. Consider a custom Expo config plugin if this needs to survive
# prebuild automatically.
set -e

PROJECT_ROOT="$PROJECT_DIR/.."
LOG_DIR="$PROJECT_DIR/.metro"
LOCK_DIR="$LOG_DIR/metro.lock.d"
LOG_FILE="$LOG_DIR/metro.log"

mkdir -p "$LOG_DIR"

if [ -f "$PROJECT_ROOT/.xcode.env" ]; then
  . "$PROJECT_ROOT/.xcode.env"
fi
if [ -f "$PROJECT_ROOT/.xcode.env.local" ]; then
  . "$PROJECT_ROOT/.xcode.env.local"
fi

NODE_BINARY="${NODE_BINARY:-$(command -v node)}"
NPX_BINARY="$(dirname "$NODE_BINARY")/npx"
PORT="${RCT_METRO_PORT:-8081}"

is_running() {
  [ "$(curl -s -m 2 "http://localhost:$PORT/status" 2>/dev/null)" = "packager-status:running" ]
}

start_metro_in_background() {
  echo "Metro not running on port $PORT; starting it in the background." | tee -a "$LOG_FILE"
  cd "$PROJECT_ROOT"
  # shellcheck disable=SC2086
  nohup "$NODE_BINARY" "$NPX_BINARY" expo start --port "$PORT" \
    >> "$LOG_FILE" 2>&1 &
  disown || true
}

# `mkdir` is an atomic test-and-set on every filesystem this runs on, so
# it's what actually prevents two near-simultaneous launches (e.g. a fast
# double-tap of Run) from each spawning their own `expo start` and fighting
# over the port — a plain "check a file, then write it" has a race window
# a single mkdir doesn't.
if mkdir "$LOCK_DIR" 2>/dev/null; then
  echo $$ >"$LOCK_DIR/pid"
  we_hold_lock=1
else
  we_hold_lock=0
  # Stale lock from a starter that crashed/was killed mid-flight: reclaim
  # once so this run isn't stuck waiting on a process that no longer exists.
  if [ -f "$LOCK_DIR/pid" ] && ! kill -0 "$(cat "$LOCK_DIR/pid" 2>/dev/null)" 2>/dev/null; then
    rm -rf "$LOCK_DIR"
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      echo $$ >"$LOCK_DIR/pid"
      we_hold_lock=1
    fi
  fi
fi

if is_running; then
  echo "Metro already running on port $PORT." | tee -a "$LOG_FILE"
  [ "$we_hold_lock" = 1 ] && rm -rf "$LOCK_DIR"
  exit 0
fi

if [ "$we_hold_lock" = 1 ]; then
  start_metro_in_background
else
  echo "Another launch is already starting Metro; waiting on it." | tee -a "$LOG_FILE"
fi

# Wait until Metro is genuinely reachable — this is the gate. Unlike a
# soft "warn and continue", timing out here is a hard failure: continuing
# to launch the app without a reachable Metro is exactly how a Debug run
# used to silently end up at "No script URL provided" instead of a clear,
# actionable error in Xcode's build log.
ATTEMPTS=45
i=0
while [ "$i" -lt "$ATTEMPTS" ]; do
  if is_running; then
    echo "Metro is up on port $PORT." | tee -a "$LOG_FILE"
    [ "$we_hold_lock" = 1 ] && rm -rf "$LOCK_DIR"
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

[ "$we_hold_lock" = 1 ] && rm -rf "$LOCK_DIR"
echo "error: Metro did not become reachable on port $PORT within ${ATTEMPTS}s. See $LOG_FILE" | tee -a "$LOG_FILE" >&2
exit 1
