// Run bilby examples headlessly in Pyodide under Node.
//
//   node scripts/test-examples.mjs                      # install + import check only
//   node scripts/test-examples.mjs core_examples/linear_regression.py ...
//   node scripts/test-examples.mjs --full ...         # without bilby test mode
//
// Uses the same py/bootstrap.py, wheels and package lock as the browser
// worker; LALSuite and extras are installed when an example needs them.
// Node has no XMLHttpRequest, so downloads through gwpy/astropy do not work
// here (see _enable_sync_downloads in py/bootstrap.py).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPyodide } from "pyodide";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// bilby test mode (short sampling runs) is on unless --full is given
const full = process.argv.includes("--full");
const examples = process.argv.slice(2).filter((a) => a !== "--full");

const t0 = performance.now();
const elapsed = () => ((performance.now() - t0) / 1000).toFixed(1) + " s";

const pyodide = await loadPyodide();
let images = 0;
pyodide.registerJsModule("_site", {
  image: (name) => { images++; console.log(`[image] ${name}`); },
});
pyodide.runPython(readFileSync(join(ROOT, "py/bootstrap.py"), "utf8"));
const py = (name) => pyodide.globals.get(name);
py("add_module")("gwosc_range", readFileSync(join(ROOT, "py/gwosc_range.py"), "utf8"));

// Install from the same files the site serves: copy wheels/ (local wheels,
// the pinned PyPI wheels and the lock) into Pyodide's file system.
const WHEELS = join(ROOT, "wheels");
let index, lock;
try {
  index = JSON.parse(readFileSync(join(WHEELS, "index.json"), "utf8"));
  lock = readFileSync(join(WHEELS, "packages.lock.json"), "utf8");
} catch {
  throw new Error("wheels/ is incomplete; run scripts/dev.sh (or the fetch/build scripts it runs)");
}
pyodide.FS.mkdirTree("/tmp/wheels/pypi");
const urls = {};
for (const [key, wheel] of Object.entries(index)) {
  if (!wheel) continue;
  pyodide.FS.writeFile(`/tmp/wheels/${wheel}`, readFileSync(join(WHEELS, wheel)));
  urls[key] = `emfs:/tmp/wheels/${wheel}`;
}
for (const wheel of readdirSync(join(WHEELS, "pypi"))) {
  pyodide.FS.writeFile(`/tmp/wheels/pypi/${wheel}`, readFileSync(join(WHEELS, "pypi", wheel)));
}
const pyUrls = pyodide.toPy(urls);
py("set_lock")(lock, "emfs:/tmp/wheels/pypi/", pyUrls);
pyUrls.destroy();

console.log(`bilby test mode ${full ? "off" : "on"}`);
console.log("bilby", await py("install_bilby")(), "installed after", elapsed());

// same rule as worker.js
const needsLalsuite = (path, code) => path.startsWith("gw_examples/") || /\b(lal\w*|bilby\.gw)\b/.test(code);
let lalsuite = false;

let failed = 0;
for (const path of examples) {
  console.log(`\n=== ${path}`);
  const dir = dirname(path);
  const code = readFileSync(join(ROOT, "examples", path), "utf8");
  if (!lalsuite && needsLalsuite(path, code)) {
    console.log("LAL", await py("install_lalsuite")(), "installed after", elapsed());
    lalsuite = true;
  }
  const extras = py("extras_for")(code).toJs();
  if (extras.length) await py("install_extras")(extras);
  py("set_test_mode")(!full);
  const globals = pyodide.toPy(py("prepare")(path).toJs({ dict_converter: Object.fromEntries }));
  // copy the example's sibling data files (priors, text data, images)
  for (const name of readdirSync(join(ROOT, "examples", dir))) {
    const src = join(ROOT, "examples", dir, name);
    if (statSync(src).isFile() && !name.endsWith(".py")) {
      pyodide.FS.writeFile(join("/home/pyodide/examples", dir, name), readFileSync(src));
    }
  }
  const since = py("now")();
  const start = performance.now();
  try {
    await pyodide.runPythonAsync(code, { globals });
    py("show")();
    py("send_new_images")(since);
    console.log(`=== ${path}: ok in ${((performance.now() - start) / 1000).toFixed(1)} s`);
  } catch (err) {
    failed++;
    console.log(String(err.message || err));
    console.log(`=== ${path}: FAILED`);
  } finally {
    globals.destroy();
  }
}
console.log(`\n${examples.length - failed}/${examples.length} examples passed, ${images} images, total ${elapsed()}`);
process.exit(failed ? 1 : 0);
