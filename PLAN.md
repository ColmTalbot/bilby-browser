# bilby-browser: plan

A static GitHub Pages site (https://colmtalbot.github.io/bilby-browser/)
where users pick a bilby example, edit it, and run it in their browser with
Pyodide. Background on the LALSuite Pyodide build is in `NOTES.md`.

## How it works now

- **Page** (`index.html`, `app.js`): nested example tree that mirrors bilby's
  `examples/`, editor, streamed output (progress bars rewrite in place) and
  figures. Stop terminates the worker and starts a new one. A header switch
  turns bilby test mode on (amber page) or off; it defaults to on and is
  remembered per browser.
- **Worker** (`worker.js`, `py/bootstrap.py`): Pyodide 0.29.5 from jsDelivr.
  Installs bilby at startup, LALSuite on the first GW example, and extras
  (gwpy, gwosc, gwinc, scikit-image) when an example needs them.
  `command_line_args.clean` is always on, so reruns never resume from a
  checkpoint; `bilby_test_mode` follows the switch.
- **bilby and examples** come from one pinned commit of bilby-dev/bilby
  `main` (`bilby-commit.txt`; `scripts/fetch-bilby.sh --update` moves it).
  `scripts/adapt_examples.py` edits them for Pyodide (pymultinest → nestle,
  cpnest → dynesty, `npool=` lines removed) and flags unsupported ones; the
  page shows both. Neither examples nor wheels are stored in git.
- **Wheels** are built or fetched by scripts: bilby from the pinned commit,
  a pure-Python igwn-segments from its sdist (for gwpy), and LALSuite from the
  GitLab job pinned with its sha256 in `lalsuite-wheel.json`.
- **Deploy**: `.github/workflows/pages.yml` runs the scripts on every push to
  `main` and publishes only the site files.
- **Testing**: `scripts/test-examples.mjs` runs examples headlessly in Node
  (test mode on unless `--full`).

### Where packages come from

| Package | Source |
|---|---|
| numpy, scipy, matplotlib, pandas, h5py, astropy, bilby-cython, scikit-image, cryptography, ssl, sqlite3, pyodide-http | Pyodide 0.29.5 distribution (jsDelivr) |
| bilby | wheel built from the pinned commit, served by the site |
| dynesty 3.1.0, emcee 3.1.6, corner 2.3.0, dill 0.4.1, nestle 0.2.1, nestle-bilby 0.1.1 | PyPI via micropip |
| bilby's other dependencies (plum-dispatch, array-api-compat, …), gwosc, gwinc | PyPI via micropip, **unpinned** |
| gwpy 4.0.2 and its auth-related dependencies | PyPI, installed with `deps=False` (recipe in `NOTES.md`) |
| igwn-segments 2.1.1 | pure-Python rebuild of the sdist, served by the site |
| LALSuite 7.26.16.1 | GitLab CI artifact of colm.talbot/lalsuite (commit `4554d05a`), served by the site |

### Example status (test mode, Node, bilby `f2d03634`)

30 of 50 pass, mostly in seconds. The rest:

| Status | Examples | Next step |
|---|---|---|
| Unsupported (flagged in the page) | pymc ×2, celerite, george, `jax_fast_tutorial`, `read_data_from_channel_name`, `read_gracedb_data`, `roq_example` | ROQ basis files will come later |
| Fail only in test mode | `linear_regression_grid`, `linear_regression_with_Fisher`, `fake_sampler_example`, `non_tensor`, `relative_binning`, `plot_time_domain_data` | test mode skips plots these examples use; see below |
| bilby `main` bug | `multivariate_gaussian_prior` (`PriorDict.rescale` after #886 cannot handle joint priors) | report upstream |
| LALSuite API change | `bns_polytrope_eos`, `bns_spectral_pca_eos` (`CreateSimNeutronStarFamily` needs `min_fam`) | Colm is fixing |
| Needs a browser | `GW150914`, `GW190425` (GWOSC download uses synchronous XHR, only in a worker) | verify in a browser |
| Not investigated | `eccentric_inspiral` ("Cannot use the GWSignal waveform generator") | investigate |

## Next steps

In rough priority order.

1. **Licensing of hosted binaries.** The site serves the LALSuite wheel
   (LALSuite GPL-2+, statically linked GSL GPL-3+, FFTW GPL-2+, FrameL
   LGPL-2.1+, HDF5 BSD-style, zlib), the igwn-segments rebuild (GPL-3+,
   modified `__init__`) and the bilby wheel (MIT), so it distributes them.
   Add a "Licences and source" page with the licence texts and links to the
   exact sources (LALSuite commit + build scripts, upstream library releases,
   igwn-segments sdist + our build script, bilby commit), and give this
   repository its own licence. Upstream: add the bundled libraries' licence
   files to the LALSuite wheel.
2. **Real data in the browser.** Run `GW150914.py` end to end; cache GWOSC
   files (Cache API or IndexedDB) so reruns do not download ~130 MB files
   again; consider serving cropped copies from the site.
3. **Pin everything.** Serve the remaining PyPI wheels from the site (or use
   a micropip lock file) so page loads are reproducible, faster, and do not
   depend on PyPI.
4. **Test in CI.** Run `scripts/test-examples.mjs` (test mode) in the Pages
   workflow before deploying, and add a Playwright smoke test that loads the
   page and runs one core and one GW example.
5. **Test-mode-incompatible examples.** Flag them in the page, or run them
   with test mode off automatically.
6. **Durable LALSuite source.** GitLab job artifacts can expire; pin a job
   whose artifacts are kept, or mirror the wheel as a GitHub release asset.
   Once the wheel is built from an upstream LALSuite release, point to that.
7. **Polish.** CodeMirror editor, a real progress bar, downloading results
   (result JSON, figures), a "copy as script" button, phone layout and
   accessibility checks.
