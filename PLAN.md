# bilby-site: plan

A static GitHub Pages site where users pick a bilby example, edit it, and
run it in their browser with Pyodide. Read with `NOTES.md`.

## What I checked (2026-10-11)

| Package | Source in the browser | Notes |
|---|---|---|
| numpy 2.2.5, scipy 1.14.1, matplotlib 3.8.4, pandas 2.3.3, h5py 3.13.0, astropy 7.0.1, tqdm, attrs, requests | Pyodide 0.29 distribution (`loadPackage`) | |
| **bilby-cython 0.5.3** | Pyodide 0.29 distribution | Optional on bilby `main`, but kept for speed. No need to build it ourselves |
| bilby | wheel built from the commit pinned in `bilby-commit.txt` (`scripts/fetch-bilby.sh`) | examples come from the same commit; `main` adds plum-dispatch and array-api-compat (pure wheels) |
| dynesty 3.1.0, emcee 3.1.6, corner 2.3.0, dill 0.4.1, nestle | pure wheels on PyPI (`micropip`) | |
| lalsuite 7.26.16.1 | `~/software/lalsuite/wheelhouse` for now, GitLab artifact later | ABI `pyodide_2025_0`, so the site must use Pyodide 0.29.x |
| gwosc 0.8.3 | pure wheel on PyPI | |
| gwpy 4.0.2 | pure wheel, but needs igwn-segments | |
| **igwn-segments 2.1.1** | **not pure**: `__init__` imports the C module `_segments_c`, with no fallback | Only gwpy needs it |

bilby imports gwpy only inside functions, so `import bilby.gw` should work
without it. **Plan: leave out gwpy at first.** Load real data by fetching
GWOSC HDF5 files and reading them with h5py, then pass the arrays to bilby
(`set_strain_data_from_frequency_domain_strain` or similar). If we need gwpy
later, build igwn-segments with `pyodide build` in CI, as NOTES.md describes.

Risks to check first:
- `bilby/core/utils/counter.py` calls `multiprocessing.RawValue` and
  `multiprocessing.Lock` when a `Counter` is created. Pyodide may not
  support these. If it doesn't, patch them with a small shim before
  importing bilby.
- `bilby.gw.conversion` and `core.result` import `multiprocessing`. The
  import is fine in Pyodide; only creating a `Pool` fails, so keep
  `npool=1`.
- Run time: everything runs on one thread, so every example needs much
  smaller settings than the bilby defaults (fewer live points, shorter
  durations, relative binning or ROQ for GW).

## Architecture

```
bilby-site/
  index.html             # UI: example list, editor, output, figures
  app.js                 # UI logic, talks to the worker
  worker.js              # loads Pyodide, installs packages, runs code
  py/bootstrap.py        # setup inside Pyodide: shims, show(), fetch helpers
  examples/
    manifest.json        # id, title, description, needs_lal, rough run time
    core/*.py            # adapted bilby examples
    gw/*.py
  wheels/                # lalsuite wheel (gitignored, fetched in CI)
  requirements.lock.json # pinned versions + sha256 for micropip installs
  scripts/
    fetch-wheels.sh      # gets lalsuite (local path or GitLab), checks sha256
    test-examples.mjs    # runs every example in Node with the pyodide npm package
  .github/workflows/
    deploy.yml           # fetch wheels, test, deploy to Pages
```

Design choices:
- **Pyodide runs in a Web Worker** from the start, so the page stays
  responsive. The worker streams stdout and stderr, progress, and figures
  (matplotlib Agg rendered to PNG, sent as base64) to the page.
- **Stop button: `worker.terminate()`, then start a new worker.**
  Interrupting Python cleanly needs `SharedArrayBuffer`, which needs
  COOP/COEP headers, and GitHub Pages can't set those. Restarting is fast
  because the browser caches the packages.
- **Load packages only when needed.** bilby core loads at startup.
  lalsuite (about 19 MB) loads the first time a GW example runs.
- **Pin versions.** Pyodide comes from jsDelivr at a fixed 0.29.x version.
  PyPI wheels are pinned in `requirements.lock.json`, and CI may copy them
  into `wheels/` so the site doesn't depend on PyPI CORS at run time.
- **Editor:** a plain `<textarea>` first, then CodeMirror 6 from a CDN.
- Pyodide runs on one thread, so the UI shows the expected run time for
  each example.

## Milestones

1. **Scaffold.** `git init`, the layout above, a worker that loads Pyodide
   0.29.x, and a local dev server (`python -m http.server` or
   `serve.py` from the LALSuite branch).
2. **Install bilby, no LAL.** `loadPackage` the distribution packages
   (including `bilby-cython`), then `micropip.install` bilby and its pure
   dependencies. Write down every failure (start with `Counter`) and fix it
   with shims in `bootstrap.py`. Do the same in Node so the check can be
   scripted.
3. **Core examples.** Linear regression (dynesty), Gaussian (emcee), and
   one or two more, with small settings. Corner plot and trace output.
4. **Add LALSuite.** Lazy-install the local wheel with `deps=False`. Run a
   GW injection with IMRPhenomXPHM and zero noise, plus a reduced
   `fast_tutorial`.
5. **Real data without gwpy.** Load a short GW150914 segment from GWOSC
   with `pyfetch` and h5py, and cache it (Cache API or IndexedDB). The
   files are about 130 MB, so consider serving a cropped copy from the
   site.
6. **CI and deploy.** GitHub Actions fetches and checks the lalsuite wheel
   (a GitHub release asset at first, the GitLab artifact later), runs
   `test-examples.mjs` in Node, then deploys to Pages. Add a smoke test of
   the real page with Playwright.
7. **Polish.** CodeMirror, a progress bar fed by dynesty's `print_func` or
   tqdm, saving results as downloads, and a "copy as script" button.

## Decisions for you

1. ~~bilby version~~: decided, a pinned commit of `main` (examples and wheel from the same commit).
2. **Where the lalsuite wheel lives until GitLab is ready:** commit it
   (19 MB is allowed), upload it as a GitHub release asset (my
   recommendation), or keep it local only, with CI skipping the GW
   examples.
3. **Examples:** which bilby examples matter most? My suggested first set:
   linear regression, Gaussian, `fast_tutorial`, and a GW150914 run with
   relative binning.
4. **gwpy:** is it OK to leave it out at first, as above?
