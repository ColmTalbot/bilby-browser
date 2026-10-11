// Page logic: the example tree, the editor and the output pane.
// Python runs in worker.js; see that file for the message protocol.

const $ = (id) => document.getElementById(id);
// "?v=<commit>" on this script when deployed: passed on to everything fetched
// later so a new deploy never mixes with cached files
const VERSION = new URL(document.currentScript.src).search;
const versioned = (path) => path + VERSION;
const output = $("output");
const SCRATCH = "scratch.py"; // the blank editor, at #scratch
const editor = BilbyEditor.createEditor($("code"), {
  onRun: () => run(),
  onChange: (text) => { if (current?.path === SCRATCH) store("bilby-scratch", text); },
  placeholderText: "# A blank editor: bilby, its samplers and LALSuite are available.\n# Ctrl/⌘+Enter to run.",
});
let worker = null;
let current = null; // {path, files, original}
let running = false;

// localStorage, which can be unavailable (private windows, blocked storage)
function stored(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function store(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

function setStatus(text, cls = "") {
  $("status").textContent = text;
  $("status").className = cls;
}

function setRunning(value) {
  running = value;
  $("run").disabled = value || !worker?.ready;
  $("stop").disabled = !value;
}

// ---- output ---------------------------------------------------------------

const nearBottom = () => output.scrollHeight - output.scrollTop - output.clientHeight < 40;

// where output goes: the latest run's block, or the pane itself
let block = output;

function scrolled(fn) {
  const stick = nearBottom();
  fn();
  if (stick) output.scrollTop = output.scrollHeight;
}

function append(text, cls) {
  scrolled(() => {
    const pre = document.createElement("pre");
    if (cls) pre.className = cls;
    pre.textContent = text;
    block.appendChild(pre);
  });
  line = null;
}

// Start a collapsible block for a run; earlier runs collapse.
function startRun(text, cls) {
  for (const old of output.querySelectorAll("details.run-block")) old.open = false;
  scrolled(() => {
    const details = document.createElement("details");
    details.className = "run-block";
    details.open = true;
    const summary = document.createElement("summary");
    summary.className = cls;
    summary.textContent = text;
    details.appendChild(summary);
    output.appendChild(details);
    block = details;
  });
  line = null;
}

// Terminal-style stream output: "\r" rewrites the current line, which keeps
// dynesty and tqdm progress bars on one line.
let line = null;
let lineKind = null;
let carriageReturn = false;

function write(kind, text) {
  scrolled(() => {
    for (const part of text.split(/(\r\n|\n|\r)/)) {
      if (part === "\n" || part === "\r\n") {
        if (!line) newLine(kind);
        line = null;
        carriageReturn = false;
      } else if (part === "\r") {
        carriageReturn = true;
      } else if (part) {
        if (!line || lineKind !== kind) newLine(kind);
        if (carriageReturn) line.textContent = "";
        carriageReturn = false;
        line.textContent += part;
      }
    }
  });
}

function newLine(kind) {
  line = document.createElement("pre");
  line.className = kind;
  lineKind = kind;
  block.appendChild(line);
}

function showImage(name, b64) {
  scrolled(() => {
    const figure = document.createElement("figure");
    const img = document.createElement("img");
    img.src = "data:image/png;base64," + b64;
    img.alt = name;
    img.addEventListener("click", () => openFigure(img.src, name));
    const caption = document.createElement("figcaption");
    caption.textContent = name;
    const download = document.createElement("a");
    download.href = img.src;
    download.download = name.split("/").pop();
    download.textContent = "download";
    caption.appendChild(download);
    figure.append(img, caption);
    block.appendChild(figure);
  });
  line = null;
}

// a figure enlarged over the page, with a download link
function openFigure(src, name) {
  const box = $("lightbox");
  box.querySelector("img").src = src;
  box.querySelector("img").alt = name;
  const download = box.querySelector("a");
  download.href = src;
  download.download = name.split("/").pop();
  box.showModal();
}
$("lightbox").addEventListener("click", (e) => { if (e.target.tagName !== "A") $("lightbox").close(); });

// ---- worker ---------------------------------------------------------------

function startWorker() {
  worker = new Worker(versioned("worker.js"));
  worker.ready = false;
  setRunning(false);
  setStatus("Starting Python…");
  worker.onmessage = ({ data }) => {
    switch (data.type) {
      case "status":
        setStatus(data.text);
        break;
      case "ready":
        worker.ready = true;
        setStatus("Ready: " + data.text, "ok");
        setRunning(running);
        break;
      case "info":
        append(data.text, "info");
        break;
      case "stream":
        write(data.kind, data.text);
        break;
      case "image":
        showImage(data.name, data.b64);
        break;
      case "done":
        append(`finished in ${data.seconds.toFixed(1)} s`, "info");
        setStatus("Ready", "ok");
        setRunning(false);
        break;
      case "error":
        append(data.text, "error");
        markTracebackLine(data.text);
        setStatus(data.fatal ? "Failed to start Python" : "Ready (last run failed)", data.fatal ? "err" : "");
        setRunning(false);
        break;
    }
  };
}

// Highlight the line of the example that a traceback points at: the last
// frame in the example itself (the worker runs it with filename = its path).
function markTracebackLine(text) {
  if (!current) return;
  const frame = new RegExp(`File "${current.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}", line (\\d+)`, "g");
  const lines = [...text.matchAll(frame)].map((m) => Number(m[1]));
  if (lines.length) editor.markErrorLine(lines[lines.length - 1]);
}

function run() {
  if (!current || running || !worker?.ready) return;
  setRunning(true);
  setStatus("Running " + current.path + "…");
  const testMode = $("test-mode").checked;
  startRun(">>> " + current.path + (testMode ? " (test mode)" : ""), testMode ? "run test" : "run");
  editor.markErrorLine(null);
  worker.postMessage({ type: "run", path: current.path, code: editor.getValue(), files: current.files, testMode });
}

function stop() {
  if (!running) return;
  worker.terminate();
  append("stopped; restarting Python", "error");
  block = output;
  running = false;
  startWorker();
}

// ---- example tree ---------------------------------------------------------

function buildTree(node, parent, depth = 0) {
  for (const dir of node.dirs) {
    const details = document.createElement("details");
    details.open = depth === 0;
    const summary = document.createElement("summary");
    summary.textContent = dir.name;
    details.appendChild(summary);
    const list = document.createElement("div");
    list.className = "children";
    details.appendChild(list);
    buildTree(dir, list, depth + 1);
    parent.appendChild(details);
  }
  for (const example of node.examples) {
    const link = document.createElement("a");
    link.href = "#" + example.path;
    link.textContent = example.name;
    link.title = example.description;
    link.dataset.path = example.path;
    link.dataset.files = JSON.stringify(node.files);
    link.dataset.info = JSON.stringify({ changes: example.changes || [], support: example.support || null });
    if (example.support) {
      link.classList.add(example.support.status);
      link.title += `\n\n${example.support.status}: ${example.support.reason}`;
    }
    parent.appendChild(link);
  }
}

// Show only the examples whose path matches every word typed, with their
// folders opened; an empty search restores the folders as they were.
let openBeforeSearch = null;
function filterTree(query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const folders = [...document.querySelectorAll("#tree details")];
  if (words.length && !openBeforeSearch) openBeforeSearch = folders.map((d) => d.open);
  let any = false;
  for (const a of document.querySelectorAll("#tree a")) {
    const match = words.every((w) => a.dataset.path.toLowerCase().includes(w));
    a.classList.toggle("hidden", !match);
    any ||= match;
  }
  // innermost folders first, so a parent sees whether its children are visible
  for (const details of folders.reverse()) {
    const visible = !words.length || details.querySelector(".children > :not(.hidden)") !== null;
    details.classList.toggle("hidden", !visible);
    if (words.length) details.open = visible;
  }
  if (!words.length && openBeforeSearch) {
    folders.reverse().forEach((d, i) => { d.open = openBeforeSearch[i]; });
    openBeforeSearch = null;
  }
  $("no-match").classList.toggle("hidden", any || !words.length);
}
$("search").addEventListener("input", (e) => filterTree(e.target.value));
$("search").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const first = document.querySelector("#tree a:not(.hidden)");
    if (first) location.hash = first.dataset.path;
  } else if (e.key === "Escape") {
    e.target.value = "";
    filterTree("");
  }
});

