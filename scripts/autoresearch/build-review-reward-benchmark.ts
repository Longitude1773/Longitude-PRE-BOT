import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { EvalData, EvalDecision } from "../write-sheet-data.ts";
import { inferUnderwriteDecision, normalizeConfidence } from "../workflows/underwrite-decision.ts";
import { buildUnderwriteBundle, type UnderwriteInput } from "../workflows/underwrite.ts";
import {
  reviewRewardDatasetPath,
  type RewardEpisodeMetadata,
  type RewardEvidenceRequirements,
  type RewardProjectionSet,
  type ReviewRewardCase,
  type ReviewRewardDataset,
} from "./review-reward.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
const dataDir = resolve(repoRoot, "data");
const threadContextDir = resolve(dataDir, "inbox/thread-context");

type ListingRecord = {
  mlsNumber?: string;
  listingSource?: string;
  identifierLabel?: string;
  address?: string;
  listingUrl?: string;
  city?: string;
  state?: string;
  zip?: string;
  price?: number;
  bedrooms?: number;
  bathrooms?: number;
  squareFootage?: number;
  propertyType?: string;
  nightlyRentalAllowed?: string;
  nightlyRentalAllowedSource?: string;
  strApproved?: boolean;
  amenities?: string[];
  openHouses?: Array<{ date: string; time: string; hostedBy: string }>;
  rentZestimate?: number;
  lat?: number;
  lng?: number;
  confidence?: string;
};

type ThreadContextRecord = {
  threadTs: string;
  mlsNumber: string;
  status: string;
  version: number;
  address?: string;
  listingUrl?: string;
  region?: string;
  confidence?: string;
  methodology?: string;
  projections?: RewardProjectionSet;
  comparables?: Array<unknown>;
  recentEvents?: Array<{
    kind?: string;
    action?: string;
    eventPath?: string;
  }>;
};

type RewardTargetSnapshot = {
  status: "approved" | "dismissed";
  region?: string;
  confidence?: string;
  methodology?: string;
  decision: EvalDecision;
  decisionReason: string;
  projections: RewardProjectionSet;
  comparableCount: number;
};

function asProjectionSet(value: EvalData["projections"] | ThreadContextRecord["projections"]) {
  if (!value?.high || !value?.medium || !value?.low) return null;
  return {
    high: {
      revenue: value.high.revenue,
      occupancy: value.high.occupancy,
      adr: value.high.adr,
    },
    medium: {
      revenue: value.medium.revenue,
      occupancy: value.medium.occupancy,
      adr: value.medium.adr,
    },
    low: {
      revenue: value.low.revenue,
      occupancy: value.low.occupancy,
      adr: value.low.adr,
    },
  } satisfies RewardProjectionSet;
}

function comparableCount(evaluation: EvalData | undefined, context: ThreadContextRecord, fallback = 0) {
  if (Array.isArray(evaluation?.comparables)) return evaluation.comparables.length;
  if (Array.isArray(context.comparables)) return context.comparables.length;
  return fallback;
}

function buildInput(id: string, listing: ListingRecord, evaluation?: EvalData): UnderwriteInput {
  return {
    listingId: String(listing.mlsNumber || id),
    listingSource: String(listing.listingSource || evaluation?.listingSource || ""),
    identifierLabel: String(listing.identifierLabel || evaluation?.identifierLabel || "MLS#"),
    skipMarketGate: true,
    address: String(listing.address || evaluation?.address || ""),
    listingUrl: String(listing.listingUrl || evaluation?.listingUrl || ""),
    city: listing.city,
    state: listing.state,
    zip: listing.zip,
    price: listing.price,
    bedrooms: listing.bedrooms,
    bathrooms: listing.bathrooms,
    squareFootage: listing.squareFootage,
    propertyType: listing.propertyType,
    area: Array.isArray(listing.amenities) ? listing.amenities[0] : undefined,
    subdivision: Array.isArray(listing.amenities) ? listing.amenities[1] : undefined,
    nightlyRentalAllowed: listing.nightlyRentalAllowed,
    nightlyRentalAllowedSource: listing.nightlyRentalAllowedSource,
    strApproved: listing.strApproved,
    openHouses: listing.openHouses,
    rentZestimate: listing.rentZestimate,
    latitude: listing.lat,
    longitude: listing.lng,
  };
}

