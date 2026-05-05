import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { EvalGroundingSource } from "../write-sheet-data.ts";
import { buildUnderwriteBundle, type UnderwriteInput } from "./underwrite.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
const researchDir = resolve(repoRoot, "data/inbox/underwrite-research");
const defaultTimeoutMs = Number(process.env.UNDERWRITE_WEB_RESEARCH_TIMEOUT_MS || "3500");
const defaultMaxResults = Number(process.env.UNDERWRITE_WEB_RESEARCH_MAX_RESULTS || "3");

export type WebSearchResult = {
  provider: string;
  query: string;
  rank: number;
  title: string;
  url: string;
  snippet: string;
};

export type UnderwriteResearchReport = {
  listingId: string;
  generatedAt: string;
  listingUrl: string;
  queries: string[];
  webSearchEnabled: boolean;
  webSearchExecuted: boolean;
  webSearchError?: string;
  results: WebSearchResult[];
  groundingSummary: string;
  groundingSources: EvalGroundingSource[];
};

export type UnderwriteResearchOptions = {
  enableWebSearch?: boolean;
  timeoutMs?: number;
  maxResults?: number;
  saveReport?: boolean;
};

function compactWhitespace(value: string) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function decodeHtml(value: string) {
  return compactWhitespace(
    String(value || "")
      .replace(/&quot;/g, "\"")
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " "),
  );
}

function stripTags(value: string) {
  return decodeHtml(String(value || "").replace(/<[^>]+>/g, " "));
}

