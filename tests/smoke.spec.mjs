// Load the page, run one core and one GW example in bilby test mode, and
// check the licences page. Run with: npx playwright test
import { expect, test } from "@playwright/test";

async function runExample(page, path) {
  await page.goto(`./#${path}`);
  await expect(page.locator("#title")).toHaveText(path);
  await expect(page.locator("#status")).toHaveText(/^Ready/, { timeout: 180_000 });
  await expect(page.locator("body")).toHaveClass(/test-mode/); // the default
  await page.click("#run");
  const finished = page.locator("#output .info", { hasText: "finished in" });
  const failed = page.locator("#output .error");
  await expect(finished.or(failed).first()).toBeVisible({ timeout: 240_000 });
  await expect(failed, await failed.allTextContents().then((t) => t.join("\n"))).toHaveCount(0);
}

test("core example runs and its figures are in the Files tab", async ({ page }) => {
  await runExample(page, "core_examples/linear_regression.py");
  await page.locator("#tab-files").click();
  await page.locator("#file-list button", { hasText: /\.png/ }).first().click();
  await expect(page.locator("#file-view img")).toBeVisible();
});

test("GW example installs LALSuite and runs", async ({ page }) => {
  await runExample(page, "gw_examples/injection_examples/fast_tutorial.py");
  await expect(page.locator("#output .info", { hasText: /^LAL .* installed$/ })).toBeVisible();
});

test("licences page lists the hosted components", async ({ page }) => {
  await page.goto("./licenses.html");
  await expect(page.locator("h1")).toHaveText("Licences and source code");
  await expect(page.locator("body")).toContainText("LALSuite");
  await expect(page.locator("body")).toContainText("GPL-3.0-or-later");
});
