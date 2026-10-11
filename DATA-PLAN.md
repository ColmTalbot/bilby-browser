# Plan: GWOSC data by HTTP range reads

Status (2026-10-11): steps 1–3 below are implemented (`py/gwosc_range.py`,
`tests/test_gwosc_range.py`). The examples are still blocked by a separate
32-bit numpy problem in the PSD (see `PLAN.md`).

Goal: `TimeSeries.fetch_open_data` works in the browser for any detector,
any times and any event, with no list of supported times. It downloads
roughly the bytes for the requested span instead of whole 130 MB files.
`GW150914.py` and `GW190425.py` then run unchanged, and so do edited
versions of them.

## What we know (measured 2026-10-11)

- **gwpy downloads whole files.** `fetch_open_data` downloads every
  4096 s, 4 kHz GWOSC file that overlaps the request (about 130 MB each)
  through astropy. `read_gwosc_hdf5` then reads the whole dataset
  (`dataset[()]`) and crops it.
- **GWOSC is slow per connection.** One request gets about 350 kB/s, and
  four in parallel get about 1.1 MB/s together. Each request has 0.4–0.5 s
  of latency. gwosc.org serves HTTP/1.1, so a browser can open about 6
  connections to it.
- **GWOSC supports range reads from the browser.** It answers `Range`
  requests with `206` and sends `access-control-allow-origin: *`. A single
  `bytes=a-b` range is a CORS-safelisted header, so there is no preflight.
- **The file layout suits range reads.** `strain/Strain` is float64, gzip
  level 1, in chunks of 8192 samples (2 s, about 64 kB). gzip barely
  shrinks noise.
- **Prototype result** (CPython, h5py over a range-request file object,
  GW150914 H1, 133 s):
  - Opening the file and reading its metadata and chunk index took
    2 requests (0.5 MB, 1.9 s).
  - The 67 chunks the span needs total 4.25 MB and are stored almost
    contiguously (one gap).
  - Read in one stream that took 14 s. Split into parallel ranges it would
    take roughly 4–5 s.

Rough cost per `fetch_open_data` call, compared with today:

| Request | Today (whole files) | One stream | ~4 parallel |
|---|---|---|---|
| GW150914, 133 s × 2 detectors | 260 MB, ~12 min | 8.5 MB, ~30 s | ~10 s |
| GW190425, 1154 s × 2 detectors | 260 MB, ~12 min | ~75 MB, ~3.5 min | ~1 min |

Cost scales with the span requested, not the file size. Short analyses
are cheap, and long PSD segments cost what they really contain.

## Design

### Range-backed file object

`py/gwosc_range.py` (new) defines a read-only, seekable file object over
HTTP range requests. h5py accepts it directly (`h5py.File(fileobj)`).

- Data is cached in fixed-size blocks (on the order of 256 kB). When one
  read needs several missing blocks next to each other, they are fetched in
  one request.
- Fetching is a small function that can be swapped:
  - in the browser worker, synchronous XHR with a `Range` header;
  - in CPython (tests), urllib.
- The object knows its total size from the first response
  (`Content-Range`).

### Reading only the slice

At this point gwpy downloads a file and reads it. That happens in
`gwpy.timeseries.io.losc._fetch_gwosc_data_file(url, ..., start, end)`.
The bootstrap replaces that function, for `.hdf5` URLs and `TimeSeries`
only, with one that:

1. opens the URL with the range-backed file object;
2. finds the strain dataset and works out the sample range for
   `[start, end)` from `Xstart` and `Xspacing`;
3. prefetches the bytes of the chunks covering that range (next section);
4. reads only `dataset[i0:i1]` and builds the `TimeSeries` with the same
   epoch, sample rate, unit and name that `read_gwosc_hdf5` would give.

Anything else goes to gwpy's original function, which downloads the whole
file as it does today: GWF or text formats, `StateVector` data-quality
reads, or a file that isn't laid out as expected.

URL discovery is unchanged: gwpy still asks the GWOSC API through
`gwosc.locate.get_urls`, which already works through `pyodide_http`.

### Prefetching chunks, in parallel where possible

After the file is opened, h5py tells us exactly where each chunk lives
(`dataset.id.get_chunk_info_by_coord`). The patch merges the chunks for the
slice into byte ranges and loads them into the block cache before reading.
Two ways, picked at run time:

