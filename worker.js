// Runs Pyodide and bilby off the main thread. Messages:
//   in:  {type: "run", path, code, files, testMode}
//   out: {type: "status" | "ready" | "info" | "stream" | "image" | "results" | "done" | "error", ...}
// The page stops a run by terminating this worker and starting a new one.
importScripts("https://cdn.jsdelivr.net/pyodide/v0.29.5/full/pyodide.js");

let pyodide = null;
let lalsuite = null;
const post = (type, data = {}) => postMessage({ type, ...data });
const py = (name) => pyodide.globals.get(name);

function stream(kind) {
  const decoder = new TextDecoder();
  return {
    write(buffer) {
      post("stream", { kind, text: decoder.decode(buffer, { stream: true }) });
      return buffer.length;
    },
  };
}

const REPORT = "Please report this at https://github.com/ColmTalbot/bilby-browser/issues";
const siteUrl = (path) => new URL(path, self.location).href;
// "?v=<commit>" from app.js, so a new deploy never mixes with cached files
const versioned = (path) => path + self.location.search;

async function fetchText(path, what) {
  const response = await fetch(versioned(path));
  if (!response.ok) {
    throw new Error(`This site could not load its ${what} (HTTP ${response.status}). ${REPORT}`);
  }
  return response.text();
}

async function init() {
  post("status", { text: "Loading Pyodide…" });
  pyodide = await loadPyodide();
  pyodide.setStdout(stream("stdout"));
  pyodide.setStderr(stream("stderr"));
  pyodide.registerJsModule("_site", { image: (name, b64) => post("image", { name, b64 }) });
  pyodide.runPython(await fetchText("py/bootstrap.py", "Python setup code"));

  // Everything is installed from the site itself: the local wheels listed in
  // wheels/index.json and the PyPI wheels pinned in wheels/packages.lock.json.
  const index = JSON.parse(await fetchText("wheels/index.json", "package list"));
  const lock = await fetchText("wheels/packages.lock.json", "package lock");
  const urls = {};
  for (const [key, wheel] of Object.entries(index)) {
    if (wheel) urls[key] = siteUrl("wheels/" + wheel);
  }
  const pyUrls = pyodide.toPy(urls);
  try {
    py("set_lock")(lock, siteUrl("wheels/pypi/"), pyUrls);
  } finally {
    pyUrls.destroy();
  }
  post("status", { text: "Installing bilby…" });
  const version = await py("install_bilby")();
  post("ready", { text: `bilby ${version} · Pyodide ${pyodide.version}` });
}

// LALSuite is about 19 MB, so install it the first time a GW example runs.
function installLalsuite() {
  lalsuite ??= (async () => {
    post("status", { text: "Installing LALSuite…" });
    post("info", { text: `LAL ${await py("install_lalsuite")()} installed` });
  })();
  return lalsuite;
}

const needsLalsuite = (path, code) =>
  path.startsWith("gw_examples/") || /\b(lal\w*|bilby\.gw)\b/.test(code);

async function run({ path, code, files, testMode }) {
  const start = performance.now();
  if (needsLalsuite(path, code)) {
    await installLalsuite();
    post("status", { text: `Running ${path}…` });
  }
  const extras = py("extras_for")(code).toJs();
  if (extras.length) {
    post("status", { text: `Installing ${extras.join(", ")}…` });
    await py("install_extras")(extras);
    post("status", { text: `Running ${path}…` });
  }
  py("set_test_mode")(testMode);
  const globals = py("prepare")(path);
  // copy the example's data files (priors, text data, images) next to it
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  for (const name of files) {
    const response = await fetch(versioned(`examples/${dir}/${name}`));
    pyodide.FS.writeFile(name, new Uint8Array(await response.arrayBuffer()));
  }
  const since = py("now")();
  try {
    await pyodide.runPythonAsync(code, { globals, filename: path });
  } finally {
    // show figures even if the example failed part way through
    py("show")();
    py("send_new_images")(since);
    sendResults(path, since);
    globals.destroy();
  }
  post("done", { seconds: (performance.now() - start) / 1000 });
}

// everything the run wrote (results, figures, data), zipped for download
function sendResults(path, since) {
  const stem = path.split("/").pop().replace(/\.py$/, "");
  const zipped = py("zip_new_files")(since, stem + "_results");
  if (!zipped) return;
  const [bytes, count] = zipped.toJs();
  zipped.destroy();
  postMessage({ type: "results", name: stem + "_results.zip", bytes, count }, [bytes.buffer]);
}

const ready = init().catch((err) => post("error", { text: String(err.stack || err), fatal: true }));

self.onmessage = async ({ data }) => {
  await ready;
  if (data.type !== "run") return;
  try {
    await run(data);
  } catch (err) {
    post("error", { text: String(err.message || err) });
  }
};
