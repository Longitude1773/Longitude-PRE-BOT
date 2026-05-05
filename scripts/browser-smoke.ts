import { resolve } from "node:path";
import { launchConfiguredBrowser, getBrowserBackend } from "./browser-runtime.ts";

const [, , targetUrl = "https://example.com/", screenshotArg] = process.argv;
const screenshotPath = screenshotArg || resolve(import.meta.dirname, "../tmp/browser-smoke.png");

const browser = await launchConfiguredBrowser({
  headless: true,
  label: "browser-smoke",
  log: (message) => console.log(message),
});

try {
  const context = browser.contexts()[0] || await browser.newContext();
  const page = context.pages()[0] || await context.newPage();
  await page.setViewportSize({ width: 1440, height: 1000 }).catch(() => {});
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.screenshot({ path: screenshotPath, fullPage: true });

  console.log(JSON.stringify({
    backend: getBrowserBackend(),
    finalUrl: page.url(),
    title: await page.title(),
    screenshotPath,
  }, null, 2));
} finally {
  await browser.close().catch(() => {});
}
