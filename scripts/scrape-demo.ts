import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const pages = [
  { label: 'Version A (semantic)', file: 'data/scrape-demo/version-a.html' },
  { label: 'Version B (legacy)',   file: 'data/scrape-demo/version-b.html' },
];

const browser = await chromium.launch();
const page = await browser.newPage();

for (const { label, file } of pages) {
  await page.goto(pathToFileURL(resolve(file)).href);

  // "Naive but reasonable" scraper: same selectors for both pages.
  const result = await page.evaluate(() => ({
    title:    document.querySelector('h2')?.textContent?.trim() ?? null,
    badge:    document.querySelector('.badge')?.textContent?.trim() ?? null,
    features: Array.from(document.querySelectorAll('ul li')).map(li => li.textContent?.trim()),
  }));

  console.log(`\n── ${label} ──`);
  console.log(JSON.stringify(result, null, 2));
}

await browser.close();
