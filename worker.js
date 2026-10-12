// Runs Pyodide and bilby off the main thread. Messages:
//   in:  {type: "run", path, code, files, uploads, testMode, logLevel}
//        (uploads: [{name, bytes}], files the user added, written next to the example)
//   in:  {type: "read", path}  (a file the run wrote; answered with "file")
//   out: {type: "status" | "progress" | "ready" | "info" | "stream" | "image" | "files" | "file" | "results" | "done" | "error", ...}
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
      watchFiles();
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

// ---- download progress ----------------------------------------------------
// While start-up or an install runs, every response fetched (by Pyodide,
// micropip or this file) is counted as it arrives, against the total that
// wheels/sizes.json predicts; the page draws the bar. Counting reads a clone,
// so the response itself is untouched.

let sizes = { site: {} };
let lock = null;
let index = {};
let phase = null; // {label, received, expected}; expected 0 = unknown
let lastProgress = 0;

const realFetch = self.fetch.bind(self);
self.fetch = async (...args) => {
  const response = await realFetch(...args);
  if (phase && response.ok && response.body) count(response.clone(), phase);
  return response;
};

async function count(response, current) {
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      current.received += value.length;
      progress(current);
    }
  } catch {
    // only the bar is affected
  }
}

function progress(current, force = false) {
  const now = performance.now();
  if (current !== phase || (!force && now - lastProgress < 100)) return;
  lastProgress = now;
  post("progress", { label: current.label, received: current.received, expected: current.expected });
}

function setPhaseLabel(label) {
  phase.label = label;
  post("status", { text: label + "…" });
  progress(phase, true);
}

async function withProgress(label, expected, fn) {
  phase = { label, received: 0, expected };
  setPhaseLabel(label);
  try {
    return await fn();
  } finally {
    phase = null;
    post("progress", { done: true });
  }
}

// The site-built wheel in each group (see GROUPS in py/bootstrap.py).
const LOCAL_WHEELS = { bilby: "bilby", lalsuite: "lalsuite", gwpy: "igwn_segments" };

// Bytes still to download to install these groups, or 0 if unknown.
function groupBytes(names) {
  const loaded = pyodide ? pyodide.loadedPackages : {};
  const files = new Map();
  for (const name of names) {
    const group = lock.groups[name];
    for (const pkg of group.pyodide) {
      if (pkg in loaded) continue;
      const size = sizes.pyodide?.packages?.[pkg];
      if (size == null) return 0;
      files.set("pyodide:" + pkg, size);
    }
    for (const wheel of group.pypi) files.set(wheel.file, sizes.site["wheels/pypi/" + wheel.file] ?? 0);
    const local = index[LOCAL_WHEELS[name]];
    if (local) files.set(local, sizes.site["wheels/" + local] ?? 0);
  }
  return [...files.values()].reduce((a, b) => a + b, 0);
}

async function init() {
  // Everything is installed from the site itself: the local wheels listed in
  // wheels/index.json and the PyPI wheels pinned in wheels/packages.lock.json.
  const lockText = await fetchText("wheels/packages.lock.json", "package lock");
  lock = JSON.parse(lockText);
  index = JSON.parse(await fetchText("wheels/index.json", "package list"));
  try {
    sizes = JSON.parse(await fetchText("wheels/sizes.json", "file sizes"));
  } catch {
    // no sizes: the bar shows activity without a percentage
  }
  const core = sizes.pyodide ? Object.values(sizes.pyodide.core).reduce((a, b) => a + b, 0) : 0;
  const bilby = groupBytes(["bilby"]);
  const expected = core && bilby ? core + bilby : 0;

  const version = await withProgress("Loading Pyodide", expected, async () => {
    pyodide = await loadPyodide();
    pyodide.setStdout(stream("stdout"));
    pyodide.setStderr(stream("stderr"));
    pyodide.registerJsModule("_site", {
      image: (name, b64) => { post("image", { name, b64 }); watchFiles(); },
    });
    pyodide.runPython(await fetchText("py/bootstrap.py", "Python setup code"));
    py("add_module")("gwosc_range", await fetchText("py/gwosc_range.py", "Python setup code"));
    const urls = {};
    for (const [key, wheel] of Object.entries(index)) {
      if (wheel) urls[key] = siteUrl("wheels/" + wheel);
    }
    const pyUrls = pyodide.toPy(urls);
    try {
      py("set_lock")(lockText, siteUrl("wheels/pypi/"), pyUrls);
    } finally {
      pyUrls.destroy();
    }
    setPhaseLabel("Installing bilby");
    return await py("install_bilby")();
  });
  post("ready", { text: `bilby ${version} · Pyodide ${pyodide.version}` });
}

