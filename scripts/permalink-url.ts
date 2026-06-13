// FlexMLS "share" permalinks embed the listing address as a slug after the
// opaque token, e.g.:
//   https://www.flexmls.com/share/E8UT8/1128-S-820-East-1303-Heber-City-UT-84032
// The MLS watcher captures these from a share modal that is a page-level
// singleton: #permalinkinput retains the PREVIOUS listing's URL, so a captured
// permalink can silently belong to a different listing (observed: a Heber
// listing linked to "93 E 200 North"). These helpers let the watcher reject a
// permalink whose address slug doesn't match the listing it was captured for.

export function flexmlsShareSlug(shareUrl: string): string {
  const match = String(shareUrl || "").match(/\/share\/[A-Za-z0-9_-]+\/([^/?#]+)/i);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

// Returns true when the share URL plausibly belongs to `expectedAddress`.
// Conservative by design: when there is nothing to validate against (no expected
// address, or no address slug in the URL) it returns true rather than risk
// over-rejecting a legitimate link — the only thing it actively blocks is a
// permalink whose street number contradicts the listing.
export function permalinkMatchesAddress(shareUrl: string, expectedAddress: string): boolean {
  const expected = String(expectedAddress || "").trim();
  if (!expected) return true; // nothing to validate against
  const slug = flexmlsShareSlug(shareUrl).toLowerCase();
  if (!slug) return true; // no address slug present — cannot disprove

  const houseNumber = expected.match(/^\s*(\d+)\b/)?.[1];
  if (houseNumber) {
    // The slug always begins with the street number; an exact first-token match
    // is the most decisive, abbreviation-proof discriminator (1128 vs 93) and
    // avoids false positives from a number reappearing later (zip, unit, etc.).
    return slug.split(/[-_]/)[0] === houseNumber;
  }

  // No leading house number (rare — e.g. named buildings): fall back to the
  // first address word appearing as a slug token.
  const firstWord = expected.toLowerCase().match(/[a-z0-9]+/)?.[0];
  return firstWord ? slug.split(/[-_]/).includes(firstWord) : true;
}
