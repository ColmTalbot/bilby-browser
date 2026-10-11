"""Write licenses.html: what software this site distributes, under which
licences, and where the exact source of each is.

Generated from the files that pin everything (bilby-commit.txt,
lalsuite-wheel.json, packages.lock.json), so it always matches what is
deployed. Run by scripts/dev.sh and the Pages workflow; the licence texts
it links to are in licenses/.
"""

import html
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO = "https://github.com/ColmTalbot/bilby-browser"
IGWN_SEGMENTS_VERSION = "2.1.1"  # keep in step with scripts/build-igwn-segments.sh


def link(url, text=None):
    return f'<a href="{html.escape(url)}">{html.escape(text or url)}</a>'


def row(*cells):
    return "<tr>" + "".join(f"<td>{c}</td>" for c in cells) + "</tr>"


def main():
    bilby_commit = (ROOT / "bilby-commit.txt").read_text().strip()
    lal = json.loads((ROOT / "lalsuite-wheel.json").read_text())
    lock = json.loads((ROOT / "packages.lock.json").read_text())
    bilby_tree = f"https://github.com/bilby-dev/bilby/tree/{bilby_commit}"
    lal_tree = f"{lal['source_repo']}/-/tree/{lal['source_commit']}"

    hosted = [
        row(
            "bilby (wheel)", "MIT", link("examples/LICENSE.md", "licence"),
            f"{link(bilby_tree, 'bilby-dev/bilby@' + bilby_commit[:8])}, built by "
            f"{link(REPO + '/blob/main/scripts/fetch-bilby.sh', 'scripts/fetch-bilby.sh')}",
        ),
        row(
            "bilby examples", "MIT", link("examples/LICENSE.md", "licence"),
            f"{link(bilby_tree + '/examples', 'examples at the same commit')}, adapted for "
            f"Pyodide by {link(REPO + '/blob/main/scripts/adapt_examples.py', 'scripts/adapt_examples.py')} "
            "(each change is listed in the page above the example)",
        ),
        row(
            f"igwn-segments {IGWN_SEGMENTS_VERSION} (<strong>modified</strong>)",
            "GPL-3.0-or-later", link("licenses/GPL-3.0.txt", "GPL-3.0"),
            f"{link(f'https://pypi.org/project/igwn-segments/{IGWN_SEGMENTS_VERSION}/#files', 'original sdist on PyPI')}; "
            f"rebuilt as pure Python with a modified <code>__init__.py</code> by "
            f"{link(REPO + '/blob/main/scripts/build-igwn-segments.sh', 'scripts/build-igwn-segments.sh')}",
        ),
        row(
            f"LALSuite {html.escape(lal['version'])} (Pyodide build)",
            html.escape(lal["license"]), link("licenses/GPL-2.0.txt", "GPL-2.0"),
            f"{link(lal_tree, 'colm.talbot/lalsuite@' + lal['source_commit'][:8])}; "
            f"build scripts in {link(lal_tree + '/' + lal['build_scripts'], lal['build_scripts'])}; "
            f"{link(lal['url'], 'wheel as built')} (sha256 <code>{lal['sha256'][:16]}…</code>)",
        ),
    ]
    npm = json.loads((ROOT / "package-lock.json").read_text())["packages"]
    cm_version = npm["node_modules/codemirror"]["version"]
    hosted.append(row(
        f"CodeMirror {html.escape(cm_version)} and its packages (code editor)", "MIT",
        link("editor.bundle.LICENSE.txt", "licences"),
        f"{link('https://github.com/codemirror/dev', 'codemirror/dev')} and the package versions pinned in "
        f"{link(REPO + '/blob/main/package-lock.json', 'package-lock.json')}; bundled by esbuild "
        f"from {link(REPO + '/blob/main/editor/editor.js', 'editor/editor.js')}",
    ))
    bundled = [
        row(
            html.escape(f"{lib['name']} {lib['version']}".strip()), html.escape(lib["license"]),
            link("licenses/" + lib["license_file"], "licence"), link(lib["source"], "source"),
        )
        for lib in lal["bundled"]
    ]
    pypi = {}
    for group in lock["groups"].values():
        for wheel in group["pypi"]:
            pypi[wheel["file"]] = wheel
    pypi_rows = [
        row(
            html.escape(f"{w['name']} {w['version']}"), html.escape(w["license"]),
            link(f"https://pypi.org/project/{w['name']}/{w['version']}/", "PyPI page and source"),
            link("wheels/pypi/" + w["file"], "wheel served here"),
        )
        for w in sorted(pypi.values(), key=lambda w: w["name"].lower())
    ]

    page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bilby licences</title>
