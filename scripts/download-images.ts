/**
 * Image downloader — downloads listing photos from URLs.
 *
 * Usage:
 *   tsx scripts/download-images.ts <mls-number> <urls-json> [max-count]
 *
 * Example:
 *   tsx scripts/download-images.ts PC12345 '["https://...", "https://..."]' 10
 *
 * Downloads to: data/images/<mls-number>/photo-0.jpg, photo-1.jpg, etc.
 * Outputs: JSON array of local file paths
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, join } from "path";

const [, , mlsNumber, urlsJson, maxCountStr] = process.argv;

if (!mlsNumber || !urlsJson) {
  console.error("Usage: tsx scripts/download-images.ts <mls-number> <urls-json> [max-count]");
  process.exit(1);
}

const urls: string[] = JSON.parse(urlsJson);
const maxCount = parseInt(maxCountStr || "10");
const imageDir = resolve("data/images", mlsNumber);
mkdirSync(imageDir, { recursive: true });

const downloadedPaths: string[] = [];

for (let i = 0; i < Math.min(urls.length, maxCount); i++) {
  const localPath = join(imageDir, `photo-${i}.jpg`);

  if (existsSync(localPath)) {
    downloadedPaths.push(localPath);
    continue;
  }

  try {
    const res = await fetch(urls[i]);
    if (!res.ok) {
      console.error(`Failed to download photo ${i}: ${res.status}`);
      continue;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    writeFileSync(localPath, buffer);
    downloadedPaths.push(localPath);
  } catch (err) {
    console.error(`Error downloading photo ${i}: ${err}`);
  }
}

console.log(JSON.stringify(downloadedPaths));
