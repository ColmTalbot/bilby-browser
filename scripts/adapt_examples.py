"""Adapt the bilby examples (fresh from scripts/fetch-bilby.sh) to Pyodide.

Edits the files in examples/ in place and writes examples/adaptations.json,
which make_manifest.py merges into the manifest so the page can say what was
changed and which examples cannot run in the browser.
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "examples"

# (description, function from source text to new source text)
EDITS = [
    (
        "sampler pymultinest replaced by nestle (MultiNest is compiled code)",
        lambda text: text.replace('"pymultinest"', '"nestle"'),
    ),
    (
        "sampler cpnest replaced by dynesty (cpnest is not available)",
        lambda text: text.replace('"cpnest"', '"dynesty"'),
    ),
    (
        "lines with npool= removed (no multiprocessing in Pyodide)",
        lambda text: "".join(
            line for line in text.splitlines(keepends=True) if "npool=" not in line
        ),
    ),
]

# Examples that cannot run (fully) in the browser, and why.
UNSUPPORTED = {
    "core_examples/alternative_samplers/linear_regression_pymc.py":
        "needs pymc, which needs numba; numba is not available in Pyodide",
    "core_examples/alternative_samplers/linear_regression_pymc_custom_likelihood.py":
        "needs pymc, which needs numba; numba is not available in Pyodide",
    "core_examples/gaussian_process_celerite_example.py":
        "needs celerite, which is compiled code with no Pyodide build",
    "core_examples/gaussian_process_george_example.py":
        "needs george, which is compiled code with no Pyodide build",
    "gw_examples/injection_examples/jax_fast_tutorial.py":
        "needs JAX, which is not available in Pyodide",
    "gw_examples/data_examples/read_data_from_channel_name.py":
        "needs GraceDB credentials and data only available on LIGO clusters",
    "gw_examples/data_examples/read_gracedb_data.py":
        "needs GraceDB credentials and data only available on LIGO clusters",
    "gw_examples/injection_examples/roq_example.py":
        "needs ROQ basis files that are not available here yet",
}
PARTIAL = {
    "gw_examples/injection_examples/plot_skymap.py":
        "sampling runs, but the final skymap needs ligo.skymap (compiled code)",
}


def adapt():
    adaptations = {}
    for path in sorted(ROOT.rglob("*.py")):
        key = path.relative_to(ROOT).as_posix()
        text = path.read_text()
        changes = []
        for description, edit in EDITS:
            new = edit(text)
            if new != text:
                changes.append(description)
                text = new
        if changes:
            path.write_text(text)
        entry = {}
        if changes:
            entry["changes"] = changes
        if key in UNSUPPORTED:
            entry["support"] = {"status": "unsupported", "reason": UNSUPPORTED[key]}
        elif key in PARTIAL:
            entry["support"] = {"status": "partial", "reason": PARTIAL[key]}
        if entry:
            adaptations[key] = entry
    missing = (set(UNSUPPORTED) | set(PARTIAL)) - {
        p.relative_to(ROOT).as_posix() for p in ROOT.rglob("*.py")
    }
    for key in sorted(missing):
        print(f"warning: {key} is listed in adapt_examples.py but no longer exists")
    out = ROOT / "adaptations.json"
    out.write_text(json.dumps(adaptations, indent=1) + "\n")
    print(f"adapted {sum('changes' in e for e in adaptations.values())} examples, wrote {out}")


if __name__ == "__main__":
    adapt()