function buildEpisodeMetadata(events: ThreadContextRecord["recentEvents"], finalVersion: number): RewardEpisodeMetadata {
  const recentEvents = events || [];
  return {
    finalVersion,
    extraVersions: Math.max(0, finalVersion - 1),
    threadReplyTurns: recentEvents.filter((event) => event.kind === "thread-reply").length,
    adjustmentCount: recentEvents.filter((event) => event.action === "adjust").length,
    clarifyCount: recentEvents.filter((event) => String(event.action || "").includes("clarify")).length,
    questionCount: recentEvents.filter((event) => event.action === "question").length,
    manualAdjustmentCount: recentEvents.filter((event) => String(event.eventPath || "").includes("manual-thread-adjustment")).length,
  };
}

function inferDecision(snapshot: {
  status: "approved" | "dismissed";
  region?: string;
  confidence?: string;
  methodology?: string;
  comparableCount: number;
  decision?: EvalDecision;
  decisionReason?: string;
}) {
  if (snapshot.status === "dismissed") {
    return {
      decision: "escalate" as const,
      decisionReason: "dismissed_terminal_review",
    };
  }
  if (snapshot.decision) {
    return {
      decision: snapshot.decision,
      decisionReason: String(snapshot.decisionReason || "accepted_eval_decision"),
    };
  }
  return inferUnderwriteDecision({
    comparableCount: snapshot.comparableCount,
    confidence: snapshot.confidence,
    methodology: snapshot.methodology,
    region: snapshot.region,
  });
}

function buildTargetSnapshot(
  context: ThreadContextRecord,
  listing: ListingRecord,
  evaluation: EvalData | undefined,
  reference: Awaited<ReturnType<typeof buildUnderwriteBundle>>,
) {
  const status = context.status === "dismissed" ? "dismissed" : "approved";
  const projections = asProjectionSet(evaluation?.projections) || asProjectionSet(context.projections);
  if (!projections) return null;

  const region = String(evaluation?.region || context.region || reference.evalData.region || "");
  const confidence = String(evaluation?.confidence || context.confidence || listing.confidence || reference.evalData.confidence || "");
  const methodology = String(evaluation?.methodology || context.methodology || reference.evalData.methodology || "");
  const resolvedComparableCount = comparableCount(
    evaluation,
    context,
    reference.evalData.comparables?.length || 0,
  );
  const { decision, decisionReason } = inferDecision({
    status,
    region,
    confidence,
    methodology,
    comparableCount: resolvedComparableCount,
    decision: evaluation?.decision,
    decisionReason: evaluation?.decisionReason,
  });

  return {
    status,
    region,
    confidence,
    methodology,
    decision,
    decisionReason,
    projections,
    comparableCount: resolvedComparableCount,
  } satisfies RewardTargetSnapshot;
}

function buildReferenceSnapshot(reference: Awaited<ReturnType<typeof buildUnderwriteBundle>>) {
  const projections = asProjectionSet(reference.evalData.projections);
  if (!projections) {
    throw new Error(`Missing reference projections for ${reference.evalData.mlsNumber || "unknown_listing"}.`);
  }

  const comparableCount = reference.evalData.comparables?.length || 0;
  const { decision, decisionReason } = inferDecision({
    status: "approved",
    region: reference.evalData.region,
    confidence: reference.evalData.confidence,
    methodology: reference.evalData.methodology,
    comparableCount,
    decision: reference.evalData.decision,
    decisionReason: reference.evalData.decisionReason,
  });

  return {
    region: reference.evalData.region,
    confidence: reference.evalData.confidence,
    methodology: reference.evalData.methodology,
    decision,
    decisionReason,
    projections,
    comparableCount,
    grounding: reference.evalData.grounding,
  };
}