- **Parallel**, when `pyodide.ffi.can_run_sync()` is true. That means the
  browser supports JavaScript Promise Integration (JSPI), which current
  Chrome does. Split the span into about 4–6 ranges, start them all with
  `fetch`, and wait with `run_sync(asyncio.gather(...))`. Examples already
  run through `runPythonAsync`, which `run_sync` requires.
- **Sequential** everywhere else: synchronous XHR, one range per few MB.
  It's slower, but correct in every browser.

With either path, progress is reported with a tqdm bar ("H1 1126259332–
1126259465: 4.3 MB from GWOSC"). The output pane already draws tqdm bars.

Whichever path is used, the read and its results don't depend on it,
because h5py only ever sees the block cache.

### Caching

- **Within a session:** one range-backed file object per URL, kept in a
  module-level dict.
  - The analysis-segment and PSD calls on the same file share the
    metadata.
  - Rerunning an example, or a second run with overlapping times,
    downloads nothing again.
  - Memory is capped (LRU on blocks, for example 512 MB), so a long
    session can't run out of wasm memory.
- **Across sessions:** not in the first version. Browsers don't reliably
  cache `206` responses. Later, it could use the Cache API or IndexedDB
  keyed by URL and byte range, written in the parallel path, where async
  calls are available. Whether that's worth it depends on how annoying
  reloading turns out to be.

### What goes away compared with the cropped-copies plan

There is no pin file, build script or `data/` directory, and no CI, cache
or deploy changes. The site no longer redistributes GWOSC data, so it no
longer needs CC BY attribution for modified copies. Acknowledging GWOSC on
`licenses.html` is still good practice.

## Testing

- **Unit tests in CPython** (fast, no network): a synthetic GWOSC-format
  file served by a tiny local HTTP server that supports `Range`. Check
  that:
  - slices come back bit-identical to h5py reading the whole file locally;
  - spans that start or end mid-chunk, cross file boundaries, or cover the
    whole file all work;
  - requests are merged and the cache is reused.
- **One live check** (manual or opt-in, needs network): in CPython, compare
  the patched `fetch_open_data` with stock gwpy for both examples'
  requests, using `np.array_equal`.
- **Browser:** run `GW150914.py` through the preview in Chrome (parallel
  path) and in a browser without JSPI (sequential path). Then edit the
  times or detectors and run it again.
- **Node runner:** Node has no synchronous XHR, and JSPI needs a flag. The
  real-data examples stay out of `npm test` unless running them against
  GWOSC turns out to be reliable enough. If it is, add them behind an
  opt-in flag.

## Order of work

1. Range-backed file object and slice reader in CPython, with the unit
   tests and the live comparison. Most of this is the prototype, cleaned up.
2. Wire it into the bootstrap (sequential path only) and run `GW150914.py`
   in the browser.
3. Parallel prefetch with `run_sync`, progress bar, and the per-session
   cache with its cap.
4. Remove both examples from `UNSUPPORTED`. A full run takes hours, so
   mark them `partial` with that as the reason. Update `PLAN.md` and
   `NOTES.md`.
5. Later, if useful: a cache that lasts across sessions, and the same
   approach for `StateVector`.

## Risks and open questions

- **JSPI support:** Chrome has it by default. Firefox and Safari may not,
  and those users get the sequential path, which is slower but still about
  25× less data than today. `run_sync` is marked experimental in Pyodide
  0.29.
- **GWOSC load and limits:** many small range requests are kinder to GWOSC
  than whole-file downloads, but parallel requests could look like abuse.
  Keep the parallelism modest (4–6) and merge requests aggressively.
- **File layout:** checked on the O1 bulk file (GW150914) and the O3 event
  file for GW190425 (L1): both open in 2 requests (0.5 MB). GW190425's
  1154 s span is 577 chunks, 36.6 MB, stored almost contiguously (10 small
  gaps). 16 kHz files are not checked yet. Unexpected layouts fall back to gwpy's full download, so they
  would be slow, not wrong.
- **Upstream:** gwpy reading only the needed slice in `read_gwosc_hdf5`
  (`dataset[i0:i1]` instead of `dataset[()]`) is a small change that would
  help everyone. With remote range access (fsspec), most of this could live
  in gwpy itself. Worth raising once this works here.