<style>
  :root {{ --bg: #fff; --fg: #1d1d1f; --muted: #6b6b70; --border: #d8d8dc; --accent: #2457c5;
          font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }}
  @media (prefers-color-scheme: dark) {{
    :root {{ --bg: #161618; --fg: #ececf0; --muted: #9a9aa2; --border: #34343a; --accent: #7aa2ff; }}
  }}
  body {{ margin: 0 auto; max-width: 1000px; padding: 16px; background: var(--bg); color: var(--fg);
         line-height: 1.5; font-size: 14px; }}
  a {{ color: var(--accent); }}
  h1 {{ font-size: 20px; }} h2 {{ font-size: 16px; margin-top: 28px; }}
  p {{ max-width: 75ch; }}
  .table {{ overflow-x: auto; }}
  table {{ border-collapse: collapse; width: 100%; font-size: 13px; }}
  td, th {{ border-bottom: 1px solid var(--border); padding: 6px 8px; text-align: left; vertical-align: top; }}
  th {{ color: var(--muted); font-weight: 600; }}
  code {{ font-size: 12px; }}
</style>
</head>
<body>
<p><a href="./">← Back to Bilby</a></p>
<h1>Licences and source code</h1>
<p>This site runs <a href="https://github.com/bilby-dev/bilby">bilby</a> in your browser.
To do that it sends your browser copies of the software below, each under its own licence.
For every component there is a link to the exact source it was built from.</p>
<p>The site's own code is under the MIT licence: {link(REPO + '/blob/main/LICENSE', 'LICENSE')},
source at {link(REPO)}.</p>

<h2>Built for and served by this site</h2>
<div class="table"><table>
<tr><th>Component</th><th>Licence</th><th>Text</th><th>Source</th></tr>
{''.join(hosted)}
</table></div>

<h2>Libraries built into the LALSuite wheel</h2>
<p>The LALSuite wheel statically links these libraries; because GSL is GPL-3.0-or-later,
the combined wheel can only be redistributed under GPL-3.0-or-later.
The build scripts linked above download exactly these releases.</p>
<div class="table"><table>
<tr><th>Library</th><th>Licence</th><th>Text</th><th>Source</th></tr>
{''.join(bundled)}
</table></div>

<h2>Python packages from PyPI, served by this site</h2>
<p>Unmodified wheels pinned in {link(REPO + '/blob/main/packages.lock.json', 'packages.lock.json')};
each wheel contains its own licence file.</p>
<div class="table"><table>
<tr><th>Package</th><th>Licence</th><th>Source</th><th>Wheel</th></tr>
{''.join(pypi_rows)}
</table></div>

<h2>Loaded from elsewhere</h2>
<p><a href="https://pyodide.org">Pyodide</a> {html.escape(lock['pyodide_version'])} (MPL-2.0) and the packages
it builds (numpy, scipy, matplotlib, astropy, …, each under its own licence) are loaded by your browser
directly from the jsDelivr CDN; see the
<a href="https://pyodide.org/en/stable/usage/packages-in-pyodide.html">Pyodide package list</a>.
Gravitational-wave data, when used, comes from <a href="https://gwosc.org">GWOSC</a> under its own terms.</p>
</body>
</html>
"""
    (ROOT / "licenses.html").write_text(page)
    print(f"wrote {ROOT / 'licenses.html'}: {len(hosted)} hosted, {len(bundled)} bundled, {len(pypi_rows)} PyPI")


if __name__ == "__main__":
    main()
