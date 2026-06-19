import { readFile } from "node:fs/promises";

import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const accountId = process.env.R2_ACCOUNT_ID;
const bucket = process.env.R2_BUCKET_NAME;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

let cachedClient: S3Client | null = null;

function client(): S3Client {
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "Missing R2 credentials. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY.",
    );
  }
  if (!cachedClient) {
    cachedClient = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });
  }
  return cachedClient;
}

export function r2BucketName(): string {
  if (!bucket) throw new Error("Missing R2_BUCKET_NAME.");
  return bucket;
}

/** Upload a local PDF file to R2 at the given object key. Returns the key. */
export async function uploadPdfToR2(key: string, localPath: string): Promise<string> {
  const body = await readFile(localPath);
  await client().send(
    new PutObjectCommand({
      Bucket: r2BucketName(),
      Key: key,
      Body: body,
      ContentType: "application/pdf",
    }),
  );
  return key;
}

/** Returns true if an object already exists at the given key. */
export async function r2ObjectExists(key: string): Promise<boolean> {
  try {
    await client().send(new HeadObjectCommand({ Bucket: r2BucketName(), Key: key }));
    return true;
  } catch (e: any) {
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === "NotFound" || e?.name === "NotFound:") {
      return false;
    }
    throw e;
  }
}
