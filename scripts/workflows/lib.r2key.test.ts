import { test } from "node:test";
import assert from "node:assert/strict";

import {
  r2AddressSlug,
  r2DatePrefix,
  r2FallbackSlug,
  r2KeyForEval,
  r2KeySlug,
} from "./lib.ts";

test("r2AddressSlug lowercases and uses the full address", () => {
  assert.equal(
    r2AddressSlug("1583 Three Kings Drive, Park City, UT 84060"),
    "1583-three-kings-drive-park-city-ut-84060",
  );
});

test("r2AddressSlug strips commas, periods, #, &, /, parens", () => {
  assert.equal(r2AddressSlug("Unit #25 & Garage"), "unit-25-garage");
  assert.equal(r2AddressSlug("123 St. Mary's Ct. (rear)"), "123-st-marys-ct-rear");
  // "/" and "&" are stripped (not separators), so adjacent letters join.
  assert.equal(r2AddressSlug("A/B C&D"), "ab-cd");
});

test("r2AddressSlug collapses repeated hyphens and trims", () => {
  assert.equal(r2AddressSlug("  A   B  "), "a-b");
  assert.equal(r2AddressSlug("A -- B"), "a-b");
  assert.equal(r2AddressSlug(",,, leading & trailing ,,,"), "leading-trailing");
});

test("r2AddressSlug returns empty string for empty/missing input", () => {
  assert.equal(r2AddressSlug(""), "");
  assert.equal(r2AddressSlug(null), "");
  assert.equal(r2AddressSlug(undefined), "");
  assert.equal(r2AddressSlug("   "), "");
});

test("r2FallbackSlug produces mls-/zpid- prefixed slugs", () => {
  assert.equal(r2FallbackSlug("12602327"), "mls-12602327");
  assert.equal(r2FallbackSlug("ZPID-68839940"), "zpid-68839940");
  assert.equal(r2FallbackSlug("zpid-68839940"), "zpid-68839940");
  assert.equal(r2FallbackSlug(""), "evaluation");
  assert.equal(r2FallbackSlug(undefined), "evaluation");
});

test("r2KeySlug prefers the address, falls back to the id", () => {
  assert.equal(r2KeySlug("123 Main St", "12602327"), "123-main-st");
  assert.equal(r2KeySlug("", "12602327"), "mls-12602327");
  assert.equal(r2KeySlug(undefined, "ZPID-68839940"), "zpid-68839940");
});

test("r2DatePrefix extracts the UTC date portion of created_at", () => {
  assert.equal(r2DatePrefix("2026-06-03T16:04:42.93+00:00"), "2026/06/03");
  assert.equal(r2DatePrefix("2026-04-08T03:36:13.081+00:00"), "2026/04/08");
  assert.equal(r2DatePrefix("2026-12-25"), "2026/12/25");
});

test("r2DatePrefix throws on an unparseable created_at", () => {
  assert.throws(() => r2DatePrefix("not-a-date"));
  assert.throws(() => r2DatePrefix(""));
});

test("r2KeyForEval composes date prefix + slug + .pdf", () => {
  assert.equal(
    r2KeyForEval({
      address: "1583 Three Kings Drive, Park City, UT 84060",
      mlsNumber: "12602327",
      createdAt: "2026-06-03T16:04:42.93+00:00",
    }),
    "2026/06/03/1583-three-kings-drive-park-city-ut-84060.pdf",
  );
});

test("r2KeyForEval falls back to zpid slug when address missing", () => {
  assert.equal(
    r2KeyForEval({ address: "", mlsNumber: "ZPID-68839940", createdAt: "2026-06-03T00:00:00+00:00" }),
    "2026/06/03/zpid-68839940.pdf",
  );
});
