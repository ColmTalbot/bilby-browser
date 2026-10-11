"""Read GWOSC HDF5 files over HTTP range requests.

gwpy's fetch_open_data downloads every GWOSC file that overlaps a request
(4096 s at 4 kHz, about 130 MB each) and then reads the whole strain
dataset. GWOSC answers Range requests (with CORS), so this module opens the
file lazily through h5py and downloads only the HDF5 metadata and the
compressed chunks that cover the requested span.

`install(fetcher)` replaces gwpy's per-file GWOSC fetch with
`fetch_gwosc_file`; anything it does not handle (other formats,
StateVector, unexpected layouts, servers without range support) goes to
gwpy's original function. Plain Python, so it can be tested in CPython with
`UrllibFetcher`; py/bootstrap.py installs it in Pyodide with
`XhrFetcher`.
"""

import io
import logging
from collections import OrderedDict

BLOCK_SIZE = 1 << 18  # cache granularity, bytes
CACHE_LIMIT = 512 << 20  # bytes of blocks kept in memory, least recently used dropped
PIECE_SIZE = 1 << 21  # bytes per request when prefetching
PARALLEL = 6  # requests in flight at once when prefetching in parallel

logger = logging.getLogger(__name__)


class RangeUnsupported(OSError):
    """The server did not answer with the requested byte range."""


# -- block cache, shared by every file for the whole session ------------------

_blocks = OrderedDict()  # (url, index) -> bytes
_sizes = {}  # url -> total size
_cached_bytes = 0


def _get_block(url, index):
    block = _blocks.get((url, index))
    if block is not None:
        _blocks.move_to_end((url, index))
    return block


def _put_block(url, index, data):
    global _cached_bytes
    old = _blocks.pop((url, index), None)
    if old is not None:
        _cached_bytes -= len(old)
    _blocks[(url, index)] = data
    _cached_bytes += len(data)
    while _cached_bytes > CACHE_LIMIT and len(_blocks) > 1:
        _, dropped = _blocks.popitem(last=False)
        _cached_bytes -= len(dropped)


def clear_cache():
    global _cached_bytes
    _blocks.clear()
    _sizes.clear()
    _cached_bytes = 0


# -- fetchers -------------------------------------------------------------------
# A fetcher has size(url) -> int and get(url, start, stop) -> bytes for the
# bytes [start, stop). It may also have parallel() -> bool and, for when that
# is true, get_many(url, ranges, progress) -> list of bytes, fetching several
# ranges at once and calling progress(nbytes) as each arrives.


class UrllibFetcher:
    """Fetcher for CPython (tests and checks)."""

    def size(self, url):
        import urllib.request

        request = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(request, timeout=60) as response:
            return int(response.headers["Content-Length"])

    def get(self, url, start, stop):
        import urllib.request

        request = urllib.request.Request(url, headers={"Range": f"bytes={start}-{stop - 1}"})
        with urllib.request.urlopen(request, timeout=60) as response:
            if response.status != 206:
                raise RangeUnsupported(f"{url} answered {response.status} to a range request")
            return response.read()


class XhrFetcher:
    """Fetcher for a Pyodide Web Worker: synchronous XMLHttpRequest, or,
    where JavaScript Promise Integration lets Python block on a promise
    (pyodide.ffi.run_sync), several fetch() requests at once. Only
    CORS-safelisted headers are readable cross-origin, so the size comes from
    Content-Length of a HEAD request rather than from Content-Range."""

    def _request(self, method, url, headers=()):
        from js import XMLHttpRequest

        request = XMLHttpRequest.new()
        request.open(method, url, False)
        for name, value in headers:
            request.setRequestHeader(name, value)
        if method == "GET":
            request.responseType = "arraybuffer"
        request.send(None)
        return request

    def size(self, url):
        request = self._request("HEAD", url)
        length = request.getResponseHeader("Content-Length")
        if request.status != 200 or not length:
            raise RangeUnsupported(f"no size for {url} (HTTP {request.status})")
        return int(length)

    def get(self, url, start, stop):
        request = self._request("GET", url, [("Range", f"bytes={start}-{stop - 1}")])
        if request.status != 206:
            raise RangeUnsupported(f"{url} answered {request.status} to a range request")
        return request.response.to_bytes()

    def parallel(self):
        """Whether get_many can be used here and now."""
        try:
            from pyodide.ffi import can_run_sync
        except ImportError:
            return False
        return can_run_sync()

    def get_many(self, url, ranges, progress=None):
        from pyodide.ffi import run_sync

        return run_sync(self._get_many(url, ranges, progress))

    async def _get_many(self, url, ranges, progress):
        import asyncio

        import js
        from pyodide.ffi import to_js

        limit = asyncio.Semaphore(PARALLEL)
        as_object = js.Object.fromEntries

        async def one(start, stop):
            async with limit:
                headers = to_js({"Range": f"bytes={start}-{stop - 1}"}, dict_converter=as_object)
                response = await js.fetch(url, to_js({"headers": headers}, dict_converter=as_object))
                if response.status != 206:
                    raise RangeUnsupported(f"{url} answered {response.status} to a range request")
                data = (await response.arrayBuffer()).to_bytes()
                if progress is not None:
                    progress(len(data))
                return data

        return await asyncio.gather(*(one(a, b) for a, b in ranges))


