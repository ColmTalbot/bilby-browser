# bilby-site: notes for getting started

Goal: run [bilby](https://git.ligo.org/lscsoft/bilby) in the browser with
[Pyodide](https://pyodide.org), deployed as a static site on GitHub Pages.

These notes were written from the LALSuite Pyodide work (branch
`pyodide-wheels` of `git@git.ligo.org:colm.talbot/lalsuite.git`, directory
`wheel/pyodide/`). Items marked **unverified** have not been tried yet.

## What already works

- **LALSuite wheel for Pyodide** (LAL, LALSimulation, LALFrame), built in
  a container (`wheel/pyodide/run.sh`) and in CI on the fork.
  - Pyodide 0.29.5, Python 3.13, ABI `pyodide_2025_0_wasm32`.
  - Example name: `lalsuite-7.26.16.1-cp313-cp313-pyodide_2025_0_wasm32.whl`
    (about 19 MB).
  - Waveforms tested under Node (LALSimulation's Python tests pass except
    the NRSur7dq4Remnant cases, which also fail natively) and in Chrome
    (IMRPhenomXPHM, SEOBNRv4, NRSur3dq8Remnant, gwsignal).
- **Reference implementation:** `wheel/pyodide/browser/index.html` in the
  LALSuite branch: loads Pyodide, installs the wheel and gwpy, and has
  working examples. Start from it rather than from scratch.

## Getting the LALSuite wheel

- CI job `wheel:pyodide` on `colm.talbot/lalsuite` (push pipelines on
  forks only) keeps the wheel as an artifact in `wheelhouse-pyodide/`
  for 4 weeks. If the project keeps the latest artifacts (GitLab's
  default), the latest *successful pipeline* on each branch is also kept
  until a newer one succeeds. Download and pin the wheel well before
  expiry; the site should not depend on GitLab keeping it.
- Download from a specific job (works as soon as that job succeeds; best
  for pinning). First CI build: job 5185942 (pipeline 898530, commit
  `4554d05a18`), artifacts expire about 2026-11-08:

  ```bash
  curl -L -o wheelhouse-pyodide.zip "https://git.ligo.org/api/v4/projects/colm.talbot%2Flalsuite/jobs/5185942/artifacts"
  ```

- Or the latest from the branch, which only finds jobs in pipelines where
  every job succeeded (so it fails while, or if, other jobs fail):

  ```bash
  curl -L -o wheelhouse-pyodide.zip "https://git.ligo.org/api/v4/projects/colm.talbot%2Flalsuite/jobs/artifacts/pyodide-wheels/download?job=wheel:pyodide"
  ```

- Recommendation: fetch it in the GitHub Actions deploy workflow, pin it
  (record the job ID or SHA-256), and serve it from the site itself.
  Do not fetch from GitLab at page load: artifacts expire, may need
  authentication, and GitLab artifact downloads probably lack CORS
  headers (**unverified**).

## Installing in Pyodide

- LALSuite wheel: `await micropip.install(url, deps=False)`.
  Its `install_requires` (igwn-ligolw, lscsoft-glue, …) are not all
  installable in Pyodide; skip them.
- LAL data files are inside the wheel at
  `/lib/python3.13/site-packages/_lalsuite/data` and are found
  automatically. Large waveform data (e.g. NR surrogate HDF5 files from
  Zenodo, ~100 MB each) must be fetched separately and their directory
  added to `LAL_DATA_PATH`.
- gwpy needs workarounds (see `install_gwpy()` in `index.html` and the
  gwpy section of `wheel/pyodide/README.md`):
  - `igwn-segments` has a C extension and no Pyodide wheel on PyPI; build
    it with `pyodide build` from its sdist (it builds unmodified) and host
    the wheel on the site.
  - `gwdatafind`, `dqsegdb2`, `igwn-auth-utils`, `safe-netrc`,
    `scitokens` and gwpy itself are installed with `deps=False`, because
    `igwn-auth-utils` needs `gssapi` (Kerberos), which cannot exist on
    wasm.
  - Pyodide's own `cryptography` must be used (the newest needs
    `cffi>=2`; Pyodide 0.29 ships 46.0.3 built against `cffi` 1.17.1).
  - Install the `ssl` and `sqlite3` modules explicitly; Pyodide does not
    load them by default.
  - Plain `pip install gwpy` silently falls back to gwpy 0.10.1, which
    does not import.

## Known limitations

- **`TimeSeries.fetch_open_data` needs patching.** gwosc finds file URLs
  with `requests` (works in Pyodide via `pyodide_http`), but gwpy
  downloads through astropy, which uses `urllib.request` and raw sockets
  (`URLError: [Errno 23] Host is unreachable`). Files are 4096 s long
  (~130 MB at 4 kHz) even for a short request, and GWOSC serves about
  350 kB/s per connection. `py/gwosc_range.py` reads HDF5 strain with HTTP
  range requests instead: GWOSC answers `Range` with `206` and sends
  `access-control-allow-origin: *`. `Content-Range` is not readable
  cross-origin, but `Content-Length` from HEAD is. Opening a file costs
  2 requests (0.5 MB); strain is gzip-compressed in 2 s chunks stored
  nearly contiguously. gwpy's `read_gwosc_hdf5` reads the whole dataset
  and then crops, so the slice is read separately. Synchronous XHR
  downloads whole files as the fallback.
- **32-bit numpy.** Pyodide is wasm32. `float64` is unchanged (IEEE
  double), but pointers, `sys.maxsize`, `np.intp`, C `long` and numpy's
  default integer are 32-bit: `np.array([2**30]) * 4` is `[0]`, silently.
  Python `int` is still arbitrary precision, and `int64` works when asked
  for. numpy refuses arrays whose nominal size exceeds 2^31 bytes, even
  zero-copy views. scipy's Welch/CSD/STFT helper (`_fft_helper`) views the
  data as a window at every sample and then keeps every step-th one, so
  any PSD of more than about 16 s of 4 kHz data failed. `py/bootstrap.py`
  replaces it with a strided view of only the windows used (bit-identical
  to scipy for welch, median welch, csd, spectrogram, stft and coherence).
  Plain FFTs are unaffected: only a real array over 2 GB fails, and that
  would not fit in wasm32 memory anyway.
- **No multiprocessing or threads** in Pyodide: samplers run on one core.
  `npool` and similar options must stay at 1.
  gwpy 4's `fetch_open_data` always uses a `ThreadPoolExecutor` (even for
  one detector); `py/bootstrap.py` replaces `concurrent.futures.ThreadPoolExecutor`
  with an executor that runs each task as it is submitted.
