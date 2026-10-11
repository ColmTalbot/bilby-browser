"""Write wheels/sizes.json: the size of every file the page downloads while
it starts up or installs packages, so the worker can show how far along a
download is.

- "pyodide": Pyodide's own files (pyodide.asm.wasm, python_stdlib.zip,
  pyodide-lock.json) and the Pyodide packages that packages.lock.json uses,
  from HEAD requests to jsDelivr (cached in .cache/, since a Pyodide release
  never changes);
- "site": the wheels this site serves, keyed by their path on the site.

Without network access the Pyodide part is left out, and the page shows a
progress bar without a percentage. Run by scripts/dev.sh and the Pages
workflow, after the wheels are in place.
"""

import json
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WHEELS = ROOT / "wheels"
CACHE = ROOT / ".cache"
CORE = ["pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"]


def head_size(url):
    request = urllib.request.Request(url, method="HEAD")
    with urllib.request.urlopen(request, timeout=30) as response:
        return int(response.headers["Content-Length"])


def pyodide_sizes(version, names):
    """{"core": {file: size}, "packages": {name: size}} for these packages."""
    cache = CACHE / f"pyodide-{version}-sizes.json"
    sizes = json.loads(cache.read_text()) if cache.exists() else {"core": {}, "packages": {}}
    base = f"https://cdn.jsdelivr.net/pyodide/v{version}/full/"
    missing_core = [f for f in CORE if f not in sizes["core"]]
    missing = sorted(set(names) - set(sizes["packages"]))
    if missing_core or missing:
        with urllib.request.urlopen(base + "pyodide-lock.json", timeout=30) as response:
            files = {name: p["file_name"] for name, p in json.load(response)["packages"].items()}
        with ThreadPoolExecutor(8) as pool:
            for name, size in zip(missing_core, pool.map(lambda f: head_size(base + f), missing_core)):
                sizes["core"][name] = size
            for name, size in zip(missing, pool.map(lambda n: head_size(base + files[n]), missing)):
                sizes["packages"][name] = size
        CACHE.mkdir(exist_ok=True)
        cache.write_text(json.dumps(sizes, indent=1, sort_keys=True) + "\n")
    return sizes


def main():
    lock = json.loads((ROOT / "packages.lock.json").read_text())
    names = {name for group in lock["groups"].values() for name in group["pyodide"]}
    out = {"site": {
        path.relative_to(ROOT).as_posix(): path.stat().st_size
        for path in sorted(WHEELS.glob("*.whl")) + sorted((WHEELS / "pypi").glob("*.whl"))
    }}
    try:
        out["pyodide"] = pyodide_sizes(lock["pyodide_version"], names)
    except OSError as err:
        print(f"no Pyodide file sizes ({err}); progress will show without a percentage")
    (WHEELS / "sizes.json").write_text(json.dumps(out, indent=1, sort_keys=True) + "\n")
    print(f"wrote {WHEELS / 'sizes.json'}: {len(out['site'])} site files, "
          f"{len(out.get('pyodide', {}).get('packages', {}))} Pyodide packages")


if __name__ == "__main__":
    main()
