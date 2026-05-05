import assert from "node:assert/strict";
import test from "node:test";

import { runBenchmark } from "./benchmark-underwrite.ts";

test("underwrite benchmark corpus loads and produces finite metrics", async () => {
  const result = await runBenchmark(3);

  assert.ok(result.dataset.cases.length >= 30);
  assert.ok(result.aggregate.cases >= 30);
  assert.ok(Number.isFinite(result.aggregate.compositeError));
  assert.ok(Number.isFinite(result.aggregate.meanRevenueMape));
  assert.ok(Number.isFinite(result.aggregate.meanAdrMape));
  assert.ok(Number.isFinite(result.aggregate.meanOccupancyMae));
  assert.ok(result.aggregate.worstCases.length <= 3);
});