async function select(path) {
  if (path === "scratch") return openScratch();
  const link = document.querySelector(`#tree a[data-path="${CSS.escape(path)}"]`);
  if (!link) return;
  for (const a of document.querySelectorAll("#tree a.active")) a.classList.remove("active");
  link.classList.add("active");
  // open the folders containing this example
  for (let el = link.parentElement; el && el.id !== "tree"; el = el.parentElement) {
    if (el.tagName === "DETAILS") el.open = true;
  }
  const response = await fetch(versioned("examples/" + path));
  const code = await response.text();
  current = { path, files: JSON.parse(link.dataset.files), original: code };
  editor.load(code);
  $("title").textContent = path;
  $("description").textContent = link.title.split("\n\n")[0];
  showNotes(JSON.parse(link.dataset.info));
}

// A blank editor, not tied to an example; its text is kept in this browser.
function openScratch() {
  for (const a of document.querySelectorAll("#tree a.active")) a.classList.remove("active");
  current = { path: SCRATCH, files: [], original: "" };
  editor.load(stored("bilby-scratch") || "");
  $("title").textContent = SCRATCH;
  $("description").textContent = "A blank editor. Its contents are kept in this browser; Reset clears it.";
  showNotes({ changes: [], support: null });
  editor.focus();
}

// What differs from the upstream example, and whether it can run here.
function showNotes({ changes, support }) {
  const notes = $("notes");
  notes.innerHTML = "";
  if (support) {
    const p = document.createElement("p");
    p.className = support.status;
    p.textContent = (support.status === "unsupported" ? "Not supported in the browser: " : "Partly supported: ") + support.reason;
    notes.appendChild(p);
  }
  if (changes.length) {
    const p = document.createElement("p");
    p.className = "changes";
    p.textContent = "Changed from the bilby example: " + changes.join("; ");
    notes.appendChild(p);
  }
}

