# bilby-browser: plan

A static GitHub Pages site (https://colmtalbot.github.io/bilby-browser/)
where users pick a bilby example, edit it, and run it in their browser with
Pyodide. Background on the LALSuite Pyodide build is in `NOTES.md`.

## How it works now

- **Page** (`index.html`, `app.js`):
  - Example tree that mirrors bilby's `examples/`, with a search box; it can be
    hidden, and on phones (below 700px) it is a drawer.
  - Each example's docstring is shown above the editor as formatted text
    (converted from reStructuredText by `scripts/make_manifest.py`) and left
    out of the editor.
  - CodeMirror 6 editor (`editor/editor.js`, bundled into `editor.bundle.js`
    by `npm run build:editor`): Python highlighting, Ctrl/⌘+Enter to run,
    undoable Reset, the line a traceback points at highlighted. New opens a
    blank editor (`#scratch`, kept per browser); Download saves the script.
  - Output: each run is a collapsible block; progress bars rewrite in place,
    and tqdm lines are drawn as bars like tqdm's Jupyter one (filled when
    tqdm knows the total); figures enlarge on click and download; Copy copies
    the text; Results downloads a zip of every file the run wrote.
  - Stop terminates the worker and starts a new one.
  - Header: toggles for the sidebar, editor and output (never both panes
    hidden; remembered per browser), bilby-dev logo, status, test-mode switch
    (amber page while on), bilby log level menu, links, and an
    auto/light/dark theme button. Test mode is on by default when served
    locally and off on the live site; the log level is ERROR by default.
    Both choices are remembered per browser.
  - Start-up and installs show a download progress bar along the header and
    the amount in the status text, from the file sizes in `wheels/sizes.json`
    (`scripts/write_sizes.py`). It updates in bursts: while Pyodide sets up a
    large package the worker cannot report.
  - Drag the gap between editor and output to resize them.
- **Worker** (`worker.js`, `py/bootstrap.py`): Pyodide 0.29.5 from jsDelivr.
  Installs bilby at startup, LALSuite on the first GW example, and extras
  (gwpy, gwosc, gwinc, scikit-image) when an example needs them.
  `command_line_args.clean` is always on, so reruns never resume from a
  checkpoint; `bilby_test_mode` follows the switch; bilby's logger is set
  up at the menu's level before each run (overriding the level examples
  pass to `setup_logger`). Pyodide cannot start threads, so tqdm's monitor
  thread is off and gwpy's thread pool runs tasks in place.
- **Real data**: GWOSC strain is read with HTTP range requests
  (`py/gwosc_range.py`, design in `DATA-PLAN.md`), downloading only the
  requested span, in parallel where the browser supports JSPI, and cached
  for the session. Other downloads use synchronous XHR.
- **32-bit WebAssembly**: floats are 64-bit, but sizes and numpy's default
  integer are 32-bit (details in `NOTES.md`). scipy's spectral helper
  `_fft_helper` is replaced so PSDs do not hit numpy's 2 GB view limit.
- **bilby and examples** come from one pinned commit of bilby-dev/bilby
  `main` (`bilby-commit.txt`; `scripts/fetch-bilby.sh --update` moves it).
  `scripts/adapt_examples.py` edits them for Pyodide (pymultinest → nestle,
  cpnest → dynesty, `npool=` lines removed) and flags unsupported ones; the
  page shows both. Neither examples nor wheels are stored in git.
- **Wheels** are built or fetched by scripts: bilby from the pinned commit,
  a pure-Python igwn-segments from its sdist (for gwpy), and LALSuite from the
  GitLab job pinned with its sha256 in `lalsuite-wheel.json`.
- **Deploy**: `.github/workflows/pages.yml` runs the scripts on every push to
  `main` and publishes only the site files. It stamps the commit hash into
  the script URLs (`?v=dev` locally), and the page passes it on to the
  worker and its fetches, so a deploy never mixes with cached files.
- **Local development**: `scripts/dev.sh` builds everything and serves the
  site with `scripts/serve.py`, which disables browser caching.
- **Testing**: `scripts/test-examples.mjs` runs examples headlessly in Node
  (test mode on unless `--full`); `.github/workflows/tests.yml` runs every
  supported example, the range reader against gwpy in CPython
  (`tests/test_gwosc_range.py`), and a Playwright smoke test, separately
  from deploys. Pyodide has no network under Node, so the GWOSC examples
  are only checked by hand in the browser.

### Where packages come from

| Package | Source |
|---|---|
| numpy, scipy, matplotlib, pandas, h5py, astropy, bilby-cython, scikit-image, cryptography, ssl, sqlite3, pyodide-http | Pyodide 0.29.5 distribution (jsDelivr) |
| bilby | wheel built from the pinned commit, served by the site |
| dynesty, emcee, corner, dill, nestle, nestle-bilby, bilby's dependencies, gwpy and its dependencies, gwosc, gwinc | pinned in `packages.lock.json`, served by the site |
| igwn-segments 2.1.1 | pure-Python rebuild of the sdist, served by the site |
| LALSuite 7.26.16.1 | GitLab CI artifact of colm.talbot/lalsuite (commit `4554d05a`), served by the site |

