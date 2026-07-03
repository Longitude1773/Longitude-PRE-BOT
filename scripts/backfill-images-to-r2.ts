/**
 * One-time backfill: upload each listing's hero photo (data/images/<mls>/photo-0.*)
 * to the public R2 images bucket, keyed <mls>/photo-0.jpg — the layout the PRE Site
 * expects at img.longitude.network/<mls>/photo-0.jpg.
 *
 * Usage:
 *   npx tsx scripts/backfill-images-to-r2.ts            # upload
 *   npx tsx scripts/backfill-images-to-r2.ts --dry      # list what would upload
 *
 * Reads R2 creds from .env (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY).
 * Target bucket: R2_IMAGES_BUCKET or the default below.
 */
import { readdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

// Minimal .env loader (no dotenv dependency in this repo).
for (const line of readFileSync(resolve(".env"), "utf8").split("\n")) {
  const i = line.indexOf("=");
  if (i > 0 && !line.trimStart().startsWith("#")) {
    const k = line.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = line.slice(i + 1).trim();
  }
}

const DRY = process.argv.includes("--dry");
const BUCKET = process.env.R2_IMAGES_BUCKET || "longitude-pre-images";
const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
if (!accountId || !accessKeyId || !secretAccessKey) {
  throw new Error("Missing R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY in .env");
}

const client = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
});

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const imagesDir = resolve("data/images");
const mlsDirs = readdirSync(imagesDir).filter((d) => {
  try {
    return statSync(join(imagesDir, d)).isDirectory();
  } catch {
    return false;
  }
});

console.log(`bucket: ${BUCKET}${DRY ? "  (DRY RUN)" : ""}`);
console.log(`scanning ${mlsDirs.length} listing folders under data/images\n`);

let ok = 0;
let noPhoto = 0;
let failed = 0;

for (const mls of mlsDirs) {
  let file: string | undefined;
  let contentType = "image/jpeg";
  for (const [ext, ct] of Object.entries(CONTENT_TYPES)) {
    const p = join(imagesDir, mls, `photo-0.${ext}`);
    if (existsSync(p)) {
      file = p;
      contentType = ct;
      break;
    }
  }
  if (!file) {
    noPhoto++;
    continue;
  }

  const key = `${mls}/photo-0.jpg`;
  if (DRY) {
    console.log(`would upload ${file}  ->  ${key}  (${contentType})`);
    ok++;
    continue;
  }

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: readFileSync(file),
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );
    ok++;
    if (ok % 25 === 0) console.log(`  uploaded ${ok}...`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`FAIL ${key}: ${msg}`);
    // Stop early on an auth failure — no point hammering with a bad token.
    if (/access denied|forbidden|invalid|credential|no such bucket/i.test(msg) && failed === 1) {
      console.error("\nAborting: the R2 token appears unable to write to this bucket.");
      break;
    }
  }
}

console.log(`\ndone. uploaded=${ok}  no-photo-folder=${noPhoto}  failed=${failed}`);