async function main() {
  const manifest = await (await fetch(versioned("examples/manifest.json"))).json();
  const tree = document.createElement("div");
  buildTree(manifest, tree);
  $("tree").appendChild(tree);
  if (manifest.commit) {
    const link = $("source");
    link.href = `https://github.com/bilby-dev/bilby/tree/${manifest.commit}/examples`;
    link.textContent = `examples from bilby@${manifest.commit.slice(0, 8)}`;
  }
  window.addEventListener("hashchange", () => select(decodeURIComponent(location.hash.slice(1))));
  await select(decodeURIComponent(location.hash.slice(1)) || "core_examples/linear_regression.py");
}

// bilby test mode: on by default while developing; remembered per browser
const savedTestMode = stored("bilby-test-mode");
if (savedTestMode !== null) $("test-mode").checked = savedTestMode === "1";
const showTestMode = () => {
  const on = $("test-mode").checked;
  document.body.classList.toggle("test-mode", on);
  $("run").title = (on ? "Run in bilby test mode" : "Run") + " (Ctrl/⌘+Enter)";
};
showTestMode();
$("test-mode").addEventListener("change", (e) => {
  store("bilby-test-mode", e.target.checked ? "1" : "0");
  showTestMode();
});

// the example list can be hidden; remembered per browser
const showTree = (visible) => {
  document.body.classList.toggle("tree-hidden", !visible);
  $("toggle-tree").setAttribute("aria-expanded", String(visible));
  $("toggle-tree").title = visible ? "Hide the example list" : "Show the example list";
};
showTree(stored("bilby-tree-hidden") !== "1");
$("toggle-tree").addEventListener("click", () => {
  const visible = document.body.classList.contains("tree-hidden");
  store("bilby-tree-hidden", visible ? "0" : "1");
  showTree(visible);
});

$("run").addEventListener("click", run);
$("new").addEventListener("click", () => {
  if (location.hash === "#scratch") openScratch();
  else location.hash = "scratch";
});
$("stop").addEventListener("click", stop);
$("clear").addEventListener("click", () => {
  output.innerHTML = "";
  block = output;
  line = null;
});
$("copy").addEventListener("click", async () => {
  // open collapsed runs so their text is included
  const closed = [...output.querySelectorAll("details:not([open])")];
  closed.forEach((d) => { d.open = true; });
  const text = output.innerText;
  closed.forEach((d) => { d.open = false; });
  try {
    await navigator.clipboard.writeText(text);
    flash($("copy"), "Copied");
  } catch {
    flash($("copy"), "Copy failed");
  }
});
function flash(button, text) {
  const label = button.dataset.label ||= button.textContent;
  button.textContent = text;
  setTimeout(() => { button.textContent = label; }, 1200);
}

// drag the divider to share the width between editor and output; remembered
function setSplit(fraction) {
  const main = document.querySelector("main");
  if (fraction == null) {
    main.style.removeProperty("--left");
    main.style.removeProperty("--right");
    return;
  }
  main.style.setProperty("--left", `${fraction}fr`);
  main.style.setProperty("--right", `${1 - fraction}fr`);
}
const savedSplit = parseFloat(stored("bilby-split"));
if (savedSplit > 0 && savedSplit < 1) setSplit(savedSplit);
$("divider").addEventListener("pointerdown", (e) => {
  const divider = e.currentTarget;
  const left = document.querySelector("main > .pane").getBoundingClientRect().left;
  const right = $("output-pane").getBoundingClientRect().right;
  divider.setPointerCapture(e.pointerId);
  divider.classList.add("dragging");
  document.body.classList.add("resizing");
  let fraction = null;
  const move = (ev) => {
    fraction = Math.min(0.8, Math.max(0.2, (ev.clientX - left) / (right - left)));
    setSplit(fraction);
  };
  const up = () => {
    divider.removeEventListener("pointermove", move);
    divider.classList.remove("dragging");
    document.body.classList.remove("resizing");
    if (fraction != null) store("bilby-split", String(fraction));
  };
  divider.addEventListener("pointermove", move);
  divider.addEventListener("pointerup", up, { once: true });
});
$("divider").addEventListener("dblclick", () => { setSplit(null); store("bilby-split", ""); });

// colour theme: follow the system (auto), or force light or dark
const THEMES = ["auto", "light", "dark"];
const showTheme = (theme) => {
  if (theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  $("theme").textContent = "Theme: " + theme;
};
showTheme(stored("bilby-theme") || "auto");
$("theme").addEventListener("click", () => {
  const theme = THEMES[(THEMES.indexOf(stored("bilby-theme") || "auto") + 1) % THEMES.length];
  store("bilby-theme", theme === "auto" ? "" : theme);
  showTheme(theme);
});
$("reset").addEventListener("click", () => { if (current) editor.reset(current.original); });

startWorker();
main();
