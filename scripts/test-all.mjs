// Run every supported example (bilby test mode) and compare with
// tests/known-failures.json. Each example runs in its own Node process
// (scripts/test-examples.mjs), several at a time.
//
//   node scripts/test-all.mjs [--jobs N] [--timeout SECONDS]
//
// Exits non-zero if an example fails that is not a known failure. A known
// failure that passes is reported so it can be removed from the list.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const JOBS = arg("--jobs", Math.max(1, Math.min(4, availableParallelism() - 1)));
const TIMEOUT = arg("--timeout", 300);

const known = JSON.parse(readFileSync(join(ROOT, "tests/known-failures.json"), "utf8"));
delete known._comment;
const manifest = JSON.parse(readFileSync(join(ROOT, "examples/manifest.json"), "utf8"));
const examples = [];
const skipped = [];
(function walk(node) {
  for (const example of node.examples) {
    (example.support?.status === "unsupported" ? skipped : examples).push(example.path);
  }
  node.dirs.forEach(walk);
})(manifest);

function runOne(path) {
  return new Promise((done) => {
    const start = performance.now();
    const child = spawn(process.execPath, [join(ROOT, "scripts/test-examples.mjs"), path], { cwd: ROOT });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT * 1000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const seconds = (performance.now() - start) / 1000;
      const error = output.split("\n").filter((l) => /Error|error:/.test(l)).pop()?.trim() ?? "";
      done({ path, ok: code === 0, timedOut: signal === "SIGKILL", seconds, error, output });
    });
  });
}

const results = [];
const queue = [...examples];
await Promise.all(Array.from({ length: JOBS }, async () => {
  while (queue.length) {
    const result = await runOne(queue.shift());
    results.push(result);
    const status = result.ok ? "ok" : result.timedOut ? `TIMEOUT >${TIMEOUT}s` : "FAIL";
    console.log(`${status.padEnd(14)} ${result.seconds.toFixed(1).padStart(6)} s  ${result.path}${result.ok ? "" : "  " + result.error.slice(0, 160)}`);
  }
}));

const unexpected = results.filter((r) => !r.ok && !(r.path in known));
const fixed = results.filter((r) => r.ok && r.path in known);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed, ${skipped.length} unsupported skipped, ${JOBS} at a time`);
for (const r of fixed) console.log(`now passes (remove from tests/known-failures.json): ${r.path}`);
for (const r of unexpected) {
  console.log(`\n----- unexpected failure: ${r.path}\n${r.output.split("\n").slice(-40).join("\n")}`);
}
process.exit(unexpected.length ? 1 : 0);
