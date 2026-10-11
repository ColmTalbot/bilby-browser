#!/usr/bin/env bash
# Local development server: builds/fetches everything the site needs, then
# serves it on http://localhost:8000 (PORT to change).
set -euo pipefail
cd "$(dirname "$0")/.."

scripts/fetch-bilby.sh
scripts/build-igwn-segments.sh
scripts/fetch-lalsuite.sh   # set LALSUITE_WHEELHOUSE to use a local build
python3 scripts/fetch-pypi-wheels.py
[[ -d node_modules ]] || npm ci --silent
npm run -s build:editor
python3 scripts/write_wheel_index.py
python3 scripts/make_manifest.py
python3 scripts/write_licenses.py
echo "serving on http://localhost:${PORT:-8000}"
exec python3 -m http.server "${PORT:-8000}" --bind 127.0.0.1
