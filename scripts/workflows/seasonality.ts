import type { EvalData } from "../write-sheet-data.ts";
import { deriveSpreadScenarios, roundProjectionRevenue } from "./lib.ts";

type EvalScenario = NonNullable<EvalData["projections"]>["high"];

export type SeasonalityProfile = "standard" | "ski-heavy" | "summer-heavy";

export const SEASONALITY_PROFILES: readonly SeasonalityProfile[] = ["standard", "ski-heavy", "summer-heavy"];

export const SEASONALITY_LABEL: Record<SeasonalityProfile, string> = {
  standard: "Standard",
  "ski-heavy": "Ski-heavy",
  "summer-heavy": "Summer-heavy",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

// Share of annual revenue per month, Jan..Dec. Set by Erik on 2026-11-20; each
// row sums to 100. Standard is the default for every PRE; reviewers pick the
// others with "approve ski-heavy" / "approve summer-heavy".
export const SEASONALITY_SHARES: Record<SeasonalityProfile, readonly number[]> = {
  standard: [16, 15, 14, 2, 3, 9, 11, 9, 4, 3, 4, 10],
  "ski-heavy": [19, 18, 17, 2, 3, 6, 8, 6, 4, 2, 4, 11],
  "summer-heavy": [11, 10, 10, 2, 5, 12, 14, 12, 9, 3, 4, 8],
};

// The pre-2026-11-20 curve. Its only remaining job is to set the annual level
// from base ADR × occupancy, so annual revenue is the same as before the
// shapes existed; the months are then spread by SEASONALITY_SHARES.
const ANNUAL_LEVEL_PROFILE = [
  [1.32, 1.14], [1.26, 1.10], [1.12, 1.04], [0.46, 0.74], [0.40, 0.72], [0.95, 0.86],
  [1.08, 0.93], [1.00, 0.91], [0.58, 0.78], [0.50, 0.75], [0.66, 0.84], [1.18, 1.10],
] as const;

// Share of the month's revenue swing carried by occupancy; the rest is ADR.
// Matches the split spreadScenario uses for Optimized/Conservative.
const OCCUPANCY_WEIGHT = 0.6;
const MIN_MONTH_OCC = 0.18;
const MAX_MONTH_OCC = 0.9;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function isSeasonalityProfile(value: unknown): value is SeasonalityProfile {
  return typeof value === "string" && (SEASONALITY_PROFILES as readonly string[]).includes(value);
}

export function profileOf(data: Pick<EvalData, "seasonalityProfile">): SeasonalityProfile {
  return isSeasonalityProfile(data.seasonalityProfile) ? data.seasonalityProfile : "standard";
}

// Twelve months whose revenue follows the profile's shares exactly (to the
// dollar before hundreds-rounding). Occupancy follows the shape too, capped at
// 90%, and ADR is whatever makes revenue = ADR × occupancy × days, so a peak
// month shows a higher rate rather than impossible occupancy.
export function seasonalMonthly(annualRevenue: number, scenarioOcc: number, profile: SeasonalityProfile): EvalScenario["monthly"] {
  const shares = SEASONALITY_SHARES[profile];
  return MONTHS.map((month, i) => {
    const revenue = (annualRevenue * shares[i]) / 100;
    const intensity = shares[i] / 100 / (DAYS[i] / 365);
    const occupancy = Number(clamp(scenarioOcc * Math.pow(intensity, OCCUPANCY_WEIGHT), MIN_MONTH_OCC, MAX_MONTH_OCC).toFixed(2));
    return {
      month,
      revenue: Math.round(revenue),
      occupancy,
      adr: Math.round(revenue / (occupancy * DAYS[i])),
    };
  });
}

// Replacement for the old fixed-curve buildScenario in underwrite.ts and
// process-mls-review-queue.ts: same annual level, profile-shaped months.
export function buildSeasonalScenario(
  baseAdr: number,
  baseOcc: number,
  adrFactor: number,
  occDelta: number,
  profile: SeasonalityProfile = "standard",
): EvalScenario {
  const scenarioAdr = Math.round(baseAdr * adrFactor);
  const scenarioOcc = clamp(baseOcc + occDelta, 0.18, 0.82);
  const annual = ANNUAL_LEVEL_PROFILE.reduce((sum, [occMult, adrMult], i) => {
    const occupancy = clamp(scenarioOcc * occMult, MIN_MONTH_OCC, MAX_MONTH_OCC);
    return sum + Math.round(occupancy * Math.round(scenarioAdr * adrMult) * DAYS[i]);
  }, 0);
  const monthly = seasonalMonthly(annual, scenarioOcc, profile);
  return {
    revenue: monthly.reduce((sum, month) => sum + month.revenue, 0),
    occupancy: Number(scenarioOcc.toFixed(2)),
    adr: scenarioAdr,
    monthly,
  };
}

// Re-spread Balanced's existing annual revenue over the profile's months.
// Annual figures, ADR and occupancy summaries are untouched; the caller
// re-derives Optimized/Conservative so they take the same shape.
export function reshapeScenario(scenario: EvalScenario, profile: SeasonalityProfile): EvalScenario {
  return { ...scenario, monthly: seasonalMonthly(scenario.revenue, scenario.occupancy, profile) };
}

export function seasonalitySplit(profile: SeasonalityProfile) {
  const s = SEASONALITY_SHARES[profile];
  const winter = s[0] + s[1] + s[2] + s[11];
  const summer = s[5] + s[6] + s[7];
  return { winter, summer, shoulder: 100 - winter - summer };
}

export function describeSeasonality(profile: SeasonalityProfile) {
  const { winter, summer, shoulder } = seasonalitySplit(profile);
  return `${SEASONALITY_LABEL[profile]} curve: ${winter}% of annual revenue in Dec–Mar, ${summer}% in Jun–Aug, ${shoulder}% in the shoulder months.`;
}

export type SeasonalityParse = { kind: "ok"; profile: SeasonalityProfile } | { kind: "clarify"; message: string };

const PROFILE_PATTERNS: Array<[SeasonalityProfile, RegExp]> = [
  ["ski-heavy", /\b(?:ski|winter)[\s-]*heavy\b/i],
  ["summer-heavy", /\bsummer[\s-]*heavy\b/i],
  ["standard", /\bstandard[\s-]+(?:curve|seasonality|shape)\b/i],
];

// Returns null when the reply names no curve.
export function parseSeasonalityProfile(text: string): SeasonalityParse | null {
  const found = PROFILE_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([profile]) => profile);
  if (found.length === 0) return null;
  if (found.length > 1) {
    return { kind: "clarify", message: "Which seasonality curve: ski-heavy, summer-heavy, or standard curve?" };
  }
  return { kind: "ok", profile: found[0] };
}

