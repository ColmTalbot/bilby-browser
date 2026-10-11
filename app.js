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
  describedBy: "editor-help",
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

// Tell screen-reader users what happened (run started, finished, failed...).
function announce(text) {
  const region = $("announce");
  region.textContent = "";
  setTimeout(() => { region.textContent = text; }, 50);
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
        if (carriageReturn) line.raw = "";
        carriageReturn = false;
        line.raw += part;
        render(line);
      }
    }
  });
}

function newLine(kind) {
  line = document.createElement("pre");
  line.className = kind;
  line.raw = "";
  lineKind = kind;
  block.appendChild(line);
}

// A line is shown as text, or, if it is a tqdm progress line, as a bar like
// tqdm's Jupyter one: description, bar (when tqdm knows the total), count,
// time and rate, with any extra stats (dynesty's) on a second line.
//   "desc: 42%|████▏     | 42/100 [00:03<00:04, 12.5it/s, extra]"
//   "desc: 3it [00:00, 25.64it/s, extra]"
const TQDM_TOTAL = /^(?:(.*?): ?)?\s*(\d+)%\|[^|]*\| ?(\S+)\/(\S+) \[([^\]]*)\]\s*$/;
const TQDM_COUNT = /^(?:(.*?): ?)?(\d[\d.]*[kMG]?)it \[([^\]]*)\]\s*$/;

function render(pre) {
  const total = pre.raw.match(TQDM_TOTAL);
  const count = total ? null : pre.raw.match(TQDM_COUNT);
  if (!total && !count) {
    pre.classList.remove("tqdm");
    pre.textContent = pre.raw;
    return;
  }
  const [desc, stats] = total ? [total[1], total[5]] : [count[1], count[3]];
  const [time, rate, ...extra] = stats.split(", ");
  pre.classList.add("tqdm");
  pre.textContent = "";
  const row = document.createElement("div");
  row.className = "tqdm-row";
  const span = (cls, text) => {
    const el = document.createElement("span");
    el.className = cls;
    el.textContent = text;
    row.appendChild(el);
    return el;
  };
  if (desc) span("tqdm-desc", desc);
  if (total) {
    const bar = span("tqdm-bar", "");
    const fill = document.createElement("span");
    fill.style.width = `${Math.min(100, Number(total[2]))}%`;
    bar.appendChild(fill);
    span("tqdm-count", `${total[2]}% · ${total[3]}/${total[4]}`);
  } else {
    span("tqdm-count", `${count[2]} it`);
  }
  span("tqdm-meta", [time, rate].filter(Boolean).join(" · "));
  pre.appendChild(row);
  if (extra.length) {
    const more = document.createElement("div");
    more.className = "tqdm-extra";
    more.textContent = extra.join(", ");
    pre.appendChild(more);
  }
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
    download.download = fileName(name);
    download.textContent = "download";
    caption.appendChild(download);
    figure.append(img, caption);
    block.appendChild(figure);
  });
  line = null;
}

