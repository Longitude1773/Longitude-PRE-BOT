/**
 * Stalled-listing agent outreach — monthly batch.
 *
 * Opens the FlexMLS saved search "Stalled STR" (Active + Nightly Rental
 * Allowed + our areas, built by hand in the FlexMLS UI), reads the results
 * grid, joins Supabase by MLS number for agent email/phone we already hold,
 * pulls business cards only for the listings we don't, and writes
 * data/stalled-outreach-<date>.csv.
 *
 * The CSV is the deliverable — it gets imported into HubSpot by hand. This
 * script writes nothing to HubSpot and nothing to Supabase, and generates no
 * revenue evaluations.
 *
 * It runs on its OWN browser profile (.playwright/flexmls-stalled-profile) so
 * it never contends with the always-on watcher's profile. First run needs one
 * interactive 2FA — run it headed and type the code in the window.
 *
 * Usage:
 *   npx tsx scripts/stalled-outreach.ts --discover   # navigate + dump, no CSV
 *   npx tsx scripts/stalled-outreach.ts              # the monthly run
 *   npx tsx scripts/stalled-outreach.ts --min-dom 90 --limit 20
 *
 * NOTE: watch-mls.ts exports nothing (it is a process, not a module), so the
 * login/surface helpers below are adapted copies of its proven versions. Same
 * precedent as normalizeNightlyRentalAllowed, which is already duplicated in
 * scripts/workflows/underwrite.ts and process-mls-review-queue.ts.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync as readFileSyncNode } from "node:fs";
import { resolve } from "node:path";
import type { BrowserContext, Frame, Page } from "playwright";

import { launchConfiguredPersistentContext } from "./browser-runtime.ts";

const repoRoot = resolve(import.meta.dirname, "..");

// The repo has no dotenv dependency; same minimal loader the other by-hand
// scripts use so a direct `tsx` run picks up .env without a gateway restart.
function loadEnv() {
  try {
    for (const line of readFileSyncNode(resolve(repoRoot, ".env"), "utf8").split("\n")) {
      const i = line.indexOf("=");
      if (i > 0 && !line.trimStart().startsWith("#")) {
        const key = line.slice(0, i).trim();
        if (!process.env[key]) process.env[key] = line.slice(i + 1).trim();
      }
    }
  } catch {
    /* env supplied by the environment instead */
  }
}
loadEnv();

const baseUrl = process.env.FLEXMLS_URL;
const username = process.env.FLEXMLS_USERNAME;
const password = process.env.FLEXMLS_PASSWORD;
const flexmlsOpenIdUrl = process.env.FLEXMLS_OPENID_URL || "https://pc.flexmls.com/openid_rp?provider_id=44";
const flexmlsDashboardUrl =
  process.env.FLEXMLS_DASHBOARD_URL ||
  "https://pc.flexmls.com/cgi-bin/mainmenu.cgi?cmd=srv+flexdash/private_dashboard.html&command_line_mode=true&no_html_header=true";
const flexmlsSearchStepUrl =
  process.env.FLEXMLS_SEARCH_URL || "https://pc.flexmls.com/cgi-bin/mainmenu.cgi?cmd=url+search/list/step1.html";

type FlexSurface = Page | Frame;

type GridRow = {
  mlsNumber: string;
  address: string;
  cityStateZip: string;
  priceText: string;
  dom: string;
  cdom: string;
  agentName: string;
  brokerage: string;
  agentMemberId: string;
  listingRecordTechId: string;
  cells: Record<string, string>;
};

type OutRow = {
  mls_number: string;
  address: string;
  city: string;
  list_price: string;
  dom: string;
  agent_name: string;
  brokerage: string;
  agent_email: string;
  agent_phone: string;
  prior_evaluation: string;
};

type Args = {
  discover: boolean;
  loginCheck: boolean;
  minDom: number;
  csvPath: string;
  limit: number;
  headless: boolean;
  noCards: boolean;
  searchName: string;
  loginTimeoutMinutes: number;
};