function uniqueNonEmpty(values: Array<string | undefined | null>) {
  return [...new Set(values.map((value) => compactWhitespace(value || "")).filter(Boolean))];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cityStateText(input: UnderwriteInput) {
  return (
    uniqueNonEmpty([
      [input.city, input.state].filter(Boolean).join(", "),
      input.city,
      input.state,
    ])[0] || input.address
  );
}

export function buildWebResearchQueries(input: UnderwriteInput) {
  const marketText = cityStateText(input);
  const listingText = compactWhitespace(input.address || marketText);
  const localContext = uniqueNonEmpty([input.subdivision, input.area, marketText]).join(" ");
  const propertyText = compactWhitespace(input.propertyType || "property");

  return uniqueNonEmpty([
    `${marketText} Airbnb market data occupancy ADR ${propertyText}`,
    `${localContext} short term rental regulations`,
    `"${listingText}" Airbnb`,
  ]).slice(0, 3);
}

export function parseBraveHtml(html: string, query: string, maxResults: number) {
  const results: WebSearchResult[] = [];
  const blocks = html.split(/<div class="snippet\b/gi).slice(1);

  for (const block of blocks) {
    if (results.length >= maxResults) break;
    if (!/data-type="web"/i.test(block.slice(0, 240))) continue;

    const url = decodeHtml(block.match(/<a href="([^"]+)"[^>]*class="[^"]*svelte-14r20fy[^"]*"/i)?.[1] || "");
    const title = stripTags(block.match(/<div class="title[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || "");
    const snippet = stripTags(block.match(/<div class="content[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || "");
    if (!/^https?:\/\//i.test(url) || !title) continue;

    results.push({
      provider: "brave_search",
      query,
      rank: results.length + 1,
      title,
      url,
      snippet,
    });
  }

  return results;
}

async function runBraveSearch(query: string, timeoutMs: number, maxResults: number) {
  const url = `https://search.brave.com/search?${new URLSearchParams({
    q: query,
    source: "web",
    show_local: "0",
  }).toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-cache",
        pragma: "no-cache",
        referer: "https://search.brave.com/",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`search_http_${response.status}`);
    }
    return parseBraveHtml(await response.text(), query, maxResults);
  } finally {
    clearTimeout(timer);
  }
}

function buildGroundingSummary(results: WebSearchResult[], queries: string[]) {
  if (results.length === 0) {
    return `Prepared ${queries.length} web research quer${queries.length === 1 ? "y" : "ies"} but did not capture usable live search results.`;
  }

  const titles = results.slice(0, 3).map((result) => result.title);
  return `Live web research reviewed ${results.length} search result${results.length === 1 ? "" : "s"} across ${queries.length} quer${queries.length === 1 ? "y" : "ies"}, including ${titles.join("; ")}.`;
}

function buildGroundingSources(results: WebSearchResult[], queries: string[]) {
  const sources: EvalGroundingSource[] = [
    {
      kind: "tool",
      label: "web research tool",
      tool: "brave_search",
      note: `${queries.length} quer${queries.length === 1 ? "y" : "ies"} issued`,
    },
  ];

  for (const result of results) {
    sources.push({
      kind: "web_search",
      label: result.title,
      url: result.url,
      tool: result.provider,
      note: compactWhitespace([`Query: ${result.query}.`, result.snippet].filter(Boolean).join(" ")),
    });
  }

  return sources;
}

async function saveResearchReport(report: UnderwriteResearchReport) {
  const path = resolve(researchDir, `${report.listingId}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

export async function runUnderwriteResearch(
  input: UnderwriteInput,
  options: UnderwriteResearchOptions = {},
) {
  const timeoutMs = options.timeoutMs || defaultTimeoutMs;
  const maxResults = options.maxResults || defaultMaxResults;
  const enableWebSearch = options.enableWebSearch ?? false;
  const queries = buildWebResearchQueries(input);

  let results: WebSearchResult[] = [];
  let webSearchExecuted = false;
  let webSearchError = "";

  if (enableWebSearch && queries.length > 0) {
    webSearchExecuted = true;
    const seen = new Set<string>();
    const errors: string[] = [];
    const perQueryLimit = Math.max(1, Math.ceil(maxResults / Math.max(queries.length, 1)));

    for (const [index, query] of queries.entries()) {
      try {
        const queryResults = await runBraveSearch(query, timeoutMs, maxResults);
        let addedForQuery = 0;
        for (const result of queryResults) {
          const key = result.url.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          results.push(result);
          addedForQuery += 1;
          if (addedForQuery >= perQueryLimit) break;
          if (results.length >= maxResults) break;
        }
        if (results.length >= maxResults) break;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        if ((error instanceof Error ? error.message : String(error)).includes("429")) {
          await sleep(800);
        }
      }

      if (index < queries.length - 1 && results.length < maxResults) {
        await sleep(250);
      }
    }

    results = results.slice(0, maxResults);
    if (results.length === 0 && errors.length > 0) {
      webSearchError = errors.join("; ");
    }
  }

  const report: UnderwriteResearchReport = {
    listingId: input.listingId,
    generatedAt: new Date().toISOString(),
    listingUrl: input.listingUrl,
    queries,
    webSearchEnabled: enableWebSearch,
    webSearchExecuted,
    webSearchError: webSearchError || undefined,
    results,
    groundingSummary: buildGroundingSummary(results, queries),
    groundingSources: buildGroundingSources(results, queries),
  };

  const reportPath = options.saveReport === false ? undefined : await saveResearchReport(report);
  return { report, reportPath };
}

export async function buildGroundedUnderwriteBundle(
  input: UnderwriteInput,
  options: UnderwriteResearchOptions = {},
) {
  const { report, reportPath } = await runUnderwriteResearch(input, options);
  const underwrite = await buildUnderwriteBundle({
    ...input,
    groundingSummary: report.groundingSummary,
    groundingSources: report.groundingSources,
  });

  if (report.results.length > 0) {
    underwrite.evalData.methodology = [
      underwrite.evalData.methodology,
      `Supplemental live web research reviewed ${report.results.length} result${report.results.length === 1 ? "" : "s"} for listing and market context.`,
    ].filter(Boolean).join(" ");
  } else if (report.webSearchExecuted && report.webSearchError) {
    underwrite.evalData.methodology = [
      underwrite.evalData.methodology,
      `Supplemental web research was attempted but failed (${report.webSearchError}).`,
    ].filter(Boolean).join(" ");
  }

  return {
    ...underwrite,
    research: report,
    researchPath: reportPath,
  };
}
