import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { EvalData } from "../write-sheet-data.ts";
import type { UnderwriteInput } from "../workflows/underwrite.ts";

export type BenchmarkProjection = {
  revenue: number;
  occupancy: number;
  adr: number;
};

export type BenchmarkCase = {
  id: string;
  sourceListingPath: string;
  sourceEvalPath: string;
  notes?: string[];
  input: UnderwriteInput;
  target: {
    region?: string;
    confidence?: string;
    projections: {
      high: BenchmarkProjection;
      medium: BenchmarkProjection;
      low: BenchmarkProjection;
    };
  };
};

export type BenchmarkDataset = {
  version: number;
  generatedAt: string;
  description: string;
  metric: {
    name: string;
    direction: "lower";
    formula: string;
  };
  exclusions: Array<{
    id: string;
    reason: string;
  }>;
  cases: BenchmarkCase[];
};

export type BenchmarkCaseMetrics = {
  caseId: string;
  revenueMape: number;
  adrMape: number;
  occupancyMae: number;
  compositeError: number;
  exactMatch: boolean;
};

export type BenchmarkAggregate = {
  cases: number;
  exactMatches: number;
  compositeError: number;
  meanRevenueMape: number;
  meanAdrMape: number;
  meanOccupancyMae: number;
  worstCases: BenchmarkCaseMetrics[];
};

export const benchmarkDatasetPath = resolve(import.meta.dirname, "../../data/autoresearch/underwrite-benchmark.json");

function avg(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function relativeError(actual: number, predicted: number) {
  return Math.abs(predicted - actual) / Math.max(1, Math.abs(actual));
}

function occupancyError(actual: number, predicted: number) {
  return Math.abs(predicted - actual);
}

export async function loadBenchmarkDataset(path = benchmarkDatasetPath) {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as BenchmarkDataset;
}

export function computeCaseMetrics(
  caseId: string,
  predicted: NonNullable<EvalData["projections"]>,
  target: BenchmarkCase["target"]["projections"],
): BenchmarkCaseMetrics {
  const scenarioNames = ["high", "medium", "low"] as const;
  const revenueErrors: number[] = [];
  const adrErrors: number[] = [];
  const occupancyErrors: number[] = [];
  let exactMatch = true;

  for (const scenario of scenarioNames) {
    const predictedScenario = predicted[scenario];
    const targetScenario = target[scenario];
    if (
      predictedScenario.revenue !== targetScenario.revenue ||
      predictedScenario.adr !== targetScenario.adr ||
      predictedScenario.occupancy !== targetScenario.occupancy
    ) {
      exactMatch = false;
    }
    revenueErrors.push(relativeError(targetScenario.revenue, predictedScenario.revenue));
    adrErrors.push(relativeError(targetScenario.adr, predictedScenario.adr));
    occupancyErrors.push(occupancyError(targetScenario.occupancy, predictedScenario.occupancy));
  }

  const revenueMape = avg(revenueErrors);
  const adrMape = avg(adrErrors);
  const occupancyMae = avg(occupancyErrors);

  return {
    caseId,
    revenueMape,
    adrMape,
    occupancyMae,
    compositeError: revenueMape + (0.5 * adrMape) + (2 * occupancyMae),
    exactMatch,
  };
}

export function aggregateCaseMetrics(metrics: BenchmarkCaseMetrics[], top = 10): BenchmarkAggregate {
  const compositeError = avg(metrics.map((item) => item.compositeError));
  const meanRevenueMape = avg(metrics.map((item) => item.revenueMape));
  const meanAdrMape = avg(metrics.map((item) => item.adrMape));
  const meanOccupancyMae = avg(metrics.map((item) => item.occupancyMae));
  const exactMatches = metrics.filter((item) => item.exactMatch).length;
  const worstCases = [...metrics]
    .sort((a, b) => b.compositeError - a.compositeError)
    .slice(0, top);

  return {
    cases: metrics.length,
    exactMatches,
    compositeError,
    meanRevenueMape,
    meanAdrMape,
    meanOccupancyMae,
    worstCases,
  };
}

export function metricLine(name: string, value: number) {
  return `METRIC ${name}=${value.toFixed(6)}`;
}