const SEASONALITY_LINE = /^Seasonality: .*$/m;

// Methodology carries one "Seasonality:" line for a non-standard curve, so the
// report says which shape the months follow.
export function withSeasonalityLine(methodology: string, profile: SeasonalityProfile) {
  const stripped = methodology.replace(SEASONALITY_LINE, "").replace(/\n{3,}/g, "\n\n").trim();
  if (profile === "standard") return stripped;
  return `${stripped}\nSeasonality: ${describeSeasonality(profile)} Set by the reviewer; annual totals unchanged.`;
}

// Reshape an eval's months to a curve without changing any annual figure.
export function applySeasonalityProfile(data: EvalData, profile: SeasonalityProfile) {
  if (!data.projections) throw new Error("Evaluation has no projections to reshape.");
  const prior = profileOf(data);
  data.projections = deriveSpreadScenarios(reshapeScenario(data.projections.medium, profile));
  roundProjectionRevenue(data);
  data.seasonalityProfile = profile;
  data.methodology = withSeasonalityLine(String(data.methodology || ""), profile);
  const change = prior === profile ? `Re-applied the ${SEASONALITY_LABEL[profile]} curve` : `Switched from the ${SEASONALITY_LABEL[prior]} to the ${SEASONALITY_LABEL[profile]} curve`;
  return { data, reasoning: `${change}: ${describeSeasonality(profile).replace(/^\S+ curve: /, "")} Annual totals unchanged.` };
}
