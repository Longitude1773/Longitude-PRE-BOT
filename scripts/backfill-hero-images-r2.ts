#!/usr/bin/env tsx
//
// backfill-hero-images-r2.ts — mirror local hero photos to the PUBLIC R2 images
// bucket for evals that were processed BEFORE the mirror existed.
//
// Why this exists: commit 96136e5 added the "mirror photo-0 to
// img.longitude.network/<id>/photo-0.jpg" step to the manual/on-demand and
// Zillow eval paths (it previously only ran in the MLS-review-queue path). That
// fix only applies going FORWARD — evals already processed still have their hero
// on local disk (`data/images/<id>/photo-0.jpg`) but nothing on R2, so their PRE
// Site tile shows a placeholder. This script backfills those.
//
// What it does: scans the Listings table for manual (`mls_on_demand`) and Zillow
// (`zillow_on_demand`) rows, and for any whose `data/images/<id>/photo-0.jpg`
// exists locally but is missing on R2, uploads it. Idempotent — already-mirrored
// keys are skipped. Pass explicit ids to backfill just those instead of scanning.
//
//   set -a; source .env; set +a
//   ./node_modules/.bin/tsx scripts/backfill-hero-images-r2.ts            # scan + upload missing
//   ./node_modules/.bin/tsx scripts/backfill-hero-images-r2.ts --dry-run  # report only
//   ./node_modules/.bin/tsx scripts/backfill-hero-images-r2.ts 12601448 ZPID-111715943
//
import { access } from "node:fs/promises";

import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { r2ImagesBucketName, uploadImageToR2 } from "./r2.ts";
import { readSheet } from "./sheets.ts";

// Listing sources whose eval path lacked the R2 mirror before commit 96136e5.
const BACKFILLED_SOURCES = new Set(["mls_on_demand", "zillow_on_demand"]);

const client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

async function existsOnR2(key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: r2ImagesBucketName(), Key: key }));
    return true;
  } catch (e: any) {
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === "NotFound") return false;
    throw e;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function discoverIds(): Promise<string[]> {
  const rows = (await readSheet("Listings")) as Array<Record<string, unknown>>;
  const ids: string[] = [];
  for (const row of rows) {
    const source = String(row["Listing Source"] ?? "");
    const id = String(row["MLS #"] ?? "");
    if (!id || !BACKFILLED_SOURCES.has(source)) continue;
    if (await fileExists(`data/images/${id}/photo-0.jpg`)) ids.push(id);
  }
  return ids;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const explicitIds = args.filter((a) => !a.startsWith("--"));

  const ids = explicitIds.length > 0 ? explicitIds : await discoverIds();
  console.log(`Images bucket: ${r2ImagesBucketName()}`);
  console.log(`${explicitIds.length > 0 ? "Explicit" : "Discovered"} ids: ${ids.join(", ") || "(none)"}`);

  let uploaded = 0;
  let skipped = 0;
  for (const id of ids) {
    const key = `${id}/photo-0.jpg`;
    const localPath = `data/images/${id}/photo-0.jpg`;
    if (!(await fileExists(localPath))) {
      console.log(`MISS  ${key} — no local file at ${localPath}, skipping`);
      continue;
    }
    if (await existsOnR2(key)) {
      console.log(`SKIP  ${key} — already on R2`);
      skipped++;
      continue;
    }
    if (dryRun) {
      console.log(`DRY   ${key} — would upload from ${localPath}`);
      continue;
    }
    await uploadImageToR2(key, localPath);
    const verified = await existsOnR2(key);
    console.log(`${verified ? "OK   " : "FAIL "} ${key} — uploaded from ${localPath} (verified=${verified})`);
    if (verified) uploaded++;
  }
  console.log(`Done. uploaded=${uploaded} skipped=${skipped}${dryRun ? " (dry-run)" : ""}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
