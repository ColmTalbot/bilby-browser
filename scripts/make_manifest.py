"""Write examples/manifest.json: the nested tree of examples for the page.

Each directory node lists its subdirectories, its .py examples (with the first
paragraph of the module docstring as a description) and its other files, which are
copied next to the example before it runs (priors, data files, images).
"""

import ast
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "examples"
SKIP = {"manifest.json", "adaptations.json", "README.md", "README.rst"}


def describe(path):
    try:
        doc = ast.get_docstring(ast.parse(path.read_text()))
    except SyntaxError:
        doc = None
    # first paragraph of the module docstring
    return " ".join((doc or "").strip().split("\n\n")[0].split())


def walk(directory, adaptations):
    node = {"name": directory.name, "dirs": [], "examples": [], "files": []}
    for path in sorted(directory.iterdir()):
        if path.name.startswith(".") or path.name in SKIP or path.name == "__pycache__":
            continue
        if path.is_dir():
            child = walk(path, adaptations)
            if child["examples"] or child["dirs"]:
                node["dirs"].append(child)
        elif path.suffix == ".py":
            key = path.relative_to(ROOT).as_posix()
            node["examples"].append({
                "name": path.name,
                "path": key,
                "description": describe(path),
                **adaptations.get(key, {}),
            })
        else:
            node["files"].append(path.name)
    return node


if __name__ == "__main__":
    out = ROOT / "manifest.json"
    adaptations_file = ROOT / "adaptations.json"
    adaptations = json.loads(adaptations_file.read_text()) if adaptations_file.exists() else {}
    tree = walk(ROOT, adaptations)
    commit = ROOT / ".commit"
    tree["commit"] = commit.read_text().strip() if commit.exists() else None
    out.write_text(json.dumps(tree, indent=1) + "\n")
    print(f"wrote {out}")
