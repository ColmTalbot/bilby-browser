// Write editor.bundle.LICENSE.txt: the licence of every npm package that
// esbuild put into editor.bundle.js (from its metafile, editor.meta.json).
// Run by `npm run build:editor`.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const meta = JSON.parse(readFileSync(join(ROOT, "editor.meta.json"), "utf8"));
const packages = new Set();
for (const input of Object.keys(meta.inputs)) {
  const match = input.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if (match) packages.add(match[1]);
}
const sections = [...packages].sort().map((name) => {
  const dir = join(ROOT, "node_modules", name);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const file = readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
  if (!file) throw new Error(`${name} has no licence file`);
  return `${name} ${pkg.version} (${pkg.license})\n${"-".repeat(60)}\n${readFileSync(join(dir, file), "utf8").trim()}\n`;
});
writeFileSync(
  join(ROOT, "editor.bundle.LICENSE.txt"),
  "Licences of the packages bundled into editor.bundle.js (the code editor).\n\n" + sections.join("\n\n"),
);
console.log(`editor.bundle.LICENSE.txt: ${packages.size} packages`);
