"""Install bilby and run examples inside Pyodide.

Shared by worker.js (browser) and scripts/test-examples.mjs (Node). JavaScript
registers a module called ``_site`` with an ``image(name, b64)`` callback
before this file is run.
"""

import base64
import os
import re
import sys
import time

import pyodide_js

# Packages built by Pyodide (from its CDN) and pure wheels from PyPI. bilby
# itself is a wheel built from the pinned commit (scripts/fetch-bilby.sh).
# bilby-cython is optional for bilby but makes the GW time and geometry
# functions faster.
PYODIDE_PACKAGES = [
    "micropip", "numpy", "scipy", "matplotlib", "pandas", "h5py",
    "bilby-cython", "tqdm", "attrs",
]
PYPI_PACKAGES = [
    "dynesty==3.1.0", "emcee==3.1.6", "corner==2.3.0", "dill==0.4.1", "nestle==0.2.1",
]
# Samplers that bilby main provides as plugins (found through the
# bilby.samplers entry point). Installed without dependencies: their only
# other requirement is bilby itself, and micropip may not accept our
# development build of bilby as satisfying bilby>=x.y and fetch a release.
PLUGINS = ["nestle-bilby==0.1.1"]
EXAMPLES_ROOT = "/home/pyodide/examples"

# Optional packages, installed the first time an example needs them. An extra
# is needed when its pattern matches the example's code: an import, or a bilby
# function that imports the package internally. "wheels" are local wheels
# from wheels/ (by index.json key) that must be installed first.
EXTRAS = {
    "skimage": {"pattern": r"\bskimage\b", "pyodide": ["scikit-image"]},
    "gwinc": {"pattern": r"\bgwinc\b", "pypi": ["gwinc"]},
    "gwosc": {"pattern": r"\bgwosc\b|get_event_time", "pypi": ["gwosc"]},
    "gwpy": {
        "pattern": r"\bgwpy\b|plot_time_domain_data|fetch_open_data",
        "wheels": ["igwn_segments"],
    },
}
_installed_extras = set()


async def install_bilby(wheel_url):
    await pyodide_js.loadPackage(PYODIDE_PACKAGES)
    import micropip

    await micropip.install([wheel_url, *PYPI_PACKAGES])
    await micropip.install(PLUGINS, deps=False)

    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    plt.show = show
    import bilby
    from bilby.core.sampler.base_sampler import Sampler

    # Always run cleanly (the --clean flag): output stays in the in-memory
    # file system between runs, and without this a rerun would resume from
    # the previous checkpoint or reuse the cached result instead of sampling.
    bilby.core.utils.command_line_args.clean = True

    # In test mode bilby calls sampler._run_test() instead of run_sampler().
    # Only some samplers (dynesty, nestle) implement it; the base class
    # raises, so the others (emcee, bilby_mcmc, ...) run normally instead.
    def _run_normally(self):
        return self.run_sampler()

    Sampler._run_test = _run_normally
    return bilby.__version__


def set_test_mode(enabled):
    """Turn bilby's test mode (the --bilby-test-mode flag) on or off. In test
    mode samplers that support it run only a couple of iterations, and corner,
    walker and detector-data plots are skipped."""
    import bilby

    bilby.core.utils.command_line_args.bilby_test_mode = bool(enabled)


async def install_lalsuite(url):
    """Install the LALSuite wheel. Its install_requires are not all available
    in Pyodide, so dependencies are skipped. bilby.gw also needs astropy."""
    await pyodide_js.loadPackage(["astropy"])
    import micropip

    await micropip.install(url, deps=False)
    import lal

    return lal.VCSInfo.version


def extras_for(code):
    """Names of the extras that `code` needs and that are not installed yet."""
    return [
        name for name, extra in EXTRAS.items()
        if name not in _installed_extras and re.search(extra["pattern"], code)
    ]


async def install_extras(names, wheel_urls):
    """Install the extras in `names`. `wheel_urls` maps index.json keys to
    URLs of local wheels."""
    import micropip

    wheel_urls = dict(wheel_urls)
    for name in names:
        extra = EXTRAS[name]
        for key in extra.get("wheels", []):
            if not wheel_urls.get(key):
                raise RuntimeError(
                    f"{name} cannot be installed because this site is missing its "
                    f"{key} package. Please report this at "
                    "https://github.com/ColmTalbot/bilby-browser/issues"
                )
        if name == "gwpy":
            await _install_gwpy(wheel_urls["igwn_segments"])
        else:
            if extra.get("pyodide"):
                await pyodide_js.loadPackage(extra["pyodide"])
            if extra.get("pypi"):
                await micropip.install(extra["pypi"])
        _installed_extras.add(name)
        print(f"installed {name}")


