export type OpenHouseEntry = {
  date: string;
  time: string;
  hostedBy: string;
};

export type OnDemandListingScrape = {
  source: "zillow" | "mls";
  listingId: string;
  identifierLabel: "ZPID" | "MLS";
  listingSource: "zillow_on_demand" | "mls_on_demand";
  url: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  price?: number;
  bedrooms?: number;
  bathrooms?: number;
  squareFootage?: number;
  propertyType?: string;
  propertyTypeCode?: string;
  subtypeCode?: string;
  area?: string;
  subdivision?: string;
  rentZestimate?: number;
  nightlyRentalAllowed?: string;
  nightlyRentalAllowedSource?: string;
  strApproved?: boolean;
  photoUrls: string[];
  openHouses?: OpenHouseEntry[];
  description?: string;
  latitude?: number;
  longitude?: number;
};

export function isZillowUrl(url: string) {
  return /zillow\.com/i.test(url);
}

export function isFlexMlsUrl(url: string) {
  return /(?:^https?:\/\/)?(?:www\.)?(?:flexmls\.com|my\.flexmls\.com)\//i.test(url);
}

function extractZpidFromUrl(url: string) {
  return url.match(/\/(\d+)_zpid\/?$/i)?.[1] || url.match(/zpid[=/:-]?(\d+)/i)?.[1] || "";
}

export function normalizeOnDemandRequestKey(rawUrl: string) {
  const url = rawUrl.trim();
  if (!url) return "";

  if (isZillowUrl(url)) {
    const zpid = extractZpidFromUrl(url);
    if (zpid) return `zillow:${zpid}`;
  }

  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";

    if (isFlexMlsUrl(url)) {
      const cmd = parsed.searchParams.get("cmd") || "";
      if (/reports\/flexreport\/generate\.html/i.test(cmd)) {
        const params = new URLSearchParams();
        params.set("cmd", cmd);
        for (const key of ["tech_id", "ma_tech_id", "report2", "report_type"]) {
          const value = parsed.searchParams.get(key);
          if (value) params.set(key, value);
        }
        return `mls:${hostname}${pathname}?${params.toString()}`;
      }

      const params = [...parsed.searchParams.entries()]
        .filter(([key]) => !["c1", "_", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"].includes(key))
        .sort(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue));
      const normalized = new URLSearchParams(params).toString();
      return `mls:${hostname}${pathname}${normalized ? `?${normalized}` : ""}`;
    }

    const normalized = [...parsed.searchParams.entries()]
      .sort(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue));
    const params = new URLSearchParams(normalized).toString();
    return `${hostname}${pathname}${params ? `?${params}` : ""}`;
  } catch {
    return url.toLowerCase();
  }
}
