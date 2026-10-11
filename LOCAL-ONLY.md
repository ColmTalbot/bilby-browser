# Local-only shortcuts

Things that currently depend on this machine and must be replaced before the
site is deployed anywhere. Add to this list whenever a new one is introduced.

| What | Where it is hardcoded | Replace with |
|---|---|---|
| LALSuite Pyodide wheel copied from `~/software/lalsuite/wheelhouse/` (override with `LALSUITE_WHEELHOUSE`) | `scripts/dev.sh` → `wheels/` (**committed for now**, 19 MB) | GitLab CI artifact of `colm.talbot/lalsuite` (`wheel:pyodide` job), pinned by sha256 |
| `examples/` and `examples/manifest.json` are generated when the dev server starts; `wheels/bilby-*.whl`, and `wheels/igwn_segments-*.whl` are generated too but **committed for now** (`wheels/index.json` is always generated) | `scripts/dev.sh`, `scripts/fetch-bilby.sh` | The same scripts run as a CI build step before deploy |

Not local-only, but runtime network dependencies to revisit for deployment:
Pyodide 0.29.5 and its packages come from jsDelivr, and dynesty, emcee,
corner, dill, nestle and bilby's own dependencies are resolved from PyPI by
micropip on every page load (slow, and unpinned for nestle and bilby's
dependencies). Serving pinned wheels from the site would fix both.
