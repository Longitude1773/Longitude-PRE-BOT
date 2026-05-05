import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWebResearchQueries,
  parseBraveHtml,
  runUnderwriteResearch,
} from "./underwrite-research.ts";

test("builds focused web research queries from listing facts", () => {
  const queries = buildWebResearchQueries({
    listingId: "12601393",
    listingSource: "mls_on_demand",
    address: "7447 Royal Street, Unit #: 252, Park City, UT 84060",
    listingUrl: "https://example.com/listing",
    city: "Park City",
    state: "UT",
    propertyType: "Condominium",
    area: "05 - Upper Deer Valley Resort",
    subdivision: "Black Bear Lodge",
  });

  assert.ok(queries.length >= 2);
  assert.match(queries[0], /Park City, UT Airbnb market data occupancy ADR/i);
  assert.match(queries[queries.length - 1], /7447 Royal Street/i);
  assert.ok(queries.some((query) => /Park City, UT Airbnb market data occupancy ADR/i.test(query)));
  assert.ok(queries.some((query) => /short term rental regulations/i.test(query)));
});

test("parses Brave HTML search results into grounding sources", () => {
  const html = `
    <div class="snippet svelte-jmfu5f" data-pos="0" data-type="web" data-keynav="true">
      <div class="result-content svelte-1rq4ngz">
        <a href="https://example.com/airbnb" target="_self" class="svelte-14r20fy l1">
          <div class="title search-snippet-title line-clamp-1 svelte-14r20fy">Park City Airbnb Example</div>
        </a>
        <div class="generic-snippet svelte-1cwdgg3">
          <div class="content desktop-default-regular t-primary line-clamp-dynamic svelte-1cwdgg3"><!---->Short term rental example snippet.<!----></div>
        </div>
      </div>
    </div>
    <div class="snippet svelte-jmfu5f" data-pos="1" data-type="web" data-keynav="true">
      <div class="result-content svelte-1rq4ngz">
        <a href="https://example.org/market-report" target="_self" class="svelte-14r20fy l1">
          <div class="title search-snippet-title line-clamp-1 svelte-14r20fy">Market Report</div>
        </a>
        <div class="generic-snippet svelte-1cwdgg3">
          <div class="content desktop-default-regular t-primary line-clamp-dynamic svelte-1cwdgg3"><!---->Occupancy and ADR trends.<!----></div>
        </div>
      </div>
    </div>
  `;

  const results = parseBraveHtml(html, "park city airbnb", 3);

  assert.equal(results.length, 2);
  assert.equal(results[0].provider, "brave_search");
  assert.equal(results[0].url, "https://example.com/airbnb");
  assert.match(results[0].snippet, /Short term rental example snippet/i);
  assert.equal(results[1].url, "https://example.org/market-report");
});

test("research can run in offline mode and still emit a tool provenance record", async () => {
  const result = await runUnderwriteResearch({
    listingId: "12601393",
    listingSource: "mls_on_demand",
    address: "7447 Royal Street, Unit #: 252, Park City, UT 84060",
    listingUrl: "https://example.com/listing",
    city: "Park City",
    state: "UT",
    propertyType: "Condominium",
  }, {
    enableWebSearch: false,
    saveReport: false,
  });

  assert.equal(result.report.webSearchExecuted, false);
  assert.equal(result.report.results.length, 0);
  assert.ok(result.report.groundingSources.some((source) => source.kind === "tool"));
});
