"""Write wheels/index.json: the newest wheel of each kind the page installs.

Run by scripts/dev.sh and the Pages workflow, so the index always matches the
wheels that are actually present.
"""

import json
from pathlib import Path

WHEELS = Path(__file__).resolve().parent.parent / "wheels"
KINDS = {
    "bilby": "bilby-*.whl",
    "lalsuite": "lalsuite-*.whl",
    "igwn_segments": "igwn_segments-*.whl",
}

if __name__ == "__main__":
    index = {}
    for key, pattern in KINDS.items():
        found = sorted(p.name for p in WHEELS.glob(pattern))
        index[key] = found[-1] if found else None
    (WHEELS / "index.json").write_text(json.dumps(index, indent=1) + "\n")
    print(f"wrote {WHEELS / 'index.json'}: {index}")