### Example status (test mode, Node, bilby `f2d03634`)

31 of the 42 supported examples pass (`scripts/test-all.mjs`), mostly in seconds. The rest:

| Status | Examples | Next step |
|---|---|---|
| Unsupported (flagged in the page) | pymc ×2, celerite, george, `jax_fast_tutorial`, `read_data_from_channel_name`, `read_gracedb_data`, `roq_example` | ROQ basis files later |
| Need network (fail in Node only) | `GW150914`, `GW190425` | run in the browser (test mode: 81 s and 111 s); test them in a browser in CI |
| Fail only in test mode | `linear_regression_grid`, `linear_regression_with_Fisher`, `fake_sampler_example`, `non_tensor`, `relative_binning`, `plot_time_domain_data` | test mode skips plots these examples use; see below |
| bilby `main` bug | `multivariate_gaussian_prior` (`PriorDict.rescale` after #886 cannot handle joint priors) | report upstream |
| LALSuite API change | `bns_polytrope_eos`, `bns_spectral_pca_eos` (`CreateSimNeutronStarFamily` needs `min_fam`) | Colm is fixing |

## Done since the last plan

- **Licensing** — `licenses.html` (generated by `scripts/write_licenses.py`
  from the pin files) lists everything the site distributes with licence
  texts (`licenses/`) and exact sources, including the libraries statically
  linked into LALSuite; the igwn-segments rebuild carries a dated
  modification notice; bilby's licence ships with the examples; this
  repository is MIT licensed.
- **Pinning** — `packages.lock.json` (from `scripts/lock-packages.mjs`) pins
  every PyPI wheel per package group with its sha256 and licence;
  `scripts/fetch-pypi-wheels.py` downloads them and the site installs only
  from its own files. Pyodide's own packages still come from jsDelivr.
- **Tests in CI** — `tests.yml` runs `scripts/test-all.mjs` (every
  supported example in Node, test mode, failures checked against
  `tests/known-failures.json`) and a Playwright smoke test of the assembled
  site, on pushes and pull requests; deploys (`pages.yml`) do not wait for it.
- **Real data** — GW150914 and GW190425 run in the browser. gwpy 4's
  thread pool runs tasks in place; GWOSC strain is read by HTTP range
  requests (128 s of H1 is 3.7 MB in about 5 s, instead of a 130 MB file),
  bit-identical to gwpy's reader; scipy's PSD helper no longer fails on
  32-bit numpy (bit-identical to scipy).
- **Log level menu** — bilby's log messages were dropped (no handler on
  bilby `main` unless `setup_logger` is called); they now show at the
  chosen level, ERROR by default.
- `eccentric_inspiral` works: GWSignal now triggers the gwpy install.
- **Editor** — CodeMirror 6 replaced the textarea.
- **Page polish** — example search and hideable sidebar, editor and output
  toggles, formatted docstrings, blank editor, script and results downloads,
  collapsible runs, figure viewer, copy output, resizable panes, theme
  switch, logo, restyled example tree, phone layout, and cache-busting on
  deploy. Test mode is now off by default on the live site.
- **Progress** — a download progress bar for start-up and installs; tqdm
  lines drawn as bars; tqdm's thread warning silenced.
- **Accessibility** — axe-core finds no issues (apart from a false positive
  on the editor's scroll area) at desktop and phone sizes, in light and dark.
  Screen readers hear run started/finished/failed instead of every output
  line; the editor explains Escape then Tab to leave it; a skip link; the
  phone drawer keeps focus inside and returns it; the divider works from the
  keyboard; example support status is announced; contrast fixes.

## Next steps

In rough priority order.

1. **Real data, next.**
   - Test the GWOSC examples in CI: run them in Playwright (a real browser,
     with network), or give the Node runner a network shim.
   - A cache that survives reloads (e.g. IndexedDB or the Cache API), so a
     rerun after Stop or a reload does not download again.
   - Range reads for StateVector (data-quality) requests, which still
     download whole files.
   - Upstream: report `_fft_helper`'s nominal-size problem to scipy (the
     same in 1.18); suggest gwpy read the requested slice rather than the
     whole dataset.
   - Watch for other 32-bit problems: silent int32 overflow (e.g. GPS times
     in nanoseconds) and large nominal views elsewhere.
2. **Test-mode-incompatible examples.** Six examples fail only in test
   mode (`tests/known-failures.json`); flag them in the page, or run them
   with test mode off automatically.
3. **Durable LALSuite source.** GitLab job artifacts can expire; pin a job
   whose artifacts are kept, or mirror the wheel as a GitHub release asset.
   Once the wheel is built from an upstream LALSuite release, point to that.
   Upstream: ship the bundled libraries' licence files in the wheel.
4. **Upstream bilby issues.** `PriorDict.rescale` with joint priors (#886);
   the GWSignal `ImportError` hides its cause (chain it with `from`).
5. **Polish.**
   - Try the page with a real screen reader (VoiceOver, NVDA); so far only
     axe-core and scripted keyboard tests.
   - A sharper logo (the only copy found is the 192px GitHub avatar).
   - Docstrings that describe samplers the adaptations replaced (e.g.
     PyMultiNest in `slabspike_example`) could be noted or adjusted.
