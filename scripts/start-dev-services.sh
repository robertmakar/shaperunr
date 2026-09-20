#!/bin/sh
# Xcode scheme pre-action (Debug LaunchAction only): orchestrates local dev
# service startup so a Debug run always has a reachable backend AND a
# reachable Metro before Xcode is allowed to launch the app.
#
# Flow: backend (:8787) -> Metro (:8081) -> ShapeRunr launches.
# Does nothing to Release/Archive builds (this pre-action is only wired
# into the Debug LaunchAction).
#
# CANONICAL COPY: this file is the version-controlled source of truth.
# The copy Xcode actually runs lives at ios/start-dev-services.sh, and ios/
# is a generated, gitignored directory (Expo Continuous Native Generation)
# — a clean `expo prebuild`/`expo prebuild --clean` wipes it, including this
# script, ios/ensure-metro-running.sh, and the scheme's pre-action XML. If
# that happens, re-copy this file and scripts/ensure-metro-running.sh to
# ios/ (chmod +x both), and re-add the "Ensure dev services are running"
# Run Script pre-action to the Debug LaunchAction in
# ios/ShapeRunr.xcodeproj/xcshareddata/xcschemes/ShapeRunr.xcscheme,
# invoking "$PROJECT_DIR/start-dev-services.sh" with build settings
# provided from the ShapeRunr target (EnvironmentBuildable), exactly as it
# is today.
set -e

PROJECT_ROOT="$PROJECT_DIR/.."
BACKEND_DIR="$PROJECT_ROOT/backend"
LOG_DIR="$PROJECT_DIR/.metro"
LOCK_DIR="$LOG_DIR/backend.lock.d"
LOG_FILE="$LOG_DIR/backend.log"
BACKEND_PORT=8787

mkdir -p "$LOG_DIR"

if [ -f "$PROJECT_ROOT/.xcode.env" ]; then
  . "$PROJECT_ROOT/.xcode.env"
fi
if [ -f "$PROJECT_ROOT/.xcode.env.local" ]; then
  . "$PROJECT_ROOT/.xcode.env.local"
fi

NODE_BINARY="${NODE_BINARY:-$(command -v node)}"
NPM_BINARY="$(dirname "$NODE_BINARY")/npm"

# The backend has no literal /status route. Its /health endpoint always
# answers — 200 once Valhalla is ready, 503 while it isn't — so any HTTP
# response (not specifically a 200) is what proves the dev server process
# itself is up and listening on $BACKEND_PORT.
is_backend_reachable() {
  code="$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://localhost:$BACKEND_PORT/health" 2>/dev/null)"
  [ -n "$code" ] && [ "$code" != "000" ]
}

start_backend_in_background() {
  echo "Backend not running on port $BACKEND_PORT; starting it in the background." | tee -a "$LOG_FILE"
  cd "$BACKEND_DIR"
  # shellcheck disable=SC2086
  nohup "$NODE_BINARY" "$NPM_BINARY" run dev \
    >> "$LOG_FILE" 2>&1 &
  disown || true
}

if is_backend_reachable; then
  echo "Backend already running on port $BACKEND_PORT." | tee -a "$LOG_FILE"
else
  # `mkdir` is an atomic test-and-set on every filesystem this runs on, so
  # it's what actually prevents two near-simultaneous launches (e.g. a fast
  # double-tap of Run) from each spawning their own `npm run dev` and
  # fighting over the port.
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo $$ >"$LOCK_DIR/pid"
    we_hold_lock=1
  else
    we_hold_lock=0
    # Stale lock from a starter that crashed/was killed mid-flight: reclaim
    # once so this run isn't stuck waiting on a process that no longer
    # exists.
    if [ -f "$LOCK_DIR/pid" ] && ! kill -0 "$(cat "$LOCK_DIR/pid" 2>/dev/null)" 2>/dev/null; then
      rm -rf "$LOCK_DIR"
      if mkdir "$LOCK_DIR" 2>/dev/null; then
        echo $$ >"$LOCK_DIR/pid"
        we_hold_lock=1
      fi
    fi
  fi

  if [ "$we_hold_lock" = 1 ]; then
    # Re-check now that the lock is held: another launch may have finished
    # starting the backend while we were racing for the lock.
    if is_backend_reachable; then
      echo "Backend already running on port $BACKEND_PORT." | tee -a "$LOG_FILE"
    else
      start_backend_in_background
    fi
  else
    echo "Another launch is already starting the backend; waiting on it." | tee -a "$LOG_FILE"
  fi

  ATTEMPTS=45
  i=0
  backend_up=0
  while [ "$i" -lt "$ATTEMPTS" ]; do
    if is_backend_reachable; then
      backend_up=1
      break
    fi
    i=$((i + 1))
    sleep 1
  done

  [ "$we_hold_lock" = 1 ] && rm -rf "$LOCK_DIR"

  if [ "$backend_up" != 1 ]; then
    echo "error: backend did not become reachable on port $BACKEND_PORT within ${ATTEMPTS}s. See $LOG_FILE" | tee -a "$LOG_FILE" >&2
    exit 1
  fi
  echo "Backend is up on port $BACKEND_PORT." | tee -a "$LOG_FILE"
fi

# Backend is confirmed reachable — hand off to the existing, unmodified
# Metro startup/wait logic. `exec` so this script's exit code is exactly
# ensure-metro-running.sh's, keeping the same hard-fail contract Xcode
# already relies on.
exec "$PROJECT_DIR/ensure-metro-running.sh"
