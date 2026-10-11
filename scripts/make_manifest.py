"""Write examples/manifest.json: the nested tree of examples for the page.

Each directory node lists its subdirectories, its .py examples and its other
files, which are copied next to the example before it runs (priors, data files,
images). For each example the module docstring becomes
- "description": its first paragraph as plain text (the tree's tooltip),
- "doc": its paragraphs as HTML, converted from the reStructuredText the
  examples use, shown above the editor,
- "header_lines": how many lines the shebang, the docstring and the blank lines
  after them take up; the page leaves them out of the editor.
"""

import ast
import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "examples"
SKIP = {"manifest.json", "adaptations.json", "README.md", "README.rst", "LICENSE.md"}


# Inline markup, matched on HTML-escaped text: roles and interpreted text
# (`x`, :code:`x`, `text <url>`_), literals, strong, emphasis and bare URLs.
INLINE = re.compile(
    r"(?::[\w-]+:)?`(?P<interp>[^`]+)`_{0,2}"
    r"|``(?P<literal>.+?)``"
    r"|\*\*(?P<strong>\S.*?)\*\*"
    r"|(?<![\w*])\*(?P<em>[^\s*][^*]*?)\*(?!\w)"
    r"|(?P<url>https?://[^\s<>\"]*[^\s<>\".,;:)])",
    re.S,
)
LINK = re.compile(r"(?P<text>.*?)\s*&lt;(?P<url>https?://[^\s]+?)&gt;$", re.S)


def inline(text):
    def convert(m):
        if m["interp"] is not None:
            link = LINK.match(m["interp"])
            if link:
                return f'<a href="{link["url"]}">{link["text"] or link["url"]}</a>'
            return f"<code>{m['interp']}</code>"
        if m["literal"] is not None:
            return f"<code>{m['literal']}</code>"
        if m["strong"] is not None:
            return f"<strong>{m['strong']}</strong>"
        if m["em"] is not None:
            return f"<em>{m['em']}</em>"
        return f'<a href="{m["url"]}">{m["url"]}</a>'

    return INLINE.sub(convert, html.escape(text, quote=True))


def rst_to_html(doc):
    """The small subset of reStructuredText the examples' docstrings use:
    paragraphs, "- " lists (with or without a blank line before them),
    shell commands starting with "$ ", and inline markup. Returns a list of
    HTML blocks."""
    blocks = []
    for chunk in re.split(r"\n\s*\n", doc.strip()):
        lines = chunk.splitlines()
        if lines[0].startswith("$ "):
            blocks.append("<pre><code>" + html.escape("\n".join(lines)) + "</code></pre>")
            continue
        paragraph, items = [], []
        for line in lines:
            if re.match(r"\s*[-*] ", line):
                items.append(line.strip()[2:])
            elif items and line.startswith((" ", "\t")):
                items[-1] += " " + line.strip()
            else:
                if items:  # text after a list starts a new paragraph
                    blocks.append("<ul>" + "".join(f"<li>{inline(i)}</li>" for i in items) + "</ul>")
                    items = []
                paragraph.append(line.strip())
                continue
            if paragraph:
                blocks.append(f"<p>{inline(' '.join(paragraph))}</p>")
                paragraph = []
        if paragraph:
            blocks.append(f"<p>{inline(' '.join(paragraph))}</p>")
        if items:
            blocks.append("<ul>" + "".join(f"<li>{inline(i)}</li>" for i in items) + "</ul>")
    return blocks


def describe(path):
    """description, doc and header_lines (see the module docstring)."""
    source = path.read_text()
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return {"description": "", "doc": [], "header_lines": 0}
    doc = ast.get_docstring(tree)
    if not doc:
        return {"description": "", "doc": [], "header_lines": 0}
    lines = source.splitlines()
    end = tree.body[0].end_lineno
    while end < len(lines) and not lines[end].strip():
        end += 1
    return {
        "description": " ".join(doc.strip().split("\n\n")[0].split()),
        "doc": rst_to_html(doc),
        "header_lines": end,
    }


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
                **describe(path),
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
