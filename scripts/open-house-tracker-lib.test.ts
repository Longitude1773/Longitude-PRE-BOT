import { test } from "node:test";
import assert from "node:assert/strict";

import type { OpenHouseReportEntry } from "./flexmls-open-house.ts";
import {
  COL,
  PLACEHOLDERS,
  SHEET_HEADERS,
  buildTrackerRow,
  formatTimeRange,
  groupEntries,
  hyperlink,
  mlsFromLinkCell,
  pickEvaluation,
  planSheetMerge,
  strStatusFrom,
  trackerDateFromIso,
  trackerSheetName,
  upcomingWednesday,
} from "./open-house-tracker-lib.ts";

function entry(over: Partial<OpenHouseReportEntry> = {}): OpenHouseReportEntry {
  return {
    mlsNumber: "12603028",
    date: "Wednesday, October 7, 2026",
    startTime: "10:00 AM",
    endTime: "01:00 PM",
    type: "In-Person Public Open House",
    agentName: "Jane Agent",
    brokerage: "Christie's Int. RE VUE",
    agentPhone: "(435) 555-0101",
    hostedBy: "",
    address: "2437 W Havens Court Unit 10, Park City, UT 84060",
    price: 4640000,
    ...over,
  };
}

test("upcoming Wednesday is tomorrow from a Tuesday afternoon and today on a Wednesday morning (MT)", () => {
  // Tue 2026-10-06 15:00 MDT = 21:00Z
  assert.equal(upcomingWednesday(new Date("2026-10-06T21:00:00Z")).iso, "2026-10-07");
  // Wed 2026-10-07 08:00 MDT = 14:00Z
  assert.equal(upcomingWednesday(new Date("2026-10-07T14:00:00Z")).iso, "2026-10-07");
  // Tue 2026-10-06 22:30 MDT is already Wed in UTC — still the MT Tuesday.
  assert.equal(upcomingWednesday(new Date("2026-10-07T04:30:00Z")).iso, "2026-10-07");
});

test("sheet name is Year.Month.Day - Open House Tracker", () => {
  const date = trackerDateFromIso("2026-10-07");
  assert.equal(trackerSheetName(date), "2026.10.07 - Open House Tracker");
  assert.equal(date.mmddyyyy, "10/07/2026");
  assert.equal(date.short, "Wed 10/7");
});

test("time range drops leading zeros", () => {
  assert.equal(formatTimeRange("10:00 AM", "01:00 PM"), "10:00 AM – 1:00 PM");
  assert.equal(formatTimeRange("", ""), "");
});

test("approved version wins over a newer unapproved one", () => {
  const pick = pickEvaluation([
    { Version: 1, Status: "posted", "Med Rev": 130000 },
    { Version: 2, Status: "approved", "Med Rev": 82500 },
    { Version: 3, Status: "posted", "Med Rev": 78500 },
  ]);
  assert.deepEqual(pick, { balanced: 82500, approved: true, status: "approved" });
  assert.deepEqual(pickEvaluation([{ Version: 1, Status: "pending_review", "Med Rev": "64000" }]), {
    balanced: 64000,
    approved: false,
    status: "pending_review",
  });
  assert.equal(pickEvaluation([]), null);
});

test("STR status normalizes MLS and Supabase spellings", () => {
  assert.equal(strStatusFrom("Yes"), "yes");
  assert.equal(strStatusFrom(false), "no");
  assert.equal(strStatusFrom(""), "unknown");
});

test("rows: STR-ineligible, approved with PRE link, pending without link, unknown STR", () => {
  const notStr = buildTrackerRow({ entries: [entry()], str: "no", listingUrl: "", evalState: { kind: "none" }, preUrl: "" });
  assert.equal(notStr.length, SHEET_HEADERS.length);
  assert.equal(notStr[COL.balanced], PLACEHOLDERS.notStr);
  assert.equal(notStr[COL.mlsLink], "12603028");
  assert.equal(notStr[COL.price], "$4,640,000");
  assert.equal(notStr[COL.time], "10:00 AM – 1:00 PM");

  const approved = buildTrackerRow({
    entries: [entry()],
    str: "yes",
    listingUrl: "https://www.flexmls.com/share/abc/2437-W-Havens",
    evalState: { kind: "existing", pick: { balanced: 82500, approved: true, status: "approved" } },
    preUrl: "https://pre.example/properties/2437-w-havens",
  });
  assert.equal(approved[COL.balanced], "$82,500");
  assert.equal(approved[COL.preLink], '=HYPERLINK("https://pre.example/properties/2437-w-havens","View PRE")');
  assert.equal(approved[COL.mlsLink], '=HYPERLINK("https://www.flexmls.com/share/abc/2437-W-Havens","12603028")');

  const pending = buildTrackerRow({
    entries: [entry()],
    str: "yes",
    listingUrl: "",
    evalState: { kind: "existing", pick: { balanced: 64000, approved: false, status: "posted" } },
    preUrl: "https://pre.example/x",
  });
  assert.equal(pending[COL.balanced], "$64,000");
  assert.equal(pending[COL.preLink], "");

  const unknown = buildTrackerRow({ entries: [entry()], str: "unknown", listingUrl: "", evalState: { kind: "none" }, preUrl: "" });
  assert.equal(unknown[COL.str], PLACEHOLDERS.strUnknown);
  assert.equal(unknown[COL.balanced], "");
});

