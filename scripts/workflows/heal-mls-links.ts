import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";

import { readSheet, updateSheetRow } from "../sheets.ts";
import { inferEvalPath, inferListingPath, repoRoot } from "./lib.ts";

type LinkHealingCandidate = {
  mlsNumber: string;
  address: string;
  cityStateZip: string;
  listingUrl?: string;
  listingUrlSource?: string;
  listingRowId?: string;
  listingRecordId?: string;
  listingMlsBoardId?: string;
  reason: string;
  mhtmlPath?: string;
  detectedAt: string;
};

type HealResult = {
  mlsNumber: string;
  status: "healed" | "unresolved" | "skipped";
  reason: string;
  resolvedUrl?: string;
  resolvedSource?: string;
  mhtmlPath?: string;
  candidates?: string[];
  updatedListingJson?: boolean;
  updatedEvalJson?: boolean;
  updatedSheetRows?: number[];
};

const queuePath = resolve(repoRoot, "data/inbox/mls-link-healing-queue.json");
const resultLogPath = resolve(repoRoot, "data/inbox/mls-link-healing-results.jsonl");

function argValue(flag: string) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function decodeQuotedPrintable(input: string) {
  return input
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function slugTokens(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

function scoreCandidate(url: string, item: Pick<LinkHealingCandidate, "address" | "cityStateZip">, source: string) {
  let score = 0;
  if (source === "permalinklink") score += 100;
  if (source === "permalinkinput") score += 90;
  if (source === "generic") score += 40;

  const lower = url.toLowerCase();
  for (const token of slugTokens(`${item.address} ${item.cityStateZip}`)) {
    if (lower.includes(token)) score += 5;
  }
  return score;
}

function findFirstMatch(text: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function extractShareLinkFromMhtml(rawMhtml: string, item: Pick<LinkHealingCandidate, "address" | "cityStateZip">) {
  const decoded = decodeQuotedPrintable(rawMhtml);
  const matches: Array<{ url: string; source: string }> = [];

  const permalinkLinkUrl = findFirstMatch(decoded, [
    /id="permalinklink"[^>]*href="(https:\/\/www\.flexmls\.com\/share\/[^"]+)"/i,
    /href="(https:\/\/www\.flexmls\.com\/share\/[^"]+)"[^>]*id="permalinklink"/i,
  ]);
  if (permalinkLinkUrl) {
    matches.push({ url: permalinkLinkUrl, source: "permalinklink" });
  }

  const permalinkInputUrl = findFirstMatch(decoded, [
    /id="permalinkinput"[^>]*(?:value|VALUE)="(https:\/\/www\.flexmls\.com\/share\/[^"]+)"/i,
    /(?:value|VALUE)="(https:\/\/www\.flexmls\.com\/share\/[^"]+)"[^>]*id="permalinkinput"/i,
  ]);
  if (permalinkInputUrl) {
    matches.push({ url: permalinkInputUrl, source: "permalinkinput" });
  }

  const genericMatches = decoded.match(/https:\/\/www\.flexmls\.com\/share\/[A-Za-z0-9/_-]+/g) || [];
  for (const url of genericMatches) {
    matches.push({ url: url.trim(), source: "generic" });
  }

  const deduped = Array.from(new Map(matches.map((match) => [match.url, match])).values());
  deduped.sort((a, b) => scoreCandidate(b.url, item, b.source) - scoreCandidate(a.url, item, a.source));

  return {
    best: deduped[0]?.url || "",
    source: deduped[0]?.source || "",
    candidates: deduped.map((match) => match.url),
  };
}

async function readQueue() {
  if (!existsSync(queuePath)) return [] as LinkHealingCandidate[];
  const raw = await readFile(queuePath, "utf8");
  const parsed = JSON.parse(raw) as LinkHealingCandidate[];
  return Array.isArray(parsed) ? parsed : [];
}

async function writeQueue(items: LinkHealingCandidate[]) {
  await writeFile(queuePath, `${JSON.stringify(items, null, 2)}\n`);
}

async function appendResultLog(result: HealResult) {
  await mkdir(resolve(repoRoot, "data/inbox"), { recursive: true });
  await appendFile(resultLogPath, `${JSON.stringify({ at: new Date().toISOString(), ...result })}\n`);
}