// LALSuite is about 15 MB, so install it the first time a GW example runs.
function installLalsuite() {
  lalsuite ??= withProgress("Installing LALSuite", groupBytes(["lalsuite"]), async () => {
    post("info", { text: `LAL ${await py("install_lalsuite")()} installed` });
  });
  return lalsuite;
}

const needsLalsuite = (path, code) =>
  path.startsWith("gw_examples/") || /\b(lal\w*|bilby\.gw)\b/.test(code);

async function run({ path, code, files, uploads = [], testMode, logLevel = "ERROR" }) {
  const start = performance.now();
  watched = null;
  if (needsLalsuite(path, code)) {
    await installLalsuite();
    post("status", { text: `Running ${path}…` });
  }
  const extras = py("extras_for")(code).toJs();
  if (extras.length) {
    await withProgress(`Installing ${extras.join(", ")}`, groupBytes(extras), () => py("install_extras")(extras));
    post("status", { text: `Running ${path}…` });
  }
  py("set_test_mode")(testMode);
  py("set_log_level")(logLevel);
  const globals = py("prepare")(path);
  // copy the example's data files (priors, text data, images) next to it
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  for (const name of files) {
    const response = await fetch(versioned(`examples/${dir}/${name}`));
    pyodide.FS.writeFile(name, new Uint8Array(await response.arrayBuffer()));
  }
  // and the user's own files, after them so an upload can replace one; dated
  // in the past so they are not taken for files the run wrote
  for (const { name, bytes } of uploads) {
    pyodide.FS.writeFile(name, bytes);
    pyodide.FS.utime(name, 0, 0);
  }
  const since = py("now")();
  watched = { dir: pyodide.FS.cwd(), since: since * 1000, seen: new Map(), last: 0 };
  post("files", { files: [], reset: true });
  try {
    await pyodide.runPythonAsync(code, { globals, filename: path });
  } finally {
    // show figures even if the example failed part way through
    py("show")();
    watchFiles(true);
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

// ---- files the run writes -------------------------------------------------
// While Python runs, this thread cannot answer messages, so the files the
// run writes (checkpoint plots, resume files, results) are sent to the page
// as they change: whenever Python prints (samplers report progress often) at
// most every WATCH_INTERVAL ms, and once more at the end. The page keeps
// them, so they outlast Stop. Larger files are read on request after the run.

const WATCH_INTERVAL = 2000;
const PUSH_LIMIT = 5 * 1024 ** 2;
let watched = null; // {dir, since (ms), seen: path -> "mtime:size", last}

function listFiles(dir, since, prefix = "", found = []) {
  const FS = pyodide.FS;
  for (const name of FS.readdir(dir)) {
    if (name === "." || name === "..") continue;
    const full = dir + "/" + name;
    const stat = FS.stat(full);
    if (FS.isDir(stat.mode)) listFiles(full, since, prefix + name + "/", found);
    else if (FS.isFile(stat.mode) && +stat.mtime >= since) {
      found.push({ path: prefix + name, size: stat.size, mtime: +stat.mtime });
    }
  }
  return found;
}

function watchFiles(force = false) {
  if (!watched) return;
  const now = performance.now();
  if (!force && now - watched.last < WATCH_INTERVAL) return;
  watched.last = now;
  let files;
  try {
    files = listFiles(watched.dir, watched.since);
  } catch {
    return; // the directory was removed or renamed part way through
  }
  post("files", { files });
  for (const file of files) {
    const key = `${file.mtime}:${file.size}`;
    if (watched.seen.get(file.path) === key || file.size > PUSH_LIMIT) continue;
    watched.seen.set(file.path, key);
    sendFile(file);
  }
}

function sendFile({ path }) {
  const full = watched.dir + "/" + path;
  try {
    const mtime = +pyodide.FS.stat(full).mtime;
    const bytes = pyodide.FS.readFile(full);
    postMessage({ type: "file", path, mtime, bytes }, [bytes.buffer]);
  } catch {
    post("file", { path, missing: true });
  }
}

const ready = init().catch((err) => post("error", { text: String(err.stack || err), fatal: true }));

self.onmessage = async ({ data }) => {
  await ready;
  if (data.type === "read") {
    if (watched) sendFile({ path: data.path });
    return;
  }
  if (data.type !== "run") return;
  try {
    await run(data);
  } catch (err) {
    post("error", { text: String(err.message || err) });
  }
};
