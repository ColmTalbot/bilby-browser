// Resolve the package groups in py/bootstrap.py against PyPI and write
// packages.lock.json: for each group, the Pyodide packages it loads and the
// exact PyPI wheels (file, URL, sha256, licence) it adds on top of the
// "bilby" group. The site installs only from this lock.
//
//   node scripts/lock-packages.mjs
//
// Needs the local wheels (scripts/dev.sh, or the fetch/build scripts).
// Each group is resolved in a fresh Pyodide with only the bilby group
// installed, so every group is complete on its own.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPyodide } from "pyodide";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL = { bilby: "bilby-", lalsuite: "lalsuite-", igwn_segments: "igwn_segments-" };

async function freshPyodide() {
  const pyodide = await loadPyodide();
  pyodide.registerJsModule("_site", { image() {} });
  pyodide.runPython(readFileSync(join(ROOT, "py/bootstrap.py"), "utf8"));
  pyodide.FS.mkdirTree("/tmp/wheels");
  const urls = {};
  for (const [key, prefix] of Object.entries(LOCAL)) {
    const wheel = readdirSync(join(ROOT, "wheels")).filter((f) => f.startsWith(prefix) && f.endsWith(".whl")).sort().pop();
    if (!wheel) throw new Error(`no ${prefix}*.whl in wheels/; run scripts/dev.sh first`);
    pyodide.FS.writeFile(`/tmp/wheels/${wheel}`, readFileSync(join(ROOT, "wheels", wheel)));
    urls[key] = `emfs:/tmp/wheels/${wheel}`;
  }
  const pyUrls = pyodide.toPy(urls);
  pyodide.globals.get("set_lock")(null, "", pyUrls);
  pyUrls.destroy();
  return pyodide;
}

// {name: {version, source}} of everything installed
function installed(pyodide) {
  return pyodide.runPython(`
import micropip
{name: {"version": p.version, "source": p.source} for name, p in micropip.list().items()}
`).toJs({ dict_converter: Object.fromEntries });
}

// Packages whose PyPI metadata has no licence, checked by hand against the
// licence file in the wheel.
const LICENSE_OVERRIDES = { dynesty: "MIT" };

async function pypiWheel(name, version) {
  const response = await fetch(`https://pypi.org/pypi/${name}/${version}/json`);
  if (!response.ok) throw new Error(`PyPI has no ${name} ${version}`);
  const data = await response.json();
  const wheel = data.urls.find((u) => u.packagetype === "bdist_wheel" && /-none-any\.whl$/.test(u.filename));
  if (!wheel) throw new Error(`${name} ${version} has no pure-Python wheel on PyPI`);
  const info = data.info;
  const classifier = (info.classifiers || []).filter((c) => c.startsWith("License ::")).map((c) => c.split(" :: ").pop());
  const license = LICENSE_OVERRIDES[name] || info.license_expression || (info.license && info.license.length < 80 ? info.license : "") || classifier.join(", ") || "see package";
  return { name, version, file: wheel.filename, url: wheel.url, sha256: wheel.digests.sha256, license };
}

async function lockGroup(name, base) {
  const pyodide = await freshPyodide();
  const install = pyodide.globals.get("install_group");
  if (name !== "bilby") await install("bilby");
  const before = name === "bilby" ? {} : installed(pyodide);
  await install(name);
  const after = installed(pyodide);
  const added = Object.entries(after).filter(([pkg, info]) => !(pkg in before) || before[pkg].version !== info.version);
  const pyodidePackages = added.filter(([, info]) => info.source === "pyodide").map(([pkg]) => pkg).sort();
  const pypi = [];
  for (const [pkg, info] of added) {
    if (info.source === "pyodide" || info.source.startsWith("emfs:")) continue; // Pyodide or our local wheels
    pypi.push(await pypiWheel(pkg, info.version));
  }
  pypi.sort((a, b) => a.name.localeCompare(b.name));
  console.log(`${name}: ${pyodidePackages.length} Pyodide packages, ${pypi.length} PyPI wheels`);
  return { pyodide: pyodidePackages, pypi, pyodideVersion: pyodide.version };
}

const groups = {};
let pyodideVersion;
const names = (await freshPyodide()).globals.get("GROUPS").toJs({ dict_converter: Object.fromEntries });
for (const name of Object.keys(names)) {
  const { pyodideVersion: version, ...group } = await lockGroup(name);
  groups[name] = group;
  pyodideVersion = version;
}
const lock = { pyodide_version: pyodideVersion, generated_by: "scripts/lock-packages.mjs", groups };
writeFileSync(join(ROOT, "packages.lock.json"), JSON.stringify(lock, null, 1) + "\n");
console.log("wrote packages.lock.json");
process.exit(0);
