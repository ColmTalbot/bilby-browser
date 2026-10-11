#!/usr/bin/env bash
# Download the LALSuite Pyodide wheel pinned in lalsuite-wheel.json into
# wheels/ and check its sha256.
#
# The wheel is built by the wheel:pyodide CI job of colm.talbot/lalsuite.
# GitLab job artifacts can expire; if the download fails, pin a newer job.
# To test a local build instead, set LALSUITE_WHEELHOUSE to its directory.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p wheels

if [[ -n "${LALSUITE_WHEELHOUSE:-}" ]]; then
  rm -f wheels/lalsuite-*.whl
  cp -p "$LALSUITE_WHEELHOUSE"/lalsuite-*pyodide*.whl wheels/
  echo "using local LALSuite wheel(s) from $LALSUITE_WHEELHOUSE (not the pinned one)"
  exit 0
fi

read -r URL SHA256 < <(python3 -c '
import json; d = json.load(open("lalsuite-wheel.json")); print(d["url"], d["sha256"])')
WHEEL="wheels/${URL##*/}"

check() { echo "$SHA256  $1" | shasum -a 256 -c --status; }

if [[ -f "$WHEEL" ]] && check "$WHEEL"; then
  echo "$WHEEL already present"
  exit 0
fi
rm -f wheels/lalsuite-*.whl
curl -fsSL -o "$WHEEL.part" "$URL"
if ! check "$WHEEL.part"; then
  echo "sha256 mismatch for $URL" >&2
  rm -f "$WHEEL.part"
  exit 1
fi
mv "$WHEEL.part" "$WHEEL"
echo "downloaded $WHEEL"