async function patchJsonFile(path: string, listingUrl: string) {
  if (!existsSync(path)) return false;
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (String(parsed.listingUrl || "") === listingUrl) return false;
  parsed.listingUrl = listingUrl;
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`);
  return true;
}

async function patchListingsSheet(mlsNumber: string, listingUrl: string) {
  const matches = (await readSheet("Listings")) as Array<Record<string, unknown>>;
  let updated = false;
  for (const row of matches) {
    if (String(row["MLS #"] || "").trim() !== mlsNumber) continue;
    if (String(row["Listing URL"] || "").trim() === listingUrl) continue;
    const nextRow = { ...row, "Listing URL": listingUrl };
    await updateSheetRow("Listings", mlsNumber, nextRow);
    updated = true;
  }
  return updated;
}

async function healItem(item: LinkHealingCandidate, dryRun: boolean): Promise<HealResult> {
  if (!item.mhtmlPath || !existsSync(item.mhtmlPath)) {
    return {
      mlsNumber: item.mlsNumber,
      status: "unresolved",
      reason: "missing_mhtml",
      mhtmlPath: item.mhtmlPath,
    };
  }

  const rawMhtml = await readFile(item.mhtmlPath, "utf8");
  const extraction = extractShareLinkFromMhtml(rawMhtml, item);
  if (!extraction.best) {
    return {
      mlsNumber: item.mlsNumber,
      status: "unresolved",
      reason: "no_share_url_found",
      mhtmlPath: item.mhtmlPath,
      candidates: extraction.candidates,
    };
  }

  if (dryRun) {
    return {
      mlsNumber: item.mlsNumber,
      status: "skipped",
      reason: "dry_run",
      resolvedUrl: extraction.best,
      resolvedSource: extraction.source,
      mhtmlPath: item.mhtmlPath,
      candidates: extraction.candidates,
      updatedSheetRows: [],
    };
  }

  const updatedListingJson = await patchJsonFile(inferListingPath(item.mlsNumber), extraction.best);
  const updatedEvalJson = await patchJsonFile(inferEvalPath(item.mlsNumber), extraction.best);
  const updatedSheetRows = await patchListingsSheet(item.mlsNumber, extraction.best);

  return {
    mlsNumber: item.mlsNumber,
    status: "healed",
    reason: `mhtml_${extraction.source || "share_url"}`,
    resolvedUrl: extraction.best,
    resolvedSource: extraction.source,
    mhtmlPath: item.mhtmlPath,
    candidates: extraction.candidates,
    updatedListingJson,
    updatedEvalJson,
    updatedSheetRows,
  };
}

function inferMlsFromFilename(path: string) {
  const match = basename(path).match(/(\d{7,8})/);
  return match ? match[1] : "";
}

async function main() {
  const explicitMhtml = argValue("--mhtml");
  const explicitMls = argValue("--mls");
  const dryRun = process.argv.includes("--dry-run");

  let items: LinkHealingCandidate[] = [];
  if (explicitMhtml) {
    items = [{
      mlsNumber: explicitMls || inferMlsFromFilename(explicitMhtml),
      address: "",
      cityStateZip: "",
      reason: "manual_mhtml",
      mhtmlPath: explicitMhtml,
      detectedAt: new Date().toISOString(),
    }];
  } else {
    items = await readQueue();
  }

  if (items.length === 0) {
    console.log(JSON.stringify({ ok: true, action: "noop", queuePath, count: 0, dryRun }, null, 2));
    return;
  }

  const results: HealResult[] = [];
  const unresolvedItems: LinkHealingCandidate[] = [];

  for (const item of items) {
    const result = await healItem(item, dryRun);
    results.push(result);
    await appendResultLog(result);
    if (result.status !== "healed" && !explicitMhtml) {
      unresolvedItems.push(item);
    }
  }

  if (!explicitMhtml && !dryRun) {
    await writeQueue(unresolvedItems);
  }

  console.log(JSON.stringify({
    ok: true,
    action: explicitMhtml ? "manual_heal" : "queue_heal",
    dryRun,
    queuePath,
    resultLogPath,
    processed: results.length,
    healed: results.filter((result) => result.status === "healed").length,
    unresolved: results.filter((result) => result.status === "unresolved").length,
    results,
  }, null, 2));
}

await main();
