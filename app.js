// Page logic: the example tree, the editor and the output pane.
// Python runs in worker.js; see that file for the message protocol.

const $ = (id) => document.getElementById(id);
const output = $("output");
let worker = null;
let current = null; // {path, files, original}
let running = false;

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
    output.appendChild(pre);
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
  output.appendChild(line);
}

function showImage(name, b64) {
  scrolled(() => {
    const figure = document.createElement("figure");
    const img = document.createElement("img");
    img.src = "data:image/png;base64," + b64;
    img.alt = name;
    const caption = document.createElement("figcaption");
    caption.textContent = name;
    figure.append(img, caption);
    output.appendChild(figure);
  });
  line = null;
}

// ---- worker ---------------------------------------------------------------

function startWorker() {
  worker = new Worker("worker.js");
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
        setStatus(data.fatal ? "Failed to start Python" : "Ready (last run failed)", data.fatal ? "err" : "");
        setRunning(false);
        break;
    }
  };
}

function run() {
  if (!current || running || !worker?.ready) return;
  setRunning(true);
  setStatus("Running " + current.path + "…");
  const testMode = $("test-mode").checked;
  append(">>> " + current.path + (testMode ? " (test mode)" : ""), testMode ? "run test" : "run");
  worker.postMessage({ type: "run", path: current.path, code: $("code").value, files: current.files, testMode });
}

function stop() {
  if (!running) return;
  worker.terminate();
  append("stopped; restarting Python", "error");
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

async function select(path) {
  const link = document.querySelector(`#tree a[data-path="${CSS.escape(path)}"]`);
  if (!link) return;
  for (const a of document.querySelectorAll("#tree a.active")) a.classList.remove("active");
  link.classList.add("active");
  // open the folders containing this example
  for (let el = link.parentElement; el && el.id !== "tree"; el = el.parentElement) {
    if (el.tagName === "DETAILS") el.open = true;
  }
  const response = await fetch("examples/" + path);
  const code = await response.text();
  current = { path, files: JSON.parse(link.dataset.files), original: code };
  $("code").value = code;
  $("title").textContent = path;
  $("description").textContent = link.title.split("\n\n")[0];
  showNotes(JSON.parse(link.dataset.info));
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
  const manifest = await (await fetch("examples/manifest.json")).json();
  buildTree(manifest, $("tree"));
  if (manifest.commit) {
    const link = $("source");
    link.href = `https://github.com/bilby-dev/bilby/tree/${manifest.commit}/examples`;
    link.textContent = `examples from bilby@${manifest.commit.slice(0, 8)}`;
  }
  window.addEventListener("hashchange", () => select(decodeURIComponent(location.hash.slice(1))));
  await select(decodeURIComponent(location.hash.slice(1)) || "core_examples/linear_regression.py");
}

// bilby test mode: on by default while developing; remembered per browser
try {
  const saved = localStorage.getItem("bilby-test-mode");
  if (saved !== null) $("test-mode").checked = saved === "1";
} catch {}
const showTestMode = () => {
  const on = $("test-mode").checked;
  document.body.classList.toggle("test-mode", on);
  $("run").title = on ? "Run in bilby test mode" : "Run";
};
showTestMode();
$("test-mode").addEventListener("change", (e) => {
  try { localStorage.setItem("bilby-test-mode", e.target.checked ? "1" : "0"); } catch {}
  showTestMode();
});

$("run").addEventListener("click", run);
$("stop").addEventListener("click", stop);
$("clear").addEventListener("click", () => { output.innerHTML = ""; line = null; });
$("reset").addEventListener("click", () => { if (current) $("code").value = current.original; });
$("code").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    run();
  } else if (e.key === "Tab") {
    e.preventDefault();
    e.target.setRangeText("    ", e.target.selectionStart, e.target.selectionEnd, "end");
  }
});

startWorker();
main();
