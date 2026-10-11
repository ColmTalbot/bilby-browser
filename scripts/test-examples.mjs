// Run bilby examples headlessly in Pyodide under Node.
//
//   node scripts/test-examples.mjs                      # install + import check only
//   node scripts/test-examples.mjs core_examples/linear_regression.py ...
//   node scripts/test-examples.mjs --full ...         # without bilby test mode
//
// Uses the same py/bootstrap.py as the browser worker. GW examples
// (paths under gw_examples/) also install the LALSuite wheel from wheels/.
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

// copy a wheel from wheels/ into Pyodide's file system; returns its emfs: URL
function stageWheel(prefix) {
  const wheel = readdirSync(join(ROOT, "wheels")).filter((f) => f.startsWith(prefix) && f.endsWith(".whl")).sort().pop();
  if (!wheel) {
    const script = { "bilby-": "fetch-bilby.sh", "lalsuite-": "fetch-lalsuite.sh", "igwn_segments-": "build-igwn-segments.sh" }[prefix];
    throw new Error(`no ${prefix}*.whl in wheels/; run scripts/${script} (or scripts/dev.sh for everything)`);
  }
  pyodide.FS.mkdirTree("/tmp/wheels");
  pyodide.FS.writeFile(`/tmp/wheels/${wheel}`, readFileSync(join(ROOT, "wheels", wheel)));
  return `emfs:/tmp/wheels/${wheel}`;
}

console.log(`bilby test mode ${full ? "off" : "on"}`);
console.log("bilby", await py("install_bilby")(stageWheel("bilby-")), "installed after", elapsed());

if (examples.some((p) => p.startsWith("gw_examples/"))) {
  console.log("LAL", await py("install_lalsuite")(stageWheel("lalsuite-")), "installed after", elapsed());
}

let failed = 0;
for (const path of examples) {
  console.log(`\n=== ${path}`);
  const dir = dirname(path);
  const extras = py("extras_for")(readFileSync(join(ROOT, "examples", path), "utf8")).toJs();
  if (extras.length) {
    const urls = pyodide.toPy({ igwn_segments: extras.includes("gwpy") ? stageWheel("igwn_segments-") : null });
    await py("install_extras")(extras, urls);
    urls.destroy();
  }
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
    await pyodide.runPythonAsync(readFileSync(join(ROOT, "examples", path), "utf8"), { globals });
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
