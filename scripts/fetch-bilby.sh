#!/usr/bin/env bash
# Get bilby's examples and a bilby wheel from one pinned commit of
# github.com/bilby-dev/bilby (the hash in bilby-commit.txt).
#
#   scripts/fetch-bilby.sh            # use the pinned commit
#   scripts/fetch-bilby.sh --update   # pin the current head of main first
#
# Writes examples/ (without notebooks, adapted to Pyodide by
# scripts/adapt_examples.py) and wheels/bilby-*.whl. A blobless
# clone is kept in .cache/bilby so that setuptools_scm can compute a real
# version (e.g. 2.8.3.devN+g<hash>) from the tags.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="${BILBY_REPO:-https://github.com/bilby-dev/bilby.git}"
CLONE=.cache/bilby

if [[ "${1:-}" == "--update" ]]; then
  git ls-remote "$REPO" refs/heads/main | cut -f1 > bilby-commit.txt
  echo "pinned bilby main at $(cat bilby-commit.txt)"
fi
COMMIT="$(tr -d '[:space:]' < bilby-commit.txt)"

if [[ ! -d "$CLONE/.git" ]]; then
  git clone --quiet --filter=blob:none --no-checkout "$REPO" "$CLONE"
fi
git -C "$CLONE" cat-file -e "$COMMIT^{commit}" 2>/dev/null \
  || git -C "$CLONE" fetch --quiet --tags origin

# Examples are re-extracted every time (cheap), so changes to
# adapt_examples.py always apply to a pristine copy.
rm -rf examples
git -C "$CLONE" archive --format=tar "$COMMIT" examples | tar -x --exclude='*.ipynb' -f -
find examples -type d -empty -delete
# the examples are bilby's (MIT); keep its licence next to them
git -C "$CLONE" show "$COMMIT:LICENSE.md" > examples/LICENSE.md
echo "$COMMIT" > examples/.commit
python3 scripts/adapt_examples.py

if ls wheels/bilby-*+g"${COMMIT:0:8}"*.whl >/dev/null 2>&1; then
  echo "bilby wheel already built for ${COMMIT:0:8}"
  exit 0
fi
git -C "$CLONE" checkout --quiet --force --detach "$COMMIT"
mkdir -p wheels
rm -f wheels/bilby-*.whl
python3 -m pip wheel --quiet --no-deps --wheel-dir wheels "$CLONE"
echo "bilby $(git -C "$CLONE" describe --tags --always) -> $(ls wheels/bilby-*.whl)"