test("MLS # reads back from a link formula or a bare number", () => {
  assert.equal(mlsFromLinkCell(hyperlink("https://x.test/share/1/12345678-st", "12603028")), "12603028");
  assert.equal(mlsFromLinkCell("12603028"), "12603028");
  assert.equal(mlsFromLinkCell("View"), "");
});

test("entries group by MLS # and sort by start time", () => {
  const groups = groupEntries([
    entry({ mlsNumber: "22222222", startTime: "02:00 PM", address: "B St" }),
    entry({ mlsNumber: "11111111", startTime: "10:00 AM", address: "A St" }),
    entry({ mlsNumber: "22222222", startTime: "04:00 PM", address: "B St" }),
  ]);
  assert.deepEqual(groups.map((g) => [g[0].mlsNumber, g.length]), [["11111111", 1], ["22222222", 2]]);
});

test("merge fills blanks and placeholders, keeps human edits, appends new MLS #s", () => {
  const header = [...SHEET_HEADERS];
  const existing = [
    header,
    ["1 A St", "Jane", "Co", "10:00 AM – 1:00 PM", "Yes", "$1,000,000", "11111111", PLACEHOLDERS.evalInProgress, ""],
    ["2 B St", "Sam", "Co", "2:00 PM – 5:00 PM", "Yes", "$2,000,000", hyperlink("https://u/2", "22222222"), "$90,000 (Erik: bump)", ""],
  ];
  const fresh = [
    buildTrackerRow({
      entries: [entry({ mlsNumber: "11111111", address: "1 A St" })],
      str: "yes",
      listingUrl: "https://u/1",
      evalState: { kind: "existing", pick: { balanced: 70000, approved: true, status: "approved" } },
      preUrl: "https://pre/1",
    }),
    buildTrackerRow({
      entries: [entry({ mlsNumber: "22222222", address: "2 B St" })],
      str: "yes",
      listingUrl: "https://u/2",
      evalState: { kind: "existing", pick: { balanced: 85000, approved: true, status: "approved" } },
      preUrl: "https://pre/2",
    }),
    buildTrackerRow({ entries: [entry({ mlsNumber: "33333333", address: "3 C St" })], str: "no", listingUrl: "", evalState: { kind: "none" }, preUrl: "" }),
  ];

  const plan = planSheetMerge(existing, fresh, "Open Houses");
  const byRange = Object.fromEntries(plan.updates.map((u) => [u.range, u.values[0][0]]));

  // Row 2: placeholder replaced, bare MLS upgraded to a link, PRE link filled.
  assert.equal(byRange["'Open Houses'!H2"], "$70,000");
  assert.equal(byRange["'Open Houses'!G2"], hyperlink("https://u/1", "11111111"));
  assert.equal(byRange["'Open Houses'!I2"], hyperlink("https://pre/1", "View PRE"));
  // Row 3: the human-edited Balanced cell survives; blank PRE link is filled.
  assert.equal(byRange["'Open Houses'!H3"], undefined);
  assert.equal(byRange["'Open Houses'!I3"], hyperlink("https://pre/2", "View PRE"));
  // Human-typed address etc. never rewritten.
  assert.equal(byRange["'Open Houses'!A2"], undefined);

  assert.equal(plan.appends.length, 1);
  assert.equal(mlsFromLinkCell(plan.appends[0][COL.mlsLink]), "33333333");
  assert.equal(plan.appendAtRow, 4);
  assert.equal(plan.lastWritten["33333333"][COL.balanced], PLACEHOLDERS.notStr);
});

test("a number the bot wrote last run follows the evaluation; one a human changed does not", () => {
  const header = [...SHEET_HEADERS];
  // Sheets returns typed currency as a plain number under FORMULA rendering.
  const existing = [
    header,
    ["1 A St", "Jane", "Co", "", "Yes", 1000000, hyperlink("https://u/1", "11111111"), 64000, ""],
    ["2 B St", "Sam", "Co", "", "Yes", 2000000, hyperlink("https://u/2", "22222222"), 99000, ""],
  ];
  const lastWritten = {
    "11111111": ["", "", "", "", "Yes", "$1,000,000", hyperlink("https://u/1", "11111111"), "$64,000", ""],
    "22222222": ["", "", "", "", "Yes", "$2,000,000", hyperlink("https://u/2", "22222222"), "$80,000", ""],
  };
  const fresh = ["11111111", "22222222"].map((mls, i) =>
    buildTrackerRow({
      entries: [entry({ mlsNumber: mls, address: `${i + 1} St`, price: (i + 1) * 1000000 })],
      str: "yes",
      listingUrl: `https://u/${i + 1}`,
      evalState: { kind: "existing", pick: { balanced: 70000, approved: true, status: "approved" } },
      preUrl: `https://pre/${i + 1}`,
    }),
  );
  const plan = planSheetMerge(existing, fresh, "Open Houses", lastWritten);
  const byRange = Object.fromEntries(plan.updates.map((u) => [u.range, u.values[0][0]]));
  assert.equal(byRange["'Open Houses'!H2"], "$70,000"); // bot's $64,000 → follows the eval
  assert.equal(byRange["'Open Houses'!H3"], undefined); // human changed $80,000 → $99,000: kept
  assert.equal(byRange["'Open Houses'!F2"], undefined); // $1,000,000 == 1000000: no rewrite
  assert.equal(plan.lastWritten["11111111"][COL.balanced], "$70,000");
  assert.equal(plan.lastWritten["22222222"][COL.balanced], "$80,000");
});
