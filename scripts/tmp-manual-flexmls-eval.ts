import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

import { appendSheetRow, readSheet } from "./sheets.ts";
import { buildListingRow } from "./write-sheet-data.ts";
import {
  asString,
  buildReviewMessage,
  inferEvalPath,
  inferListingPath,
  readPostedReviewRecord,
  resolveEvaluationByMls,
  savePostedReviewRecord,
  updateEvaluationSummaryRow,
  upsertThreadContext,
  writeEvaluationVersion,
  repoRoot,
} from "./workflows/lib.ts";
import { buildGroundedUnderwriteBundle } from "./workflows/underwrite-research.ts";

const sourceHtmlPath = process.argv[2];
const channel = process.argv[3];
const threadTs = process.argv[4];
const listingUrl = process.argv[5];

if (!sourceHtmlPath || !channel || !threadTs || !listingUrl) {
  throw new Error("Usage: tsx scripts/tmp-manual-flexmls-eval.ts <htmlPath> <channel> <threadTs> <listingUrl>");
}

function envFlag(name: string, fallback: boolean) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

function decode(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function stripTags(value: string) {
  return decode(value)
    .replace(/<div[^>]*>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pick(html: string, regex: RegExp) {
  const match = html.match(regex);
  return match?.[1] ? stripTags(match[1]) : "";
}

function toNumber(value: string) {
  const normalized = String(value || "").replace(/[^\d.-]/g, "");
  return normalized ? Number(normalized) : undefined;
}

async function listingExists(listingId: string) {
  const rows = await readSheet("Listings").catch(() => []);
  return (rows as Array<Record<string, unknown>>).some((row) => asString(row["MLS #"]) === listingId);
}

async function downloadListingImages(listingId: string, photoUrls: string[]) {
  if (photoUrls.length === 0) return [] as string[];
  const result = spawnSync("npx", ["tsx", "scripts/download-images.ts", listingId, JSON.stringify(photoUrls), "1"], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
  });
  if (result.status !== 0) return [] as string[];
  try {
    const parsed = JSON.parse((result.stdout || "[]").trim() || "[]");
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string" && value.length > 0) : [];
  } catch {
    return [];
  }
}

async function main() {
  const html = await readFile(sourceHtmlPath, "utf8");

  const headerCandidates = Array.from(html.matchAll(/<td[^>]*text-align:\s*center[^>]*>([\s\S]*?)<\/td>/gi))
    .map((match) => stripTags(match[1] || ""))
    .filter(Boolean);
  const headerText = headerCandidates.find((value) => /MLS#:/i.test(value)) || "";
  const listingId = headerText.match(/MLS#:\s*([A-Z0-9-]+)/i)?.[1]?.trim() || "";
  const beforeStatus = (headerText.split(/\b(?:Residential\s+Active|Residential\s+Pending|Active\s+Under\s+Contract|Active|Pending|Closed)\b/i)[0] || "").trim();
  const cityStateZipMatch = beforeStatus.match(/(.+?)\s+([A-Za-z .'-]+),\s*([A-Z]{2})\s*(\d{5})$/);
  if (!listingId || !cityStateZipMatch) throw new Error("Could not parse listing identity from FlexMLS HTML artifact.");
  const street = cityStateZipMatch[1].trim().replace(/\s{2,}/g, " ");
  const cityStateZip = `${cityStateZipMatch[2].trim()}, ${cityStateZipMatch[3]} ${cityStateZipMatch[4]}`;
  const address = `${street}, ${cityStateZip}`;

  const city = cityStateZipMatch?.[2] || "Park City";
  const state = cityStateZipMatch?.[3] || "UT";
  const zip = cityStateZipMatch?.[4] || "";

  const price = toNumber(pick(html, /Latest Price:\/span>\s*([^<]+)/i)) || toNumber(pick(html, /Last List Price:\s*([^<]+)/i));
  const bedrooms = toNumber(pick(html, /<strong>Total Bedrooms:<\/strong><\/td>\s*<td[^>]*>([^<]+)/i));
  const bathrooms = toNumber(pick(html, /<strong>Total Baths:<\/strong><\/td>\s*<td[^>]*>([^<]+)/i));
  const squareFootage = toNumber(pick(html, /<strong>Apx SqFt Total:<\/strong><\/td>\s*<td[^>]*>([^<]+)/i)) || toNumber(pick(html, /<strong>Apx SqFt Finished:<\/strong><\/td>\s*<td[^>]*>([^<]+)/i));
  const propertyType = pick(html, /<strong>Type:<\/strong><\/td>\s*<td[^>]*>([^<]+)/i);
  const subtypeCode = pick(html, /<strong>Sub-Type:\s*<\/strong><\/td>\s*<td[^>]*>([^<]+)/i);
  const area = pick(html, /<strong>Area:<\/strong><\/td>\s*<td[^>]*>([^<]+)/i);
  const subdivision = pick(html, /<strong>Subdivision:<\/strong><\/td>\s*<td[^>]*>([^<]+)/i);
  const nightlyRentalAllowed = pick(html, /Nightly Rental Allowed:[^A-Za-z0-9]*<\/strong>\s*([^<\n]+)/i) || pick(html, /Nightly Rental Allowed:\s*([^<\n]+)/i);
  const description = pick(html, /<strong>Remarks - Public:<\/strong>([^]*?)<table style="width: 100%;" border="0" cellspacing="0" cellpadding="0">/i)
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
  const mapMatch = decode(html).match(/markers=([-\d.]+)%2C([-\d.]+)%2Cstar/i);
  const longitude = mapMatch?.[1] ? Number(mapMatch[1]) : undefined;
  const latitude = mapMatch?.[2] ? Number(mapMatch[2]) : undefined;
  const photoUrls = Array.from(new Set(Array.from(html.matchAll(/<img[^>]+id="\{\{PHOTO:[^\"]+\}\}"[^>]+src="([^"]+)"/gi)).map((match) => decode(match[1])).filter(Boolean))).slice(0, 12);

  if (!price || !bedrooms || !bathrooms || !squareFootage || !propertyType) {
    throw new Error(`Missing required fields from artifact for ${listingId}. price=${price} beds=${bedrooms} baths=${bathrooms} sqft=${squareFootage} type=${propertyType}`);
  }

  const downloadedPhotos = await downloadListingImages(listingId, photoUrls);
  const underwrite = await buildGroundedUnderwriteBundle({
    listingId,
    listingSource: "mls_on_demand",
    identifierLabel: "MLS#",
    skipMarketGate: true,
    address,
    listingUrl,
    city,
    state,
    zip,
    price,
    bedrooms,
    bathrooms,
    squareFootage,
    propertyType,
    subtypeCode,
    area,
    subdivision,
    nightlyRentalAllowed,
    nightlyRentalAllowedSource: nightlyRentalAllowed ? "flexmls_private_report_html" : "",
    strApproved: nightlyRentalAllowed ? /^yes$/i.test(nightlyRentalAllowed) : undefined,
    photoUrls: downloadedPhotos.length > 0 ? downloadedPhotos : photoUrls,
    openHouses: [],
    description,
    latitude,
    longitude,
  }, {
    enableWebSearch: envFlag("UNDERWRITE_WEB_RESEARCH_ENABLED", true),
  });

  const listingPath = inferListingPath(listingId);
  const evalPath = inferEvalPath(listingId);
  await writeFile(listingPath, `${JSON.stringify(underwrite.listingData, null, 2)}\n`);
  await writeFile(evalPath, `${JSON.stringify(underwrite.evalData, null, 2)}\n`);

  const hasListingRow = await listingExists(listingId);
  if (!hasListingRow) {
    await appendSheetRow("Listings", buildListingRow(underwrite.listingData, { source: "mls_on_demand", status: "Active" }));
  }

  let resolved = await resolveEvaluationByMls(listingId);
  if (!resolved) {
    await writeEvaluationVersion(underwrite.evalData, {
      source: "mls_on_demand",
      status: "pending_review",
      version: "1",
      "pdf-path": `data/pdfs/${listingId}.pdf`,
    });
    resolved = await resolveEvaluationByMls(listingId);
  }

  if (!resolved) throw new Error(`Could not resolve evaluation for ${listingId} after writing sheet rows.`);

  const postedRecord = await readPostedReviewRecord(channel, listingId).catch(() => null);
  const recoveredThreadTs = postedRecord ? asString(postedRecord.record.threadTs) : "";
  if (recoveredThreadTs) {
    console.log(JSON.stringify({ ok: true, action: "already_posted", listingId, threadTs: recoveredThreadTs }, null, 2));
    return;
  }

  const { reply } = await import("./slack.ts");
  const text = await buildReviewMessage(resolved.data);
  await reply(channel, threadTs, text);
  await savePostedReviewRecord({
    channel,
    mlsNumber: listingId,
    threadTs,
    source: "mls_on_demand",
    evalId: asString(resolved.row["Eval ID"]),
    version: Number(resolved.row.Version),
  });
  const nextRow = await updateEvaluationSummaryRow(resolved.row, { Status: "posted", "Slack Timestamp": threadTs });
  await upsertThreadContext({
    threadTs,
    row: nextRow,
    data: resolved.data,
    slackChannelId: channel,
    event: {
      kind: "on-demand-review",
      note: `Posted on-demand review for ${listingId} from FlexMLS private report fallback.`,
      status: "posted",
      version: Number(nextRow.Version),
    },
  });

  console.log(JSON.stringify({
    ok: true,
    action: "posted",
    listingId,
    threadTs,
    listingPath,
    evalPath,
    researchPath: underwrite.researchPath || "",
    webResearchResults: underwrite.research.results.length,
  }, null, 2));
}

await main();
