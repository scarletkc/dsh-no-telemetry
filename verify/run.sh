#!/bin/sh
# Runs verify.mjs with the Electron runtime bundled in DeepSeek Harness (macOS).
# Usage: sh verify/run.sh
set -e
RESOURCES="${DSH_APP_RESOURCES:-/Applications/DeepSeek Harness.app/Contents/Resources}"
EXE="$RESOURCES/../MacOS/DeepSeek Harness"
if [ ! -x "$EXE" ]; then
  echo "DeepSeek Harness not found at $EXE; set DSH_APP_RESOURCES" >&2
  exit 1
fi
ELECTRON_RUN_AS_NODE=1 exec "$EXE" "$(dirname "$0")/verify.mjs"
