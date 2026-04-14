import type { Page } from "playwright";
import type { OnDemandListingScrape } from "./on-demand-listing.ts";

export type ZillowScrape = OnDemandListingScrape;

export function extractZpid(url: string) {
  return url.match(/\/(\d+)_zpid\/?$/i)?.[1] || url.match(/zpid[=/:-]?(\d+)/i)?.[1] || "";
}

export function asNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function cleanAddressCandidate(value: string) {
  return value
    .replace(/\s+\|\s+zillow.*$/i, "")
    .replace(/\s*[-|]\s*\$[\d,]+.*$/i, "")
    .trim();
}

function decodeHtml(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripHtml(value: string) {
  return decodeHtml(value.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function extractMetaContent(html: string, attribute: "name" | "property", key: string) {
  const patterns = [
    new RegExp(`<meta[^>]*${attribute}=["']${key}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*${attribute}=["']${key}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtml(match[1]);
  }
  return "";
}

function extractTagText(html: string, tagName: string) {
  const match = html.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match?.[1] ? stripHtml(match[1]) : "";
}

function findNumberValue(bodyText: string, pattern: RegExp) {
  const match = bodyText.match(pattern);
  if (!match?.[1]) return undefined;
  return Number(match[1].replace(/,/g, ""));
}

function findMoneyValue(bodyText: string, pattern: RegExp) {
  const match = bodyText.match(pattern);
  if (!match?.[1]) return undefined;
  return Number(match[1].replace(/,/g, ""));
}

export async function isZillowBlocked(page: Page) {
  const title = (await page.title()).toLowerCase();
  const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
  return (
    title.includes("access to this page has been denied") ||
    bodyText.includes("before we continue") ||
    bodyText.includes("press & hold") ||
    bodyText.includes("px-captcha")
  );
}

export async function extractZillowListingFromPage(page: Page, fallbackUrl: string): Promise<ZillowScrape> {
  const [title, html, rawBodyText] = await Promise.all([
    page.title().catch(() => ""),
    page.content(),
    page.locator("body").innerText().catch(() => ""),
  ]);

  const bodyText = rawBodyText.replace(/\u00a0/g, " ");
  const lines = bodyText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const uniqueLines = Array.from(new Set(lines));
  const ogTitle = extractMetaContent(html, "property", "og:title");
  const metaDescription = extractMetaContent(html, "name", "description");
  const h1 = extractTagText(html, "h1");
  const canonical = decodeHtml(html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i)?.[1] || "") || fallbackUrl;
  const zpid = canonical.match(/\/(\d+)_zpid\/?$/i)?.[1] || extractZpid(fallbackUrl);
  const addressCandidates = [h1, ogTitle, title, ...uniqueLines]
    .map((value) => value.trim())
    .filter((value) => /,\s*[A-Z]{2}\s+\d{5}/.test(value));
  const address = cleanAddressCandidate(asString(addressCandidates[0] || ""));
  if (!address) {
    throw new Error("Could not extract a Zillow address from the page.");
  }

  const cityStateZipMatch = address.match(/,\s*([^,]+),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?/);
  const city = cityStateZipMatch?.[1]?.trim() || "";
  const state = cityStateZipMatch?.[2] || "";
  const zip = cityStateZipMatch?.[3] || "";

  let price: number | undefined;
  for (const line of uniqueLines) {
    if (!/^\$[\d,]+$/.test(line) || line.includes("/mo")) continue;
    const parsed = Number(line.replace(/[^\d]/g, ""));
    if (parsed >= 50_000) {
      price = parsed;
      break;
    }
  }
  if (!price) {
    price = findMoneyValue(bodyText, /(?:price|list price|zestimate)\D+\$([\d,]+)/i);
  }

  const bedrooms = findNumberValue(bodyText, /(\d+(?:\.\d+)?)\s*(?:bd|beds?)\b/i);
  const bathrooms = findNumberValue(bodyText, /(\d+(?:\.\d+)?)\s*(?:ba|baths?)\b/i);
  const squareFootage = findNumberValue(bodyText, /([\d,]+)\s*sqft\b/i);

  const knownPropertyTypes = [
    "Single Family",
    "Condominium",
    "Condo",
    "Townhouse",
    "Multi-family",
    "Manufactured",
    "Apartment",
    "Lot/Land",
  ];

  let propertyType = "";
  for (const candidate of knownPropertyTypes) {
    const line = uniqueLines.find((value) => new RegExp(`\\b${candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(value));
    if (!line) continue;
    propertyType = candidate === "Condo" ? "Condominium" : candidate;
    break;
  }

  const rentZestimate =
    findMoneyValue(bodyText, /Rent Zestimate[^$]*\$([\d,]+)/i) ||
    findMoneyValue(bodyText, /rent estimate[^$]*\$([\d,]+)/i);

  const strAllowedMatch =
    bodyText.match(/(?:ST Rentals Allowed|Short(?:-| )Term Rentals Allowed)[^A-Za-z]*(Yes|No)/i) ||
    bodyText.match(/(?:Short(?:-| )term rentals?|STRs?)\s+(?:allowed|permitted)[^A-Za-z]*(Yes|No)/i);
  const nightlyRentalAllowed = strAllowedMatch?.[1] || "";

  const descriptionIndex = uniqueLines.findIndex((line) => /what'?s special/i.test(line));
  const description =
    descriptionIndex >= 0
      ? uniqueLines.slice(descriptionIndex + 1, descriptionIndex + 4).join(" ").slice(0, 800)
      : metaDescription;

  const photoCandidates = [
    extractMetaContent(html, "property", "og:image"),
    ...((html.match(/https?:\/\/[^"'\\s>]+(?:zillowstatic\.com|photos\.zillowstatic\.com)[^"'\\s>]*/gi) || []).map((value) => decodeHtml(value))),
  ];
  const photoUrls = Array.from(new Set(photoCandidates))
    .filter((value) => /\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(value))
    .slice(0, 8);
  const latitude = html.match(/"latitude"\s*:\s*(-?\d+(?:\.\d+)?)/i)?.[1];
  const longitude = html.match(/"longitude"\s*:\s*(-?\d+(?:\.\d+)?)/i)?.[1];

  return {
    source: "zillow",
    listingId: asString(zpid),
    identifierLabel: "ZPID",
    listingSource: "zillow_on_demand",
    url: canonical || fallbackUrl,
    address,
    city,
    state,
    zip,
    price: asNumber(price),
    bedrooms: asNumber(bedrooms),
    bathrooms: asNumber(bathrooms),
    squareFootage: asNumber(squareFootage),
    propertyType,
    rentZestimate: asNumber(rentZestimate),
    nightlyRentalAllowed,
    nightlyRentalAllowedSource: nightlyRentalAllowed ? "zillow_page_text" : "",
    photoUrls,
    description: asString(description),
    latitude: asNumber(latitude),
    longitude: asNumber(longitude),
  };
}