# -- the file object ----------------------------------------------------------


class RangeFile(io.RawIOBase):
    """Read-only, seekable file over HTTP range requests, for h5py.File.

    Reads go through the shared block cache; missing neighbouring blocks are
    fetched in one request.
    """

    def __init__(self, url, fetcher):
        self.url = url
        self.fetcher = fetcher
        if url not in _sizes:
            _sizes[url] = fetcher.size(url)
        self.size = _sizes[url]
        self.pos = 0

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=io.SEEK_SET):
        if whence == io.SEEK_SET:
            self.pos = offset
        elif whence == io.SEEK_CUR:
            self.pos += offset
        else:
            self.pos = self.size + offset
        return self.pos

    def readinto(self, buffer):
        n = min(len(buffer), self.size - self.pos)
        if n <= 0:
            return 0
        first, last = self.pos // BLOCK_SIZE, (self.pos + n - 1) // BLOCK_SIZE
        blocks = self._blocks(first, last)
        offset = self.pos - first * BLOCK_SIZE
        buffer[:n] = b"".join(blocks)[offset:offset + n]
        self.pos += n
        return n

    def _blocks(self, first, last):
        """Blocks first..last (inclusive), fetching runs of missing ones."""
        found = {i: _get_block(self.url, i) for i in range(first, last + 1)}
        missing = [i for i, block in found.items() if block is None]
        for run_first, run_last in _runs(missing):
            start = run_first * BLOCK_SIZE
            data = self.fetcher.get(self.url, start, min((run_last + 1) * BLOCK_SIZE, self.size))
            for i in range(run_first, run_last + 1):
                block = data[(i - run_first) * BLOCK_SIZE:(i - run_first + 1) * BLOCK_SIZE]
                _put_block(self.url, i, block)
                found[i] = block
        return [found[i] for i in range(first, last + 1)]

    def prefetch(self, start, stop, label=None):
        """Load the bytes [start, stop) into the cache, in pieces of
        PIECE_SIZE, in parallel if the fetcher can, with a progress bar."""
        first, last = start // BLOCK_SIZE, (stop - 1) // BLOCK_SIZE
        missing = [i for i in range(first, last + 1) if _get_block(self.url, i) is None]
        per_piece = max(1, PIECE_SIZE // BLOCK_SIZE)
        pieces = []  # (first block, last block)
        for run_first, run_last in _runs(missing):
            for a in range(run_first, run_last + 1, per_piece):
                pieces.append((a, min(a + per_piece - 1, run_last)))
        if not pieces:
            return
        ranges = [(a * BLOCK_SIZE, min((b + 1) * BLOCK_SIZE, self.size)) for a, b in pieces]
        total = sum(b - a for a, b in ranges)

        from tqdm.auto import tqdm

        name = self.url.rsplit("/", 1)[-1]
        with tqdm(total=total, unit="B", unit_scale=True, desc=label or name) as bar:
            if getattr(self.fetcher, "parallel", lambda: False)():
                datas = self.fetcher.get_many(self.url, ranges, bar.update)
            else:
                datas = []
                for a, b in ranges:
                    datas.append(self.fetcher.get(self.url, a, b))
                    bar.update(b - a)
        for (a, b), data in zip(pieces, datas):
            for i in range(a, b + 1):
                _put_block(self.url, i, data[(i - a) * BLOCK_SIZE:(i - a + 1) * BLOCK_SIZE])


def _runs(indices):
    """Sorted integers -> list of (first, last) runs of consecutive values."""
    runs = []
    for i in indices:
        if runs and i == runs[-1][1] + 1:
            runs[-1][1] = i
        else:
            runs.append([i, i])
    return [tuple(run) for run in runs]


# -- reading a slice ------------------------------------------------------------


def _dataset_byte_range(dataset, i0, i1):
    """Byte range [start, stop) in the file holding samples [i0, i1) of a
    1-D dataset, or None if it cannot be worked out."""
    dsid = dataset.id
    if dataset.chunks is None:
        offset = dsid.get_offset()
        if offset is None:
            return None
        item = dataset.dtype.itemsize
        return offset + i0 * item, offset + i1 * item
    if not hasattr(dsid, "get_chunk_info_by_coord"):
        return None
    chunk = dataset.chunks[0]
    first = dsid.get_chunk_info_by_coord(((i0 // chunk) * chunk,))
    last = dsid.get_chunk_info_by_coord((((i1 - 1) // chunk) * chunk,))
    if first.byte_offset is None or last.byte_offset is None:
        return None
    start = min(first.byte_offset, last.byte_offset)
    stop = max(first.byte_offset + first.size, last.byte_offset + last.size)
    # chunks are normally stored in order; if not, this range would be far
    # bigger than the data, so give up on prefetching
    compressed = (i1 - i0) * dataset.dtype.itemsize
    if stop - start > 4 * compressed + 2 * chunk * dataset.dtype.itemsize:
        return None
    return start, stop


def read_strain(url, start, end, fetcher, path="strain/Strain"):
    """The GWOSC strain in `url` cropped to [start, end), as a gwpy
    TimeSeries, downloading only what is needed. Gives the same result as
    gwpy's read_gwosc_hdf5(url, start=start, end=end)."""
    import h5py
    from astropy.units import Quantity
    from gwpy.detector.units import parse_unit
    from gwpy.timeseries import TimeSeries
    from gwpy.timeseries.io.losc import _name_from_gwosc_hdf5

    with RangeFile(url, fetcher) as raw, h5py.File(raw, "r") as h5f:
        dataset = h5f[path]
        if dataset.ndim != 1:
            raise RangeUnsupported(f"{path} in {url} is not one-dimensional")
        epoch = dataset.attrs["Xstart"]
        spacing = dataset.attrs["Xspacing"]
        xunit = parse_unit(dataset.attrs["Xunits"])
        unit = dataset.attrs["Yunits"]
        name = _name_from_gwosc_hdf5(dataset)
        n = dataset.shape[0]
        # one sample of margin each side, then gwpy's own crop, so the
        # samples kept are exactly those read_gwosc_hdf5 would keep
        i0 = 0 if start is None else max(0, int((float(start) - epoch) // spacing) - 1)
        i1 = n if end is None else min(n, int(-(-(float(end) - epoch) // spacing)) + 1)
        if i1 <= i0:
            i0, i1 = 0, 0
        else:
            byte_range = _dataset_byte_range(dataset, i0, i1)
            if byte_range is not None:
                detector = name.split(":", 1)[0]
                raw.prefetch(*byte_range, label=f"{detector} data from GWOSC")
        data = dataset[i0:i1]
    return TimeSeries(
        data,
        t0=epoch + i0 * spacing,
        sample_rate=(1 / Quantity(spacing, xunit)).to("Hertz"),
        unit=unit,
        name=name,
    ).crop(start=start, end=end)


# -- gwpy integration -------------------------------------------------------------

_original = None
_fetcher = None


def fetch_gwosc_file(url, *args, series_class=None, cache=None, timeout=None,
                     format=None, start=None, end=None, **kwargs):
    """Replacement for gwpy.timeseries.io.losc._fetch_gwosc_data_file."""
    from gwpy.timeseries import StateVector, TimeSeries

    # fetch_dict passes parallel=1 (a read option); nothing else is expected
    handled = (
        url.startswith(("http://", "https://"))
        and url.endswith(".hdf5")
        and format in (None, "hdf5", "hdf5.gwosc")
        and not args
        and set(kwargs) <= {"parallel"}
        and series_class is not None
        and issubclass(series_class, TimeSeries)
        and not issubclass(series_class, StateVector)
    )
    if handled:
        try:
            series = read_strain(url, start, end, _fetcher)
        except RangeUnsupported as exc:
            logger.warning("range reads failed (%s); downloading the whole file", exc)
        else:
            return series if series_class is TimeSeries else series.view(series_class)
    return _original(url, *args, series_class=series_class, cache=cache,
                     timeout=timeout, format=format, start=start, end=end, **kwargs)


def install(fetcher):
    """Make gwpy's GWOSC fetches use range reads through `fetcher`."""
    global _original, _fetcher
    import gwpy.timeseries.io.losc as losc

    _fetcher = fetcher
    if _original is None:
        _original = losc._fetch_gwosc_data_file
        losc._fetch_gwosc_data_file = fetch_gwosc_file
