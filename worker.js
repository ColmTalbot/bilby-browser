// Runs Pyodide and bilby off the main thread. Messages:
//   in:  {type: "run", path, code, files, testMode}
//   out: {type: "status" | "ready" | "info" | "stream" | "image" | "done" | "error", ...}
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

async function wheelIndex() {
  const response = await fetch("wheels/index.json");
  if (!response.ok) {
    throw new Error(`This site could not load its package list (HTTP ${response.status}). ${REPORT}`);
  }
  return response.json();
}

async function init() {
  post("status", { text: "Loading Pyodide…" });
  pyodide = await loadPyodide();
  pyodide.setStdout(stream("stdout"));
  pyodide.setStderr(stream("stderr"));
  pyodide.registerJsModule("_site", { image: (name, b64) => post("image", { name, b64 }) });
  pyodide.runPython(await (await fetch("py/bootstrap.py")).text());
  const index = await wheelIndex();
  if (!index.bilby) throw new Error(`This site is missing its bilby package, so Python cannot start. ${REPORT}`);
  post("status", { text: `Installing ${index.bilby}…` });
  const version = await py("install_bilby")(new URL("wheels/" + index.bilby, self.location).href);
  post("ready", { text: `bilby ${version} · Pyodide ${pyodide.version}` });
}

// LALSuite is about 19 MB, so install it the first time a GW example runs.
function installLalsuite() {
  lalsuite ??= (async () => {
    const index = await wheelIndex();
    if (!index.lalsuite) {
      throw new Error(`This site is missing its LALSuite package, so gravitational-wave examples cannot run. ${REPORT}`);
    }
    post("status", { text: `Installing ${index.lalsuite}…` });
    const url = new URL("wheels/" + index.lalsuite, self.location).href;
    post("info", { text: `LAL ${await py("install_lalsuite")(url)} installed` });
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
    const index = await wheelIndex();
    const urls = {};
    for (const [key, wheel] of Object.entries(index)) {
      if (wheel) urls[key] = new URL("wheels/" + wheel, self.location).href;
    }
    const pyUrls = pyodide.toPy(urls);
    try {
      await py("install_extras")(extras, pyUrls);
    } finally {
      pyUrls.destroy();
    }
    post("status", { text: `Running ${path}…` });
  }
  py("set_test_mode")(testMode);
  const globals = py("prepare")(path);
  // copy the example's data files (priors, text data, images) next to it
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  for (const name of files) {
    const response = await fetch(`examples/${dir}/${name}`);
    pyodide.FS.writeFile(name, new Uint8Array(await response.arrayBuffer()));
  }
  const since = py("now")();
  try {
    await pyodide.runPythonAsync(code, { globals, filename: path });
  } finally {
    // show figures even if the example failed part way through
    py("show")();
    py("send_new_images")(since);
    globals.destroy();
  }
  post("done", { seconds: (performance.now() - start) / 1000 });
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
