import { test } from "node:test";
import assert from "node:assert/strict";

import { parseListedBy, parseOpenHouseReportText, parseScheduledTime } from "./flexmls-open-house.ts";

// Shape captured from the live report on 2026-09-30 (names/phones altered).
const REPORT = `
flexmls Web Public Open House From 9/30/2026 To 9/30/2026 Print Select
MLS # Public Open House Information
12603028
Scheduled Time: Wednesday, September 30, 2026 10:00 AM to 01:00 PM
Type: In-Person Public Open House
Listed by: Jane Q Agent of Christie's Int. RE VUE (4501) (435) 555-0101
Hosted By: Pat Host & Jane Agent
Hosted Phone: (970)555-0102
Address: 2437 W Havens Court Unit 10, Park City, UT 84060
Price: 4,640,000
Total Bathrooms: 4
Total Bedrooms: 3
Directions:
Comments: Please join us — Price: includes lobster rolls.
12603648
Scheduled Time: Wednesday, September 30, 2026 02:00 PM to 06:00 PM
Type: In-Person Public Open House
Listed by: Sam Seller of ERA Brokers Consolidated (SLC) (4023) (801) 555-0103
Hosted By:
Hosted Phone:
Address: 5610 Kodiak Way, Park City, UT 84098
Price: 1,425,000
Total Bathrooms: 5
Total Bedrooms: 4
Directions:
Comments:
`;

test("parses every entry with agent, brokerage, time, address and price", () => {
  const report = parseOpenHouseReportText(REPORT);
  assert.equal(report.header, "9/30/2026 To 9/30/2026");
  assert.equal(report.entries.length, 2);

  const [a, b] = report.entries;
  assert.deepEqual(
    { mls: a.mlsNumber, agent: a.agentName, brokerage: a.brokerage, phone: a.agentPhone },
    { mls: "12603028", agent: "Jane Q Agent", brokerage: "Christie's Int. RE VUE", phone: "(435) 555-0101" },
  );
  assert.equal(a.date, "Wednesday, September 30, 2026");
  assert.equal(a.startTime, "10:00 AM");
  assert.equal(a.endTime, "01:00 PM");
  assert.equal(a.address, "2437 W Havens Court Unit 10, Park City, UT 84060");
  assert.equal(a.price, 4640000);
  assert.equal(a.bedrooms, 3);

  // A label repeated inside Comments must not bleed into the next entry.
  assert.equal(b.mlsNumber, "12603648");
  assert.equal(b.hostedBy, "");
  assert.equal(b.price, 1425000);
});

test("keeps the brokerage's own parenthetical, drops only the office code", () => {
  assert.deepEqual(parseListedBy("Sam Seller of ERA Brokers Consolidated (SLC) (4023) (801) 555-0103"), {
    agentName: "Sam Seller",
    brokerage: "ERA Brokers Consolidated (SLC)",
    agentPhone: "(801) 555-0103",
  });
  assert.equal(
    parseListedBy("A B of Summit Sotheby's International Realty (545 Main) (SSIR3) (435) 555-0104").brokerage,
    "Summit Sotheby's International Realty (545 Main)",
  );
  assert.equal(parseListedBy("A B of Stein Eriksen Realty Group (CHAT) (435) 555-0105").brokerage, "Stein Eriksen Realty Group");
});

test("scheduled time without a recognizable range keeps the raw text as the date", () => {
  assert.deepEqual(parseScheduledTime("TBD"), { date: "TBD", startTime: "", endTime: "" });
});

test("an empty report parses to zero entries, not an error", () => {
  const report = parseOpenHouseReportText("Public Open House From 10/7/2026 To 10/7/2026 MLS # Public Open House Information");
  assert.equal(report.entries.length, 0);
  assert.equal(report.header, "10/7/2026 To 10/7/2026");
});
