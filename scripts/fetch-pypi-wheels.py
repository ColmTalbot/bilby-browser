"""Download the PyPI wheels pinned in packages.lock.json into wheels/pypi/,
checking each sha256, and copy the lock to wheels/packages.lock.json so the
site can serve both. Regenerate the lock with scripts/lock-packages.mjs.
"""

import hashlib
import json
import shutil
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "wheels" / "pypi"


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    lock = json.loads((ROOT / "packages.lock.json").read_text())
    wheels = {w["file"]: w for group in lock["groups"].values() for w in group["pypi"]}
    OUT.mkdir(parents=True, exist_ok=True)
    for stale in set(p.name for p in OUT.glob("*.whl")) - set(wheels):
        (OUT / stale).unlink()
    fetched = 0
    for name, wheel in sorted(wheels.items()):
        path = OUT / name
        if path.exists() and sha256(path) == wheel["sha256"]:
            continue
        part = path.with_suffix(".part")
        with urllib.request.urlopen(wheel["url"]) as response, open(part, "wb") as f:
            shutil.copyfileobj(response, f)
        if sha256(part) != wheel["sha256"]:
            part.unlink()
            raise SystemExit(f"sha256 mismatch for {wheel['url']}")
        part.rename(path)
        fetched += 1
    shutil.copy(ROOT / "packages.lock.json", ROOT / "wheels" / "packages.lock.json")
    print(f"{len(wheels)} PyPI wheels in {OUT} ({fetched} downloaded)")


if __name__ == "__main__":
    main()
