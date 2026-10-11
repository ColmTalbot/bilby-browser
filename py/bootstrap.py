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

# What the site installs, in groups: "bilby" at startup, "lalsuite" for the
# first GW example, and one group per extra. Each group lists packages from
# the Pyodide distribution (loadPackage) and from PyPI (micropip).
#
# These specs are only *resolved* by scripts/lock-packages.mjs, which records
# the exact PyPI wheels each group needs in packages.lock.json. The site and
# the Node runner install from that lock: the wheels are served by the site
# (wheels/pypi/, downloaded by scripts/fetch-pypi-wheels.py), installed
# without dependency resolution, so page loads are reproducible and do not
# depend on PyPI. The local wheels (bilby, LALSuite, igwn-segments; see
# wheels/index.json) are installed separately.
#
# bilby-cython is optional for bilby but makes the GW time and geometry
# functions faster. nestle-bilby provides the nestle sampler through the
# bilby.samplers entry point; it is installed without dependencies because
# micropip may not accept our development build of bilby as satisfying its
# bilby>=x.y requirement.
GROUPS = {
    "bilby": {
        "pyodide": ["micropip", "numpy", "scipy", "matplotlib", "pandas", "h5py",
                    "bilby-cython", "tqdm", "attrs"],
        "pypi": ["dynesty==3.1.0", "emcee==3.1.6", "corner==2.3.0", "dill==0.4.1",
                 "nestle==0.2.1"],
        "pypi_nodeps": ["nestle-bilby==0.1.1"],
        "local": "bilby",
    },
    # LALSuite's own requirements (igwn-ligolw, ...) are not all installable
    # in Pyodide, so it is installed without them.
    "lalsuite": {"pyodide": ["astropy"], "local": "lalsuite", "local_nodeps": True},
    # gwpy recipe from the LALSuite Pyodide work (see NOTES.md): dqsegdb2 and
    # gwdatafind need igwn-auth-utils, which needs gssapi (Kerberos) and
    # cannot exist on wasm, so these are installed without dependencies, and
    # authenticated LIGO data access does not work. Pyodide's own cryptography
    # is used, and ssl and sqlite3 are not loaded by default.
    "gwpy": {
        "pyodide": ["astropy", "ssl", "sqlite3", "cryptography", "pyodide-http"],
        "local": "igwn_segments",
        "pypi": ["PyJWT", "dateparser", "gwosc", "ligotimegps", "python-dateutil",
                 "requests"],
        "pypi_nodeps": ["gwpy==4.0.2", "dqsegdb2", "gwdatafind", "igwn-auth-utils",
                        "safe-netrc", "scitokens"],
    },
    "gwosc": {"pypi": ["gwosc"]},
    "gwinc": {"pypi": ["gwinc"]},
    "skimage": {"pyodide": ["scikit-image"]},
}

# Extras are installed the first time an example needs them: when a pattern
# matches the example's code (an import, or a bilby function that imports the
# package internally; bilby's GWSignal generator imports
# lalsimulation.gwsignal, which imports gwpy).
EXTRAS = {
    "skimage": r"\bskimage\b",
    "gwinc": r"\bgwinc\b",
    "gwosc": r"\bgwosc\b|get_event_time",
    "gwpy": r"\bgwpy\b|plot_time_domain_data|fetch_open_data|GWSignal|gwsignal",
}
EXAMPLES_ROOT = "/home/pyodide/examples"
REPORT = "Please report this at https://github.com/ColmTalbot/bilby-browser/issues"

_lock = None  # packages.lock.json, set by set_lock()
_pypi_base_url = ""
_wheel_urls = {}  # index.json key -> URL of a local wheel
_installed = set()


def set_lock(lock_json, pypi_base_url, wheel_urls):
    """Install from `lock_json` (the text of packages.lock.json), with its
    PyPI wheels under `pypi_base_url`. `wheel_urls` maps wheels/index.json
    keys to URLs of the local wheels. Without a lock (only when
    scripts/lock-packages.mjs resolves the groups), PyPI is used."""
    import json

    global _lock, _pypi_base_url
    _lock = json.loads(lock_json) if lock_json else None
    _pypi_base_url = pypi_base_url
    _wheel_urls.update(dict(wheel_urls))
    if _lock and _lock["pyodide_version"] != pyodide_js.version:
        raise RuntimeError(
            f"packages.lock.json was made for Pyodide {_lock['pyodide_version']}, "
            f"but this is Pyodide {pyodide_js.version}. {REPORT}"
        )


async def install_group(name):
    """Install one group of packages (see GROUPS), once."""
    if name in _installed:
        return
    group = GROUPS[name]
    local = group.get("local")
    if local and not _wheel_urls.get(local):
        raise RuntimeError(f"This site is missing its {local} package. {REPORT}")
    if _lock is None:
        await _resolve_group(group)
    else:
        locked = _lock["groups"][name]
        await pyodide_js.loadPackage(locked["pyodide"])
        import micropip

        urls = [_pypi_base_url + wheel["file"] for wheel in locked["pypi"]]
        if local:
            urls.append(_wheel_urls[local])
        if urls:
            await micropip.install(urls, deps=False)
    _installed.add(name)


async def _resolve_group(group):
    """Install a group by resolving its specs against PyPI (lock generation)."""
    await pyodide_js.loadPackage(group.get("pyodide", []))
    import micropip

    local = [_wheel_urls[group["local"]]] if group.get("local") else []
    with_deps, without_deps = group.get("pypi", []), group.get("pypi_nodeps", [])
    if group.get("local_nodeps"):
        without_deps = local + without_deps
    else:
        with_deps = local + with_deps
    if with_deps:
        await micropip.install(with_deps)
    if without_deps:
        await micropip.install(without_deps, deps=False)


async def install_bilby():
    await install_group("bilby")

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


async def install_lalsuite():
    """Install LALSuite (its own requirements are not all available in
    Pyodide, so it is installed without them) and astropy for bilby.gw."""
    await install_group("lalsuite")
    import lal

    return lal.VCSInfo.version


def extras_for(code):
    """Names of the extras that `code` needs and that are not installed yet."""
    return [
        name for name, pattern in EXTRAS.items()
        if name not in _installed and re.search(pattern, code)
    ]


async def install_extras(names):
    for name in names:
        await install_group(name)
        if name == "gwpy":
            _enable_sync_downloads()
        print(f"installed {name}")


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


def _new_files(since):
    """Files written under the current directory after `since`, sorted."""
    found = []
    for root, _, files in os.walk("."):
        for name in files:
            path = os.path.join(root, name)
            if os.path.getmtime(path) >= since:
                found.append(os.path.normpath(path))
    return sorted(found)


def send_new_images(since):
    """Send PNG files written under the current directory after `since`."""
    import _site

    found = [path for path in _new_files(since) if path.lower().endswith(".png")]
    for path in found:
        with open(path, "rb") as f:
            _site.image(path, base64.b64encode(f.read()).decode())
    return len(found)


def zip_new_files(since, folder):
    """Zip the files written under the current directory after `since`, inside
    `folder`. Returns (zip bytes, number of files), or None if there are none."""
    import io
    import zipfile

    found = _new_files(since)
    if not found:
        return None
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in found:
            archive.write(path, os.path.join(folder, path))
    return buffer.getvalue(), len(found)


def now():
    return time.time()
