import assert from "node:assert/strict";
import test from "node:test";

import { flexmlsShareSlug, permalinkMatchesAddress } from "./permalink-url.ts";

// The actual reported failure: a Heber listing whose stored permalink belonged
// to a different listing (93 E 200 North) because the share modal's
// #permalinkinput retained the previous value.
const RIGHT = "https://www.flexmls.com/share/E8bbY/1128-S-820-East-1303-Heber-City-UT-84032";
const WRONG = "https://www.flexmls.com/share/E8UT8/93-E-200-North-Heber-City-UT-84032";
const ADDR = "1128 S 820 East 1303, Heber City, UT 84032";

test("extracts the address slug after the share token", () => {
  assert.equal(flexmlsShareSlug(RIGHT), "1128-S-820-East-1303-Heber-City-UT-84032");
  assert.equal(flexmlsShareSlug("https://www.flexmls.com/share/E8UT8"), "");
  assert.equal(flexmlsShareSlug(""), "");
});

test("accepts a permalink whose house number matches the listing", () => {
  assert.equal(permalinkMatchesAddress(RIGHT, ADDR), true);
});

test("rejects the stale-singleton wrong-listing permalink (the reported bug)", () => {
  assert.equal(permalinkMatchesAddress(WRONG, ADDR), false);
});

test("does not over-reject when there is nothing to validate against", () => {
  assert.equal(permalinkMatchesAddress(WRONG, ""), true); // no expected address
  assert.equal(permalinkMatchesAddress("https://www.flexmls.com/share/E8UT8", ADDR), true); // no slug
});

test("matches on a street-only address (as scraped from the hot-sheet row)", () => {
  assert.equal(permalinkMatchesAddress(RIGHT, "1128 S 820 East 1303"), true);
  assert.equal(permalinkMatchesAddress(WRONG, "1128 S 820 East 1303"), false);
});

test("does not false-positive when the number only appears later in the slug", () => {
  // House number 200 should not match a slug that merely contains 200 mid-string.
  const url = "https://www.flexmls.com/share/AB123/93-E-200-North-Heber-City-UT-84032";
  assert.equal(permalinkMatchesAddress(url, "200 Main St, Heber City, UT 84032"), false);
});

test("handles addresses without a leading house number via first-word fallback", () => {
  const url = "https://www.flexmls.com/share/AB123/Mayflower-Lodge-Unit-5-Park-City-UT-84060";
  assert.equal(permalinkMatchesAddress(url, "Mayflower Lodge Unit 5, Park City, UT 84060"), true);
  assert.equal(permalinkMatchesAddress(WRONG, "Mayflower Lodge Unit 5, Park City, UT 84060"), false);
});