async def _install_gwpy(igwn_segments_url):
    """Install gwpy (recipe from the LALSuite Pyodide work, see NOTES.md).

    igwn-segments is our pure-Python build (scripts/build-igwn-segments.sh).
    dqsegdb2 and gwdatafind need igwn-auth-utils, which needs gssapi
    (Kerberos) and cannot exist on wasm, so these are installed without
    dependencies; authenticated LIGO data access does not work. Pyodide's own
    cryptography is used, and ssl and sqlite3 are not loaded by default.
    """
    import micropip

    await pyodide_js.loadPackage(["astropy", "ssl", "sqlite3", "cryptography", "pyodide-http"])
    await micropip.install([igwn_segments_url, "PyJWT"])
    await micropip.install(
        ["gwpy==4.0.2", "dqsegdb2", "gwdatafind", "igwn-auth-utils",
         "safe-netrc", "scitokens"],
        deps=False,
    )
    await micropip.install(
        ["dateparser", "gwosc", "ligotimegps", "python-dateutil", "requests"]
    )
    _enable_sync_downloads()
    import gwpy

    return gwpy.__version__


def _enable_sync_downloads():
    """Let requests and astropy (and so gwpy's fetch_open_data) download
    files, using synchronous XMLHttpRequest. That is allowed in a Web Worker,
    which is where the browser runs this code; under Node there is no
    XMLHttpRequest and nothing is patched.

    gwpy downloads through astropy.utils.data._download_file_from_source,
    which uses its own urllib opener, so pyodide_http.patch_all() does not
    cover it; it is replaced here. This must happen before gwpy is imported,
    because gwpy keeps a reference to the original function.
    """
    import js

    if not hasattr(js, "XMLHttpRequest"):
        return
    import pyodide_http
    import astropy.utils.data

    pyodide_http.patch_all()
    astropy.utils.data._download_file_from_source = _xhr_download


def _xhr_download(source_url, *args, **kwargs):
    """Replacement for astropy.utils.data._download_file_from_source: download
    `source_url` into a temporary file and return its path."""
    import tempfile
    import urllib.error

    from js import XMLHttpRequest

    print(f"downloading {source_url} ...")
    start = time.time()
    request = XMLHttpRequest.new()
    request.open("GET", source_url, False)
    request.responseType = "arraybuffer"
    request.send(None)
    if request.status != 200:
        raise urllib.error.HTTPError(
            source_url, request.status, request.statusText, None, None
        )
    fd, path = tempfile.mkstemp()
    with os.fdopen(fd, "wb") as f:
        f.write(request.response.to_bytes())
    size = os.path.getsize(path) / 1e6
    print(f"downloaded {size:.0f} MB in {time.time() - start:.0f} s")
    return path


def show(*args, **kwargs):
    """Replacement for plt.show(): send every open figure to the page."""
    import io

    import matplotlib.pyplot as plt
    import _site

    for num in plt.get_fignums():
        buf = io.BytesIO()
        plt.figure(num).savefig(buf, format="png", dpi=100, bbox_inches="tight")
        _site.image(f"figure {num}", base64.b64encode(buf.getvalue()).decode())
    plt.close("all")


def prepare(path):
    """Change into the directory of examples/<path> and set up sys.argv.
    Returns a fresh globals dict to run the example in."""
    directory = os.path.join(EXAMPLES_ROOT, os.path.dirname(path))
    os.makedirs(directory, exist_ok=True)
    os.chdir(directory)
    sys.argv = [os.path.basename(path)]
    return {"__name__": "__main__", "__file__": os.path.join(EXAMPLES_ROOT, path)}


def send_new_images(since):
    """Send PNG files written under the current directory after `since`."""
    import _site

    found = []
    for root, _, files in os.walk("."):
        for name in files:
            path = os.path.join(root, name)
            if name.lower().endswith(".png") and os.path.getmtime(path) >= since:
                found.append(path)
    for path in sorted(found):
        with open(path, "rb") as f:
            _site.image(os.path.normpath(path), base64.b64encode(f.read()).decode())
    return len(found)


def now():
    return time.time()
