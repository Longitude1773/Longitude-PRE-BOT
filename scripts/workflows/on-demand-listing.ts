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
