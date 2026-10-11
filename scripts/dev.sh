#!/usr/bin/env bash
# Local development server. See LOCAL-ONLY.md for the hardcoded paths.
set -euo pipefail
cd "$(dirname "$0")/.."

scripts/fetch-bilby.sh
scripts/build-igwn-segments.sh

LALSUITE_WHEELHOUSE="${LALSUITE_WHEELHOUSE:-$HOME/software/lalsuite/wheelhouse}"
mkdir -p wheels
cp -p "$LALSUITE_WHEELHOUSE"/lalsuite-*pyodide*.whl wheels/
python3 - <<'PY'
import json, pathlib
def newest(pattern):
    found = sorted(p.name for p in pathlib.Path("wheels").glob(pattern))
    return found[-1] if found else None
index = {
    "bilby": newest("bilby-*.whl"),
    "lalsuite": newest("lalsuite-*.whl"),
    "igwn_segments": newest("igwn_segments-*.whl"),
}
pathlib.Path("wheels/index.json").write_text(json.dumps(index) + "\n")
PY
python3 scripts/make_manifest.py
echo "serving on http://localhost:${PORT:-8000}"
exec python3 -m http.server "${PORT:-8000}" --bind 127.0.0.1