- **Run Python in a Web Worker** for anything long (sampling), so the
  page stays responsive; the LALSuite test page runs on the main thread.
- No authenticated LIGO data access (Kerberos/SciTokens).

## bilby (all unverified)

- bilby is pure Python. Likely dependencies: `numpy`, `scipy`,
  `matplotlib`, `pandas`, `h5py`, `dill`, `tqdm`, `corner`, `dynesty`,
  `emcee`, `bilby.cython`, `attrs`. Check which are in Pyodide's package
  list or have pure-Python wheels on PyPI.
- `bilby.cython` is a compiled extension and probably needs
  `pyodide build`, like `igwn-segments`.
- `bilby.gw` needs LALSuite (above); waveform generation through
  `lalsimulation` should work as in the test page.
- Check `bilby` imports for multiprocessing/`schwimmbad` use at import
  time.

## Suggested first steps

1. Initialise the repository and a minimal Pages site based on
   `wheel/pyodide/browser/index.html`.
2. Install bilby in Pyodide and record every dependency failure.
3. Run a non-GW bilby example (e.g. linear regression with dynesty) in
   the browser.
4. Add the LALSuite wheel and run a short GW injection with
   IMRPhenomXPHM, without real data.
5. Move Python execution into a Web Worker.
6. GitHub Actions: fetch and pin the LALSuite and `igwn-segments`
   wheels, build any other missing wheels, deploy to Pages.

## Suggested layout

```
bilby-site/
  index.html            # UI
  worker.js             # Pyodide in a Web Worker
  py/                   # Python run inside Pyodide
  wheels/               # wheels not on PyPI/Pyodide (fetched in CI, not committed)
  scripts/              # build/fetch scripts used by CI
  .github/workflows/    # build and deploy to Pages
```