function buildEvidenceRequirements(
  target: RewardTargetSnapshot,
  listingUrl: string,
): RewardEvidenceRequirements {
  const supportedMarket = Boolean(String(target.region || "").trim());
  const lowConfidence = ["low", "very_low"].includes(normalizeConfidence(target.confidence));

  return {
    minComparableCount: target.decision === "estimate" && supportedMarket
      ? Math.max(1, Math.min(target.comparableCount || 0, 3))
      : 0,
    minSourceCount: target.decision === "escalate" ? 3 : supportedMarket ? 3 : 2,
    requiredKinds: supportedMarket ? ["listing", "tool", "market_knowledge"] : ["listing", "tool"],
    requireGroundingSummary: true,
    requireListingUrl: Boolean(listingUrl),
    preferWebSearch: target.decision === "escalate" || !supportedMarket || lowConfidence,
  };
}

export async function buildReviewRewardBenchmark() {
  const files = (await readdir(threadContextDir)).filter((file) => file.endsWith(".json")).sort();
  const dataset: ReviewRewardDataset = {
    version: 2,
    generatedAt: new Date().toISOString(),
    description: "Frozen review-reward benchmark built from terminal Slack thread contexts plus final eval artifacts when available. Each case stores the reference first-pass underwrite, the accepted target decision, and review-friction metadata so candidate underwriting can be judged on correct estimate-versus-escalate behavior, evidence coverage, calibration, and projection accuracy when an estimate is warranted.",
    metric: {
      name: "mean_reward",
      direction: "higher",
      formula: "mean( decision_reward - friction_weight * (projection_loss + evidence_coverage_loss + calibration_loss) )",
    },
    exclusions: [],
    cases: [],
  };

  for (const file of files) {
    const threadContextPath = resolve(threadContextDir, file);
    const context = JSON.parse(await readFile(threadContextPath, "utf8")) as ThreadContextRecord;

    if (!["approved", "dismissed"].includes(String(context.status || ""))) {
      dataset.exclusions.push({ id: context.mlsNumber || file, threadTs: context.threadTs, reason: "non_terminal_thread" });
      continue;
    }

    const listingPath = resolve(dataDir, `listing-${context.mlsNumber}.json`);
    let listing: ListingRecord;
    try {
      listing = JSON.parse(await readFile(listingPath, "utf8")) as ListingRecord;
    } catch {
      dataset.exclusions.push({ id: context.mlsNumber || file, threadTs: context.threadTs, reason: "missing_listing_pair" });
      continue;
    }

    let evaluation: EvalData | undefined;
    try {
      evaluation = JSON.parse(await readFile(resolve(dataDir, `eval-${context.mlsNumber}.json`), "utf8")) as EvalData;
    } catch {
      evaluation = undefined;
    }

    const input = buildInput(context.mlsNumber, listing, evaluation);
    const reference = await buildUnderwriteBundle(input);
    const approvedTarget = buildTargetSnapshot(context, listing, evaluation, reference);

    if (!approvedTarget) {
      dataset.exclusions.push({ id: context.mlsNumber || file, threadTs: context.threadTs, reason: "missing_final_projections" });
      continue;
    }

    const rewardCase: ReviewRewardCase = {
      id: context.mlsNumber,
      threadTs: context.threadTs,
      sourceListingPath: `data/listing-${context.mlsNumber}.json`,
      sourceThreadContextPath: `data/inbox/thread-context/${file}`,
      input,
      referenceInitial: buildReferenceSnapshot(reference),
      approvedTarget: {
        ...approvedTarget,
        evidenceRequirements: buildEvidenceRequirements(approvedTarget, input.listingUrl),
      },
      episode: buildEpisodeMetadata(context.recentEvents, Number(context.version || 1)),
    };

    dataset.cases.push(rewardCase);
  }

  dataset.cases.sort((a, b) => a.id.localeCompare(b.id));
  dataset.exclusions.sort((a, b) => `${a.id}:${a.threadTs || ""}`.localeCompare(`${b.id}:${b.threadTs || ""}`));

  await mkdir(dirname(reviewRewardDatasetPath), { recursive: true });
  await writeFile(reviewRewardDatasetPath, `${JSON.stringify(dataset, null, 2)}\n`);
  return {
    reviewRewardDatasetPath,
    cases: dataset.cases.length,
    exclusions: dataset.exclusions,
  };
}

async function main() {
  console.log(JSON.stringify(await buildReviewRewardBenchmark(), null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
