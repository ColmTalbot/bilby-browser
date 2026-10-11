#!/usr/bin/env bash
# Build a pure-Python igwn-segments wheel for Pyodide (gwpy needs it).
#
# igwn-segments only ships compiled wheels, and its __init__ imports the C
# module unconditionally. The sdist also contains a complete pure-Python
# implementation (_segments_py.py), so this repackages the sdist without the C
# extension and with an __init__ that falls back to it, as ligo-segments did.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${IGWN_SEGMENTS_VERSION:-2.1.1}"
WHEEL="wheels/igwn_segments-${VERSION}-py3-none-any.whl"
[[ -f "$WHEEL" ]] && { echo "$WHEEL already built"; exit 0; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
python3 -m pip download --quiet --no-deps --no-binary :all: \
  "igwn-segments==${VERSION}" -d "$WORK/sdist"
tar -xzf "$WORK"/sdist/igwn_segments-"${VERSION}".tar.gz -C "$WORK"
SRC="$WORK/igwn_segments-${VERSION}"

PKG="$WORK/pure/igwn_segments"
mkdir -p "$PKG"
cp "$SRC"/src/igwn_segments/{_segments_py.py,utils.py,_version.py} "$PKG/"
python3 - "$SRC/src/igwn_segments/__init__.py" "$PKG/__init__.py" <<'PY'
import sys
src, dst = sys.argv[1:]
text = open(src).read()
old = "from ._segments_c import NegInfinity, PosInfinity, infinity, segment, segmentlist\n"
assert old in text, "igwn_segments/__init__.py changed; update build-igwn-segments.sh"
new = (
    "try:\n"
    "    from ._segments_c import NegInfinity, PosInfinity, infinity, segment, segmentlist\n"
    "except ImportError:  # pure-Python build for Pyodide\n"
    "    from ._segments_py import NegInfinity, PosInfinity, infinity, segment, segmentlist\n"
)
notice = (
    "# Modified 2026-10-11 by bilby-browser (https://github.com/ColmTalbot/bilby-browser):\n"
    "# falls back to the pure-Python implementation in _segments_py when the C\n"
    "# extension is not available, and is packaged without the C extension for\n"
    "# Pyodide. Built by scripts/build-igwn-segments.sh from the unmodified\n"
    "# igwn-segments sdist on PyPI. Licensed, like the original, under the GNU\n"
    "# General Public License, version 3 or later (see LICENSE).\n"
)
open(dst, "w").write(notice + text.replace(old, new))
PY
grep -q "^NegInfinity\|^PosInfinity" "$PKG/_segments_py.py" \
  || { echo "_segments_py.py does not define NegInfinity/PosInfinity" >&2; exit 1; }

cat > "$WORK/pure/pyproject.toml" <<TOML
[build-system]
requires = ["setuptools>=61"]
build-backend = "setuptools.build_meta"

[project]
name = "igwn-segments"
version = "${VERSION}"
description = "Pure-Python build of igwn-segments for Pyodide (modified; see igwn_segments/__init__.py)"
readme = {text = """Modified build of igwn-segments ${VERSION} for Pyodide, made by
scripts/build-igwn-segments.sh in https://github.com/ColmTalbot/bilby-browser
on 2026-10-11: igwn_segments/__init__.py falls back to the pure-Python
implementation (_segments_py) and the C extension is not built. Original
source: https://pypi.org/project/igwn-segments/${VERSION}/ (GPL-3.0-or-later).
""", content-type = "text/plain"}
requires-python = ">=3.9"
license = {text = "GPL-3.0-or-later"}
authors = [{name = "Kipp Cannon"}, {name = "Tito Dal Canton"}, {name = "Duncan Macleod"}, {name = "Leo Singer"}]

[tool.setuptools]
packages = ["igwn_segments"]
TOML
cp "$SRC/LICENSE" "$WORK/pure/" 2>/dev/null || true
mkdir -p wheels
python3 -m pip wheel --quiet --no-deps --wheel-dir wheels "$WORK/pure"
echo "built $WHEEL"
