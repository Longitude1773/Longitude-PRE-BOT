import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { repoRoot } from "./lib.ts";

function argValue(flag: string) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const AREA_MAP: Record<string, string> = {
  pinebrook: "Pinebrook/Jeremy Ranch",
  "jeremy ranch": "Pinebrook/Jeremy Ranch",
  kimball: "Kimball Junction",
  jordanelle: "Jordanelle",
  heber: "Heber/Midway",
  midway: "Heber/Midway",
  kamas: "Kamas/Oakley",
  oakley: "Kamas/Oakley",
  deer: "Lower Deer Valley",
  lower: "Lower Deer Valley",
  upper: "Upper Deer Valley",
  canyons: "Canyons Village",
  "old town": "Park City Core (Old Town/Main St)",
  "main st": "Park City Core (Old Town/Main St)",
};

function normalizeInstruction(input: string) {
  return input.replace(/^update market knowledge:\s*/i, "").trim();
}

function detectArea(text: string) {
  const lower = text.toLowerCase();
  for (const [needle, area] of Object.entries(AREA_MAP)) {
    if (lower.includes(needle)) return area;
  }
  return null;
}

function detectTier(text: string) {
  const lower = text.toLowerCase();
  if (lower.includes("premium")) return "premium";
  if (lower.includes("luxury") || lower.includes("ski-in")) return "luxury";
  return "standard";
}

async function main() {
  const instruction = argValue("--instruction");
  const dryRun = process.argv.includes("--dry-run");
  if (!instruction) throw new Error("Pass --instruction.");

  const normalized = normalizeInstruction(instruction);
  const area = detectArea(normalized);
  const tier = detectTier(normalized);
  const rangeMatch = normalized.match(/\$(\d+(?:,\d+)?)\s*[-–]\s*\$?(\d+(?:,\d+)?)/);
  if (!area || !rangeMatch) {
    throw new Error("Only structured ADR updates like 'Pinebrook standard ADR should be $300-400' are supported right now.");
  }

  const nextRange = `$${rangeMatch[1]}-$${rangeMatch[2]}`;
  const filePath = resolve(repoRoot, "data/market-knowledge.md");
  const current = await readFile(filePath, "utf8");
  const rowRegex = new RegExp(`^(\\| ${area.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\| )(\\$[^|]+)( \\| )(\\$[^|]+)( \\| )(.*?)( \\|)$`, "m");
  const match = current.match(rowRegex);
  if (!match) throw new Error(`Could not find ADR row for ${area}.`);

  let replacement = match[0];
  if (tier === "standard") replacement = `${match[1]}${nextRange}${match[3]}${match[4]}${match[5]}${match[6]}${match[7]}`;
  if (tier === "premium") replacement = `${match[1]}${match[2]}${match[3]}${nextRange}${match[5]}${match[6]}${match[7]}`;
  if (tier === "luxury") replacement = `${match[1]}${match[2]}${match[3]}${match[4]}${match[5]}${nextRange}${match[7]}`;

  const updated = current.replace(rowRegex, replacement);
  if (!dryRun) await writeFile(filePath, updated);

  console.log(JSON.stringify({
    ok: true,
    action: "market_knowledge_updated",
    area,
    tier,
    newRange: nextRange,
    dryRun,
  }, null, 2));
}

await main();