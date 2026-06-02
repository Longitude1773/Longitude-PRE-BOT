import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// === Types ===

export type LuxuryTier = "tier-1" | "tier-2" | "tier-3" | "tier-4";

export const TIERS: readonly LuxuryTier[] = ["tier-1", "tier-2", "tier-3", "tier-4"];

export const TIER_DISPLAY_NAME: Record<LuxuryTier, string> = {
  "tier-1": "Tier 1 (Standard)",
  "tier-2": "Tier 2 (Premium)",
  "tier-3": "Tier 3 (Luxury)",
  "tier-4": "Tier 4 (Ultra-Luxury)",
};

export type TierDefinition = {
  description: string;
  examples: string[];
  priceCeiling?: number;
  ppsfCeiling?: number;
};

export type PrimaryAmenity = {
  name: string;
  lift: number;
  geographicScope?: string[];
  qualifier?: string;
};

export type SecondaryAmenity = { name: string };

export type AmenityFramework = {
  primaries: PrimaryAmenity[];
  primaryDiminishingReturn: number;
  secondaries: SecondaryAmenity[];
  secondaryThreshold: number;
  secondaryLiftWithoutPrimary: number;
  secondaryLiftWithPrimary: number;
};

export type AnchoredSubMarket = {
  kind: "anchored";
  name: string;
  market: string;
  anchorRevenueGrid: { [bedrooms: number]: Partial<Record<LuxuryTier, number>> };
  baseAdr: Partial<Record<LuxuryTier, [number, number]>>;
  baseOccupancy: Partial<Record<LuxuryTier, [number, number]>>;
};

export type DerivedSubMarket = {
  kind: "derived";
  name: string;
  market: string;
  derivedFrom: string;
  revenueFactor: number | Partial<Record<LuxuryTier, number>>;
  occupancyDelta: number;
  notes: string;
};

export type SubMarket = AnchoredSubMarket | DerivedSubMarket;

export type MarketKnowledge = {
  tierDefinitions: Record<LuxuryTier, TierDefinition>;
  amenityFramework: AmenityFramework;
  subMarkets: Record<string, SubMarket>;
};

export type EffectiveGrid = {
  byBedroom: { [bedrooms: number]: Partial<Record<LuxuryTier, number>> };
  baseAdr: Partial<Record<LuxuryTier, [number, number]>>;
  baseOccupancy: Partial<Record<LuxuryTier, [number, number]>>;
  anchorName: string;
  chain: string[];
  occupancyDeltaSum: number;
};

// === Constants ===

export const SEASONALITY_K = 306.62;
export const PARK_CITY_GENERIC_FALLBACK = { adr: 350, occupancy: 0.55 };

const FRAMEWORK_DEFAULTS = {
  primaryDiminishingReturn: 0.05,
  secondaryThreshold: 3,
  secondaryLiftWithoutPrimary: 0.10,
  secondaryLiftWithPrimary: 0.03,
};

const DEFAULT_PATH = resolve(import.meta.dirname, "../..", "data/market-knowledge.md");

// === Helpers ===

function normalizeText(s: string) {
  return s.trim().replace(/\s+/g, " ");
}

function parseCurrency(raw: string): number | undefined {
  const text = String(raw || "").trim();
  if (!text || text === "—") return undefined;
  const m = text.match(/\$?\s*([\d,]+(?:\.\d+)?)\s*([KkMm]?)/);
  if (!m) return undefined;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return undefined;
  const suffix = (m[2] || "").toLowerCase();
  if (suffix === "k") return n * 1_000;
  if (suffix === "m") return n * 1_000_000;
  return n;
}

