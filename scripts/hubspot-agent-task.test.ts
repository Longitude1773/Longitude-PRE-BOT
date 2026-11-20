import assert from "node:assert/strict";
import test from "node:test";

import { resolveTaskOwner } from "./hubspot-agent-task.ts";

test("assigns the PRE task to the Slack approver's HubSpot owner", () => {
  assert.deepEqual(resolveTaskOwner("U04KN0PHWTB"), { ownerId: "159240868", name: "Spencer Sanders", matched: true });
  assert.deepEqual(resolveTaskOwner("U053T09V88P"), { ownerId: "80608210", name: "Erik Mikkelsen", matched: true });
});

test("falls back to the default owner for an unknown or missing approver", () => {
  for (const approver of [undefined, "", "U0NOTMAPPED"]) {
    const owner = resolveTaskOwner(approver);
    assert.equal(owner.matched, false);
    assert.equal(owner.ownerId, process.env.HUBSPOT_TASK_OWNER_ID || "80608210");
  }
});