// Save a Blob as a file.
function save(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// The files a run wrote, zipped by the worker: a link in the run's output,
// and the Results button for the latest run.
let latestResults = null;
const resultUrls = [];
function showResults({ name, bytes, count }) {
  const blob = new Blob([bytes], { type: "application/zip" });
  latestResults = { blob, name };
  $("download-results").disabled = false;
  const url = URL.createObjectURL(blob);
  resultUrls.push(url);
  scrolled(() => {
    const pre = document.createElement("pre");
    pre.className = "info";
    const tab = document.createElement("a");
    tab.href = "#";
    tab.className = "files-link";
    tab.textContent = `${count} file${count === 1 ? "" : "s"} written`;
    tab.title = "See them in the Files tab";
    tab.addEventListener("click", (e) => { e.preventDefault(); showTab("files", true); });
    pre.appendChild(tab);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.textContent = `download ${name} (${formatSize(blob.size)})`;
    pre.appendChild(link);
    block.appendChild(pre);
  });
  line = null;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

// what a figure is saved as: its file name, or "figure 1.png" for figures
// that were only shown (plt.show), never saved
const fileName = (name) => {
  const base = name.split("/").pop();
  return /\.\w+$/.test(base) ? base : base + ".png";
};

// a figure enlarged over the page, with a download link
function openFigure(src, name) {
  const box = $("lightbox");
  box.querySelector("img").src = src;
  box.querySelector("img").alt = name;
  const download = box.querySelector("a");
  download.href = src;
  download.download = fileName(name);
  box.showModal();
}
$("lightbox").addEventListener("click", (e) => { if (e.target.tagName !== "A") $("lightbox").close(); });

// ---- files tab -------------------------------------------------------------
// The files the latest run wrote, as the worker reports them while it runs
// (worker.js, watchFiles): a list, and a preview of the one picked, which
// follows its updates (a checkpoint plot redrawn by the sampler, say).

const files = new Map(); // path -> {size, mtime, bytes?, url?, missing?}
let shownFile = null;
let workerHasFiles = false; // false once Stop has replaced the worker

const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
                      svg: "image/svg+xml", webp: "image/webp" };
const TEXT_LIMIT = 200 * 1024;
const extension = (path) => (path.match(/\.(\w+)$/)?.[1] || "").toLowerCase();

function setFileList(list, reset = false) {
  if (reset) {
    for (const file of files.values()) if (file.url) URL.revokeObjectURL(file.url);
    files.clear();
    shownFile = null;
    workerHasFiles = true;
  }
  for (const { path, size, mtime } of list) {
    const file = files.get(path) || {};
    // a file too large to send while running (PUSH_LIMIT in worker.js) is
    // read again after the run if it changed
    if (file.bytes && mtime !== file.mtime && size > 5 * 1024 ** 2) {
      delete file.bytes;
      if (file.url) URL.revokeObjectURL(file.url);
      file.url = null;
    }
    files.set(path, { ...file, size, mtime });
  }
  drawFileList();
  if (reset) drawFile();
}

function receiveFile({ path, mtime, bytes, missing }) {
  const file = files.get(path);
  if (!file) return;
  if (file.url) URL.revokeObjectURL(file.url);
  file.url = null;
  file.missing = Boolean(missing);
  if (bytes) {
    file.bytes = bytes;
    file.size = bytes.length;
    file.mtime = mtime;
  }
  drawFileList();
  if (path === shownFile) drawFile();
}

function fileUrl(path) {
  const file = files.get(path);
  file.url ||= URL.createObjectURL(new Blob([file.bytes], { type: IMAGE_TYPES[extension(path)] || "application/octet-stream" }));
  return file.url;
}

function drawFileList() {
  const list = $("file-list");
  const paths = [...files.keys()].sort();
  $("file-count").textContent = paths.length ? String(paths.length) : "";
  list.textContent = "";
  for (const path of paths) {
    const file = files.get(path);
    const button = document.createElement("button");
    button.dataset.path = path;
    if (path === shownFile) button.setAttribute("aria-current", "true");
    const name = document.createElement("span");
    name.className = "name";
    const slash = path.lastIndexOf("/") + 1;
    const dir = document.createElement("span");
    dir.className = "dir";
    dir.textContent = path.slice(0, slash);
    name.append(dir, path.slice(slash));
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${formatSize(file.size)} · ${new Date(file.mtime).toLocaleTimeString()}`;
    button.append(name, meta);
    list.appendChild(button);
  }
}

function drawFile() {
  const view = $("file-view");
  view.textContent = "";
  const file = files.get(shownFile);
  if (!file) return;
  const head = document.createElement("div");
  head.className = "head";
  const title = document.createElement("strong");
  title.textContent = shownFile;
  head.append(title, `${formatSize(file.size)} · written ${new Date(file.mtime).toLocaleTimeString()}`);
  view.appendChild(head);
  if (!file.bytes) {
    const note = document.createElement("p");
    if (file.missing) note.textContent = "This file could not be read; it may have been removed.";
    else if (!workerHasFiles) note.textContent = "Not available: Python was restarted (Stop) before this file was sent.";
    else if (running) note.textContent = "This file is large, so it is sent when the run finishes.";
    else {
      note.textContent = "Loading…";
      worker.postMessage({ type: "read", path: shownFile });
    }
    view.appendChild(note);
    return;
  }
  const download = document.createElement("button");
  download.textContent = "Download";
  download.addEventListener("click", () => save(new Blob([file.bytes]), shownFile.split("/").pop()));
  head.appendChild(download);
  const ext = extension(shownFile);
  if (IMAGE_TYPES[ext]) {
    const img = document.createElement("img");
    img.src = fileUrl(shownFile);
    img.alt = shownFile;
    img.addEventListener("click", () => openFigure(img.src, shownFile));
    view.appendChild(img);
    return;
  }
  // text if there is no NUL byte near the start
  const start = file.bytes.subarray(0, 4096);
  if (start.includes(0)) {
    const note = document.createElement("p");
    note.textContent = "A binary file: download it to open it.";
    view.appendChild(note);
    return;
  }
  const pre = document.createElement("pre");
  pre.textContent = new TextDecoder().decode(file.bytes.subarray(0, TEXT_LIMIT));
  if (file.bytes.length > TEXT_LIMIT) {
    const note = document.createElement("p");
    note.textContent = `Showing the first ${formatSize(TEXT_LIMIT)}; download it for the rest.`;
    view.appendChild(note);
  }
  view.appendChild(pre);
}

$("file-list").addEventListener("click", (e) => {
  const button = e.target.closest("button[data-path]");
  if (!button) return;
  shownFile = button.dataset.path;
  drawFileList();
  $("file-list").querySelector(`[data-path="${CSS.escape(shownFile)}"]`).focus();
  $("file-view").scrollTop = 0;
  drawFile();
});

// Output / Files tabs (arrow keys move between them)
const TABS = ["output", "files"];
function showTab(name, focus = false) {
  for (const tab of TABS) {
    const button = $("tab-" + tab);
    button.setAttribute("aria-selected", String(tab === name));
    button.tabIndex = tab === name ? 0 : -1;
    $(tab).hidden = tab !== name;
  }
  $("output-pane").classList.toggle("files-tab", name === "files");
  if (focus) $("tab-" + name).focus();
}
for (const tab of TABS) {
  $("tab-" + tab).addEventListener("click", () => showTab(tab));
  $("tab-" + tab).addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    showTab(TABS[(TABS.indexOf(tab) + 1) % TABS.length], true);
  });
}

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
        if (!running) announce(data.text);
        break;
      case "progress":
        showProgress(data);
        break;
      case "ready":
        worker.ready = true;
        setStatus("Ready: " + data.text, "ok");
        announce("Ready to run");
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
      case "files":
        setFileList(data.files, data.reset);
        break;
      case "file":
        receiveFile(data);
        break;
      case "results":
        showResults(data);
        break;
      case "done":
        append(`finished in ${data.seconds.toFixed(1)} s`, "info");
        announce(`Finished in ${data.seconds.toFixed(1)} seconds` + (block.querySelector("img") ? ", with figures" : ""));
        setStatus("Ready", "ok");
        setRunning(false);
        if (shownFile) drawFile(); // a large file can be read now
        break;
      case "error":
        append(data.text, "error");
        markTracebackLine(data.text);
        announce((data.fatal ? "Python failed to start: " : "The run failed: ") + data.text.trim().split("\n").pop());
        setStatus(data.fatal ? "Failed to start Python" : "Ready (last run failed)", data.fatal ? "err" : "");
        setRunning(false);
        if (shownFile && !data.fatal) drawFile();
        break;
    }
  };
}

// Download progress of start-up and installs: the bar under the header, and
// the amount in the status text. expected is 0 when the total is unknown.
function showProgress({ done, label, received, expected }) {
  const bar = $("progress");
  bar.classList.toggle("active", !done);
  bar.setAttribute("aria-hidden", String(Boolean(done)));
  if (done) return;
  bar.classList.toggle("unknown", !expected);
  const fraction = expected ? Math.min(1, received / expected) : 0;
  bar.firstElementChild.style.width = expected ? `${(fraction * 100).toFixed(1)}%` : "";
  if (expected) bar.setAttribute("aria-valuenow", Math.round(fraction * 100));
  else bar.removeAttribute("aria-valuenow");
  const amount = expected
    ? `${formatSize(Math.min(received, expected))} of ${formatSize(expected)}`
    : formatSize(received);
  setStatus(`${label}… ${amount}`);
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
  if (document.body.classList.contains("output-hidden")) setPaneHidden("output", false);
  setRunning(true);
  setStatus("Running " + current.path + "…");
  const testMode = $("test-mode").checked;
  startRun(">>> " + current.path + (testMode ? " (test mode)" : ""), testMode ? "run test" : "run");
  announce(`Running ${current.path.split("/").pop()}` + (testMode ? " in test mode" : ""));
  editor.markErrorLine(null);
  worker.postMessage({
    type: "run", path: current.path, code: editor.getValue(), files: current.files, testMode,
    logLevel: $("log-level").value,
  });
}

function stop() {
  if (!running) return;
  worker.terminate();
  append("stopped; restarting Python", "error");
  announce("Stopped; restarting Python");
  block = output;
  running = false;
  workerHasFiles = false;
  if (shownFile) drawFile();
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
    link.dataset.doc = JSON.stringify(example.doc || []);
    link.dataset.headerLines = example.header_lines || 0;
    link.dataset.path = example.path;
    link.dataset.files = JSON.stringify(node.files);
    link.dataset.info = JSON.stringify({ changes: example.changes || [], support: example.support || null });
    if (example.support) {
      link.classList.add(example.support.status);
      const note = document.createElement("span");
      note.className = "sr-only";
      note.textContent = example.support.status === "unsupported" ? " (not supported in the browser)" : " (partly supported)";
      link.appendChild(note);
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
  // the shebang and docstring are shown as formatted text above the editor
  // instead of in it; Download puts them back
  const lines = (await response.text()).split("\n");
  const headerLines = Number(link.dataset.headerLines);
  const code = lines.slice(headerLines).join("\n");
  current = {
    path, files: JSON.parse(link.dataset.files), original: code,
    header: headerLines ? lines.slice(0, headerLines).join("\n") + "\n" : "",
  };
  editor.load(code);
  $("title").textContent = path;
  showDoc(JSON.parse(link.dataset.doc));
  showNotes(JSON.parse(link.dataset.info));
}

// A blank editor, not tied to an example; its text is kept in this browser.
function openScratch() {
  for (const a of document.querySelectorAll("#tree a.active")) a.classList.remove("active");
  current = { path: SCRATCH, files: [], original: "", header: "" };
  editor.load(stored("bilby-scratch") || "");
  $("title").textContent = SCRATCH;
  showDoc(["<p>A blank editor. Its contents are kept in this browser; Reset clears it.</p>"]);
  showNotes({ changes: [], support: null });
  editor.focus();
}

// The example's docstring (HTML blocks made by scripts/make_manifest.py):
// the first paragraph, and the rest behind "more"; expanded stays expanded.
let docExpanded = false;
function showDoc(blocks) {
  const doc = $("description");
  doc.innerHTML = blocks[0] || "";
  doc.classList.toggle("expanded", docExpanded);
  if (blocks.length > 1) {
    const more = document.createElement("div");
    more.className = "more";
    more.innerHTML = blocks.slice(1).join("");
    const toggle = document.createElement("button");
    toggle.className = "toggle-doc";
    const label = () => { toggle.textContent = docExpanded ? "less" : "more"; };
    label();
    toggle.addEventListener("click", () => {
      docExpanded = !docExpanded;
      doc.classList.toggle("expanded", docExpanded);
      label();
    });
    doc.append(more, toggle);
  }
  // links open in a new tab, so edits here are not lost
  for (const a of doc.querySelectorAll("a")) {
    a.target = "_blank";
    a.rel = "noopener";
  }
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
  $("tree").insertBefore(tree, $("tree").querySelector(".links")); // links stay last (phones)
  if (manifest.commit) {
    const link = $("source");
    link.href = `https://github.com/bilby-dev/bilby/tree/${manifest.commit}/examples`;
    link.textContent = `examples from bilby@${manifest.commit.slice(0, 8)}`;
  }
  window.addEventListener("hashchange", () => select(decodeURIComponent(location.hash.slice(1))));
  await select(decodeURIComponent(location.hash.slice(1)) || "core_examples/linear_regression.py");
}

// bilby test mode: on by default when served locally (development), off on
// the live site; a choice made with the switch is remembered per browser
const savedTestMode = stored("bilby-test-mode");
const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
$("test-mode").checked = savedTestMode === null ? local : savedTestMode === "1";
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

// bilby's log level (ERROR unless changed); remembered per browser
const savedLogLevel = stored("bilby-log-level");
if ([...$("log-level").options].some((o) => o.value === savedLogLevel)) $("log-level").value = savedLogLevel;
$("log-level").addEventListener("change", (e) => store("bilby-log-level", e.target.value));

// the example list can be hidden; remembered per browser. On phones it is a
// drawer over the page instead, closed after picking an example.
const phone = matchMedia("(max-width: 700px)");
const treeVisible = () => phone.matches
  ? document.body.classList.contains("tree-open")
  : !document.body.classList.contains("tree-hidden");
const showTree = () => {
  const visible = treeVisible();
  $("toggle-tree").setAttribute("aria-expanded", String(visible));
  $("toggle-tree").title = visible ? "Hide the example list" : "Show the example list";
};
// while the drawer is open the page behind it cannot be reached; closing it
// returns focus to the button that opened it
function setDrawer(open) {
  const wasOpen = document.body.classList.contains("tree-open");
  document.body.classList.toggle("tree-open", open);
  for (const el of [document.querySelector("header"), $("editor-pane"), $("output-pane")]) el.inert = open;
  showTree();
  if (open) $("search").focus({ preventScroll: true });
  else if (wasOpen && (!document.activeElement || $("tree").contains(document.activeElement) || document.activeElement === document.body)) {
    $("toggle-tree").focus({ preventScroll: true });
  }
}
$("close-tree").addEventListener("click", () => setDrawer(false));
document.body.classList.toggle("tree-hidden", stored("bilby-tree-hidden") === "1");
showTree();
$("toggle-tree").addEventListener("click", () => {
  if (phone.matches) return setDrawer(!treeVisible());
  const hidden = !document.body.classList.contains("tree-hidden");
  document.body.classList.toggle("tree-hidden", hidden);
  store("bilby-tree-hidden", hidden ? "1" : "0");
  showTree();
});
$("scrim").addEventListener("click", () => setDrawer(false));

// the editor and the output can be hidden as well, but never both: hiding one
// while the other is hidden swaps them. Remembered per browser.
const PANES = { editor: "the editor", output: "the output" };
function setPaneHidden(pane, hidden) {
  const other = pane === "editor" ? "output" : "editor";
  document.body.classList.toggle(pane + "-hidden", hidden);
  if (hidden) document.body.classList.remove(other + "-hidden");
  for (const name in PANES) {
    const isHidden = document.body.classList.contains(name + "-hidden");
    const button = $("toggle-" + name);
    button.setAttribute("aria-expanded", String(!isHidden));
    button.title = (isHidden ? "Show " : "Hide ") + PANES[name];
    store("bilby-" + name + "-hidden", isHidden ? "1" : "0");
  }
}
if (stored("bilby-output-hidden") === "1") setPaneHidden("output", true);
else if (stored("bilby-editor-hidden") === "1") setPaneHidden("editor", true);
for (const name in PANES) {
  $("toggle-" + name).addEventListener("click", () =>
    setPaneHidden(name, !document.body.classList.contains(name + "-hidden")));
}
// Run lives in the editor toolbar; with the editor hidden, Ctrl/⌘+Enter
// anywhere on the page still runs (the editor handles it otherwise)
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.repeat &&
      document.body.classList.contains("editor-hidden")) {
    e.preventDefault();
    run();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("tree-open")) setDrawer(false);
});
$("tree").addEventListener("click", (e) => {
  if (phone.matches && e.target.closest("a[data-path]")) setDrawer(false);
});
// the header links live at the bottom of the drawer on phones
const placeLinks = () => {
  const links = document.querySelector(".links");
  if (phone.matches) $("tree").appendChild(links);
  else document.querySelector("header").appendChild(links);
  setDrawer(false);
};
placeLinks();
phone.addEventListener("change", placeLinks);
// iOS zooms in when focusing text smaller than 16px (the editor); stop that
// zoom there only (iOS still allows pinch zoom with maximum-scale set)
if (/iPhone|iPad|iPod/.test(navigator.userAgent)) {
  document.querySelector('meta[name="viewport"]').content += ", maximum-scale=1";
}

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
  resultUrls.splice(0).forEach((url) => URL.revokeObjectURL(url));
  latestResults = null;
  $("download-results").disabled = true;
});
$("download-results").addEventListener("click", () => {
  if (latestResults) save(latestResults.blob, latestResults.name);
});
$("download-script").addEventListener("click", () => {
  if (current) save(new Blob([current.header + editor.getValue()], { type: "text/x-python" }), current.path.split("/").pop());
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
  $("divider").setAttribute("aria-valuenow", Math.round((fraction ?? 0.5) * 100));
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
// from the keyboard: arrow keys move it by 5%, Home resets it
$("divider").addEventListener("keydown", (e) => {
  const now = Number($("divider").getAttribute("aria-valuenow")) / 100;
  let fraction;
  if (e.key === "ArrowLeft" || e.key === "ArrowDown") fraction = now - 0.05;
  else if (e.key === "ArrowRight" || e.key === "ArrowUp") fraction = now + 0.05;
  else if (e.key === "Home") { setSplit(null); store("bilby-split", ""); e.preventDefault(); return; }
  else return;
  e.preventDefault();
  fraction = Math.min(0.8, Math.max(0.2, fraction));
  setSplit(fraction);
  store("bilby-split", String(fraction));
});
$("skip").addEventListener("click", (e) => { e.preventDefault(); editor.focus(); });

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