function parsePercent(raw: string): number | undefined {
  const m = String(raw || "").trim().match(/([\d.]+)\s*%/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n / 100 : undefined;
}

function tierSlug(n: number | string): LuxuryTier | null {
  const num = Number(n);
  if (num === 1) return "tier-1";
  if (num === 2) return "tier-2";
  if (num === 3) return "tier-3";
  if (num === 4) return "tier-4";
  return null;
}

function parseRange(raw: string): [number, number] | undefined {
  const text = String(raw || "").replace(/\s/g, "");
  const m = text.match(/\$?([\d.,]+)-\$?([\d.,]+)/);
  if (!m) return undefined;
  const lo = Number(m[1].replace(/,/g, ""));
  const hi = Number(m[2].replace(/,/g, ""));
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return undefined;
  return [lo, hi];
}

function tableRowCells(line: string): string[] {
  // "| a | b | c |" → ["a", "b", "c"]
  const parts = line.split("|");
  return parts.slice(1, -1).map((c) => c.trim());
}

// === Parser ===

export function parseMarketKnowledge(raw: string): MarketKnowledge {
  const lines = raw.split("\n");
  const tierDefinitions: Partial<Record<LuxuryTier, TierDefinition>> = {};
  const subMarkets: Record<string, SubMarket> = {};
  let amenityFramework: AmenityFramework | undefined;

  type Section = "tier-defs" | "amenity-framework" | "sub-markets" | "other";
  let section: Section = "other";

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^##\s+Luxury Tier Definitions/i.test(line)) { section = "tier-defs"; i++; continue; }
    if (/^##\s+Amenity Framework/i.test(line)) { section = "amenity-framework"; i++; continue; }
    if (/^##\s+Sub-Markets/i.test(line)) { section = "sub-markets"; i++; continue; }
    if (/^##\s+/.test(line)) { section = "other"; i++; continue; }

    if (section === "tier-defs") {
      const tierMatch = line.match(/^###\s+Tier\s+(\d+)\s+—\s+(.+?)\s*$/);
      if (tierMatch) {
        const slug = tierSlug(tierMatch[1]);
        if (slug) {
          const result = parseTierBlock(lines, i + 1);
          tierDefinitions[slug] = result.def;
          i = result.nextIndex;
          continue;
        }
      }
    }

    if (section === "amenity-framework") {
      if (/^###\s+Primary Amenities/i.test(line)) {
        const result = parsePrimariesBlock(lines, i + 1);
        amenityFramework = {
          primaries: result.primaries,
          secondaries: [],
          ...FRAMEWORK_DEFAULTS,
        };
        i = result.nextIndex;
        continue;
      }
      if (/^###\s+Secondary Amenities/i.test(line)) {
        const result = parseSecondariesBlock(lines, i + 1);
        if (amenityFramework) amenityFramework.secondaries = result.secondaries;
        i = result.nextIndex;
        continue;
      }
    }

    if (section === "sub-markets") {
      const subMatch = line.match(/^###\s+(.+?)\s\s+\[(ANCHOR|DERIVED from (.+?))\]\s*$/);
      if (subMatch) {
        const name = normalizeText(subMatch[1]);
        const isAnchor = subMatch[2] === "ANCHOR";
        const derivedFrom = isAnchor ? "" : normalizeText(subMatch[3]);
        const result = parseSubMarketBlock(lines, i + 1, name, isAnchor, derivedFrom);
        subMarkets[name] = result.subMarket;
        i = result.nextIndex;
        continue;
      }
    }

    i++;
  }

  for (const slug of TIERS) {
    if (!tierDefinitions[slug]) throw new Error(`Missing tier definition: ${slug}`);
  }
  if (!amenityFramework) throw new Error("Missing Amenity Framework section");
  if (Object.keys(subMarkets).length === 0) throw new Error("No sub-markets parsed");

  return {
    tierDefinitions: tierDefinitions as Record<LuxuryTier, TierDefinition>,
    amenityFramework,
    subMarkets,
  };
}

function parseTierBlock(lines: string[], start: number) {
  const def: TierDefinition = { description: "", examples: [] };
  const descLines: string[] = [];
  let inExamples = false;
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    if (/^###\s+/.test(line) || /^##\s+/.test(line)) break;

    const ceilingMatch = line.match(/^Price ceiling:\s*(.*)$/i);
    if (ceilingMatch) { def.priceCeiling = parseCurrency(ceilingMatch[1]); i++; continue; }

    const ppsfMatch = line.match(/^PPSF ceiling:\s*(.*)$/i);
    if (ppsfMatch) { def.ppsfCeiling = parseCurrency(ppsfMatch[1]); i++; continue; }

    if (/^Examples:\s*$/i.test(line)) { inExamples = true; i++; continue; }

    if (inExamples) {
      const bulletMatch = line.match(/^-\s+(.+)$/);
      if (bulletMatch) { def.examples.push(bulletMatch[1].trim()); i++; continue; }
      if (!line.trim()) { i++; continue; }
      inExamples = false;
      continue;
    }

    if (line.trim()) descLines.push(line.trim());
    i++;
  }

  def.description = descLines.join(" ").trim();
  return { def, nextIndex: i };
}

function parsePrimariesBlock(lines: string[], start: number) {
  const primaries: PrimaryAmenity[] = [];
  let i = start;

  while (i < lines.length) {
    if (/^###\s+/.test(lines[i]) || /^##\s+/.test(lines[i])) break;
    if (/^\|\s*Amenity\s*\|/.test(lines[i])) {
      i++;
      if (i < lines.length && /^\|[\s|\-:]+\|$/.test(lines[i])) i++;
      while (i < lines.length && lines[i].startsWith("|")) {
        const cells = tableRowCells(lines[i]);
        if (cells.length >= 4) {
          const name = cells[0];
          const lift = parsePercent(cells[1]);
          const scope = cells[2] === "—" || !cells[2] ? undefined : cells[2].split(",").map((s) => normalizeText(s));
          const qualifier = cells[3] === "—" || !cells[3] ? undefined : cells[3];
          if (name && lift !== undefined) primaries.push({ name, lift, geographicScope: scope, qualifier });
        }
        i++;
      }
      break;
    }
    i++;
  }

  return { primaries, nextIndex: i };
}

function parseSecondariesBlock(lines: string[], start: number) {
  // Collect the FIRST contiguous bullet group only. Prose later in the section
  // (threshold-rule bullets, etc.) is not part of the secondaries list.
  const secondaries: SecondaryAmenity[] = [];
  let i = start;
  let started = false;

  while (i < lines.length) {
    if (/^###\s+/.test(lines[i]) || /^##\s+/.test(lines[i])) break;
    const bulletMatch = lines[i].match(/^-\s+(.+)$/);
    if (bulletMatch) {
      started = true;
      const name = bulletMatch[1].trim();
      if (name && !/^Tier\s+\d/i.test(name)) secondaries.push({ name });
      i++;
      continue;
    }
    // First non-blank, non-bullet line after we've started → end of list.
    if (started && lines[i].trim() !== "") break;
    i++;
  }

  return { secondaries, nextIndex: i };
}

function parseSubMarketBlock(lines: string[], start: number, name: string, isAnchor: boolean, derivedFrom: string) {
  let i = start;
  let market = "";

  while (i < lines.length) {
    if (/^###\s+/.test(lines[i]) || /^##\s+/.test(lines[i])) break;
    const m = lines[i].match(/^Market:\s*(.+)$/i);
    if (m) { market = m[1].trim(); i++; break; }
    i++;
  }

  if (isAnchor) {
    const grid: { [bedrooms: number]: Partial<Record<LuxuryTier, number>> } = {};
    const baseAdr: Partial<Record<LuxuryTier, [number, number]>> = {};
    const baseOccupancy: Partial<Record<LuxuryTier, [number, number]>> = {};

    while (i < lines.length) {
      if (/^###\s+/.test(lines[i]) || /^##\s+/.test(lines[i])) break;
      const line = lines[i];

      if (/^\|\s*Bedrooms\s*\|/.test(line)) {
        i++;
        if (i < lines.length && /^\|[\s|\-:]+\|$/.test(lines[i])) i++;
        while (i < lines.length && lines[i].startsWith("|")) {
          const cells = tableRowCells(lines[i]);
          if (cells.length >= 5) {
            const bedrooms = Number(cells[0]);
            if (Number.isFinite(bedrooms)) {
              const row: Partial<Record<LuxuryTier, number>> = {};
              const t1 = parseCurrency(cells[1]); if (t1 !== undefined) row["tier-1"] = t1;
              const t2 = parseCurrency(cells[2]); if (t2 !== undefined) row["tier-2"] = t2;
              const t3 = parseCurrency(cells[3]); if (t3 !== undefined) row["tier-3"] = t3;
              const t4 = parseCurrency(cells[4]); if (t4 !== undefined) row["tier-4"] = t4;
              grid[bedrooms] = row;
            }
          }
          i++;
        }
        continue;
      }

      if (/^Typical ADR by tier/i.test(line)) {
        i++;
        while (i < lines.length) {
          const next = lines[i];
          if (/^###\s+/.test(next) || /^##\s+/.test(next)) break;
          const m = next.match(/^-\s+Tier\s+(\d+):\s+(.+)$/);
          if (m) {
            const slug = tierSlug(m[1]);
            const range = parseRange(m[2]);
            if (slug && range) baseAdr[slug] = range;
            i++;
            continue;
          }
          if (next.trim() === "" || /^Typical/i.test(next)) break;
          i++;
        }
        continue;
      }

      if (/^Typical occupancy by tier/i.test(line)) {
        i++;
        while (i < lines.length) {
          const next = lines[i];
          if (/^###\s+/.test(next) || /^##\s+/.test(next)) break;
          const m = next.match(/^-\s+Tier\s+(\d+):\s+(.+)$/);
          if (m) {
            const slug = tierSlug(m[1]);
            const range = parseRange(m[2]);
            if (slug && range) baseOccupancy[slug] = range;
            i++;
            continue;
          }
          if (next.trim() === "" || /^Typical/i.test(next)) break;
          i++;
        }
        continue;
      }

      i++;
    }

    return {
      subMarket: { kind: "anchored" as const, name, market, anchorRevenueGrid: grid, baseAdr, baseOccupancy },
      nextIndex: i,
    };
  }

  // Derived sub-market
  let revenueFactor: number | Partial<Record<LuxuryTier, number>> = 1;
  let occupancyDelta = 0;
  let notes = "";

  while (i < lines.length) {
    if (/^###\s+/.test(lines[i]) || /^##\s+/.test(lines[i])) break;
    const line = lines[i];

    const factorMatch = line.match(/^Revenue factor:\s*(.*)$/i);
    if (factorMatch) {
      const value = factorMatch[1].trim();
      if (value) {
        const n = Number(value);
        if (Number.isFinite(n)) revenueFactor = n;
        i++;
      } else {
        i++;
        const tieredFactor: Partial<Record<LuxuryTier, number>> = {};
        while (i < lines.length) {
          const next = lines[i];
          const bulletMatch = next.match(/^-\s+Tier\s+(\d+):\s+([\d.]+)\s*$/);
          if (bulletMatch) {
            const slug = tierSlug(bulletMatch[1]);
            const n = Number(bulletMatch[2]);
            if (slug && Number.isFinite(n)) tieredFactor[slug] = n;
            i++;
            continue;
          }
          break;
        }
        revenueFactor = tieredFactor;
      }
      continue;
    }

    const deltaMatch = line.match(/^Occupancy delta:\s*(.+)$/i);
    if (deltaMatch) {
      const n = Number(deltaMatch[1].trim());
      if (Number.isFinite(n)) occupancyDelta = n;
      i++;
      continue;
    }

    const notesMatch = line.match(/^Notes:\s*(.+)$/i);
    if (notesMatch) {
      notes = notesMatch[1].trim();
      i++;
      while (i < lines.length) {
        const next = lines[i];
        if (/^###\s+/.test(next) || /^##\s+/.test(next)) break;
        if (/^(Market|Revenue factor|Occupancy delta|Notes):/i.test(next)) break;
        if (next.trim()) notes += " " + next.trim();
        else if (notes) break;
        i++;
      }
      continue;
    }

    i++;
  }

  return {
    subMarket: { kind: "derived" as const, name, market, derivedFrom, revenueFactor, occupancyDelta, notes },
    nextIndex: i,
  };
}

// === Chain resolver ===

export function resolveEffectiveGrid(knowledge: MarketKnowledge, subMarketName: string): EffectiveGrid {
  const start = knowledge.subMarkets[subMarketName];
  if (!start) throw new Error(`Unknown sub-market: ${subMarketName}`);

  const visited = new Set<string>();
  const chain: string[] = [];
  let occupancyDeltaSum = 0;
  const factors: Array<number | Partial<Record<LuxuryTier, number>>> = [];

  let cursor: SubMarket = start;
  while (cursor.kind === "derived") {
    if (visited.has(cursor.name)) {
      throw new Error(`Cycle detected in sub-market chain: ${[...chain, cursor.name].join(" → ")}`);
    }
    visited.add(cursor.name);
    chain.push(cursor.name);
    factors.push(cursor.revenueFactor);
    occupancyDeltaSum += cursor.occupancyDelta;
    const next = knowledge.subMarkets[cursor.derivedFrom];
    if (!next) throw new Error(`Broken chain at ${cursor.name}: derivedFrom "${cursor.derivedFrom}" not found`);
    cursor = next;
  }

  const anchor = cursor as AnchoredSubMarket;

  const byBedroom: { [bedrooms: number]: Partial<Record<LuxuryTier, number>> } = {};
  for (const [bedroomsStr, tierMap] of Object.entries(anchor.anchorRevenueGrid)) {
    const bedrooms = Number(bedroomsStr);
    const row: Partial<Record<LuxuryTier, number>> = {};
    for (const tier of TIERS) {
      const anchorValue = tierMap[tier];
      if (anchorValue === undefined) continue;
      let value: number | undefined = anchorValue;
      for (const factor of factors) {
        if (value === undefined) break;
        const f = typeof factor === "number" ? factor : factor[tier];
        if (f === undefined) { value = undefined; break; }
        value = value * f;
      }
      if (value !== undefined) row[tier] = value;
    }
    byBedroom[bedrooms] = row;
  }

  return {
    byBedroom,
    baseAdr: anchor.baseAdr,
    baseOccupancy: anchor.baseOccupancy,
    anchorName: anchor.name,
    chain,
    occupancyDeltaSum,
  };
}

// === File loader (cached) ===

let cachedKnowledge: MarketKnowledge | undefined;
let cachedPath: string | undefined;

export async function loadMarketKnowledge(path = DEFAULT_PATH): Promise<MarketKnowledge> {
  if (cachedKnowledge && cachedPath === path) return cachedKnowledge;
  const raw = await readFile(path, "utf8");
  cachedKnowledge = parseMarketKnowledge(raw);
  cachedPath = path;
  return cachedKnowledge;
}

export function clearMarketKnowledgeCache() {
  cachedKnowledge = undefined;
  cachedPath = undefined;
}

// Read-tolerant amenities unwrap. Accepts:
//   { primary: string[], secondary: string[] }  → new structured format
//   string[]                                    → legacy [area, subdivision] format → empty
//   JSON string of either                       → parse + recurse
//   anything else                               → warn + empty
export function unwrapAmenities(value: unknown): { primary: string[]; secondary: string[] } {
  if (value == null) return { primary: [], secondary: [] };
  if (Array.isArray(value)) return { primary: [], secondary: [] };
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if ("primary" in v || "secondary" in v) {
      return {
        primary: Array.isArray(v.primary) ? v.primary.filter((s): s is string => typeof s === "string") : [],
        secondary: Array.isArray(v.secondary) ? v.secondary.filter((s): s is string => typeof s === "string") : [],
      };
    }
  }
  if (typeof value === "string" && value.trim()) {
    try {
      return unwrapAmenities(JSON.parse(value));
    } catch {
      return { primary: [], secondary: [] };
    }
  }
  console.warn("unwrapAmenities: unexpected value shape, defaulting to empty", value);
  return { primary: [], secondary: [] };
}

// === Classification ===

export type ListingFacts = {
  price?: number;
  squareFootage?: number;
  bedrooms?: number;
  maxOccupancy?: number;
  area?: string;
  subdivision?: string;
  address?: string;
  city?: string;
  description?: string;
  amenities?: string[];
};

export type Classification = {
  market: string;
  subMarket: string;
  luxuryTier: LuxuryTier;
  tierConfidence: "high" | "borderline";
  borderlineWith?: LuxuryTier;
  amenities: { primary: string[]; secondary: string[] };
};

// Ordered most-specific to least-specific. NOTE: do NOT add bare-city catch-alls
// like "park city" or "heber" here — postal city is matched separately (pass 2)
// in inferSubMarket, and falling through to "matched: false" routes the listing
// to the low-confidence generic fallback in underwrite.ts.
export const SUB_MARKET_KEYWORDS: Array<{ keywords: string[]; name: string; promontoryHint?: boolean }> = [
  { keywords: ["empire pass", "upper deer valley", "silver lake", "bald eagle", "solamere"], name: "Upper Deer Valley" },
  { keywords: ["deer valley east village", "east village", "deer crest"], name: "Deer Valley East Village" },
  { keywords: ["lower deer valley", "snow park"], name: "Lower Deer Valley" },
  { keywords: ["canyons", "the colony", "white pine"], name: "Canyons Village" },
  { keywords: ["old town", "main st", "main street", "park meadows", "prospector", "marsac", "daly", "norfolk", "park avenue"], name: "Old Town / Main St" },
  { keywords: ["glen wild", "glenwild", "racquet club", "park city north"], name: "Park City North (Glen Wild / Racquet Club)" },
  { keywords: ["pinebrook", "jeremy ranch", "summit park"], name: "Pinebrook / Jeremy Ranch / Summit Park" },
  { keywords: ["promontory"], name: "East Basin", promontoryHint: true },
  { keywords: ["silver summit"], name: "Silver Summit" },
  { keywords: ["kimball junction", "newpark", "silver creek", "bear hollow", "kimball"], name: "Kimball Junction" },
  { keywords: ["lakeside", "jordanelle lakeside", "mayflower", "sky ridge", "jordanelle"], name: "Lakeside" },
  { keywords: ["jordanelle ridge", "mountain village"], name: "Jordanelle Ridge" },
  { keywords: ["hideout", "black rock"], name: "Hideout" },
  { keywords: ["south valley", "francis", "woodland", "victory ranch"], name: "South Valley" },
  { keywords: ["north fields"], name: "North Fields" },
  { keywords: ["heber mountains", "heber mountain", "lake creek"], name: "Heber Mountains" },
  { keywords: ["heber town", "heber center", "heber main street"], name: "Heber Town Center" },
  { keywords: ["midway", "soldier hollow", "wasatch state park", "homestead"], name: "Midway" },
  { keywords: ["kamas", "oakley", "mirror lake"], name: "Kamas/Oakley" },
];

const PRIMARY_AMENITY_ALIASES: Record<string, string[]> = {
  "Ski-in/ski-out access": ["ski-in/ski-out", "ski in/ski out", "ski in ski out", "ski-in ski-out", "skiin skiout"],
};

const SECONDARY_AMENITY_ALIASES: Record<string, string[]> = {
  "Hot tub": ["hot tub", "hottub", "hot-tub", "jacuzzi"],
  "Game room": ["game room", "gameroom", "game-room", "rec room"],
  "Theater room": ["theater room", "theatre room", "media room", "home theater", "home theatre", "screening room"],
  "Sauna / steam room": ["sauna", "steam room", "steam shower"],
  "Golf simulator": ["golf simulator", "golf sim"],
  "Heated driveway": ["heated driveway"],
  "Firepit": ["firepit", "fire pit", "fire-pit"],
  "Fitness room": ["fitness room", "gym", "workout room", "exercise room"],
  "Exceptional views": ["mountain view", "valley view", "scenic view", "panoramic view"],
};

function buildCorpus(input: ListingFacts): string {
  // All-fields corpus; used by inferAmenities.
  return [
    input.area, input.subdivision, input.address, input.city, input.description,
    ...(input.amenities || []),
  ].filter(Boolean).join(" ").toLowerCase();
}

function buildStrongCorpus(input: ListingFacts): string {
  // Strong sub-market signals only; excludes postal city, which is almost
  // always "Park City, UT" or "Heber City, UT" regardless of actual sub-market.
  return [
    input.area, input.subdivision, input.address, input.description,
    ...(input.amenities || []),
  ].filter(Boolean).join(" ").toLowerCase();
}

function nextTierOf(t: LuxuryTier): LuxuryTier {
  if (t === "tier-1") return "tier-2";
  if (t === "tier-2") return "tier-3";
  if (t === "tier-3") return "tier-4";
  return "tier-4";
}

export function inferSubMarket(input: ListingFacts, knowledge: MarketKnowledge): { name: string; matched: boolean; promontoryHint: boolean } {
  // Pass 1: strong-signal fields (description / area / subdivision / address / amenities).
  const strong = buildStrongCorpus(input);
  for (const entry of SUB_MARKET_KEYWORDS) {
    if (entry.keywords.some((kw) => strong.includes(kw))) {
      if (knowledge.subMarkets[entry.name]) {
        return { name: entry.name, matched: true, promontoryHint: !!entry.promontoryHint };
      }
    }
  }
  // Pass 2: postal city as last-resort tiebreaker. Only neighborhood-distinctive
  // city names like "Kamas" or "Midway" will hit — bare "Park City" / "Heber"
  // are intentionally absent from the keyword list.
  const cityCorpus = (input.city || "").toLowerCase();
  if (cityCorpus) {
    for (const entry of SUB_MARKET_KEYWORDS) {
      if (entry.keywords.some((kw) => cityCorpus.includes(kw))) {
        if (knowledge.subMarkets[entry.name]) {
          return { name: entry.name, matched: true, promontoryHint: !!entry.promontoryHint };
        }
      }
    }
  }
  return { name: "", matched: false, promontoryHint: false };
}

export function inferTier(input: ListingFacts, knowledge: MarketKnowledge): { tier: LuxuryTier; confidence: "high" | "borderline"; borderlineWith?: LuxuryTier } {
  const price = input.price || 0;
  const sqft = input.squareFootage || 0;
  const ppsf = sqft > 0 ? price / sqft : 0;

  const lowerTiers: LuxuryTier[] = ["tier-1", "tier-2", "tier-3"];
  let exceededCount = 0;
  for (const candidate of lowerTiers) {
    const def = knowledge.tierDefinitions[candidate];
    const priceExceeded = def.priceCeiling != null && price > def.priceCeiling;
    const ppsfExceeded = def.ppsfCeiling != null && ppsf > def.ppsfCeiling;
    if (priceExceeded || ppsfExceeded) exceededCount++;
  }
  const allTiers: LuxuryTier[] = ["tier-1", "tier-2", "tier-3", "tier-4"];
  const tier = allTiers[exceededCount];

  // Borderline: within 10% (inclusive) of any ceiling on either dimension.
  const BORDERLINE_PCT = 0.10;
  let borderlineWith: LuxuryTier | undefined;
  for (const candidate of lowerTiers) {
    const def = knowledge.tierDefinitions[candidate];
    const nearPrice = def.priceCeiling != null && price > 0 &&
      Math.abs(price / def.priceCeiling - 1) <= BORDERLINE_PCT;
    const nearPpsf = def.ppsfCeiling != null && ppsf > 0 &&
      Math.abs(ppsf / def.ppsfCeiling - 1) <= BORDERLINE_PCT;
    if (nearPrice || nearPpsf) {
      const above = nextTierOf(candidate);
      borderlineWith = tier === above ? candidate : above;
      break;
    }
  }

  return {
    tier,
    confidence: borderlineWith ? "borderline" : "high",
    borderlineWith,
  };
}

export function inferAmenities(input: ListingFacts, knowledge: MarketKnowledge, subMarketName: string): { primary: string[]; secondary: string[] } {
  const corpus = buildCorpus(input);
  const primary: string[] = [];
  const secondary: string[] = [];

  for (const p of knowledge.amenityFramework.primaries) {
    if (p.name === "Ski-in/ski-out access") {
      const aliases = PRIMARY_AMENITY_ALIASES[p.name] || [];
      const keywordHit = aliases.some((a) => corpus.includes(a));
      const scopeMatch = !p.geographicScope || p.geographicScope.includes(subMarketName);
      if (keywordHit && scopeMatch) primary.push(p.name);
      continue;
    }
    if (p.name === "Exceptional sleeping capacity") {
      const bedrooms = input.bedrooms || 0;
      const maxOcc = input.maxOccupancy || 0;
      if (bedrooms > 0 && maxOcc >= bedrooms * 2 + 4) primary.push(p.name);
      continue;
    }
    // "Iconic/unique" never auto-triggers in V1; user adds via Slack adjustment.
  }

  for (const s of knowledge.amenityFramework.secondaries) {
    const aliases = SECONDARY_AMENITY_ALIASES[s.name] || [s.name.toLowerCase()];
    if (aliases.some((a) => corpus.includes(a))) secondary.push(s.name);
  }

  return { primary, secondary };
}

// === Projection math ===

export type ProjectionResult = {
  annualRevenue: number;
  adr: number;
  occupancy: number;
  methodologyNotes: string[];
};

type CellHit = { value: number; bedroomsUsed: number; tierUsed: LuxuryTier };

function findNearestCell(eff: EffectiveGrid, bedrooms: number, tier: LuxuryTier): CellHit | null {
  const direct = eff.byBedroom[bedrooms]?.[tier];
  if (direct !== undefined) return { value: direct, bedroomsUsed: bedrooms, tierUsed: tier };

  // Walk bedrooms at the requested tier: nearest defined bedrooms (ties prefer lower).
  const bedroomCandidates = Object.keys(eff.byBedroom)
    .map(Number)
    .filter((b) => eff.byBedroom[b]?.[tier] !== undefined)
    .sort((a, b) => Math.abs(a - bedrooms) - Math.abs(b - bedrooms) || a - b);
  if (bedroomCandidates.length > 0) {
    const b = bedroomCandidates[0];
    return { value: eff.byBedroom[b][tier]!, bedroomsUsed: b, tierUsed: tier };
  }

  // Walk tier: prefer lower (one tier down) before higher.
  const tierOrder: LuxuryTier[] = ["tier-1", "tier-2", "tier-3", "tier-4"];
  const tierIdx = tierOrder.indexOf(tier);
  for (let d = 1; d < 4; d++) {
    for (const dir of [-1, +1]) {
      const altIdx = tierIdx + dir * d;
      if (altIdx < 0 || altIdx >= tierOrder.length) continue;
      const altTier = tierOrder[altIdx];
      // Try same bedrooms first
      const sameRoom = eff.byBedroom[bedrooms]?.[altTier];
      if (sameRoom !== undefined) return { value: sameRoom, bedroomsUsed: bedrooms, tierUsed: altTier };
      // Then nearest bedrooms
      const alts = Object.keys(eff.byBedroom)
        .map(Number)
        .filter((b) => eff.byBedroom[b]?.[altTier] !== undefined)
        .sort((a, b) => Math.abs(a - bedrooms) - Math.abs(b - bedrooms) || a - b);
      if (alts.length > 0) {
        const b = alts[0];
        return { value: eff.byBedroom[b][altTier]!, bedroomsUsed: b, tierUsed: altTier };
      }
    }
  }

  return null;
}

function applyPrimaryLift(target: number, primaries: string[], knowledge: MarketKnowledge) {
  if (primaries.length === 0) return { target, lift: 0 };
  const lifts = primaries
    .map((name) => knowledge.amenityFramework.primaries.find((p) => p.name === name)?.lift)
    .filter((v): v is number => typeof v === "number")
    .sort((a, b) => b - a);
  if (lifts.length === 0) return { target, lift: 0 };
  const largest = lifts[0];
  const diminishing = (lifts.length - 1) * knowledge.amenityFramework.primaryDiminishingReturn;
  const totalLift = largest + diminishing;
  return { target: target * (1 + totalLift), lift: totalLift };
}

function applySecondaryLift(target: number, count: number, hasPrimary: boolean, framework: AmenityFramework) {
  if (count < framework.secondaryThreshold) return { target, lift: 0 };
  const lift = hasPrimary ? framework.secondaryLiftWithPrimary : framework.secondaryLiftWithoutPrimary;
  return { target: target * (1 + lift), lift };
}

function backSolveAdrOcc(targetRevenue: number, baseAdr: [number, number], baseOcc: [number, number]) {
  const targetProduct = targetRevenue / SEASONALITY_K;
  const occMid = (baseOcc[0] + baseOcc[1]) / 2;
  let adr = targetProduct / occMid;
  let occ = occMid;
  const notes: string[] = [];

  if (adr > baseAdr[1]) {
    adr = baseAdr[1];
    occ = targetProduct / adr;
    if (occ > baseOcc[1]) {
      notes.push(
        `Stretched: target revenue $${Math.round(targetRevenue).toLocaleString()} exceeds typical ranges; capped ADR at $${Math.round(adr)} with occupancy ${occ.toFixed(2)}.`,
      );
    }
  } else if (adr < baseAdr[0]) {
    adr = baseAdr[0];
    occ = targetProduct / adr;
    if (occ < baseOcc[0]) {
      notes.push(
        `Stretched: target revenue $${Math.round(targetRevenue).toLocaleString()} below typical ranges; floored ADR at $${Math.round(adr)} with occupancy ${occ.toFixed(2)}.`,
      );
    }
  }

  return { adr, occ, notes };
}

export function projectMedium(
  bedrooms: number,
  knowledge: MarketKnowledge,
  classification: Classification | null,
): ProjectionResult {
  if (!classification) {
    const { adr, occupancy } = PARK_CITY_GENERIC_FALLBACK;
    return {
      annualRevenue: Math.round(adr * occupancy * SEASONALITY_K),
      adr,
      occupancy,
      methodologyNotes: [
        "Sub-market not recognized; used Park City generic baseline (ADR $350, occupancy 0.55).",
      ],
    };
  }

  const notes: string[] = [];
  const eff = resolveEffectiveGrid(knowledge, classification.subMarket);
  const cell = findNearestCell(eff, bedrooms, classification.luxuryTier);

  if (!cell) {
    const { adr, occupancy } = PARK_CITY_GENERIC_FALLBACK;
    return {
      annualRevenue: Math.round(adr * occupancy * SEASONALITY_K),
      adr,
      occupancy,
      methodologyNotes: [
        `No grid cell found for ${classification.subMarket} ${classification.luxuryTier} ${bedrooms}BR or any nearby cell; used Park City generic baseline.`,
      ],
    };
  }

  if (cell.bedroomsUsed !== bedrooms || cell.tierUsed !== classification.luxuryTier) {
    notes.push(
      `Used ${cell.bedroomsUsed}BR ${cell.tierUsed} cell as proxy for ${bedrooms}BR ${classification.luxuryTier} (not present in ${classification.subMarket}).`,
    );
  }

  let targetRevenue = cell.value;
  targetRevenue = applyPrimaryLift(targetRevenue, classification.amenities.primary, knowledge).target;
  targetRevenue = applySecondaryLift(
    targetRevenue,
    classification.amenities.secondary.length,
    classification.amenities.primary.length > 0,
    knowledge.amenityFramework,
  ).target;

  const baseAdr = eff.baseAdr[cell.tierUsed];
  const baseOcc = eff.baseOccupancy[cell.tierUsed];

  if (!baseAdr || !baseOcc) {
    notes.push(
      `Typical ADR/occupancy ranges missing for ${cell.tierUsed} in ${eff.anchorName}; using PC generic ranges.`,
    );
    const occWithDelta = Math.max(0.18, Math.min(0.82, PARK_CITY_GENERIC_FALLBACK.occupancy + eff.occupancyDeltaSum));
    return {
      annualRevenue: Math.round(targetRevenue),
      adr: PARK_CITY_GENERIC_FALLBACK.adr,
      occupancy: Number(occWithDelta.toFixed(4)),
      methodologyNotes: notes,
    };
  }

  const solved = backSolveAdrOcc(targetRevenue, baseAdr, baseOcc);
  notes.push(...solved.notes);

  const occupancy = Math.max(0.18, Math.min(0.82, solved.occ + eff.occupancyDeltaSum));

  return {
    annualRevenue: Math.round(targetRevenue),
    adr: Math.round(solved.adr),
    occupancy: Number(occupancy.toFixed(4)),
    methodologyNotes: notes,
  };
}

export function classify(input: ListingFacts, knowledge: MarketKnowledge): Classification | null {
  const subMarketResult = inferSubMarket(input, knowledge);
  if (!subMarketResult.matched) return null;

  const tierResult = inferTier(input, knowledge);

  let subMarket = subMarketResult.name;
  if (subMarketResult.promontoryHint && (tierResult.tier === "tier-3" || tierResult.tier === "tier-4")) {
    if (knowledge.subMarkets["East Basin (Promontory Tier 3-4)"]) {
      subMarket = "East Basin (Promontory Tier 3-4)";
    }
  }

  const market = knowledge.subMarkets[subMarket]?.market || "";
  const amenities = inferAmenities(input, knowledge, subMarket);

  return {
    market,
    subMarket,
    luxuryTier: tierResult.tier,
    tierConfidence: tierResult.confidence,
    borderlineWith: tierResult.borderlineWith,
    amenities,
  };
}