function parseArgs(argv: string[]): Args {
  const today = new Date().toISOString().slice(0, 10);
  const args: Args = {
    discover: false,
    loginCheck: false,
    minDom: 60,
    csvPath: resolve(repoRoot, `data/stalled-outreach-${today}.csv`),
    limit: 0,
    headless: (process.env.FLEXMLS_HEADLESS || "false").toLowerCase() === "true",
    noCards: false,
    searchName: "Stalled STR",
    loginTimeoutMinutes: 15,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--discover") args.discover = true;
    else if (arg === "--login-check") args.loginCheck = true;
    else if (arg === "--no-cards") args.noCards = true;
    else if (arg === "--headless") args.headless = true;
    else if (arg === "--min-dom") args.minDom = Number(argv[++i] || 60);
    else if (arg === "--limit") args.limit = Number(argv[++i] || 0);
    else if (arg === "--csv") args.csvPath = resolve(repoRoot, argv[++i] || args.csvPath);
    else if (arg === "--search-name") args.searchName = argv[++i] || args.searchName;
    else if (arg === "--login-timeout") args.loginTimeoutMinutes = Number(argv[++i] || 15);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const diagDir = resolve(repoRoot, "data/inbox/stalled-outreach", runStamp);

function log(message: string) {
  console.log(`${new Date().toISOString().slice(11, 19)}  ${message}`);
}

async function dump(label: string, html: string) {
  await mkdir(diagDir, { recursive: true });
  const path = resolve(diagDir, `${label}.html`);
  await writeFile(path, html);
  return path;
}

async function dumpSurface(surface: FlexSurface, label: string) {
  const html = await surface.content().catch(() => "");
  if (!html) return "";
  return await dump(label, html);
}

// --- surface helpers (adapted from watch-mls.ts) -------------------------

async function surfaceBodyText(surface: FlexSurface) {
  return await surface.locator("body").innerText().catch(() => "");
}

function surfaceUrl(surface: FlexSurface) {
  return "url" in surface ? surface.url() : "";
}

async function findFlexSurface(page: Page): Promise<FlexSurface> {
  const markers = ["QuickLaunch", "Results:", "Change Search Template", "MLS # Search", "Saved Searches", "Hot Sheet For"];
  const topLevelBody = await surfaceBodyText(page);
  if (markers.some((m) => topLevelBody.includes(m))) return page;

  for (const frame of page.frames()) {
    const body = await surfaceBodyText(frame);
    const url = frame.url();
    if (markers.some((m) => body.includes(m)) || url.includes("mainmenu") || url.includes("search/")) {
      return frame;
    }
  }
  return page;
}

async function isPortalHome(page: Page) {
  const url = page.url();
  const body = await page.locator("body").innerText().catch(() => "");
  return url.includes("portal.parkcityrealtors.com/home") || (body.includes("Resources & Services") && body.includes("FLEXMLS"));
}

/** True when a FlexMLS sign-in form is on screen. */
async function showsSignInForm(page: Page) {
  const body = await page.locator("body").innerText().catch(() => "");
  if (/sign in to your account|reset password/i.test(body)) return true;
  return await page.locator('input[type="password"]').first().isVisible().catch(() => false);
}

async function looksLoggedIn(page: Page) {
  // The sign-in page is itself served from pc.flexmls.com, so a hostname match
  // is NOT evidence of a session — checking the URL alone reports "logged in"
  // while staring at the login form, and every later step then fails somewhere
  // far from the cause.
  if (await showsSignInForm(page)) return false;

  const surface = await findFlexSurface(page);
  const url = surfaceUrl(surface);
  const body = await surfaceBodyText(surface);
  if (["QuickLaunch", "MLS # Search", "Change Search Template", "Saved Searches", "Results:"].some((m) => body.includes(m))) {
    return true;
  }
  return url.includes("mainmenu") || url.includes("search/") || url.includes("private_dashboard");
}

async function enterFlexmlsFromPortal(page: Page): Promise<Page> {
  if (!(await isPortalHome(page))) return page;
  const restore = page.locator('button:has-text("Restore")').first();
  if (await restore.isVisible().catch(() => false)) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(500);
  }

  for (const selector of [
    'a[href*="pc.flexmls.com/openid_rp"]',
    'a[href*="flexmls.com/openid_rp"]',
    'a[href*="pc.flexmls.com"]',
    'a[href*="flexmls.com"]',
    "text=FLEXMLS",
  ]) {
    const link = page.locator(selector).first();
    if (!(await link.isVisible().catch(() => false))) continue;
    const popup = page.waitForEvent("popup", { timeout: 5000 }).catch(() => null);
    await link.click().catch(() => {});
    const maybePopup = await popup;
    if (maybePopup) {
      await maybePopup.waitForLoadState("domcontentloaded").catch(() => {});
      await maybePopup.waitForTimeout(1500);
      await maybePopup.bringToFront().catch(() => {});
      return maybePopup;
    }
    await page.waitForTimeout(2500);
    if (page.url().includes("flexmls.com") || (await looksLoggedIn(page))) return page;
  }
  return page;
}

/** Fill the FlexMLS sign-in form if it is on screen. */
async function submitCredentials(page: Page): Promise<boolean> {
  const passwordInput = page.locator('input[type="password"]').first();
  if (!(await passwordInput.isVisible().catch(() => false))) return false;
  if (!username || !password) throw new Error("FLEXMLS_USERNAME / FLEXMLS_PASSWORD are not set.");

  const usernameInput = page.locator('input[type="text"], input[name*="user" i], input[id*="user" i]').first();
  log("submitting credentials");
  await usernameInput.fill(username).catch(() => {});
  await passwordInput.fill(password).catch(() => {});
  await page
    .locator('button:has-text("Login"), button:has-text("Sign in"), input[type="submit"], button[type="submit"]')
    .first()
    .click()
    .catch(() => {});
  await page.waitForTimeout(4000);
  return true;
}

/**
 * Sit on the security-code screen until a human finishes it. "Trust this
 * device" is ticked for them so this profile only ever needs one code — a
 * monthly job that texts a code every run is a job that gets skipped.
 */
async function waitOutTwoFactor(page: Page): Promise<void> {
  const body = await page.locator("body").innerText().catch(() => "");
  if (/trust this device/i.test(body)) {
    const trustBox = page.locator('input[type="checkbox"]').first();
    if (await trustBox.isVisible().catch(() => false)) {
      await trustBox.check().catch(() => {});
      log('checked "Trust this device" so future runs skip the code');
    }
  }

  const digits = body.match(/sent to \(?[#\d]{3}\)?[ -]?[#\d]{3}-?(\d{4})/);
  log("");
  log("  >>> FlexMLS is asking for a security code.");
  if (digits) log(`  >>> It was texted to the number ending ${digits[1]}.`);
  log("  >>> Enter it in the Chrome window that just opened.");
  log(`  >>> Waiting up to ${args.loginTimeoutMinutes} minutes.`);
  log("");

  const deadline = Date.now() + args.loginTimeoutMinutes * 60 * 1000;
  while (Date.now() < deadline) {
    if (await looksLoggedIn(page)) return;
    if (await isPortalHome(page)) return;
    const now = await page.locator("body").innerText().catch(() => "");
    if (!/security code|verification code|trust this device/i.test(now)) return;
    await page.waitForTimeout(3000);
  }
}

/**
 * Drive the session to a logged-in FlexMLS surface from wherever it currently
 * is. Idempotent and safe to call repeatedly — the sign-in form can reappear
 * mid-flow (e.g. a live PCR portal cookie with a dead FlexMLS session), which
 * a one-shot login at startup silently fails to handle.
 *
 * Every branch ESCALATES rather than repeating: the portal home page does not
 * always render a FlexMLS link (it is a JS app, and the tile can be absent or
 * late), so retrying the click forever is a livelock. Direct navigation to the
 * OpenID entry point is tried first and is the reliable path — same approach
 * the watcher uses when the portal session is live but FlexMLS is not.
 */
async function ensureSignedIn(page: Page): Promise<Page> {
  let active = page;
  const tries = new Map<string, number>();
  const used = (key: string, max = 2) => {
    const n = (tries.get(key) || 0) + 1;
    tries.set(key, n);
    return n > max;
  };

  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (await looksLoggedIn(active)) {
      if (attempt > 0) log("signed in to FlexMLS");
      return active;
    }

    const body = await active.locator("body").innerText().catch(() => "");

    if (/security code|verification code|trust this device/i.test(body)) {
      if (!used("2fa", 2)) {
        await waitOutTwoFactor(active);
        continue;
      }
    }

    if (!used("credentials", 2) && (await submitCredentials(active))) continue;

    // Direct OpenID handshake first — works whether or not the portal renders
    // its FlexMLS tile.
    if (!used("openid", 3)) {
      log("navigating to the FlexMLS OpenID entry point");
      await active.goto(flexmlsOpenIdUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await active.waitForTimeout(3000);
      continue;
    }

    // Only then fall back to clicking through the portal.
    if ((await isPortalHome(active)) && !used("portal", 1)) {
      log("in the PCR portal, looking for a FlexMLS link");
      const next = await enterFlexmlsFromPortal(active);
      if (next !== active) active = next;
      await active.waitForTimeout(2500);
      continue;
    }

    if (!used("dashboard", 1)) {
      await active.goto(flexmlsDashboardUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await active.waitForTimeout(2500);
      continue;
    }

    if (!used("base", 1) && baseUrl) {
      await active.goto(baseUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await active.waitForTimeout(2500);
      continue;
    }

    break;
  }

  await dumpSurface(active, "sign-in-failed");
  throw new Error(
    `Could not reach a signed-in FlexMLS page (url: ${active.url()}). Dump: ${diagDir}`,
  );
}

async function loginIfNeeded(page: Page): Promise<Page> {
  if (!baseUrl) throw new Error("FLEXMLS_URL is not set.");
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  return await ensureSignedIn(page);
}

/**
 * Who does FlexMLS think we are?
 *
 * The dashboard's `user_data_obj` carries no name or email — only permissions
 * and ids — so `tech_id` (the member record) is the stable identity signal and
 * the one worth comparing across runs. Name/email/slug are opportunistic: they
 * appear on the search-results page (`agent_email_addr`) but not on the
 * dashboard, so treat a miss there as "not on this page", not "not logged in".
 */
async function readSignedInIdentity(surface: FlexSurface) {
  const ids = await surface.evaluate(() => {
    const w = window as unknown as { user_data_obj?: Record<string, unknown> };
    const u = w.user_data_obj || {};
    return {
      techId: String(u.tech_id || ""),
      maTechId: String(u.ma_tech_id || ""),
      groupTechId: String(u.group_tech_id || ""),
      accountType: String(u.account_type || ""),
      canAddListings: String(u.can_add_listings ?? ""),
      cdomEnabled: String(u.cdom_enabled ?? ""),
      adomEnabled: String(u.adom_enabled ?? ""),
    };
  }).catch(() => ({
    techId: "", maTechId: "", groupTechId: "", accountType: "",
    canAddListings: "", cdomEnabled: "", adomEnabled: "",
  }));

  const html = await surface.content().catch(() => "");
  const email = html.match(/agent_email_addr\s*=\s*"([^"]+)"/)?.[1] || "";
  const slug = html.match(/my\.flexmls\.com\/([A-Za-z0-9_-]+)\//)?.[1] || "";

  // FlexMLS tech ids are timestamp-prefixed: YYYYMMDDHHMMSS…
  const created = ids.techId.match(/^(\d{4})(\d{2})(\d{2})/);
  const createdAt = created ? `${created[1]}-${created[2]}-${created[3]}` : "";

  return { ...ids, email, slug, createdAt };
}

// --- saved search navigation ---------------------------------------------

async function gotoDashboard(page: Page): Promise<Page> {
  let active = await ensureSignedIn(page);
  await active.goto(flexmlsDashboardUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  await active.waitForTimeout(3000);
  // Navigating can bounce us back to the sign-in form; re-assert, then return.
  active = await ensureSignedIn(active);
  if (!active.url().includes("private_dashboard")) {
    await active.goto(flexmlsDashboardUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    await active.waitForTimeout(2500);
  }
  return active;
}

/**
 * Open the saved search. Layered strategies, because the Saved Searches
 * dashboard gadget renders client-side and its row markup could not be
 * captured before the search existed.
 */
async function openSavedSearch(page: Page, name: string): Promise<{ surface: FlexSurface; strategy: string }> {
  const active = await gotoDashboard(page);
  let surface = await findFlexSurface(active);

  // Give the saved_search portlet time to finish its AJAX render.
  for (let i = 0; i < 10; i += 1) {
    const body = await surfaceBodyText(surface);
    if (body.includes(name) || body.includes("Saved Searches")) break;
    await active.waitForTimeout(1000);
    surface = await findFlexSurface(active);
  }
  await dumpSurface(surface, "dashboard");

  const attempts: Array<{ strategy: string; run: () => Promise<void> }> = [
    {
      strategy: "gadget-exact-link",
      run: async () => {
        await surface.locator(`a:text-is("${name}")`).first().click({ timeout: 8000 });
      },
    },
    {
      strategy: "gadget-loose-link",
      run: async () => {
        await surface.locator(`a:has-text("${name}")`).first().click({ timeout: 8000 });
      },
    },
    {
      strategy: "gadget-any-clickable",
      run: async () => {
        await surface.locator(`text="${name}"`).first().click({ timeout: 8000 });
      },
    },
    {
      strategy: "search-screen",
      run: async () => {
        await active.goto(flexmlsSearchStepUrl, { waitUntil: "domcontentloaded" });
        await active.waitForTimeout(3000);
        const s = await findFlexSurface(active);
        await s.locator(`a:has-text("${name}"), option:has-text("${name}")`).first().click({ timeout: 8000 });
      },
    },
  ];

  for (const attempt of attempts) {
    try {
      await attempt.run();
      await active.waitForTimeout(4000);
      const next = await findFlexSurface(active);
      if (await hasResults(next)) {
        log(`opened saved search "${name}" via ${attempt.strategy}`);
        return { surface: next, strategy: attempt.strategy };
      }
    } catch {
      /* try the next strategy */
    }
    surface = await findFlexSurface(active);
  }

  const path = await dumpSurface(surface, "saved-search-not-opened");
  throw new Error(
    `Could not open the saved search "${name}". Dump: ${path}\n` +
      "Check the name matches exactly and that it shows in the dashboard's Saved Searches gadget.",
  );
}

async function hasResults(surface: FlexSurface) {
  const count = await surface.locator("tr.listing").count().catch(() => 0);
  if (count > 0) return true;
  const body = await surfaceBodyText(surface);
  return body.includes("Results:") && count > 0;
}

async function readExpectedCount(surface: FlexSurface): Promise<number> {
  const text = await surface.locator("#matchesdiv").first().innerText().catch(() => "");
  const n = Number((text || "").replace(/[^\d]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The grid renders ~100 rows and lazy-loads the rest as you reach the bottom
 * (the `#morelistingstop` / `#morelistingsbot` spinners mark a load in
 * flight). Scroll until the count reaches the search's match total or stops
 * growing across several patient passes.
 */
async function loadAllRows(surface: FlexSurface, expected: number) {
  const pause = (ms: number) =>
    "waitForTimeout" in surface ? surface.waitForTimeout(ms) : new Promise((r) => setTimeout(r, ms));

  let previous = -1;
  let stable = 0;

  for (let pass = 0; pass < 200 && stable < 4; pass += 1) {
    const count = await surface.locator("tr.listing").count().catch(() => 0);
    if (expected > 0 && count >= expected) {
      log(`grid: ${count} rows loaded (matches the search total)`);
      return count;
    }
    if (count === previous) stable += 1;
    else {
      stable = 0;
      if (count > 0 && count % 100 === 0) log(`grid: ${count}${expected ? ` of ${expected}` : ""} rows loaded…`);
    }
    previous = count;

    await surface.evaluate(() => {
      const rows = document.querySelectorAll("tr.listing");
      rows[rows.length - 1]?.scrollIntoView({ block: "end" });
      window.scrollTo(0, document.body.scrollHeight);
      for (const el of Array.from(document.querySelectorAll("div, section"))) {
        const node = el as HTMLElement;
        if (node.scrollHeight > node.clientHeight + 50) node.scrollTop = node.scrollHeight;
      }
    }).catch(() => {});

    const more = surface.locator('a:has-text("Load More"), button:has-text("Load More")').first();
    if (await more.isVisible().catch(() => false)) await more.click().catch(() => {});

    await pause(2000);

    // Wait out an in-flight lazy load rather than counting it as "stable".
    for (let spin = 0; spin < 15; spin += 1) {
      const loading = await surface.evaluate(() => {
        const ids = ["morelistingstop", "morelistingsbot", "loadingdiv"];
        return ids.some((id) => {
          const el = document.getElementById(id);
          return Boolean(el && el.style.display !== "none");
        });
      }).catch(() => false);
      if (!loading) break;
      stable = 0;
      await pause(1000);
    }
  }

  const count = await surface.locator("tr.listing").count().catch(() => 0);
  if (expected > 0 && count < expected) {
    log(`WARNING: loaded ${count} rows but the search reports ${expected} matches`);
  }
  return count;
}

/** Header column names, e.g. ["mls","status","price","address","dom","cdom",...]. */
async function readColumnNames(surface: FlexSurface): Promise<string[]> {
  return await surface.evaluate(() => {
    const names = new Set<string>();
    for (const el of Array.from(document.querySelectorAll("span.heading[data-column-name]"))) {
      const n = el.getAttribute("data-column-name");
      if (n) names.add(n);
    }
    for (const el of Array.from(document.querySelectorAll('th[class*="column_"]'))) {
      const m = (el.className || "").match(/column_([a-z0-9_]+)/i);
      if (m) names.add(m[1]);
    }
    return Array.from(names);
  }).catch(() => [] as string[]);
}

/**
 * Read the grid. Cells are addressed by their `column_<name>` class rather
 * than by position, so adding or reordering columns in the FlexMLS display
 * template does not break this.
 */
async function extractRows(surface: FlexSurface): Promise<GridRow[]> {
  return await surface.evaluate(() => {
    // NOTE: do not declare named function expressions in this callback. tsx
    // compiles them into calls to esbuild's `__name` helper, which is not
    // defined in the page, and the evaluate throws ReferenceError.
    const out = [];

    for (const row of Array.from(document.querySelectorAll("tr.listing")) as HTMLElement[]) {
      const cells: Record<string, string> = {};
      for (const td of Array.from(row.querySelectorAll('td[class*="column_"]'))) {
        const m = (td.className || "").match(/column_([a-z0-9_]+)/i);
        if (m) cells[m[1]] = (td.textContent || "").replace(/\s+/g, " ").trim();
      }

      const actionEl = row.querySelector(".triangle_down_icon_span");
      const mlsAnchor = row.querySelector('a#listingNumberAnchor, .column_mls a[title="View details"]');
      const mlsNumber =
        (actionEl?.getAttribute("list_nbr") || "").replace(/\s+/g, " ").trim() ||
        (mlsAnchor?.textContent || "").replace(/\s+/g, " ").trim() ||
        (cells.list_nbr || cells.mls || "").trim();

      const address =
        (row.querySelector('span[ls="address"], .column_address [ls="address"]')?.textContent || "")
          .replace(/\s+/g, " ").trim() || (cells.address || "").trim();
      const cityStateZip = (row.querySelector('span[ls="csz"]')?.textContent || "").replace(/\s+/g, " ").trim();
      const priceText =
        (row.querySelector('span.price[ls="price"], .column_price .price')?.textContent || "")
          .replace(/\s+/g, " ").trim() || (cells.current_price || cells.price || "").trim();

      // "Listing Member" cell: ordered links are agent, brokerage, co-agent,
      // co-office. The agent link's onclick carries the ids the business-card
      // popup needs.
      let agentName = "";
      let brokerage = "";
      let agentMemberId = "";
      let listingRecordTechId = "";
      const memberCell = row.querySelector(".column_me_tech_id");
      if (memberCell) {
        const links = Array.from(memberCell.querySelectorAll("a.columnlink, a"))
          .map((a) => ({ text: (a.textContent || "").replace(/\s+/g, " ").trim(), onclick: a.getAttribute("onclick") || "" }))
          .filter((l) => l.text);
        if (links[0]) {
          agentName = links[0].text;
          agentMemberId = (links[0].onclick.match(/showBusinessCard\('([^']+)'/) || [])[1] || "";
          listingRecordTechId = (links[0].onclick.match(/selectL\('([^']+)'/) || [])[1] || "";
        }
        if (links[1]) {
          let b = links[1].text;
          while (/\s*\([^)]*\)\s*$/.test(b)) b = b.replace(/\s*\([^)]*\)\s*$/, "");
          brokerage = b.trim() || links[1].text;
        }
      }

      if (!mlsNumber) continue;
      out.push({
        mlsNumber,
        address,
        cityStateZip,
        priceText,
        dom: (cells.dom || "").trim(),
        cdom: (cells.cdom || "").trim(),
        agentName,
        brokerage,
        agentMemberId,
        listingRecordTechId,
        cells,
      });
    }
    return out;
  });
}

/**
 * Agent email/phone via the FlexMLS business-card popup — the only place they
 * appear. Best-effort: a failure leaves the fields blank, never throws.
 */
async function resolveBusinessCard(surface: FlexSurface, memberId: string, listingTechId: string) {
  const card = await surface.evaluate(async ({ memberId, listingTechId }) => {
    const w = window as unknown as {
      selectL?: (id: string, flag: boolean) => void;
      showBusinessCard?: (id: string, event: unknown) => void;
    };
    const clear = document.getElementById("buscardinnerds");
    if (clear) clear.innerHTML = "";
    try {
      if (listingTechId && typeof w.selectL === "function") w.selectL(listingTechId, false);
      if (typeof w.showBusinessCard === "function") w.showBusinessCard(memberId, { cancelBubble: true });
    } catch {
      /* signature is best-effort; read whatever rendered */
    }
    const started = Date.now();
    while (Date.now() - started < 3500) {
      const el = document.getElementById("buscardinnerds");
      const text = (el?.textContent || "").replace(/\s+/g, " ").trim();
      if (text && /(@|\d{3})/.test(text)) return { text, html: el?.innerHTML || "" };
      await new Promise((r) => setTimeout(r, 200));
    }
    const el = document.getElementById("buscardinnerds");
    return { text: (el?.textContent || "").replace(/\s+/g, " ").trim(), html: el?.innerHTML || "" };
  }, { memberId, listingTechId }).catch(() => ({ text: "", html: "" }));

  const email = (
    card.html.match(/mailto:([^"'<>\s]+@[^"'<>\s]+)/i)?.[1] ||
    card.text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0] ||
    ""
  ).trim();
  const phone = (card.text.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]\d{4}/)?.[0] || "").trim();
  return { email, phone };
}

// --- helpers --------------------------------------------------------------

function toNumber(value: string) {
  const n = Number(String(value || "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** "1516 Deer Valley Drive #25, Park City, UT 84060" -> street + city. */
function splitAddress(address: string, cityStateZip: string) {
  let street = (address || "").trim();
  let city = "";
  const csz = (cityStateZip || "").trim();
  if (csz) city = csz.split(",")[0].trim();

  // Some rows glue the city/state/zip onto the address.
  const glued = street.match(/^(.*?),?\s*([A-Za-z .'-]+),\s*([A-Z]{2})\s*\d{5}(?:-\d{4})?$/);
  if (glued) {
    street = glued[1].trim().replace(/,$/, "");
    if (!city) city = glued[2].trim();
  }
  return { street, city };
}

const EVAL_RANK = ["none", "pending_review", "posted", "approved"];

function bestEvalStatus(statuses: string[]) {
  let best = "none";
  for (const s of statuses) {
    if (EVAL_RANK.indexOf(s) > EVAL_RANK.indexOf(best)) best = s;
  }
  return best;
}

function csvEscape(value: string) {
  const v = value ?? "";
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

// --- main -----------------------------------------------------------------

async function main() {
  log(`stalled-outreach starting (${args.discover ? "DISCOVER" : "run"}) — profile flexmls-stalled-profile`);
  log(`diagnostics: ${diagDir}`);

  const managed = await launchConfiguredPersistentContext({
    backend: "local",
    persistentDir: resolve(repoRoot, ".playwright/flexmls-stalled-profile"),
    headless: args.headless,
    viewport: { width: 1440, height: 960 },
    label: "flexmls-stalled",
  });
  const context: BrowserContext = managed.context;

  try {
    const page = context.pages()[0] || (await context.newPage());
    const active = await loginIfNeeded(page);

    if (args.loginCheck) {
      const dash = await gotoDashboard(active);
      const surface = await findFlexSurface(dash);
      const who = await readSignedInIdentity(dash);
      const savedSearches = await surface.evaluate(() => {
        const names: string[] = [];
        for (const a of Array.from(document.querySelectorAll("a"))) {
          const t = (a.textContent || "").replace(/\s+/g, " ").trim();
          if (t && t.length < 60 && a.closest('[id*="saved"], [class*="saved"]')) names.push(t);
        }
        return Array.from(new Set(names));
      }).catch(() => [] as string[]);
      await dumpSurface(surface, "login-check-dashboard");

      console.log("\n=== LOGIN CHECK ===");
      console.log(`signed in:       YES`);
      console.log(`member tech id:  ${who.techId || "(not found)"}${who.createdAt ? `  (account created ${who.createdAt})` : ""}`);
      console.log(`office tech id:  ${who.maTechId || "(not found)"}`);
      console.log(`account type:    ${who.accountType || "?"} | can add listings: ${who.canAddListings || "?"}`);
      console.log(`DOM columns:     CDOM ${who.cdomEnabled === "true" ? "enabled" : who.cdomEnabled || "?"} | ADOM ${who.adomEnabled === "true" ? "enabled" : who.adomEnabled || "?"}`);
      if (who.email) console.log(`account email:   ${who.email}`);
      if (who.slug) console.log(`profile slug:    ${who.slug}`);
      console.log(`saved searches:  ${savedSearches.length ? savedSearches.join(", ") : "(none listed on the dashboard gadget)"}`);
      console.log(`\ndump: ${diagDir}`);
      console.log("Nothing was scraped or written.");
      return;
    }

    const { surface, strategy } = await openSavedSearch(active, args.searchName);
    const expected = await readExpectedCount(surface);
    if (expected) log(`saved search reports ${expected} matches`);
    const rowCount = await loadAllRows(surface, expected);
    log(`grid loaded: ${rowCount} rows (strategy ${strategy})`);
    await dumpSurface(surface, "results-grid");

    const columnNames = await readColumnNames(surface);
    log(`columns: ${columnNames.join(", ") || "(none found)"}`);

    const rows = await extractRows(surface);
    log(`parsed ${rows.length} rows`);

    if (args.discover) {
      console.log("\n=== DISCOVERY ===");
      console.log(`saved search opened via: ${strategy}`);
      console.log(`search reports ${expected} matches; rows in grid: ${rowCount}, parsed: ${rows.length}`);
      console.log(`column names: ${JSON.stringify(columnNames)}`);
      const hasDom = columnNames.includes("dom");
      const hasCdom = columnNames.includes("cdom");
      console.log(`DOM column present: ${hasDom ? "yes" : "NO"} | CDOM column present: ${hasCdom ? "yes" : "no"}`);
      console.log(`Listing Member column present: ${columnNames.includes("me_tech_id") ? "yes" : "NO"}`);
      console.log("\nfirst 3 rows:");
      for (const r of rows.slice(0, 3)) console.log(JSON.stringify(r, null, 1));
      console.log(`\ndumps written to ${diagDir}`);
      console.log("Nothing else was read or written. Re-run without --discover for the CSV.");
      return;
    }

    if (!rows.length) throw new Error("The saved search returned no rows. See the dump in " + diagDir);

    // --- resolve days-on-market -------------------------------------------
    // Preferred source is a DOM (or CDOM) column in the FlexMLS display
    // template. If the template carries neither, fall back to Supabase's
    // listing_date — which only covers listings the watcher has seen.
    const { supabase } = await import("./supabase.ts");
    const allMls = rows.map((r) => r.mlsNumber);

    const listingDates = new Map<string, string>();
    for (let i = 0; i < allMls.length; i += 500) {
      const { data, error } = await supabase
        .from("listings")
        .select("mls_number,listing_date")
        .in("mls_number", allMls.slice(i, i + 500));
      if (error) throw error;
      for (const r of data || []) {
        if (r.listing_date) listingDates.set(String(r.mls_number), String(r.listing_date));
      }
    }

    const gridHasDom = rows.some((r) => r.dom || r.cdom);
    const domOf = (r: GridRow) => {
      const fromGrid = toNumber(r.dom) || toNumber(r.cdom);
      if (fromGrid > 0) return fromGrid;
      const listed = listingDates.get(r.mlsNumber);
      if (!listed) return -1; // unknown
      return Math.floor((Date.now() - new Date(listed).getTime()) / 86400000);
    };

    if (!gridHasDom) {
      log("NOTE: the display template has no DOM/CDOM column — falling back to Supabase listing_date");
    }
    const unknownDom = rows.filter((r) => domOf(r) < 0);
    if (unknownDom.length) {
      log(`WARNING: ${unknownDom.length} of ${rows.length} rows have no DOM signal and were excluded`);
    }

    let selected = rows.filter((r) => domOf(r) >= args.minDom);
    log(`${selected.length} of ${rows.length} rows have DOM >= ${args.minDom}`);
    selected.sort((a, b) => domOf(b) - domOf(a));
    if (args.limit > 0) selected = selected.slice(0, args.limit);

    // --- join Supabase ----------------------------------------------------
    const mlsNumbers = selected.map((r) => r.mlsNumber);

    const { data: listingRows, error: listingError } = await supabase
      .from("listings")
      .select("mls_number,listing_agent_email,listing_agent_phone,listing_agent_name,agent,listing_brokerage,city")
      .in("mls_number", mlsNumbers);
    if (listingError) throw listingError;
    const bySupabase = new Map((listingRows || []).map((r) => [String(r.mls_number), r]));
    log(`Supabase: matched ${bySupabase.size} of ${mlsNumbers.length} listings`);

    const { data: evalRows, error: evalError } = await supabase
      .from("evaluations")
      .select("mls_number,status")
      .in("mls_number", mlsNumbers);
    if (evalError) throw evalError;
    const evalsByMls = new Map<string, string[]>();
    for (const e of evalRows || []) {
      const key = String(e.mls_number);
      evalsByMls.set(key, [...(evalsByMls.get(key) || []), String(e.status || "")]);
    }

    // --- business cards, only for the gaps --------------------------------
    const out: OutRow[] = [];
    let cardsPulled = 0;
    let cardsFailed = 0;

    for (const row of selected) {
      const sb = bySupabase.get(row.mlsNumber);
      let email = String(sb?.listing_agent_email || "").trim();
      let phone = String(sb?.listing_agent_phone || "").trim();

      if (!email && !args.noCards && row.agentMemberId) {
        const card = await resolveBusinessCard(surface, row.agentMemberId, row.listingRecordTechId);
        if (card.email) {
          email = card.email;
          cardsPulled += 1;
        } else {
          cardsFailed += 1;
        }
        if (!phone && card.phone) phone = card.phone;
      }

      const { street, city } = splitAddress(row.address, row.cityStateZip);
      out.push({
        mls_number: row.mlsNumber,
        address: street,
        city: city || String(sb?.city || ""),
        list_price: String(toNumber(row.priceText) || ""),
        dom: String(domOf(row) || ""),
        agent_name: row.agentName || String(sb?.listing_agent_name || sb?.agent || ""),
        brokerage: row.brokerage || String(sb?.listing_brokerage || ""),
        agent_email: email,
        agent_phone: phone,
        prior_evaluation: bestEvalStatus(evalsByMls.get(row.mlsNumber) || []),
      });
    }

    // --- write CSV --------------------------------------------------------
    const header = [
      "mls_number", "address", "city", "list_price", "dom",
      "agent_name", "brokerage", "agent_email", "agent_phone", "prior_evaluation",
    ];
    const lines = [header.join(",")];
    for (const r of out) lines.push(header.map((h) => csvEscape(String(r[h as keyof OutRow] ?? ""))).join(","));
    await mkdir(resolve(repoRoot, "data"), { recursive: true });
    await writeFile(args.csvPath, `${lines.join("\n")}\n`);

    const withEmail = out.filter((r) => r.agent_email).length;
    const agents = new Set(out.filter((r) => r.agent_email).map((r) => r.agent_email.toLowerCase()));

    console.log("");
    console.log(`Stalled STR listings — ${args.minDom}+ days on market`);
    console.log("─".repeat(60));
    console.log(`  ${out.length} listings · ${agents.size} distinct agents by email`);
    console.log(`  ${withEmail} with an agent email · ${out.length - withEmail} without`);
    console.log(`  business cards pulled: ${cardsPulled} ok, ${cardsFailed} no email found`);
    console.log("");
    console.log(`  CSV: ${args.csvPath}`);
    if (out.length - withEmail > 0) {
      console.log("");
      console.log("  No email (blank agent_email in the CSV):");
      for (const r of out.filter((x) => !x.agent_email)) {
        console.log(`    ${r.mls_number}  ${r.address} — ${r.agent_name || "(no agent name)"}`);
      }
    }
  } finally {
    await managed.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`\nstalled-outreach failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
