"""Tests for py/gwosc_range.py in CPython, against a local HTTP server that
supports Range requests and serves a small synthetic GWOSC-format file.

    pip install gwpy==4.0.2
    python -m unittest tests/test_gwosc_range.py
"""

import http.server
import os
import sys
import tempfile
import threading
import unittest
import warnings
from pathlib import Path

import h5py
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "py"))
import gwosc_range  # noqa: E402

EPOCH = 1126256640
RATE = 4096
DURATION = 64
CHUNK = 8192


def write_gwosc_file(path, detector="H1"):
    rng = np.random.default_rng(1)
    with h5py.File(path, "w") as f:
        strain = f.create_dataset(
            "strain/Strain", data=rng.normal(size=DURATION * RATE) * 1e-21,
            chunks=(CHUNK,), compression="gzip", compression_opts=1,
        )
        strain.attrs.update({
            "Xstart": np.int64(EPOCH), "Xspacing": 1 / RATE, "Npoints": DURATION * RATE,
            "Xunits": "second", "Yunits": "", "Xlabel": "GPS time", "Ylabel": "Strain",
        })
        f["meta/Detector"] = detector.encode()
        f["meta/GPSstart"] = np.int64(EPOCH)
        f["meta/Duration"] = np.int64(DURATION)


class Handler(http.server.SimpleHTTPRequestHandler):
    """Serves the test directory, with single byte ranges (or without them
    when the server's `ranges` attribute is False), counting GETs."""

    def log_message(self, *args):
        pass

    def send_head(self):
        path = self.translate_path(self.path)
        size = os.path.getsize(path)
        spec = self.headers.get("Range")
        f = open(path, "rb")
        if spec and self.server.ranges:
            a, b = spec.removeprefix("bytes=").split("-")
            a, b = int(a), min(int(b), size - 1)
            f.seek(a)
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {a}-{b}/{size}")
            self.send_header("Content-Length", str(b - a + 1))
            self.remaining = b - a + 1
        else:
            self.send_response(200)
            self.send_header("Content-Length", str(size))
            self.remaining = size
        self.end_headers()
        return f

    def do_GET(self):
        self.server.gets += 1
        f = self.send_head()
        try:
            self.wfile.write(f.read(self.remaining))
        except BrokenPipeError:
            pass  # the client gave up on a response it did not want
        finally:
            f.close()


class RangeReadTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        cls.name = f"H-H1_GWOSC_4KHZ_R1-{EPOCH}-{DURATION}.hdf5"
        cls.path = os.path.join(cls.dir.name, cls.name)
        write_gwosc_file(cls.path)
        handler = lambda *a, **k: Handler(*a, directory=cls.dir.name, **k)  # noqa: E731
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.server.ranges = True
        cls.server.gets = 0
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}/{cls.name}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.dir.cleanup()

    def setUp(self):
        gwosc_range.clear_cache()
        self.server.ranges = True
        self.server.gets = 0

    def expected(self, start, end):
        from gwpy.timeseries.io.losc import read_gwosc_hdf5

        return read_gwosc_hdf5(self.path, start=start, end=end)

    def assertSameSeries(self, got, want):
        self.assertTrue(np.array_equal(got.value, want.value))
        self.assertEqual(got.t0, want.t0)
        self.assertEqual(got.dt, want.dt)
        self.assertEqual(got.unit, want.unit)
        self.assertEqual(got.name, want.name)

    def test_matches_gwpy(self):
        from gwpy.time import LIGOTimeGPS

        spans = [
            (EPOCH + 10, EPOCH + 14),  # whole seconds
            (EPOCH + 10.4, EPOCH + 14.4),  # GW150914-style fractional times
            (EPOCH + 4, EPOCH + 6),  # exactly one chunk
            (EPOCH + 3.9999, EPOCH + 6.0001),  # just over chunk boundaries
            (EPOCH, EPOCH + 1),  # file start
            (EPOCH + DURATION - 1, EPOCH + DURATION),  # file end
            (EPOCH, EPOCH + DURATION),  # whole file
            (None, None),
            (LIGOTimeGPS(EPOCH + 10, 400000000), LIGOTimeGPS(EPOCH + 14, 400000000)),  # as gwpy passes them
        ]
        for start, end in spans:
            with self.subTest(start=start, end=end):
                gwosc_range.clear_cache()
                with warnings.catch_warnings():
                    warnings.simplefilter("error")  # e.g. crop outside the data
                    got = gwosc_range.read_strain(self.url, start, end, gwosc_range.UrllibFetcher())
                self.assertSameSeries(got, self.expected(start, end))

    def test_downloads_little_and_caches(self):
        fetcher = gwosc_range.UrllibFetcher()
        gwosc_range.read_strain(self.url, EPOCH + 10, EPOCH + 14, fetcher)
        first = self.server.gets
        # metadata + one prefetch of a few chunks; h5py's reads all hit the cache
        self.assertLessEqual(first, 4)
        self.assertLess(gwosc_range._cached_bytes, os.path.getsize(self.path) / 2)
        gwosc_range.read_strain(self.url, EPOCH + 11, EPOCH + 13, fetcher)
        self.assertEqual(self.server.gets, first)

    def test_cache_limit(self):
        old = gwosc_range.CACHE_LIMIT
        gwosc_range.CACHE_LIMIT = 2 * gwosc_range.BLOCK_SIZE
        try:
            got = gwosc_range.read_strain(self.url, None, None, gwosc_range.UrllibFetcher())
            self.assertLessEqual(gwosc_range._cached_bytes, gwosc_range.CACHE_LIMIT)
            self.assertSameSeries(got, self.expected(None, None))
        finally:
            gwosc_range.CACHE_LIMIT = old

    def test_falls_back_without_range_support(self):
        from gwpy.timeseries import TimeSeries

        self.server.ranges = False
        calls = []

        def original(url, *args, **kwargs):
            calls.append(url)
            return "original"

        gwosc_range._original, gwosc_range._fetcher = original, gwosc_range.UrllibFetcher()
        try:
            with self.assertLogs("gwosc_range", "WARNING"):
                out = gwosc_range.fetch_gwosc_file(
                    self.url, series_class=TimeSeries, start=EPOCH + 1, end=EPOCH + 2)
        finally:
            gwosc_range._original = gwosc_range._fetcher = None
        self.assertEqual(out, "original")
        self.assertEqual(calls, [self.url])

    def test_uses_range_reads_for_gwpy_call(self):
        from gwpy.time import LIGOTimeGPS
        from gwpy.timeseries import TimeSeries

        def original(*args, **kwargs):
            raise AssertionError("fell back to gwpy")

        gwosc_range._original, gwosc_range._fetcher = original, gwosc_range.UrllibFetcher()
        start, end = LIGOTimeGPS(EPOCH + 10, 400000000), LIGOTimeGPS(EPOCH + 14, 400000000)
        try:
            # the keyword arguments fetch_gwosc_data passes
            got = gwosc_range.fetch_gwosc_file(
                self.url, series_class=TimeSeries, cache=None, timeout=None,
                format=None, start=start, end=end, parallel=1)
        finally:
            gwosc_range._original = gwosc_range._fetcher = None
        self.assertSameSeries(got, self.expected(start, end))

    def test_other_requests_use_gwpy(self):
        from gwpy.timeseries import StateVector, TimeSeries

        gwosc_range._original = lambda url, *a, **k: "original"
        try:
            self.assertEqual(gwosc_range.fetch_gwosc_file(
                self.url, series_class=StateVector, start=EPOCH, end=EPOCH + 1), "original")
            self.assertEqual(gwosc_range.fetch_gwosc_file(
                self.url.replace(".hdf5", ".gwf"), series_class=TimeSeries), "original")
        finally:
            gwosc_range._original = None


@unittest.skipUnless(os.environ.get("GWOSC_LIVE"), "set GWOSC_LIVE=1 to compare with GWOSC")
class LiveTest(unittest.TestCase):
    """fetch_open_data with range reads against stock gwpy, on real GWOSC
    data (GW150914). Downloads a 130 MB file for the stock read."""

    def test_gw150914(self):
        import gwpy.timeseries.io.losc as losc
        from gwpy.timeseries import TimeSeries

        from astropy.utils.data import conf

        start, end = 1126259460.4, 1126259464.4
        with conf.set_temp("remote_timeout", 300):  # GWOSC can stall on 130 MB
            want = TimeSeries.fetch_open_data("H1", start, end)
        gwosc_range.clear_cache()
        gwosc_range.install(gwosc_range.UrllibFetcher())
        try:
            got = TimeSeries.fetch_open_data("H1", start, end)
            self.assertGreater(gwosc_range._cached_bytes, 0, "range reads were not used")
            self.assertLess(gwosc_range._cached_bytes, 10e6)
        finally:
            losc._fetch_gwosc_data_file = gwosc_range._original
            gwosc_range._original = None
        self.assertTrue(np.array_equal(got.value, want.value))
        self.assertEqual((got.t0, got.dt, got.unit, got.name), (want.t0, want.dt, want.unit, want.name))


if __name__ == "__main__":
    unittest.main()
