// Smoke test of the real page in headless Chromium (tests/smoke.spec.mjs).
// Serves SITE_DIR (default: the repository root, after scripts/dev.sh has
// generated examples/ and wheels/; CI uses the assembled _site/).
import { defineConfig } from "@playwright/test";

const PORT = 8123;
export default defineConfig({
  testDir: "tests",
  testMatch: "*.spec.mjs",
  timeout: 300_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: { baseURL: `http://127.0.0.1:${PORT}/`, browserName: "chromium" },
  webServer: {
    command: `python3 -m http.server ${PORT} --bind 127.0.0.1 --directory ${process.env.SITE_DIR || "."}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
  },
});
