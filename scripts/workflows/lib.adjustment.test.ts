import assert from "node:assert/strict";
import test from "node:test";

import type { EvalData } from "../write-sheet-data.ts";
import { applyStructuredAdjustment, parseAdjustmentRequest } from "./lib.ts";

function buildEvalData(): EvalData {
  return {
    mlsNumber: "12601393",
    projections: {
      high: {
        revenue: 157473,
        occupancy: 0.77,
        adr: 686,
        monthly: [{ month: "Jan", revenue: 13123, occupancy: 0.77, adr: 686 }],
      },
      medium: {
        revenue: 90979,
        occupancy: 0.55,
        adr: 540,
        monthly: [{ month: "Jan", revenue: 7582, occupancy: 0.55, adr: 540 }],
      },
      low: {
        revenue: 90893,
        occupancy: 0.55,
        adr: 539,
        monthly: [{ month: "Jan", revenue: 7574, occupancy: 0.55, adr: 539 }],
      },
    },
  };
}

test("anchors conservative comparison to the affirmed balanced scenario", () => {
  const parsed = parseAdjustmentRequest("The balanced revenue looks good but the conservative should be 25% lower");
  assert.equal(parsed.kind, "ok");
  if (parsed.kind !== "ok") return;

  assert.equal(parsed.spec.mode, "relative");
  assert.equal(parsed.spec.field, "revenue");
  assert.deepEqual(parsed.spec.scenarios, ["low"]);
  assert.equal(parsed.spec.anchorScenario, "medium");
  assert.equal(parsed.spec.value, 0.75);

  const data = buildEvalData();
  applyStructuredAdjustment(data, parsed.spec);

  assert.equal(data.projections?.medium.revenue, 90979);
  assert.equal(data.projections?.medium.adr, 540);
  assert.equal(data.projections?.low.revenue, Math.round(90979 * 0.75));
  assert.equal(data.projections?.low.occupancy, 0.55);
});

test("treats lower-to requests as absolute targets instead of generic 10 percent nudges", () => {
  const parsed = parseAdjustmentRequest("lets lower the balanced revenue on this one to 90K");
  assert.equal(parsed.kind, "ok");
  if (parsed.kind !== "ok") return;

  assert.equal(parsed.spec.mode, "set");
  assert.equal(parsed.spec.field, "revenue");
  assert.deepEqual(parsed.spec.scenarios, ["medium"]);
  assert.equal(parsed.spec.value, 90000);
});

test("locks scenario spread when balanced revenue is set", () => {
  const parsed = parseAdjustmentRequest("balanced should be 250000");
  assert.equal(parsed.kind, "ok");
  if (parsed.kind !== "ok") return;

  assert.equal(parsed.spec.mode, "set");
  assert.equal(parsed.spec.field, "revenue");
  assert.deepEqual(parsed.spec.scenarios, ["medium"]);
  assert.equal(parsed.spec.value, 250000);

  const data = buildEvalData();
  applyStructuredAdjustment(data, parsed.spec);
  assert.equal(data.projections?.medium.revenue, 250000);
  assert.equal(data.projections?.high.revenue, 337500); // × 1.35
  assert.equal(data.projections?.low.revenue, 187500); // × 0.75
});

test("ignores embedded spread percentages on a balanced revenue set", () => {
  const parsed = parseAdjustmentRequest(
    "adjust the balanced revenue to be 235500 and set the optimized 35% up and the conservative 25% down from 235500",
  );
  assert.equal(parsed.kind, "ok");
  if (parsed.kind !== "ok") return;

  assert.deepEqual(parsed.spec.scenarios, ["medium"]);
  assert.equal(parsed.spec.value, 235500);

  const data = buildEvalData();
  applyStructuredAdjustment(data, parsed.spec);
  assert.equal(data.projections?.medium.revenue, 235500);
  assert.equal(data.projections?.high.revenue, 317925); // 235500 × 1.35
  assert.equal(data.projections?.low.revenue, 176625); // 235500 × 0.75
});
