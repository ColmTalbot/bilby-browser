# Local-only shortcuts

Things that depend on one machine and would break the deployed site. Add to
this list whenever a new one is introduced.

Currently none. Everything the site serves is built or downloaded by the
scripts in `scripts/` (run together by `scripts/dev.sh` locally and by
`.github/workflows/pages.yml` for GitHub Pages):

| What | Source |
|---|---|
| `examples/`, `wheels/bilby-*.whl` | bilby commit pinned in `bilby-commit.txt` (`scripts/fetch-bilby.sh`) |
| `wheels/igwn_segments-*.whl` | igwn-segments sdist from PyPI (`scripts/build-igwn-segments.sh`) |
| `wheels/lalsuite-*.whl` | GitLab job artifact pinned with sha256 in `lalsuite-wheel.json` (`scripts/fetch-lalsuite.sh`) |

Optional local override: `LALSUITE_WHEELHOUSE=~/software/lalsuite/wheelhouse
scripts/dev.sh` serves a locally built LALSuite wheel instead of the pinned one.
