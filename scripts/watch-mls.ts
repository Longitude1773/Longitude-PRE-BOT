import { spawnSync } from "node:child_process";
import { mkdir, appendFile, writeFile, readFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { type BrowserContext, type Frame, type Page } from "playwright";
import { getBrowserBackend, launchConfiguredPersistentContext, listBrowserRunTargets, type ManagedBrowserContext } from "./browser-runtime.ts";
import { markOnDemandRequestForCommand } from "./workflows/on-demand-request-store.ts";
import { isFlexMlsUrl, type OnDemandListingScrape } from "./workflows/on-demand-listing.ts";
import { permalinkMatchesAddress } from "./permalink-url.ts";
import { extractZillowListingFromPage, extractZpid, isZillowBlocked } from "./workflows/zillow.ts";

const repoRoot = resolve(import.meta.dirname, "..");
const inboxDir = resolve(repoRoot, "data/inbox");
const mhtmlDir = resolve(inboxDir, "mhtml");
const htmlDebugDir = resolve(inboxDir, "html-debug");
const profileDir = resolve(repoRoot, ".playwright/flexmls-profile");
const mlsOnDemandProfileDir = resolve(repoRoot, ".playwright/flexmls-on-demand-profile");
const zillowProfileDir = resolve(repoRoot, ".playwright/zillow-profile");
const heartbeatLog = resolve(inboxDir, "mls-watch.log");
const stateFile = resolve(inboxDir, "mls-watch-state.json");
const commandFile = resolve(inboxDir, "mls-commands.jsonl");
const processedCommandFile = resolve(inboxDir, "mls-commands.processed.jsonl");
const commandResultsFile = resolve(inboxDir, "mls-command-results.jsonl");
const linkHealingQueueFile = resolve(inboxDir, "mls-link-healing-queue.json");
const approvalAlertStateFile = resolve(inboxDir, "mls-approval-alert-state.json");
const mlsOnDemandBrowserRunSessionFile = resolve(inboxDir, "flexmls-on-demand-browser-run-session.json");
const zillowBrowserRunSessionFile = resolve(inboxDir, "zillow-browser-run-session.json");

const baseUrl = process.env.FLEXMLS_URL;
const username = process.env.FLEXMLS_USERNAME;
const password = process.env.FLEXMLS_PASSWORD;
const intervalSeconds = Number(process.env.FLEXMLS_WATCH_INTERVAL_SECONDS || "1800");
const headless = (process.env.FLEXMLS_HEADLESS || "false").toLowerCase() === "true";
const scanEnabled = (process.env.FLEXMLS_SCAN_ENABLED || "true").toLowerCase() !== "false";
const scanWindowStartHour = Number(process.env.FLEXMLS_SCAN_WINDOW_START_HOUR || "7");
const scanWindowEndHour = Number(process.env.FLEXMLS_SCAN_WINDOW_END_HOUR || "19");
const MOUNTAIN_TIME_ZONE = "America/Denver";
const mountainHourFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: MOUNTAIN_TIME_ZONE,
  hour: "numeric",
  hour12: false,
});
const mountainTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: MOUNTAIN_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
function isWithinScanWindow(now: Date = new Date()): boolean {
  const hour = Number(mountainHourFormatter.format(now));
  return hour >= scanWindowStartHour && hour < scanWindowEndHour;
}
const pauseAfterStep4Seconds = Number(process.env.FLEXMLS_PAUSE_AFTER_STEP4_SECONDS || "90");
const stopAfterStep4 = (process.env.FLEXMLS_STOP_AFTER_STEP4 || "false").toLowerCase() === "true";
const stopAfterHotSheet = (process.env.FLEXMLS_STOP_AFTER_HOTSHEET || "false").toLowerCase() === "true";
const stopAfterPermalink = (process.env.FLEXMLS_STOP_AFTER_PERMALINK || "false").toLowerCase() === "true";
const debugHtmlSnapshotsEnabled = (process.env.FLEXMLS_DEBUG_HTML || "true").toLowerCase() !== "false";
const zillowBrowserChannel = (process.env.ZILLOW_BROWSER_CHANNEL || "chrome").trim();
const zillowHeadless = (process.env.ZILLOW_HEADLESS || String(headless)).toLowerCase() === "true";
const zillowWarmUrl = process.env.ZILLOW_WARM_URL || "https://www.zillow.com/";
const zillowBrowserRunReuseSession = (process.env.ZILLOW_BROWSER_RUN_REUSE_SESSION || "true").toLowerCase() !== "false";
const zillowCaptchaWaitMs = Number(process.env.ZILLOW_CAPTCHA_WAIT_MS || "180000");
const slackBotToken = process.env.SLACK_BOT_TOKEN;
const slackAlertTarget =
  process.env.SLACK_ALERT_USER_ID ||
  process.env.SLACK_ALLOWED_USERS?.split(",")[0]?.trim() ||
  process.env.REVIEW_BUFFER_CHANNEL_ID;
const slackReviewTarget =
  process.env.SLACK_CHANNEL_ID ||
  process.env.REVIEW_BUFFER_CHANNEL_ID ||
  slackAlertTarget;
const slackAlertMentionUserId = process.env.SLACK_ALERT_MENTION_USER_ID;
const flexmlsOpenIdUrl = process.env.FLEXMLS_OPENID_URL || "https://pc.flexmls.com/openid_rp?provider_id=44";
const flexmlsDashboardUrl = process.env.FLEXMLS_DASHBOARD_URL || "https://pc.flexmls.com/cgi-bin/mainmenu.cgi?cmd=srv+flexdash/private_dashboard.html&command_line_mode=true&no_html_header=true";
const flexmlsHotSheetUrl = process.env.FLEXMLS_HOTSHEET_URL || "https://pc.flexmls.com/cgi-bin/mainmenu.cgi?cmd=url+search/hotsheet/24hourpre.html";
const flexmlsMlsNumberSearchUrl =
  process.env.FLEXMLS_MLS_NUMBER_SEARCH_URL ||
  "https://pc.flexmls.com/cgi-bin/mainmenu.cgi?cmd=url+search/listnum/index.html";
const watcherViewport = { width: 1440, height: 1000 };
const mlsBrowserBackend = getBrowserBackend(process.env.FLEXMLS_BROWSER_BACKEND);
const mlsOnDemandBrowserBackend = getBrowserBackend(
  process.env.FLEXMLS_ON_DEMAND_BROWSER_BACKEND ||
  process.env.MLS_ON_DEMAND_BROWSER_BACKEND ||
  process.env.FLEXMLS_BROWSER_BACKEND,
);
const mlsOnDemandBrowserRunReuseSession =
  (process.env.FLEXMLS_ON_DEMAND_BROWSER_RUN_REUSE_SESSION || "true").toLowerCase() !== "false";
const zillowBrowserBackend = getBrowserBackend(process.env.ZILLOW_BROWSER_BACKEND);
// Supabase-backed sheets read
import { readSheet } from "./sheets.ts";

let twoFactorAlertActive = false;
let twoFactorAlertRequestedAt = "";
let shuttingDown = false;
let mlsOnDemandSession: ManagedBrowserContext | null = null;
let mlsOnDemandSessionPromise: Promise<ManagedBrowserContext> | null = null;

if (!baseUrl || !username || !password) {
  throw new Error("Missing FLEXMLS_URL, FLEXMLS_USERNAME, or FLEXMLS_PASSWORD.");
}

type SubmitMls2faCommand = {
  id: string;
  type: "submit_2fa_code";
  code: string;
  submittedBy?: string;
  createdAt: string;
};

type ScrapeZillowListingCommand = {
  id: string;
  type: "scrape_zillow_listing";
  url: string;
  requestKey?: string;
  submittedBy?: string;
  createdAt: string;
};

type ScrapeMlsListingCommand = {
  id: string;
  type: "scrape_mls_listing";
  url: string;
  requestKey?: string;
  submittedBy?: string;
  createdAt: string;
};

type MlsCommand = SubmitMls2faCommand | ScrapeZillowListingCommand | ScrapeMlsListingCommand;

type MlsCommandResult =
  | {
      commandId: string;
      ok: true;
      action: "scrape_zillow_listing" | "scrape_mls_listing";
      createdAt: string;
      data: OnDemandListingScrape;
      htmlPath?: string;
      mhtmlPath?: string;
    }
  | {
      commandId: string;
      ok: false;
      action: "scrape_zillow_listing" | "scrape_mls_listing";
      createdAt: string;
      error: string;
      htmlPath?: string;
      mhtmlPath?: string;
    };

async function ensureDirs() {
  await mkdir(inboxDir, { recursive: true });
  await mkdir(mhtmlDir, { recursive: true });
  await mkdir(htmlDebugDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });
  await mkdir(mlsOnDemandProfileDir, { recursive: true });
  await mkdir(zillowProfileDir, { recursive: true });
  await appendFile(commandResultsFile, "");
}

async function logLine(message: string) {
  const line = `${new Date().toISOString()} ${message}\n`;
  await appendFile(heartbeatLog, line);
  process.stdout.write(line);
}

async function saveState(payload: Record<string, unknown>) {
  await writeFile(stateFile, `${JSON.stringify({ updatedAt: new Date().toISOString(), ...payload }, null, 2)}\n`);
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function elapsedMs(start: number) {
  return Date.now() - start;
}

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function safeFileLabel(value: string) {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "snapshot";
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function parseEmbeddedJson<T>(html: string, attributeName: string) {
  const patterns = [
    new RegExp(`${attributeName}="([^"]+)"`, "i"),
    new RegExp(`${attributeName}='([^']+)'`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match?.[1]) continue;
    try {
      return JSON.parse(decodeHtmlEntities(match[1])) as T;
    } catch {
      continue;
    }
  }
  return null;
}

function extractMetaContentFromHtml(html: string, attribute: "name" | "property", key: string) {
  const patterns = [
    new RegExp(`<meta[^>]*${attribute}=["']${key}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*${attribute}=["']${key}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtmlEntities(match[1]);
  }
  return "";
}

function toNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const normalized = String(value || "").replace(/[^\d.-]/g, "");
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getFieldValue(fieldMap: Map<string, string>, ...labels: string[]) {
  for (const label of labels) {
    const normalized = normalizeDetailFieldLabel(label);
    const exact = fieldMap.get(normalized);
    if (exact) return exact;
  }
  for (const [key, value] of fieldMap.entries()) {
    if (!value) continue;
    if (labels.some((label) => key.includes(normalizeDetailFieldLabel(label)))) return value;
  }
  return "";
}

function isContextClosedMessage(message: string) {
  return (
    message.includes("Target page, context or browser has been closed") ||
    message.includes("Browser has been closed")
  );
}

function isShutdownCancellation(error: unknown) {
  if (!shuttingDown) return false;
  const message = error instanceof Error ? error.message : String(error);
  return isContextClosedMessage(message);
}

async function getPage(context: BrowserContext) {
  const page = context.pages()[0] || await context.newPage();
  await page.setViewportSize(watcherViewport).catch(() => {});
  page.setDefaultTimeout(20000);
  return page;
}

async function logBrowserRunLiveView(label: string, sessionId: string, preferredUrl?: string) {
  const targets = await listBrowserRunTargets(sessionId).catch(() => [] as Array<{
    devtoolsFrontendUrl?: string;
    title?: string;
    url?: string;
  }>);
  const liveView =
    (preferredUrl ? targets.find((target) => target.url === preferredUrl)?.devtoolsFrontendUrl : undefined) ||
    targets[0]?.devtoolsFrontendUrl;
  if (liveView) {
    await logLine(`mls watcher: ${label} browser run live view sessionId=${sessionId} url=${liveView}`);
  }
}

async function getZillowWarmPage(context: BrowserContext) {
  const existing = [...context.pages()].reverse().find((candidate) => !candidate.isClosed());
  const page = existing || await context.newPage();
  await page.setViewportSize(watcherViewport).catch(() => {});
  page.setDefaultTimeout(20000);

  const currentUrl = page.url();
  if (!currentUrl || currentUrl === "about:blank" || !/zillow\.com/i.test(currentUrl)) {
    await page.goto(zillowWarmUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1500);
  }

  return page;
}

async function hardenZillowContext(context: BrowserContext) {
  await context.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
  });
}

async function launchZillowContext() {
  const options = {
    headless: zillowHeadless,
    viewport: watcherViewport,
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled"],
  };

  if (zillowBrowserBackend === "local" && zillowBrowserChannel) {
    try {
      const launched = await launchConfiguredPersistentContext({
        backend: zillowBrowserBackend,
        label: "zillow-watch",
        log: logLine,
        persistentDir: zillowProfileDir,
        ...options,
        channel: zillowBrowserChannel,
      });
      await logLine(`mls watcher: launched zillow context with channel=${zillowBrowserChannel}`);
      return launched;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await logLine(`mls watcher: failed to launch zillow channel=${zillowBrowserChannel}; falling back to bundled chromium error=${message}`);
    }
  }

  const launched = await launchConfiguredPersistentContext({
    backend: zillowBrowserBackend,
    label: "zillow-watch",
    log: logLine,
    persistentDir: zillowProfileDir,
    browserRunSessionFilePath: zillowBrowserBackend === "browser-run" && zillowBrowserRunReuseSession ? zillowBrowserRunSessionFile : undefined,
    ...options,
  });
  await logLine(
    zillowBrowserBackend === "browser-run"
      ? `mls watcher: launched zillow context with Cloudflare Browser Run sessionId=${launched.sessionId || "unknown"}`
      : "mls watcher: launched zillow context with bundled chromium",
  );
  return launched;
}

async function launchMlsOnDemandContext() {
  const launched = await launchConfiguredPersistentContext({
    backend: mlsOnDemandBrowserBackend,
    label: "flexmls-on-demand",
    log: logLine,
    persistentDir: mlsOnDemandProfileDir,
    browserRunSessionFilePath:
      mlsOnDemandBrowserBackend === "browser-run" && mlsOnDemandBrowserRunReuseSession
        ? mlsOnDemandBrowserRunSessionFile
        : undefined,
    headless,
    viewport: watcherViewport,
  });
  await logLine(
    mlsOnDemandBrowserBackend === "browser-run"
      ? `mls watcher: launched mls on-demand context with Cloudflare Browser Run sessionId=${launched.sessionId || "unknown"}`
      : "mls watcher: launched dedicated mls on-demand context with bundled chromium",
  );
  if (mlsOnDemandBrowserBackend === "browser-run" && launched.sessionId) {
    await logBrowserRunLiveView("mls on-demand", launched.sessionId).catch(() => {});
  }
  return launched;
}

async function ensureMlsOnDemandSession() {
  if (mlsOnDemandSession) return mlsOnDemandSession;
  if (!mlsOnDemandSessionPromise) {
    mlsOnDemandSessionPromise = launchMlsOnDemandContext()
      .then((session) => {
        mlsOnDemandSession = session;
        return session;
      })
      .finally(() => {
        mlsOnDemandSessionPromise = null;
      });
  }
  return await mlsOnDemandSessionPromise;
}

async function exportPageMhtml(page: Page, label: string) {
  const session = await page.context().newCDPSession(page);
  await session.send("Page.enable");
  const snapshot = await session.send("Page.captureSnapshot", { format: "mhtml" }) as { data?: string };
  const path = resolve(mhtmlDir, `${safeTimestamp()}-${label}.mhtml`);
  await writeFile(path, snapshot.data || "");
  return path;
}

async function exportNavigationHtml(page: Page, label: string) {
  if (!debugHtmlSnapshotsEnabled) return [] as string[];

  const prefix = `${safeTimestamp()}-${safeFileLabel(label)}`;
  const paths: string[] = [];
  const mainHtml = await page.content().catch(() => "");
  if (mainHtml) {
    const mainPath = resolve(htmlDebugDir, `${prefix}-main.html`);
    await writeFile(mainPath, mainHtml);
    paths.push(mainPath);
  }

  const frames = page.frames().filter((frame) => frame !== page.mainFrame());
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const frameHtml = await frame.content().catch(() => "");
    if (!frameHtml) continue;
    const framePath = resolve(htmlDebugDir, `${prefix}-frame-${index + 1}.html`);
    await writeFile(framePath, frameHtml);
    paths.push(framePath);
  }

  if (paths.length > 0) {
    await logLine(`mls watcher: saved html snapshot label=${label} files=${JSON.stringify(paths)}`);
  }

  return paths;
}

async function slackApi(method: string, body: Record<string, unknown>) {
  if (!slackBotToken) return null;
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${slackBotToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  return await res.json().catch(() => null);
}

function formatAlertText(text: string, mention = false) {
  return mention && slackAlertMentionUserId ? `<@${slackAlertMentionUserId}> ${text}` : text;
}

async function pollSlackForNumericCode() {
  if (!slackBotToken || !slackAlertTarget || !slackAlertTarget.startsWith("C")) return null;
  const history = await slackApi("conversations.history", { channel: slackAlertTarget, limit: 20 });
  const messages = Array.isArray(history?.messages) ? history.messages : [];
  for (const message of messages) {
    const text = String(message?.text || "").trim();
    const ts = String(message?.ts || "");
    if (message?.bot_id) continue;
    if (twoFactorAlertRequestedAt && ts <= twoFactorAlertRequestedAt) continue;
    const codeMatch = text.match(/\b(\d{4,8})\b/);
    if (!codeMatch) continue;
    return { code: codeMatch[1], ts, user: String(message?.user || "") };
  }
  return null;
}

async function postSlackAlert(text: string, options?: { mention?: boolean }) {
  if (!slackBotToken) return false;

  const attemptTargets = [
    slackAlertTarget,
    process.env.SLACK_ALLOWED_USERS?.split(",")[0]?.trim(),
    process.env.REVIEW_BUFFER_CHANNEL_ID,
  ].filter(Boolean) as string[];

  return await postSlackMessage(attemptTargets, text, options);
}

async function postSlackMessage(targets: string[], text: string, options?: { mention?: boolean }) {
  if (!slackBotToken) return false;
  const attemptTargets = targets.filter(Boolean);

  for (const target of attemptTargets) {
    let channel = target;
    if (target.startsWith("U")) {
      const open = await slackApi("conversations.open", { users: target });
      if (open?.ok && open.channel?.id) channel = open.channel.id as string;
    }

    const posted = await slackApi("chat.postMessage", { channel, text: formatAlertText(text, options?.mention === true) });
    if (posted?.ok) return true;
  }

  return false;
}

async function alertUnresolvedApprovalCandidates(candidates: HotSheetListing[]) {
  const nextMls = Array.from(new Set(candidates.map((candidate) => candidate.mlsNumber).filter(Boolean))).sort();
  const previous = await readJsonFile<{ unresolvedMls?: string[] }>(approvalAlertStateFile, {});
  const previousMls = Array.isArray(previous.unresolvedMls) ? previous.unresolvedMls : [];
  const newlyBlocked = nextMls.filter((mlsNumber) => !previousMls.includes(mlsNumber));

  if (newlyBlocked.length > 0) {
    const preview = candidates
      .filter((candidate) => newlyBlocked.includes(candidate.mlsNumber))
      .slice(0, 10)
      .map((candidate) => `- MLS ${candidate.mlsNumber}: ${[candidate.address, candidate.cityStateZip].filter(Boolean).join(", ")}`)
      .join("\n");
    const overflow = newlyBlocked.length > 10 ? `\n- plus ${newlyBlocked.length - 10} more` : "";
    const message = [
      `FlexMLS watcher could not read nightly-rental status for ${newlyBlocked.length} new listing${newlyBlocked.length === 1 ? "" : "s"} on this scan, so those listings were queued for retry and no review post was created yet.`,
      preview,
      overflow,
      `Healing queue: ${linkHealingQueueFile}`,
    ].filter(Boolean).join("\n");

    const posted = slackReviewTarget
      ? await postSlackMessage([slackReviewTarget], message, { mention: false })
      : false;
    await logLine(
      `mls watcher: approval alert ${posted ? "posted" : "failed"} target=${slackReviewTarget || "none"} newlyBlocked=${JSON.stringify(newlyBlocked)}`
    );
  }

  await writeFile(
    approvalAlertStateFile,
    `${JSON.stringify({ updatedAt: new Date().toISOString(), unresolvedMls: nextMls }, null, 2)}\n`
  );
}

type OpenHouseEntry = {
  date: string;
  time: string;
  hostedBy: string;
};

type HotSheetListing = {
  mlsNumber: string;
  priceText: string;
  address: string;
  cityStateZip: string;
  openHouses: OpenHouseEntry[];
  listingRowId?: string;
  listingRecordId?: string;
  listingMlsBoardId?: string;
  listingPrefix?: string;
  listingUrl?: string;
  listingUrlSource?: string;
  statusText: string;
  markerText: string;
  area: string;
  subdivision: string;
  propertyTypeCode: string;
  subtypeCode: string;
  bedrooms: number;
  bathrooms: number;
  squareFootage: number;
  photoUrls?: string[];
  nightlyRentalAllowed?: string;
  nightlyRentalAllowedSource?: string;
  strApproved?: boolean;
  approvalMhtmlPath?: string;
  listingAgentName?: string;
  listingAgentEmail?: string;
  listingAgentPhone?: string;
  listingBrokerage?: string;
  listingAgentMemberId?: string;
  listingRecordTechId?: string;
};

type ExtractedHotSheet = {
  listings: HotSheetListing[];
  stats: {
    totalTableRows: number;
    candidateRows: number;
    parsedRows: number;
    parseMissCount: number;
    parseMissSamples: string[];
    missingLinkCount: number;
    missingLinkSamples: Array<{
      text: string;
      anchorSnippets: string[];
      clickableSnippets: string[];
    }>;
    linkSourceCounts?: Record<string, number>;
  };
};

type QueueCandidate = {
  mlsNumber: string;
  address: string;
  cityStateZip: string;
  displayAddress: string;
  listingUrl?: string;
  listingUrlSource?: string;
  nightlyRentalAllowed?: string;
  nightlyRentalAllowedSource?: string;
  strApproved?: boolean;
  priceText: string;
  statusText: string;
  markerText: string;
  area?: string;
  subdivision?: string;
  propertyTypeCode?: string;
  subtypeCode?: string;
  bedrooms?: number;
  bathrooms?: number;
  squareFootage?: number;
  photoUrls?: string[];
  openHouses?: OpenHouseEntry[];
  listingAgentName?: string;
  listingAgentEmail?: string;
  listingAgentPhone?: string;
  listingBrokerage?: string;
  detectedAt: string;
  nextStep: string;
  slackStatus: string;
};

type LinkHealingCandidate = {
  mlsNumber: string;
  address: string;
  cityStateZip: string;
  listingUrl?: string;
  listingUrlSource?: string;
  nightlyRentalAllowed?: string;
  nightlyRentalAllowedSource?: string;
  strApproved?: boolean;
  listingRowId?: string;
  listingRecordId?: string;
  listingMlsBoardId?: string;
  reason: string;
  mhtmlPath?: string;
  detectedAt: string;
};

type LinkResolutionAttempt = {
  mlsNumber: string;
  hadRowLink: boolean;
  initialSurfaceUrl: string;
  rowSelector?: string;
  rowClickTarget?: string;
  rowSelected?: boolean;
  shareButtonVisible?: boolean;
  permalinkInputVisible?: boolean;
  mhtmlPath?: string;
  hasMlsSearch: boolean;
  chosenSectionSelector: string;
  chosenInputSelector: string;
  searchTrigger: string;
  popupOpened: boolean;
  popupUrl: string;
  detailFrameUrl: string;
  directUrlAfterSearch: string;
  extractedUrlAfterSearch: string;
  finalUrl: string;
  finalSource: string;
  bodySnippet: string;
  error?: string;
};

type EligibilityResolutionAttempt = {
  mlsNumber: string;
  listingUrl: string;
  nightlyRentalAllowed: string;
  approvalStatus: "approved" | "rejected" | "unknown";
  source: string;
  pageUrl: string;
  mhtmlPath?: string;
  error?: string;
};

type FlexSurface = Page | Frame;

async function surfaceBodyText(surface: FlexSurface) {
  return await surface.locator("body").innerText().catch(() => "");
}

function surfaceUrl(surface: FlexSurface) {
  return surface.url();
}

async function findFlexSurface(page: Page): Promise<FlexSurface> {
  const topLevelBody = await surfaceBodyText(page);
  if (
    topLevelBody.includes("QuickLaunch") ||
    topLevelBody.includes("Results:") ||
    topLevelBody.includes("Change Search Template") ||
    topLevelBody.includes("MLS # Search") ||
    topLevelBody.includes("Hot Sheet For") ||
    topLevelBody.includes("New Listings (")
  ) {
    return page;
  }

  for (const frame of page.frames()) {
    const body = await surfaceBodyText(frame);
    const url = frame.url();
    if (
      body.includes("QuickLaunch") ||
      body.includes("Results:") ||
      body.includes("Change Search Template") ||
      body.includes("MLS # Search") ||
      body.includes("Hot Sheet For") ||
      body.includes("New Listings (") ||
      url.includes("mainmenu") ||
      url.includes("search/")
    ) {
      return frame;
    }
  }

  return page;
}

function detectAuthBlock(body: string) {
  const lower = body.toLowerCase();
  if (
    lower.includes("two-factor") ||
    lower.includes("2fa") ||
    lower.includes("verification code") ||
    lower.includes("enter code") ||
    lower.includes("trusted device") ||
    lower.includes("trust this device") ||
    lower.includes("authentication code")
  ) {
    return "2fa";
  }
  return null;
}

async function isPortalHome(page: Page) {
  const url = page.url();
  const body = await page.locator("body").innerText().catch(() => "");
  return url.includes("portal.parkcityrealtors.com/home") || (body.includes("Resources & Services") && body.includes("FLEXMLS"));
}

async function looksLoggedIn(page: Page) {
  const surface = await findFlexSurface(page);
  const url = surfaceUrl(surface);
  const body = await surfaceBodyText(surface);
  if (url.includes("pc.flexmls.com") || url.includes("mainmenu") || url.includes("search/")) return true;
  return body.includes("QuickLaunch") || body.includes("MLS # Search") || body.includes("Change Search Template") || body.includes("Hot Sheet For") || body.includes("New Listings (");
}

async function drainCommands(types?: Array<MlsCommand["type"]>) {
  try {
    const temp = `${commandFile}.consumed.${Date.now()}`;
    await rename(commandFile, temp);
    const raw = await readFile(temp, "utf8");
    if (!raw.trim()) return [] as MlsCommand[];
    await appendFile(processedCommandFile, raw);
    const commands = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as MlsCommand);
    if (!types || types.length === 0) return commands;

    const wanted = commands.filter((command) => types.includes(command.type));
    const remaining = commands.filter((command) => !types.includes(command.type));
    if (remaining.length > 0) {
      await appendFile(commandFile, `${remaining.map((command) => JSON.stringify(command)).join("\n")}\n`);
    }
    return wanted;
  } catch {
    return [] as MlsCommand[];
  }
}

async function appendCommandResult(result: MlsCommandResult) {
  await appendFile(commandResultsFile, `${JSON.stringify(result)}\n`);
}

async function handleScrapeMlsListingCommand(context: BrowserContext, surfacePage: Page, command: ScrapeMlsListingCommand) {
  const listingLabel = safeFileLabel(command.url);
  const page = await context.newPage();
  await page.setViewportSize(watcherViewport).catch(() => {});
  page.setDefaultTimeout(20000);

  try {
    await logLine(`mls watcher: handling mls scrape command id=${command.id} url=${command.url}`);
    if (command.requestKey) {
      await markOnDemandRequestForCommand({
        requestKey: command.requestKey,
        commandId: command.id,
        status: "scraping",
        error: null,
      }).catch(() => {});
    }
    if (isFlexMlsUrl(command.url)) {
      await loginIfNeeded(surfacePage).catch(() => {});
      const warmPage = await warmSearchSurface(surfacePage).catch(() => surfacePage);
      await warmPage.bringToFront().catch(() => {});
      const sessionId =
        mlsOnDemandBrowserBackend === "browser-run"
          ? mlsOnDemandSession?.sessionId
          : undefined;
      if (sessionId) {
        await logBrowserRunLiveView("mls on-demand", sessionId, warmPage.url()).catch(() => {});
      }
      await warmPage.waitForTimeout(250);
    }
    const maxAttempts = isFlexMlsUrl(command.url) ? 3 : 1;
    let data: OnDemandListingScrape | null = null;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt === 0) {
        await page.goto(command.url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      } else {
        await logLine(`mls watcher: retrying mls scrape command id=${command.id} attempt=${attempt + 1}/${maxAttempts}`);
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(async () => {
          await page.goto(command.url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
        });
      }

      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(2200 + attempt * 1200);

      try {
        const candidate = await extractMlsListingFromPage(page, command.url);
        const looksIncomplete =
          !candidate.price ||
          /detail-(?:private|rev\d+)/i.test(candidate.address) ||
          /^property description$/i.test(candidate.description || "") ||
          /^property description$/i.test(candidate.nightlyRentalAllowed || "");
        if (looksIncomplete) {
          throw new Error(`MLS scrape returned incomplete listing data on attempt ${attempt + 1}.`);
        }
        data = candidate;
        break;
      } catch (error) {
        lastError = error;
        if (attempt + 1 < maxAttempts) continue;
      }
    }

    if (!data) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError || "MLS scrape failed."));
    }

    const htmlPaths = await exportNavigationHtml(page, `on-demand-mls-${listingLabel}-resolved`);
    const mhtmlPath = await exportPageMhtml(page, `on-demand-mls-${listingLabel}-resolved`).catch(() => "");
    await appendCommandResult({
      commandId: command.id,
      ok: true,
      action: "scrape_mls_listing",
      createdAt: new Date().toISOString(),
      data,
      htmlPath: htmlPaths[0],
      mhtmlPath: mhtmlPath || undefined,
    });
    await logLine(`mls watcher: mls scrape command completed id=${command.id} mls=${data.listingId} address=${JSON.stringify(data.address)}`);
  } catch (error) {
    const htmlPaths = await exportNavigationHtml(page, `on-demand-mls-${listingLabel}-error`).catch(() => [] as string[]);
    const mhtmlPath = await exportPageMhtml(page, `on-demand-mls-${listingLabel}-error`).catch(() => "");
    const message = error instanceof Error ? error.message : String(error);
    if (command.requestKey) {
      await markOnDemandRequestForCommand({
        requestKey: command.requestKey,
        commandId: command.id,
        status: "failed",
        error: message,
      }).catch(() => {});
    }
    await appendCommandResult({
      commandId: command.id,
      ok: false,
      action: "scrape_mls_listing",
      createdAt: new Date().toISOString(),
      error: message,
      htmlPath: htmlPaths[0],
      mhtmlPath: mhtmlPath || undefined,
    });
    await logLine(`mls watcher: mls scrape command error id=${command.id} error=${message}`);
  } finally {
    await page.close().catch(() => {});
  }
}

async function handleScrapeZillowListingCommand(context: BrowserContext, command: ScrapeZillowListingCommand) {
  const zpid = extractZpid(command.url) || safeFileLabel(command.id);
  const page = await getZillowWarmPage(context);

  try {
    await logLine(`mls watcher: handling zillow scrape command id=${command.id} zpid=${zpid} url=${command.url}`);
    if (command.requestKey) {
      await markOnDemandRequestForCommand({
        requestKey: command.requestKey,
        commandId: command.id,
        status: "scraping",
        error: null,
      }).catch(() => {});
    }
    await page.bringToFront().catch(() => {});
    await page.goto(command.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3500);

    if (await isZillowBlocked(page)) {
      await exportNavigationHtml(page, `zillow-${zpid}-blocked-initial`);
      await logLine(`mls watcher: zillow blocked for zpid=${zpid}; waiting up to ${Math.round(zillowCaptchaWaitMs / 1000)}s for manual solve in live browser`);
      const startedAt = Date.now();
      while (Date.now() - startedAt < zillowCaptchaWaitMs) {
        await page.bringToFront().catch(() => {});
        await page.waitForTimeout(2000);
        if (!(await isZillowBlocked(page))) break;
      }
    }

    if (await isZillowBlocked(page)) {
      const htmlPaths = await exportNavigationHtml(page, `zillow-${zpid}-blocked-timeout`);
      const mhtmlPath = await exportPageMhtml(page, `zillow-${zpid}-blocked-timeout`).catch(() => "");
      const error = `Zillow is still showing the challenge in the live watcher browser after waiting ${Math.round(zillowCaptchaWaitMs / 1000)} seconds. Solve it in the open tab and retry.`;
      if (command.requestKey) {
        await markOnDemandRequestForCommand({
          requestKey: command.requestKey,
          commandId: command.id,
          status: "failed",
          error,
        }).catch(() => {});
      }
      await appendCommandResult({
        commandId: command.id,
        ok: false,
        action: "scrape_zillow_listing",
        createdAt: new Date().toISOString(),
        error,
        htmlPath: htmlPaths[0],
        mhtmlPath: mhtmlPath || undefined,
      });
      await logLine(`mls watcher: zillow scrape command failed id=${command.id} zpid=${zpid} reason=still_blocked`);
      return;
    }

    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    const htmlPaths = await exportNavigationHtml(page, `zillow-${zpid}-resolved`);
    const mhtmlPath = await exportPageMhtml(page, `zillow-${zpid}-resolved`).catch(() => "");
    const data = await extractZillowListingFromPage(page, command.url);
    await appendCommandResult({
      commandId: command.id,
      ok: true,
      action: "scrape_zillow_listing",
      createdAt: new Date().toISOString(),
      data,
      htmlPath: htmlPaths[0],
      mhtmlPath: mhtmlPath || undefined,
    });
    await logLine(`mls watcher: zillow scrape command completed id=${command.id} zpid=${data.listingId || zpid} address=${JSON.stringify(data.address)}`);
  } catch (error) {
    const htmlPaths = await exportNavigationHtml(page, `zillow-${zpid}-error`).catch(() => [] as string[]);
    const mhtmlPath = await exportPageMhtml(page, `zillow-${zpid}-error`).catch(() => "");
    const message = error instanceof Error ? error.message : String(error);
    if (command.requestKey) {
      await markOnDemandRequestForCommand({
        requestKey: command.requestKey,
        commandId: command.id,
        status: "failed",
        error: message,
      }).catch(() => {});
    }
    await appendCommandResult({
      commandId: command.id,
      ok: false,
      action: "scrape_zillow_listing",
      createdAt: new Date().toISOString(),
      error: message,
      htmlPath: htmlPaths[0],
      mhtmlPath: mhtmlPath || undefined,
    });
    await logLine(`mls watcher: zillow scrape command error id=${command.id} zpid=${zpid} error=${message}`);
  }
}

async function processWatcherCommands(
  mlsContext: BrowserContext,
  basePage: Page,
  zillowContext: BrowserContext,
) {
  const commands = await drainCommands(["scrape_zillow_listing", "scrape_mls_listing"]);
  for (const command of commands) {
    if (command.type === "scrape_zillow_listing") {
      await handleScrapeZillowListingCommand(zillowContext, command);
    } else if (command.type === "scrape_mls_listing") {
      if (mlsOnDemandBrowserBackend === mlsBrowserBackend) {
        await handleScrapeMlsListingCommand(mlsContext, basePage, command);
      } else {
        const onDemandSession = await ensureMlsOnDemandSession();
        const onDemandPage = await getPage(onDemandSession.context);
        await handleScrapeMlsListingCommand(onDemandSession.context, onDemandPage, command);
      }
    }
  }
}

async function waitForTwoFactorCode(page: Page) {
  const existingState = JSON.parse(await readFile(stateFile, "utf8").catch(() => "{}"));
  const alreadyPrompted = existingState.mode === "awaiting_2fa" && existingState.promptedFor2fa === true;

  await saveState({
    mode: "awaiting_2fa",
    loggedIn: false,
    url: page.url(),
    twoFactorAlertActive: true,
    promptedFor2fa: true,
  });

  if (!alreadyPrompted && !twoFactorAlertActive) {
    twoFactorAlertActive = true;
    await postSlackAlert(
      "FlexMLS watcher is blocked on a 2FA / trusted-device page. Reply in this channel with the 2FA code and I will try it on the live MLS session.",
      { mention: true }
    );
    twoFactorAlertRequestedAt = new Date().toISOString();
    await logLine("mls watcher: sent Slack alert for 2FA/trusted-device block");
  } else {
    twoFactorAlertActive = true;
  }

  for (let attempt = 0; attempt < 120; attempt += 1) {
    const commands = await drainCommands(["submit_2fa_code"]);
    const queuedCommands = commands
      .filter((command): command is SubmitMls2faCommand => command.type === "submit_2fa_code")
      .reverse();
    const queued = queuedCommands.find((command) => /^\d{4,8}$/.test(command.code));
    const polled = await pollSlackForNumericCode();
    const submit = queued || (polled ? { type: "submit_2fa_code", code: polled.code, submittedBy: polled.user, id: polled.ts, createdAt: polled.ts } : null);
    if (submit) {
      const codeInput = page.locator(':is(input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name*="code" i], input[id*="code" i], input[type="tel"], input[type="text"]):visible').first();
      await codeInput.waitFor({ timeout: 5000, state: "visible" });
      await codeInput.fill(submit.code);
      const submitButton = page.locator('button:has-text("Verify"), button:has-text("Submit"), button:has-text("Continue"), input[type="submit"], button[id*="verify" i], button[name*="verify" i]').first();
      await submitButton.click();
      await page.waitForTimeout(4000);

      if (await looksLoggedIn(page)) {
        twoFactorAlertActive = false;
        twoFactorAlertRequestedAt = "";
        await postSlackAlert("FlexMLS watcher accepted the 2FA code and is back in the logged-in session.");
        await logLine(`mls watcher: 2FA code accepted from ${submit.submittedBy || "unknown"}`);
        return;
      }

      await logLine("mls watcher: submitted 2FA code but login still not complete");
      await postSlackAlert("That 2FA code did not clear the MLS login. Reply with the newest code and I will try again.", { mention: true });
      twoFactorAlertRequestedAt = new Date().toISOString();
      await saveState({
        mode: "awaiting_2fa",
        loggedIn: false,
        url: page.url(),
        twoFactorAlertActive: true,
        promptedFor2fa: true,
        lastFailure: "submitted code but still blocked",
      });
    }

    await page.waitForTimeout(5000);
  }

  throw new Error("Timed out waiting for FlexMLS 2FA code.");
}

async function loginIfNeeded(page: Page) {
  await page.goto(baseUrl!, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await exportNavigationHtml(page, "login-base-url");
  if (await looksLoggedIn(page)) {
    await logLine("mls watcher: session already live in FlexMLS");
    return false;
  }
  if (await isPortalHome(page)) {
    await logLine("mls watcher: session already authenticated in PCR portal");
    return false;
  }

  const usernameInput = page.locator('input[type="text"], input[name*="user" i], input[id*="user" i]').first();
  const passwordInput = page.locator('input[type="password"]').first();
  await usernameInput.waitFor({ timeout: 15000 });
  await usernameInput.fill(username!);
  await passwordInput.fill(password!);

  const submit = page.locator('button:has-text("Login"), input[type="submit"], button[type="submit"]').first();
  await submit.click();
  await page.waitForTimeout(4000);
  await exportNavigationHtml(page, "login-post-submit");

  if (!(await looksLoggedIn(page))) {
    const body = await page.locator("body").innerText().catch(() => "");
    const authBlock = detectAuthBlock(body);
    if (authBlock === "2fa") {
      await waitForTwoFactorCode(page);
      await exportNavigationHtml(page, "login-post-2fa");
      if (await looksLoggedIn(page)) {
        await logLine("mls watcher: logged into FlexMLS after 2FA");
        return true;
      }
    }
    if (await isPortalHome(page)) {
      await logLine("mls watcher: credentials accepted; authenticated in PCR portal and will continue into FlexMLS");
      return true;
    }
    throw new Error("Login did not reach a logged-in FlexMLS page.");
  }

  await logLine("mls watcher: logged into FlexMLS");
  return true;
}

async function dismissRestorePrompt(page: Page) {
  const restore = page.locator('button:has-text("Restore")').first();
  if (await restore.isVisible().catch(() => false)) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(500);
  }
}

async function enterFlexmlsFromPortal(page: Page) {
  if (!(await isPortalHome(page))) return;
  await dismissRestorePrompt(page);
  await exportNavigationHtml(page, "portal-home");

  const candidateSelectors = [
    'a[href*="pc.flexmls.com/openid_rp"]',
    'a[href*="flexmls.com/openid_rp"]',
    'a[href*="pc.flexmls.com"]',
    'a[href*="flexmls.com"]',
    'text=FLEXMLS',
  ];

  for (const selector of candidateSelectors) {
    const flexLink = page.locator(selector).first();
    if (!(await flexLink.isVisible().catch(() => false))) continue;

    const popup = page.waitForEvent("popup", { timeout: 5000 }).catch(() => null);
    await flexLink.click().catch(() => {});
    const maybePopup = await popup;
    if (maybePopup) {
      await maybePopup.waitForLoadState("domcontentloaded").catch(() => {});
      await maybePopup.waitForTimeout(1500);
      await exportNavigationHtml(maybePopup, "portal-flex-popup");
      await maybePopup.bringToFront().catch(() => {});
      return maybePopup;
    }

    await page.waitForTimeout(2500);
    await exportNavigationHtml(page, "portal-flex-click");
    if (page.url().includes("flexmls.com") || (await looksLoggedIn(page))) {
      return page;
    }
  }

  return page;
}

async function readSheetRows(sheet: string) {
  try {
    const rows = await readSheet(sheet);
    return Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
  } catch {
    return [] as Record<string, unknown>[];
  }
}

async function existingPostedEvaluationMlsSet() {
  const evaluationRows = await readSheetRows("Evaluations");
  return new Set(
    evaluationRows
      .filter((row) => String(row["Slack Timestamp"] || "").trim().length > 0)
      .map((row) => String(row["MLS #"] || ""))
      .filter(Boolean)
  );
}

async function readReviewQueue() {
  try {
    const raw = await readFile(resolve(inboxDir, "mls-review-queue.json"), "utf8");
    const parsed = JSON.parse(raw) as QueueCandidate[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [] as QueueCandidate[];
  }
}

async function runHotSheetIfPrompted(page: Page, surface: FlexSurface) {
  const body = await surfaceBodyText(surface);
  if (!body.includes("24-Hour Hot Sheet")) return await findFlexSurface(page);

  const runHotSheetButton = surface.locator('button:has-text("Run 24-Hour Hot Sheet")').first();
  const runHotSheetText = surface.locator('text=Run 24-Hour Hot Sheet').first();
  if (await runHotSheetButton.isVisible().catch(() => false)) {
    await runHotSheetButton.click().catch(() => {});
    await page.waitForTimeout(5000);
    await exportNavigationHtml(page, "hotsheet-run-button");
    return await findFlexSurface(page);
  }
  if (await runHotSheetText.isVisible().catch(() => false)) {
    await runHotSheetText.click().catch(() => {});
    await page.waitForTimeout(5000);
    await exportNavigationHtml(page, "hotsheet-run-text");
    return await findFlexSurface(page);
  }

  return await findFlexSurface(page);
}

async function goToHotSheetNewListings(page: Page) {
  let surface = await findFlexSurface(page);
  const directHotSheetLink = surface.locator('a[href*="search/hotsheet/24hourpre.html"]').first();
  if (await directHotSheetLink.isVisible().catch(() => false)) {
    await directHotSheetLink.click().catch(() => {});
    await page.waitForTimeout(3000);
    await exportNavigationHtml(page, "hotsheet-direct-link");
    surface = await findFlexSurface(page);
  }

  const ranDirectSurface = await runHotSheetIfPrompted(page, surface);
  const ranDirectBody = await surfaceBodyText(ranDirectSurface);
  if (ranDirectBody.includes("Results:") || ranDirectBody.includes("Hot Sheet For") || ranDirectBody.includes("New Listings (")) {
    return ranDirectSurface;
  }

  const template = ranDirectSurface.locator('select, [role="combobox"]').first();
  if (await template.isVisible().catch(() => false)) {
    await template.selectOption({ label: '[Hot Sheet - New Listing *]' }).catch(() => {});
    await page.waitForTimeout(3000);
    await exportNavigationHtml(page, "hotsheet-template-select");
    return await runHotSheetIfPrompted(page, await findFlexSurface(page));
  }

  await page.goto(flexmlsHotSheetUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(3000);
  await exportNavigationHtml(page, "hotsheet-direct-url");
  surface = await findFlexSurface(page);
  return await runHotSheetIfPrompted(page, surface);
}

function isMeaningfulFlexUrl(url: string) {
  if (!url) return false;
  if (!url.includes("flexmls.com") && !url.includes("mainmenu.cgi") && !url.includes("/cgi-bin/")) return false;
  if (url.includes("openid_rp") || url.includes("sso.tangilla.com")) return false;
  if (/\/cgi-bin\/mainmenu\.cgi\/?$/.test(url) && !url.includes("?")) return false;
  return true;
}

function dedupeListingsByMls(listings: HotSheetListing[]) {
  const byMls = new Map<string, HotSheetListing>();
  for (const listing of listings) {
    if (!listing.mlsNumber) continue;
    byMls.set(listing.mlsNumber, listing);
  }
  return Array.from(byMls.values());
}

async function searchListingUrlFromCurrentSurface(surface: FlexSurface, mlsNumber: string) {
  const body = await surfaceBodyText(surface);
  if (!body.includes(mlsNumber)) return "";

  const result = await surface.evaluate((targetMls) => {
    const anchors = Array.from(document.querySelectorAll("a"));
    const candidates: string[] = [];

    for (const anchor of anchors) {
      const text = (anchor.textContent || "").replace(/\s+/g, " ").trim();
      const href = anchor.getAttribute("href") || "";
      const onclick = anchor.getAttribute("onclick") || "";
      const outer = (anchor as HTMLElement).outerHTML || "";
      if (
        text.includes(targetMls) ||
        href.includes(targetMls) ||
        onclick.includes(targetMls) ||
        outer.includes(targetMls)
      ) {
        candidates.push(href, onclick, outer);
      }
    }

    const patterns = [
      /https?:\/\/[^"'\\s<>]+/i,
      /\/cgi-bin\/mainmenu\.cgi[^"'\\s<>]*/i,
      /cgi-bin\/mainmenu\.cgi[^"'\\s<>]*/i,
    ];

    for (const raw of candidates) {
      const value = String(raw || "").replace(/&amp;/g, "&").trim();
      if (!value) continue;
      for (const pattern of patterns) {
        const match = value.match(pattern);
        if (!match) continue;
        try {
          return new URL(match[0], window.location.href).toString();
        } catch {
          continue;
        }
      }
    }

    return "";
  }, mlsNumber);

  return typeof result === "string" ? result : "";
}

async function extractPermalinkFromShareMenu(page: Page, mlsNumber = "", expectedAddress = "") {
  const shareDropdown = page.locator("#share-listings-dropdown").first();
  const shareButton = page
    .locator('#share-listings-dropdown .dropdown-trigger, #share-listings-dropdown a[title="Share listing(s)"], button:has-text("Share"), a:has-text("Share"), [role="button"]:has-text("Share")')
    .first();
  if (!(await shareButton.isVisible().catch(() => false))) return "";

  const dropdownOpenBefore = await shareDropdown.getAttribute("class").catch(() => "");
  if (!String(dropdownOpenBefore || "").includes("open")) {
    await shareButton.click({ force: true }).catch(() => {});
  }
  await page.waitForTimeout(500);

  // The share/permalink modal is a page-level singleton: #permalinkinput keeps
  // the PREVIOUS listing's URL. Clear it before regenerating so a stale value
  // can never be read for the current listing.
  const permalinkInput = page.locator("#permalinkinput").first();
  await permalinkInput.evaluate((el) => { (el as HTMLInputElement).value = ""; }).catch(() => {});

  const permalinkOption = page
    .locator('#share-listings-dropdown .dropdown-menu li a')
    .filter({ hasText: "Permalink" })
    .first();
  if (!(await permalinkOption.isVisible().catch(() => false))) return "";

  await permalinkOption.click({ force: true }).catch(async () => {
    await permalinkOption.evaluate((el) => {
      const target = el as HTMLElement;
      target.click();
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    }).catch(() => {});
  });
  await page.waitForTimeout(700);

  const permalinkRow = page.locator("#permalinkrow").first();
  await permalinkRow.waitFor({ state: "visible", timeout: 2500 }).catch(() => {});
  await permalinkInput.waitFor({ state: "visible", timeout: 2500 }).catch(() => {});

  // Only trust the specific permalink field / link. The previous broad fallbacks
  // (any `.modal`/`[role=dialog]`/first `input[type=text]`, plus a page-wide
  // body regex) could latch onto an unrelated or stale URL.
  const candidates: string[] = [];
  for (const locator of [
    permalinkInput,
    page.locator('input[value*="flexmls.com/share/"]').first(),
  ]) {
    if (!(await locator.isVisible().catch(() => false))) continue;
    const value = await locator.inputValue().catch(async () =>
      await locator.evaluate((el) => (el as HTMLInputElement).value || "").catch(() => ""),
    );
    if (value) candidates.push(value.trim());
  }
  const permalinkHref = await page.locator("#permalinklink").getAttribute("href").catch(() => "");
  if (permalinkHref) candidates.push(permalinkHref.trim());

  for (const candidate of candidates) {
    if (!candidate.includes("flexmls.com/share/")) continue;

    // Guard against the stale-singleton bug: the share URL embeds the address
    // slug, so reject any permalink whose street number doesn't match this
    // listing. A missing link is recoverable via healing; a wrong link silently
    // mislabels the eval.
    if (expectedAddress && !permalinkMatchesAddress(candidate, expectedAddress)) {
      await logLine(
        `mls watcher: rejected mismatched permalink mls=${mlsNumber || "unknown"} expected="${expectedAddress}" got=${candidate}`,
      );
      continue;
    }

    if (stopAfterPermalink) {
      const mhtmlPath = await exportPageMhtml(page, `${mlsNumber || "unknown"}-permalink-open`).catch(() => "");
      await saveState({
        mode: "paused_permalink",
        loggedIn: await looksLoggedIn(page),
        url: page.url(),
        reason: "FLEXMLS_STOP_AFTER_PERMALINK enabled",
        mlsNumber,
        permalink: candidate,
        mhtmlPath,
      });
      if (mhtmlPath) {
        await logLine(`mls watcher: saved permalink-open MHTML to ${mhtmlPath}`);
      }
      throw new Error(`Stopped at permalink for MLS ${mlsNumber || "unknown"}.`);
    }
    return candidate;
  }

  return "";
}

function collapseWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripHtmlTags(value: string) {
  return decodeHtmlEntities(
    value
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/div>/gi, " ")
      .replace(/<div[^>]*>/gi, " ")
      .replace(/<\/p>/gi, " ")
      .replace(/<p[^>]*>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  );
}

function extractReportFieldFromHtml(html: string, ...labels: string[]) {
  for (const label of labels) {
    const escaped = escapeRegExp(label);
    const patterns = [
      new RegExp(`<strong>(?:<[^>]+>|\\s|&nbsp;)*${escaped}(?:<[^>]+>|\\s|&nbsp;|:)*<\\/strong>\\s*<\\/td>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>`, "i"),
      new RegExp(`<strong>(?:<[^>]+>|\\s|&nbsp;)*${escaped}(?:<[^>]+>|\\s|&nbsp;|:)*<\\/strong>\\s*([\\s\\S]{0,5000}?)(?=(?:<strong>(?:<[^>]+>|\\s|&nbsp;)*[A-Za-z][^<]{0,120}:)|<table|<\\/td>|<\\/tr>)`, "i"),
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      const value = collapseWhitespace(stripHtmlTags(match?.[1] || ""));
      if (value) return value;
    }
  }
  return "";
}


function extractReportHeaderIdentityFromHtml(html: string) {
  const headerCandidates = Array.from(html.matchAll(/<td[^>]*text-align:\s*center[^>]*>([\s\S]*?)<\/td>/gi))
    .map((match) => collapseWhitespace(stripHtmlTags(match[1] || "")))
    .filter(Boolean);
  const headerText = headerCandidates.find((value) => /MLS#:/i.test(value)) || "";
  const listingId = headerText.match(/MLS#:\s*([A-Za-z0-9-]+)/i)?.[1]?.trim() || "";
  const beforeStatus = collapseWhitespace(headerText.split(/\b(?:Residential\s+Active|Residential\s+Pending|Active\s+Under\s+Contract|Active|Pending|Closed)\b/i)[0] || "");
  const cityStateZipMatch = beforeStatus.match(/(.+?)\s+([A-Za-z .'-]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  const cityStateZip = cityStateZipMatch ? `${cityStateZipMatch[2].trim()}, ${cityStateZipMatch[3]} ${cityStateZipMatch[4]}` : "";
  const streetAddress = cityStateZipMatch ? collapseWhitespace(cityStateZipMatch[1].replace(/[,-]\s*$/, "")) : "";
  return {
    listingId,
    streetAddress,
    city: cityStateZipMatch?.[2]?.trim() || "",
    state: cityStateZipMatch?.[3]?.trim() || "",
    zip: cityStateZipMatch?.[4]?.trim() || "",
    address: [streetAddress, cityStateZip].filter(Boolean).join(", "),
  };
}

function extractReportPhotoUrlsFromHtml(html: string) {
  const matches = Array.from(html.matchAll(/https:\/\/cdn\d+\.photos\.sparkplatform\.com\/[^"'\s>]+/gi));
  const unique = new Set<string>();
  for (const match of matches) {
    const value = decodeHtmlEntities(match[0] || "").trim();
    if (value) unique.add(value);
  }
  return Array.from(unique).slice(0, 12);
}

function extractReportHeaderPriceFromHtml(html: string) {
  const match = html.match(/Latest Price:\s*<\/span>\s*\$?([\d,]+)/i)
    || html.match(/Last List Price:\s*\$?([\d,]+)/i)
    || html.match(/Original List Price:\s*\$?([\d,]+)/i);
  return match?.[1] ? `$${match[1]}` : "";
}

function extractMapCoordinatesFromHtml(html: string) {
  const match = html.match(/markers=([-\d.]+)%2C([-\d.]+)%2C/i) || html.match(/markers=([-\d.]+),([-\d.]+),/i);
  return {
    longitude: toNumber(match?.[1]),
    latitude: toNumber(match?.[2]),
  };
}

function normalizeNightlyRentalAllowed(raw: string) {
  const value = collapseWhitespace(raw).toLowerCase();
  if (!value) return "";
  if (["yes", "y", "true", "allowed", "approved", "permitted"].includes(value)) return "Yes";
  if (["no", "n", "false", "not allowed", "not approved", "not permitted", "prohibited"].includes(value)) return "No";
  return raw.trim();
}

function normalizeDetailFieldLabel(raw: string) {
  return collapseWhitespace(raw).toLowerCase().replace(/[:\s]+$/g, "");
}

function nightlyRentalAllowedStatus(raw: string) {
  const value = normalizeNightlyRentalAllowed(raw).toLowerCase();
  if (value === "yes") return "approved" as const;
  if (value === "no") return "rejected" as const;
  return "unknown" as const;
}

function extractNightlyRentalAllowedFromText(text: string) {
  const collapsed = collapseWhitespace(text);
  if (!collapsed.toLowerCase().includes("nightly rental allowed")) return "";

  const directMatch = collapsed.match(/Nightly Rental Allowed\s*(?::|-)?\s*(Yes|No|Y|N|True|False|Allowed|Not Allowed|Approved|Not Approved|Permitted|Not Permitted)\b/i);
  if (directMatch?.[1]) {
    return normalizeNightlyRentalAllowed(directMatch[1]);
  }

  const nearbyMatch = collapsed.match(/Nightly Rental Allowed(.{0,80}?)(Yes|No|Y|N|True|False|Allowed|Not Allowed|Approved|Not Approved|Permitted|Not Permitted)\b/i);
  if (nearbyMatch?.[2]) {
    return normalizeNightlyRentalAllowed(nearbyMatch[2]);
  }

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/Nightly Rental Allowed/i.test(line)) continue;

    const inline = line.match(/Nightly Rental Allowed\s*(?::|-)?\s*(.+)$/i);
    if (inline?.[1]) {
      const normalized = normalizeNightlyRentalAllowed(inline[1]);
      if (normalized) return normalized;
    }

    const nextLine = lines[index + 1] || "";
    const normalizedNext = normalizeNightlyRentalAllowed(nextLine);
    if (normalizedNext) return normalizedNext;
  }

  return "";
}

async function collectSurfaceTexts(surface: Page | Frame) {
  const texts: string[] = [];
  const pushText = (value: string | null | undefined) => {
    const normalized = collapseWhitespace(value || "");
    if (normalized && !texts.includes(normalized)) texts.push(normalized);
  };

  pushText(await surface.locator("body").innerText().catch(() => ""));
  pushText(await surface.locator("body").textContent().catch(() => ""));

  const detailFieldTexts = await surface
    .locator(".listing-detail-field-line, .listingDetailFieldLine")
    .evaluateAll((elements) =>
      elements
        .map((element) => (element.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
    )
    .catch(() => [] as string[]);
  for (const fieldText of detailFieldTexts) pushText(fieldText);

  return texts;
}

async function collectPageTexts(page: Page) {
  const texts: string[] = [];
  const seen = new Set<string>();
  const pushUnique = (value: string) => {
    if (value && !seen.has(value)) {
      seen.add(value);
      texts.push(value);
    }
  };

  for (const text of await collectSurfaceTexts(page)) pushUnique(text);
  for (const frame of page.frames()) {
    for (const text of await collectSurfaceTexts(frame)) pushUnique(text);
  }

  return texts;
}

async function collectDetailFieldMap(surface: Page | Frame) {
  const entries = await surface
    .locator(".listing-detail-field-line, .listingDetailFieldLine")
    .evaluateAll((elements) =>
      elements
        .map((element) => {
          const labelEl = element.querySelector(".listing-detail-field-label");
          const label = (labelEl?.textContent || "").replace(/\s+/g, " ").trim().toLowerCase().replace(/[:\s]+$/g, "");
          const valueParts = Array.from(element.childNodes)
            .filter((node) => node !== labelEl)
            .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
            .filter(Boolean);
          const value = valueParts.join(" ").trim();
          return label ? { label, value } : null;
        })
        .filter((entry): entry is { label: string; value: string } => Boolean(entry?.label))
    )
    .catch(() => [] as Array<{ label: string; value: string }>);

  const map = new Map<string, string>();
  for (const entry of entries) {
    if (entry.value && !map.has(entry.label)) map.set(entry.label, entry.value);
  }
  return map;
}

async function collectReportFieldMap(surface: Page | Frame) {
  const entries = await surface
    .locator("tr")
    .evaluateAll((rows) =>
      rows
        .map((row) => {
          const cells = Array.from(row.querySelectorAll("td"));
          if (cells.length < 2) return null;
          const label = (cells[0]?.textContent || "").replace(/\s+/g, " ").trim().toLowerCase().replace(/[:\s]+$/g, "");
          const value = (cells[1]?.textContent || "").replace(/\s+/g, " ").trim();
          return label && value ? { label, value } : null;
        })
        .filter((entry): entry is { label: string; value: string } => Boolean(entry?.label && entry?.value))
    )
    .catch(() => [] as Array<{ label: string; value: string }>);

  const map = new Map<string, string>();
  for (const entry of entries) {
    if (entry.value && !map.has(entry.label)) map.set(entry.label, entry.value);
  }
  return map;
}

function normalizeRelativeOpenHouseDate(raw: string) {
  const value = collapseWhitespace(raw);
  if (!value) return "";
  const lower = value.toLowerCase();
  const now = new Date();
  if (lower.startsWith("today")) {
    return now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  }
  if (lower.startsWith("tomorrow")) {
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    return tomorrow.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  }
  return value;
}

function extractOpenHouseDateAndTime(raw: string) {
  const value = collapseWhitespace(raw);
  if (!value) return { date: "", time: "" };
  const tomorrowMatch = value.match(/^(Today|Tomorrow),?\s*(.+)$/i);
  if (tomorrowMatch) {
    return {
      date: normalizeRelativeOpenHouseDate(tomorrowMatch[1]),
      time: collapseWhitespace(tomorrowMatch[2]),
    };
  }

  const fullMatch = value.match(/^([A-Za-z]+,\s+[A-Za-z]+\s+\d{1,2}(?:\s+\d{4})?)(?:,\s*|\s+)(.+)$/);
  if (fullMatch) {
    return {
      date: collapseWhitespace(fullMatch[1]),
      time: collapseWhitespace(fullMatch[2]),
    };
  }

  return { date: value, time: "" };
}

async function collectDetailOpenHouses(surface: Page | Frame) {
  return await surface
    .locator(".panel.panel-default")
    .evaluateAll((elements) =>
      elements
        .map((element) => {
          const timeEl = element.querySelector(".listing-detail-event-time");
          if (!timeEl) return null;
          const rawTime = (timeEl.textContent || "").replace(/\s+/g, " ").trim();
          const lines = Array.from(element.querySelectorAll(".oh-additional p"))
            .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
            .filter(Boolean);
          const hostedByLine = lines.find((line) => /^Hosted By:/i.test(line)) || "";
          const hostedBy = hostedByLine.replace(/^Hosted By:\s*/i, "").trim();
          return {
            rawTime,
            hostedBy,
          };
        })
        .filter((entry): entry is { rawTime: string; hostedBy: string } => Boolean(entry?.rawTime))
    )
    .then((entries) =>
      entries
        .map((entry) => {
          const parsed = extractOpenHouseDateAndTime(entry.rawTime);
          return {
            date: parsed.date,
            time: parsed.time,
            hostedBy: entry.hostedBy,
          };
        })
        .filter((entry) => entry.date || entry.time || entry.hostedBy)
    )
    .catch(() => [] as OpenHouseEntry[]);
}

async function tryOpenListingDetailView(page: Page) {
  const detailTriggers = [
    page.locator('a:has-text("Detail")').first(),
    page.locator('button:has-text("Detail")').first(),
    page.locator('[role="tab"]:has-text("Detail")').first(),
  ];
  for (const trigger of detailTriggers) {
    if (!(await trigger.isVisible().catch(() => false))) continue;
    await trigger.click({ force: true }).catch(async () => {
      await trigger.dispatchEvent("click").catch(() => {});
    });
    await page.waitForTimeout(1200);
    return true;
  }
  return false;
}

async function trySwitchToParkCityDetailReport(page: Page) {
  return await page.evaluate(() => {
    const select = document.querySelector("#detailreportshidden") as HTMLSelectElement | null;
    if (!select || !select.options?.length) return "";
    const options = Array.from(select.options);
    const preferred =
      options.find((option) => /Park City Detail-Rev22/i.test(option.text)) ||
      options.find((option) => /Park City Detail/i.test(option.text)) ||
      options.find((option) => /Agent Full Report/i.test(option.text));
    if (!preferred) return "";
    select.value = preferred.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return preferred.text || "";
  }).catch(() => "");
}
async function extractMlsListingFromPage(page: Page, fallbackUrl: string): Promise<OnDemandListingScrape> {
  const [html, title] = await Promise.all([
    page.content(),
    page.title().catch(() => ""),
  ]);
  const detailFieldMap = await collectDetailFieldMap(page);
  const reportFieldMap = await collectReportFieldMap(page);
  const fieldMap = new Map<string, string>(detailFieldMap);
  for (const [key, value] of reportFieldMap.entries()) {
    if (value && !fieldMap.has(key)) fieldMap.set(key, value);
  }
  const openHouses = await collectDetailOpenHouses(page);
  const texts = await collectPageTexts(page);

  const embeddedListing = parseEmbeddedJson<Record<string, unknown>>(html, "data-map--ldp-listing")
    || parseEmbeddedJson<Record<string, unknown>>(html, "data-listing");
  const embeddedMedia = parseEmbeddedJson<Record<string, unknown>>(html, "data-map--ldp-listing-native-media");
  const standardFields = (embeddedListing?.StandardFields as Record<string, unknown> | undefined) || {};
  const photoPayload = Array.isArray(embeddedMedia?.Photos) ? embeddedMedia?.Photos as Array<Record<string, unknown>> : [];
  const photoUrls = photoPayload
    .map((photo) => String(photo.Uri1280 || photo.UriLarge || photo.Uri1024 || photo.Uri800 || photo.Uri640 || ""))
    .filter(Boolean)
    .slice(0, 12);

  const headerIdentity = extractReportHeaderIdentityFromHtml(html);
  const headerPrice = extractReportHeaderPriceFromHtml(html);
  const mapCoordinates = extractMapCoordinatesFromHtml(html);
  const city = decodeHtmlEntities(String(embeddedListing?.City || "")).trim() || headerIdentity.city;
  const state = decodeHtmlEntities(String(embeddedListing?.StateOrProvince || "")).trim() || headerIdentity.state;
  const zip = decodeHtmlEntities(String(embeddedListing?.PostalCode || "")).trim() || headerIdentity.zip;
  const streetAddress = decodeHtmlEntities(String(embeddedListing?.StreetAddress || "")).trim() || headerIdentity.streetAddress;
  const address = [streetAddress, city && state && zip ? `${city}, ${state} ${zip}` : [city, state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ") || headerIdentity.address;
  const listingId = String(embeddedListing?.ListingId || "").trim() || headerIdentity.listingId;

  if (!listingId || !address) {
    throw new Error(`Could not extract MLS listing identity from ${fallbackUrl || title || "the page"}.`);
  }

  const exactNightlyRentalAllowed = fieldMap.get(normalizeDetailFieldLabel("Nightly Rental Allowed")) || "";
  const inlineNightlyRentalAllowed = texts.map(extractNightlyRentalAllowedFromText).find(Boolean) || "";
  const nightlyRentalAllowed =
    normalizeNightlyRentalAllowed(exactNightlyRentalAllowed) ||
    inlineNightlyRentalAllowed ||
    normalizeNightlyRentalAllowed(extractReportFieldFromHtml(html, "Nightly Rental Allowed")) ||
    "";
  const nightlyRentalAllowedSource = nightlyRentalAllowed
    ? (exactNightlyRentalAllowed ? "mls_detail_field" : inlineNightlyRentalAllowed ? "mls_detail_text" : "mls_report_html")
    : "";
  const propertyType =
    getFieldValue(fieldMap, "Type", "Property Type") ||
    String(standardFields.PropertyClass || "").trim() ||
    extractReportFieldFromHtml(html, "Type", "Property Type");
  const propertyTypeCode = String(standardFields.PropertyType || "").trim();
  const subtypeCode = getFieldValue(fieldMap, "Subtype", "Sub Type") || extractReportFieldFromHtml(html, "Sub-Type", "Subtype", "Sub Type");
  const description =
    getFieldValue(fieldMap, "Description") ||
    extractMetaContentFromHtml(html, "property", "og:description") ||
    extractReportFieldFromHtml(html, "Remarks - Public", "Public Remarks", "Remarks", "Property Description");

  return {
    source: "mls",
    listingId,
    identifierLabel: "MLS",
    listingSource: "mls_on_demand",
    url: page.url() || fallbackUrl,
    address,
    city,
    state,
    zip,
    price: toNumber(
      embeddedListing?.CurrentPrice ||
      embeddedListing?.ListPrice ||
      getFieldValue(fieldMap, "Current Price", "List Price") ||
      extractReportFieldFromHtml(html, "Latest Price", "Current Price", "List Price") ||
      headerPrice
    ),
    bedrooms: toNumber(
      embeddedListing?.BedsTotal ||
      getFieldValue(fieldMap, "Total Bedrooms", "Beds") ||
      extractReportFieldFromHtml(html, "Total Bedrooms", "Beds")
    ),
    bathrooms: toNumber(
      embeddedListing?.BathsTotal ||
      getFieldValue(fieldMap, "Total Bathrooms", "Total Baths", "Baths") ||
      extractReportFieldFromHtml(html, "Total Bathrooms", "Total Baths", "Baths")
    ),
    squareFootage: toNumber(
      getFieldValue(
        fieldMap,
        "Apx SqFt Total",
        "Apx SqFt Finished",
        "Total Living Area",
        "Total Square Feet",
        "Finished SqFt"
      ) || extractReportFieldFromHtml(
        html,
        "Apx SqFt Total",
        "Apx SqFt Finished",
        "Total Living Area",
        "Total Square Feet",
        "Finished SqFt"
      )
    ),
    propertyType,
    propertyTypeCode,
    subtypeCode,
    area: getFieldValue(fieldMap, "Area") || extractReportFieldFromHtml(html, "Area", "Major Area"),
    subdivision: getFieldValue(fieldMap, "Subdivision") || extractReportFieldFromHtml(html, "Subdivision"),
    nightlyRentalAllowed,
    nightlyRentalAllowedSource,
    strApproved: nightlyRentalAllowed ? nightlyRentalAllowedStatus(nightlyRentalAllowed) === "approved" : undefined,
    photoUrls: photoUrls.length > 0 ? photoUrls : extractReportPhotoUrlsFromHtml(html),
    openHouses,
    description,
    latitude: toNumber(embeddedListing?.Latitude || standardFields.Latitude) || mapCoordinates.latitude,
    longitude: toNumber(embeddedListing?.Longitude || standardFields.Longitude) || mapCoordinates.longitude,
  };
}

async function resolveNightlyRentalAllowed(page: Page, listings: HotSheetListing[]) {
  const next = listings.map((listing) => ({ ...listing }));
  const attempts: EligibilityResolutionAttempt[] = [];
  if (next.length === 0) return { listings: next, attempts };

  const detailPage = await page.context().newPage();
  try {
    for (const listing of next) {
      const attempt: EligibilityResolutionAttempt = {
        mlsNumber: listing.mlsNumber,
        listingUrl: listing.listingUrl || "",
        nightlyRentalAllowed: "",
        approvalStatus: "unknown",
        source: "missing_listing_url",
        pageUrl: "",
      };

      try {
        if (!listing.listingUrl) {
          attempts.push(attempt);
          continue;
        }

        await detailPage.goto(listing.listingUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
        await detailPage.waitForTimeout(2200);
        attempt.pageUrl = detailPage.url();
        await exportNavigationHtml(detailPage, `approval-${listing.mlsNumber}-initial`);

        const initialFieldMap = await collectDetailFieldMap(detailPage);
        const initialOpenHouses = await collectDetailOpenHouses(detailPage);
        if (initialOpenHouses.length > 0) {
          listing.openHouses = initialOpenHouses;
        }

        let texts = await collectPageTexts(detailPage);
        let nightlyRentalAllowed =
          normalizeNightlyRentalAllowed(initialFieldMap.get(normalizeDetailFieldLabel("Nightly Rental Allowed")) || "") ||
          texts.map(extractNightlyRentalAllowedFromText).find(Boolean) || "";
        if (nightlyRentalAllowed) {
          attempt.nightlyRentalAllowed = nightlyRentalAllowed;
          attempt.approvalStatus = nightlyRentalAllowedStatus(nightlyRentalAllowed);
          attempt.source = "permalink_initial";
        }

        if (!nightlyRentalAllowed) {
          const openedDetail = await tryOpenListingDetailView(detailPage);
          if (openedDetail) {
            await exportNavigationHtml(detailPage, `approval-${listing.mlsNumber}-detail-tab`);
            const detailFieldMap = await collectDetailFieldMap(detailPage);
            const detailOpenHouses = await collectDetailOpenHouses(detailPage);
            if (detailOpenHouses.length > 0) {
              listing.openHouses = detailOpenHouses;
            }
            texts = await collectPageTexts(detailPage);
            nightlyRentalAllowed =
              normalizeNightlyRentalAllowed(detailFieldMap.get(normalizeDetailFieldLabel("Nightly Rental Allowed")) || "") ||
              texts.map(extractNightlyRentalAllowedFromText).find(Boolean) || "";
            if (nightlyRentalAllowed) {
              attempt.nightlyRentalAllowed = nightlyRentalAllowed;
              attempt.approvalStatus = nightlyRentalAllowedStatus(nightlyRentalAllowed);
              attempt.source = "permalink_detail_tab";
            }
          }
        }

        if (!nightlyRentalAllowed) {
          const selectedReport = await trySwitchToParkCityDetailReport(detailPage);
          if (selectedReport) {
            await detailPage.waitForTimeout(1800);
            await exportNavigationHtml(detailPage, `approval-${listing.mlsNumber}-report-${selectedReport}`);
            const reportFieldMap = await collectDetailFieldMap(detailPage);
            const reportOpenHouses = await collectDetailOpenHouses(detailPage);
            if (reportOpenHouses.length > 0) {
              listing.openHouses = reportOpenHouses;
            }
            texts = await collectPageTexts(detailPage);
            nightlyRentalAllowed =
              normalizeNightlyRentalAllowed(reportFieldMap.get(normalizeDetailFieldLabel("Nightly Rental Allowed")) || "") ||
              texts.map(extractNightlyRentalAllowedFromText).find(Boolean) || "";
            if (nightlyRentalAllowed) {
              attempt.nightlyRentalAllowed = nightlyRentalAllowed;
              attempt.approvalStatus = nightlyRentalAllowedStatus(nightlyRentalAllowed);
              attempt.source = `permalink_report:${selectedReport}`;
            }
          }
        }

        if (!nightlyRentalAllowed) {
          attempt.mhtmlPath = await exportPageMhtml(detailPage, `${listing.mlsNumber || "unknown"}-nightly-rental-heal`).catch(() => "");
          attempt.source = "nightly_rental_missing";
        }
      } catch (error) {
        attempt.error = error instanceof Error ? error.message : String(error);
        attempt.source = "nightly_rental_error";
      }

      listing.nightlyRentalAllowed = attempt.nightlyRentalAllowed;
      listing.nightlyRentalAllowedSource = attempt.source;
      listing.strApproved = attempt.approvalStatus === "approved" ? true : attempt.approvalStatus === "rejected" ? false : undefined;
      listing.approvalMhtmlPath = attempt.mhtmlPath;
      attempts.push(attempt);
      await logLine(
        `mls watcher: nightly rental check mls=${attempt.mlsNumber} status=${attempt.approvalStatus} value=${attempt.nightlyRentalAllowed || "missing"} source=${attempt.source} pageUrl=${attempt.pageUrl || "none"}${attempt.mhtmlPath ? ` mhtml=${attempt.mhtmlPath}` : ""}${attempt.error ? ` error=${attempt.error}` : ""}`
      );
    }
  } finally {
    await detailPage.close().catch(() => {});
  }

  return { listings: next, attempts };
}

// Best-effort agent email/phone via the FlexMLS business-card popup. Name and
// brokerage already come from the hot-sheet row; this fills the two fields that
// only exist behind showBusinessCard() (AJAX-injected into #buscardinnerds).
// The popup's internal markup is unverified offline, so this degrades quietly:
// any miss leaves email/phone empty and the Slack block falls back gracefully.
async function resolveAgentContacts(surface: FlexSurface, listings: HotSheetListing[]) {
  const targets = listings.filter(
    (listing) => listing.strApproved === true && listing.listingAgentMemberId,
  );
  for (const listing of targets) {
    try {
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
          /* showBusinessCard signature is best-effort; ignore and read whatever rendered */
        }
        const started = Date.now();
        while (Date.now() - started < 3500) {
          const el = document.getElementById("buscardinnerds");
          const text = (el?.textContent || "").replace(/\s+/g, " ").trim();
          if (text && /(@|\d{3})/.test(text)) {
            return { text, html: el?.innerHTML || "" };
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        const el = document.getElementById("buscardinnerds");
        return { text: (el?.textContent || "").replace(/\s+/g, " ").trim(), html: el?.innerHTML || "" };
      }, { memberId: listing.listingAgentMemberId || "", listingTechId: listing.listingRecordTechId || "" }).catch(() => ({ text: "", html: "" }));

      const email = (
        card.html.match(/mailto:([^"'<>\s]+@[^"'<>\s]+)/i)?.[1] ||
        card.text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0] ||
        ""
      ).trim();
      const phone = (card.text.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]\d{4}/)?.[0] || "").trim();
      if (email) listing.listingAgentEmail = email;
      if (phone) listing.listingAgentPhone = phone;
      await logLine(
        `mls watcher: agent card mls=${listing.mlsNumber} member=${listing.listingAgentMemberId} email=${email || "none"} phone=${phone || "none"}`,
      );
    } catch (error) {
      await logLine(
        `mls watcher: agent card failed mls=${listing.mlsNumber} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return listings;
}

async function resolveListingUrlFromHotSheetRow(page: Page, listing: HotSheetListing, hadRowLink = false): Promise<LinkResolutionAttempt> {
  const attempt: LinkResolutionAttempt = {
    mlsNumber: listing.mlsNumber,
    hadRowLink,
    initialSurfaceUrl: "",
    rowSelector: "",
    rowClickTarget: "",
    hasMlsSearch: false,
    chosenSectionSelector: "hotsheet_row_click",
    chosenInputSelector: "",
    searchTrigger: "row_click",
    popupOpened: false,
    popupUrl: "",
    detailFrameUrl: "",
    directUrlAfterSearch: "",
    extractedUrlAfterSearch: "",
    finalUrl: "",
    finalSource: "missing",
    bodySnippet: "",
  };

  try {
    const warmPage = await warmSearchSurface(page);
    let surface = await goToHotSheetNewListings(warmPage);
    const body = await surfaceBodyText(surface);
    attempt.initialSurfaceUrl = surfaceUrl(surface);
    attempt.bodySnippet = body.replace(/\s+/g, " ").slice(0, 240);

    const rowSelectorCandidates = [
      listing.listingRowId,
      listing.listingRecordId ? `row-${listing.listingRecordId}` : "",
    ].filter(Boolean) as string[];

    let row = null as ReturnType<FlexSurface["locator"]> | null;
    for (const rowId of rowSelectorCandidates) {
      const selector = `tr#${rowId}`;
      const candidate = surface.locator(selector).first();
      if (await candidate.isVisible().catch(() => false)) {
        row = candidate;
        attempt.rowSelector = selector;
        break;
      }
    }

    if (!row) {
      const fallbackRow = surface.locator("tr.listing", {
        has: surface.locator(`a#listingNumberAnchor:has-text("${listing.mlsNumber}")`),
      }).first();
      if (await fallbackRow.isVisible().catch(() => false)) {
        row = fallbackRow;
        attempt.rowSelector = `tr.listing[a#listingNumberAnchor=${listing.mlsNumber}]`;
      }
    }

    if (!row) {
      attempt.finalSource = "missing_hotsheet_row";
      return attempt;
    }

    const clickTargets = [
      { label: "selectL_js", selector: "__selectL__" },
      { label: "listing_address_cell", selector: ".column_address, .addressdiv [ls='address']" },
      { label: "listingNumberAnchor", selector: 'a#listingNumberAnchor, a[title="View details"]' },
      { label: "listing_row", selector: "" },
    ];

    for (let pass = 0; pass < 2; pass += 1) {
      for (const target of clickTargets) {
        surface = await goToHotSheetNewListings(warmPage);
        if (!attempt.rowSelector) continue;
        const freshRow = surface.locator(attempt.rowSelector).first();
        if (!(await freshRow.isVisible().catch(() => false))) continue;

        attempt.rowClickTarget = target.label;
        const popupPromise = page.waitForEvent("popup", { timeout: 2500 }).catch(() => null);
        const navPromise = warmPage.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 2500 }).catch(() => null);

        if (target.selector === "__selectL__") {
          if (!listing.listingRecordId) continue;
          const invoked = await surface.evaluate((recordId) => {
            const w = window as unknown as { selectL?: (id: string, multi: boolean) => void };
            if (typeof w.selectL === "function") {
              w.selectL(recordId, false);
              return true;
            }
            return false;
          }, listing.listingRecordId).catch(() => false);
          if (!invoked) continue;
        } else {
          const clickLocator = target.selector ? freshRow.locator(target.selector).first() : freshRow;
          if (!(await clickLocator.isVisible().catch(() => false))) continue;
          await clickLocator.click({ force: true }).catch(async () => {
            await clickLocator.dispatchEvent("click").catch(() => {});
          });
        }

        await warmPage.waitForTimeout(pass === 0 ? 400 : 900);

        const popup = await popupPromise;
        if (popup) {
          attempt.popupOpened = true;
          await popup.waitForLoadState("domcontentloaded").catch(() => {});
          await popup.waitForTimeout(1500);
          await exportNavigationHtml(popup, `listing-popup-${listing.mlsNumber}-${target.label}`);
          const popupPermalink = await extractPermalinkFromShareMenu(popup, listing.mlsNumber, listing.address);
          if (popupPermalink) {
            attempt.finalUrl = popupPermalink;
            attempt.finalSource = "hotsheet_popup_permalink";
            return attempt;
          }
          attempt.popupUrl = popup.url();
        }

        await navPromise;
        await warmPage.waitForTimeout(pass === 0 ? 700 : 1200);
        await exportNavigationHtml(warmPage, `listing-row-${listing.mlsNumber}-${target.label}-pass-${pass + 1}`);

        const selectedRow = warmPage.locator(`${attempt.rowSelector}.selected`).first();
        const rowIsSelected = await selectedRow.isVisible().catch(() => false);
        attempt.rowSelected = rowIsSelected;
        if (!rowIsSelected) {
          continue;
        }

        attempt.shareButtonVisible = await warmPage
          .locator('#share-listings-dropdown .dropdown-trigger, #share-listings-dropdown a[title="Share listing(s)"]')
          .first()
          .isVisible()
          .catch(() => false);

        const permalink = await extractPermalinkFromShareMenu(warmPage, listing.mlsNumber, listing.address);
        attempt.permalinkInputVisible = await warmPage.locator("#permalinkinput").first().isVisible().catch(() => false);
        if (permalink) {
          attempt.finalUrl = permalink;
          attempt.finalSource = "hotsheet_page_permalink";
          return attempt;
        }
      }
    }

    attempt.finalSource = "missing_permalink_after_hotsheet_click";
    const healMhtmlPath = await exportPageMhtml(warmPage, `${listing.mlsNumber || "unknown"}-permalink-heal`).catch(() => "");
    if (healMhtmlPath) {
      attempt.mhtmlPath = healMhtmlPath;
      await logLine(`mls watcher: saved permalink-heal MHTML to ${healMhtmlPath}`);
    }
    if (stopAfterPermalink) {
      await saveState({
        mode: "paused_permalink_failure",
        loggedIn: await looksLoggedIn(warmPage),
        url: warmPage.url(),
        reason: "FLEXMLS_STOP_AFTER_PERMALINK enabled but permalink capture failed",
        mlsNumber: listing.mlsNumber,
        rowSelector: attempt.rowSelector,
        rowClickTarget: attempt.rowClickTarget,
        rowSelected: attempt.rowSelected,
        shareButtonVisible: attempt.shareButtonVisible,
        permalinkInputVisible: attempt.permalinkInputVisible,
        mhtmlPath: attempt.mhtmlPath,
      });
      throw new Error(`Stopped after permalink failure for MLS ${listing.mlsNumber}.`);
    }
    return attempt;
  } catch (error) {
    attempt.error = error instanceof Error ? error.message : String(error);
    if (attempt.error.includes("Stopped at permalink")) {
      attempt.finalSource = "permalink_paused";
    } else {
      attempt.finalSource = "error";
    }
    return attempt;
  }
}

async function resolveListingUrlByMls(page: Page, mlsNumber: string, hadRowLink = false): Promise<LinkResolutionAttempt> {
  const attempt: LinkResolutionAttempt = {
    mlsNumber,
    hadRowLink,
    initialSurfaceUrl: "",
    rowSelector: "",
    rowClickTarget: "",
    hasMlsSearch: false,
    chosenSectionSelector: "",
    chosenInputSelector: "",
    searchTrigger: "",
    popupOpened: false,
    popupUrl: "",
    detailFrameUrl: "",
    directUrlAfterSearch: "",
    extractedUrlAfterSearch: "",
    finalUrl: "",
    finalSource: "missing",
    bodySnippet: "",
  };

  try {
  const warmPage = await warmSearchSurface(page);
  let surface = await findFlexSurface(warmPage);
  let body = await surfaceBodyText(surface);
  attempt.initialSurfaceUrl = surfaceUrl(surface);
  attempt.bodySnippet = body.replace(/\s+/g, " ").slice(0, 240);

  await warmPage.goto(flexmlsMlsNumberSearchUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  await warmPage.waitForTimeout(2500);
  surface = await findFlexSurface(warmPage);
  body = await surfaceBodyText(surface);
  attempt.hasMlsSearch = body.includes("MLS # Search");
  attempt.chosenSectionSelector = "direct_mls_number_search_url";
  attempt.bodySnippet = body.replace(/\s+/g, " ").slice(0, 240);

  if (!attempt.hasMlsSearch) {
    attempt.finalSource = "missing_mls_search_page";
    await warmPage.waitForTimeout(2500);
    return attempt;
  }

  const inputCandidates = [
    { label: "placeholder_mls", selector: 'input[placeholder*="MLS" i]' },
    { label: "aria_mls", selector: 'input[aria-label*="MLS" i]' },
    { label: "name_mls", selector: 'input[name*="mls" i]' },
    { label: "id_mls", selector: 'input[id*="mls" i]' },
    { label: "title_mls", selector: 'input[title*="MLS" i]' },
    { label: "section_search", selector: 'input[type="search"]' },
    { label: "section_text", selector: 'input[type="text"]' },
  ];

  let input = null as ReturnType<FlexSurface["locator"]> | null;
  for (const candidateDef of inputCandidates) {
    const candidate = surface.locator(candidateDef.selector).first();
    if (await candidate.isVisible().catch(() => false)) {
      input = candidate;
      attempt.chosenInputSelector = candidateDef.label;
      break;
    }
  }

  if (!input) {
    attempt.finalSource = "missing_input";
    return attempt;
  }

  await input.fill("").catch(() => {});
  await input.fill(mlsNumber).catch(() => {});

  const popupPromise = page.waitForEvent("popup", { timeout: 4000 }).catch(() => null);
  const searchTriggers = [
    { label: "button_search_text", locator: surface.locator('button:has-text("Search")').first() },
    { label: "input_submit", locator: surface.locator('input[type="submit"]').first() },
    { label: "button_submit", locator: surface.locator('button[type="submit"]').first() },
    { label: "anchor_search_text", locator: surface.locator('a:has-text("Search")').first() },
  ];

  let triggered = false;
  for (const trigger of searchTriggers) {
    if (await trigger.locator.isVisible().catch(() => false)) {
      await trigger.locator.click().catch(() => {});
      attempt.searchTrigger = trigger.label;
      triggered = true;
      break;
    }
  }
  if (!triggered) {
    await input.press("Enter").catch(() => {});
    attempt.searchTrigger = "enter";
  }

  const popup = await popupPromise;
  if (popup) {
    attempt.popupOpened = true;
    await popup.waitForLoadState("domcontentloaded").catch(() => {});
    await popup.waitForTimeout(2000);
    const popupSurface = await findFlexSurface(popup);
    const popupDirectUrl = popup.url();
    attempt.popupUrl = popupDirectUrl;
    if (isMeaningfulFlexUrl(popupDirectUrl) && !popupDirectUrl.endsWith("mainmenu.cgi")) {
      attempt.finalUrl = popupDirectUrl;
      attempt.finalSource = "popup_direct";
      return attempt;
    }
    const popupExtracted = await searchListingUrlFromCurrentSurface(popupSurface, mlsNumber);
    if (isMeaningfulFlexUrl(popupExtracted)) {
      attempt.extractedUrlAfterSearch = popupExtracted;
      attempt.finalUrl = popupExtracted;
      attempt.finalSource = "popup_extracted";
      return attempt;
    }
  }

  await warmPage.waitForTimeout(2500);
  surface = await findFlexSurface(warmPage);

  const directUrl = warmPage.url();
  attempt.directUrlAfterSearch = directUrl;
  if (isMeaningfulFlexUrl(directUrl) && !directUrl.endsWith("mainmenu.cgi")) {
    attempt.finalUrl = directUrl;
    attempt.finalSource = "page_direct";
    return attempt;
  }

  const extracted = await searchListingUrlFromCurrentSurface(surface, mlsNumber);
  attempt.extractedUrlAfterSearch = extracted;
  if (isMeaningfulFlexUrl(extracted)) {
    attempt.finalUrl = extracted;
    attempt.finalSource = "page_extracted";
    return attempt;
  }

  attempt.finalSource = attempt.hasMlsSearch ? "missing_after_search" : "missing_no_mls_search";
  return attempt;
  } catch (error) {
    attempt.error = error instanceof Error ? error.message : String(error);
    attempt.finalSource = "error";
    return attempt;
  }
}

async function resolveMissingListingUrls(page: Page, listings: HotSheetListing[]) {
  const next = listings.map((listing) => ({ ...listing }));
  const targets = next.filter((listing) => !listing.listingUrl);
  const attempts: LinkResolutionAttempt[] = [];

  for (const listing of targets) {
    const rowAttempt = await resolveListingUrlFromHotSheetRow(page, listing, Boolean(listing.listingUrl));
    if (isShutdownCancellation(rowAttempt.error)) {
      break;
    }
    attempts.push(rowAttempt);
    if (rowAttempt.finalUrl) {
      listing.listingUrl = rowAttempt.finalUrl;
      listing.listingUrlSource = `flexmls_row:${rowAttempt.finalSource}`;
    }
    await logLine(
      `mls watcher: link resolution mls=${rowAttempt.mlsNumber} source=${rowAttempt.finalSource} row=${rowAttempt.rowSelector || "none"} rowClick=${rowAttempt.rowClickTarget || "none"} popup=${rowAttempt.popupOpened} popupUrl=${rowAttempt.popupUrl || "none"} final=${rowAttempt.finalUrl || "missing"}${rowAttempt.error ? ` error=${rowAttempt.error}` : ""}`
    );
  }

  await warmSearchSurface(page).catch(() => {});
  return { listings: next, attempts };
}

async function extractHotSheetListings(surface: FlexSurface): Promise<ExtractedHotSheet> {
  return await surface.evaluate(() => {
    const bodyText = document.body.innerText || "";
    if (!bodyText.includes("Results:") && !bodyText.includes("Hot Sheet For") && !bodyText.includes("New Listings (")) {
      return {
        listings: [],
        stats: {
          totalTableRows: 0,
          candidateRows: 0,
          parsedRows: 0,
          parseMissCount: 0,
          parseMissSamples: [],
          missingLinkCount: 0,
          missingLinkSamples: [],
        },
      };
    }

    const rows = Array.from(document.querySelectorAll("tr.listing")) as HTMLElement[];
    const results = [];
    const parseMissSamples: string[] = [];
    const missingLinkSamples: Array<{ text: string; anchorSnippets: string[]; clickableSnippets: string[] }> = [];
    let candidateRows = 0;
    let missingLinkCount = 0;

    for (const row of rows) {
      const text = row.textContent?.replace(/\s+/g, " ").trim() || "";
      const statusCell = row.querySelector(".column_status");
      const markerEl = row.querySelector('[title="New Listing"]');
      const statusText = statusCell?.textContent?.replace(/\s+/g, " ").trim() || "";
      const markerText = markerEl?.textContent?.replace(/\s+/g, " ").trim() || "";
      if (!statusText.includes("Active") || !markerText.includes("New Listing")) continue;
      candidateRows += 1;

      const image = row.querySelector('img[alt="Listing Image"]') as HTMLImageElement | null;
      const photoUrl = image?.currentSrc || image?.src || "";
      const priceText = row.querySelector('span.price[ls="price"], .column_price .price')?.textContent?.replace(/\s+/g, " ").trim() || "";
      const address = row.querySelector('span[ls="address"], .column_address [ls="address"]')?.textContent?.replace(/\s+/g, " ").trim() || "";
      const cityStateZip = row.querySelector('span[ls="csz"]')?.textContent?.replace(/\s+/g, " ").trim() || "";
      const mlsAnchor = row.querySelector('a#listingNumberAnchor, .column_mls a[title="View details"]');
      const actionEl = row.querySelector(".triangle_down_icon_span");
      const mlsNumber =
        actionEl?.getAttribute("list_nbr")?.trim() ||
        mlsAnchor?.textContent?.replace(/\s+/g, " ").trim() ||
        "";
      const area = row.querySelector(".column_userdefined2")?.textContent?.replace(/\s+/g, " ").trim() || "";
      const subdivision = row.querySelector(".column_subdivision")?.textContent?.replace(/\s+/g, " ").trim() || "";
      const propertyTypeCode = row.querySelector(".column_type")?.textContent?.replace(/\s+/g, " ").trim() || "";
      const subtypeCode = row.querySelector(".column_book_sec")?.textContent?.replace(/\s+/g, " ").trim() || "";
      const bedroomsText = row.querySelector(".column_total_br")?.textContent?.replace(/\s+/g, " ").trim() || "";
      const bathroomsText = row.querySelector(".column_total_bath")?.textContent?.replace(/\s+/g, " ").trim() || "";
      const squareFootageText = row.querySelector(".column_total_sqft")?.textContent?.replace(/\s+/g, " ").trim() || "";
      const listingRowId = row.getAttribute("id") || "";
      const listingRecordId = actionEl?.getAttribute("listing") || "";
      const listingMlsBoardId = actionEl?.getAttribute("listing_mls") || "";
      const listingPrefix = actionEl?.getAttribute("prefix") || "";
      const stringCandidates: string[] = [];

      for (const anchor of Array.from(row.querySelectorAll("a"))) {
        const href = anchor.getAttribute("href");
        const onclick = anchor.getAttribute("onclick");
        const outer = (anchor as HTMLElement).outerHTML;
        if (typeof href === "string" && href.trim()) stringCandidates.push(href);
        if (typeof onclick === "string" && onclick.trim()) stringCandidates.push(onclick);
        if (typeof outer === "string" && outer.trim()) stringCandidates.push(outer);
      }

      for (const el of Array.from(row.querySelectorAll("[onclick], [data-url], [data-href], [data-link-to], [data-target-url], [role='link']"))) {
        const href = el.getAttribute("href");
        const onclick = el.getAttribute("onclick");
        const dataUrl = el.getAttribute("data-url");
        const dataHref = el.getAttribute("data-href");
        const dataLinkTo = el.getAttribute("data-link-to");
        const dataTargetUrl = el.getAttribute("data-target-url");
        const datasetUrl = (el as HTMLElement).dataset?.url || "";
        const datasetHref = (el as HTMLElement).dataset?.href || "";
        const datasetLinkTo = (el as HTMLElement).dataset?.linkTo || "";
        const datasetTargetUrl = (el as HTMLElement).dataset?.targetUrl || "";
        const outer = (el as HTMLElement).outerHTML;
        if (typeof href === "string" && href.trim()) stringCandidates.push(href);
        if (typeof onclick === "string" && onclick.trim()) stringCandidates.push(onclick);
        if (typeof dataUrl === "string" && dataUrl.trim()) stringCandidates.push(dataUrl);
        if (typeof dataHref === "string" && dataHref.trim()) stringCandidates.push(dataHref);
        if (typeof dataLinkTo === "string" && dataLinkTo.trim()) stringCandidates.push(dataLinkTo);
        if (typeof dataTargetUrl === "string" && dataTargetUrl.trim()) stringCandidates.push(dataTargetUrl);
        if (datasetUrl.trim()) stringCandidates.push(datasetUrl);
        if (datasetHref.trim()) stringCandidates.push(datasetHref);
        if (datasetLinkTo.trim()) stringCandidates.push(datasetLinkTo);
        if (datasetTargetUrl.trim()) stringCandidates.push(datasetTargetUrl);
        if (typeof outer === "string" && outer.trim()) stringCandidates.push(outer);
      }

      const rowOuter = (row as HTMLElement).outerHTML;
      if (typeof rowOuter === "string" && rowOuter.trim()) stringCandidates.push(rowOuter);

      let listingUrl = "";
      const patterns = [
        /https?:\/\/[^"'\\s<>]+/i,
        /\/cgi-bin\/mainmenu\.cgi[^"'\\s<>]*/i,
        /cgi-bin\/mainmenu\.cgi[^"'\\s<>]*/i,
        /\/openid_rp\/callback[^"'\\s<>]*/i,
      ];
      for (const rawCandidate of stringCandidates) {
        const value = String(rawCandidate || "").replace(/&amp;/g, "&").trim();
        if (!value) continue;
        for (const pattern of patterns) {
          const match = value.match(pattern);
          if (!match) continue;
          let candidate = match[0];
          if (candidate.startsWith("cgi-bin/")) candidate = `/${candidate}`;
          if (!candidate.includes("mainmenu.cgi") && !candidate.includes("cgi-bin/") && !candidate.includes("flexmls.com")) {
            continue;
          }
          try {
            const resolved = new URL(candidate, window.location.href).toString();
            const isBareMainMenu = /\/cgi-bin\/mainmenu\.cgi\/?$/.test(resolved) && !resolved.includes("?");
            listingUrl = isBareMainMenu ? "" : resolved;
          } catch {
            listingUrl = "";
          }
          if (listingUrl) break;
        }
        if (listingUrl) break;
      }

      const rowHasActionableDetail = Boolean(listingRecordId || listingRowId || mlsNumber);
      if (!listingUrl && !rowHasActionableDetail) {
        missingLinkCount += 1;
        if (missingLinkSamples.length < 5) {
          const anchorSnippets: string[] = [];
          const clickableSnippets: string[] = [];
          const anchorElements = Array.from(row.querySelectorAll("a"));
          const clickableElements = Array.from(row.querySelectorAll("[onclick], [data-url], [data-href], [data-link-to], [data-target-url], [role='link']"));
          for (let i = 0; i < anchorElements.length && i < 5; i += 1) {
            anchorSnippets.push((anchorElements[i] as HTMLElement).outerHTML.replace(/\s+/g, " ").slice(0, 220));
          }
          for (let i = 0; i < clickableElements.length && i < 5; i += 1) {
            clickableSnippets.push((clickableElements[i] as HTMLElement).outerHTML.replace(/\s+/g, " ").slice(0, 220));
          }
          missingLinkSamples.push({
            text: text.slice(0, 260),
            anchorSnippets,
            clickableSnippets,
          });
        }
      }

      // Extract open house data from the column_openhouse cell
      const openHouseCell = row.querySelector(".column_openhouse");
      const openHouses: Array<{ date: string; time: string; hostedBy: string }> = [];
      if (openHouseCell) {
        const lines = (openHouseCell instanceof HTMLElement ? openHouseCell.innerText : openHouseCell.textContent || "")
          .split(/\r?\n/)
          .map((line) => line.replace(/\s+/g, " ").trim())
          .filter((line) => line && line !== "\u00a0");
        const chunks: string[][] = [];
        let currentChunk: string[] = [];
        for (const line of lines) {
          if (
            currentChunk.length > 0 &&
            (
              /^(today|tomorrow)\b/i.test(line) ||
              /^[A-Za-z]+,\s+[A-Za-z]+\s+\d{1,2}(?:\s+\d{4})?$/i.test(line)
            )
          ) {
            chunks.push(currentChunk);
            currentChunk = [line];
            continue;
          }
          currentChunk.push(line);
        }
        if (currentChunk.length > 0) chunks.push(currentChunk);

        for (const chunk of chunks) {
          const date = chunk[0] || "";
          const time = chunk.find((line) => /\d{1,2}:\d{2}\s*[AP]M\s*to\s*\d{1,2}:\d{2}\s*[AP]M/i.test(line)) || "";
          const hostedByLine = chunk.find((line) => /^Hosted\s+By:/i.test(line)) || "";
          const hostedBy = hostedByLine.replace(/^Hosted\s+By:\s*/i, "").trim();
          if (date) {
            openHouses.push({
              date,
              time,
              hostedBy,
            });
          }
        }
      }

      const bedrooms = Number(bedroomsText || "0");
      const bathrooms = Number(bathroomsText || "0");
      const squareFootage = Number(squareFootageText.replace(/,/g, "") || "0");
      if (!mlsNumber || !priceText || !address || !cityStateZip) {
        if (parseMissSamples.length < 5) parseMissSamples.push(text.slice(0, 220));
        continue;
      }

      // "Listing Member" column: ordered columnlinks are agent, brokerage, co-agent, co-office.
      // We take the first agent + first brokerage; the agent's member tech id (from the
      // showBusinessCard('<id>') onclick) lets us fetch email/phone from the business card popup.
      let listingAgentName = "";
      let listingBrokerage = "";
      let listingAgentMemberId = "";
      let listingRecordTechId = "";
      const memberCell = row.querySelector(".column_me_tech_id");
      if (memberCell) {
        const links = Array.from(memberCell.querySelectorAll("a.columnlink, a"))
          .map((anchor) => ({
            text: (anchor.textContent || "").replace(/\s+/g, " ").trim(),
            onclick: anchor.getAttribute("onclick") || "",
          }))
          .filter((entry) => entry.text);
        if (links[0]) {
          listingAgentName = links[0].text;
          listingAgentMemberId = (links[0].onclick.match(/showBusinessCard\('([^']+)'/) || [])[1] || "";
          listingRecordTechId = (links[0].onclick.match(/selectL\('([^']+)'/) || [])[1] || "";
        }
        if (links[1]) {
          let brokerage = links[1].text;
          while (/\s*\([^)]*\)\s*$/.test(brokerage)) brokerage = brokerage.replace(/\s*\([^)]*\)\s*$/, "");
          listingBrokerage = brokerage.trim() || links[1].text;
        }
      }

      results.push({
        mlsNumber,
        priceText,
        address,
        cityStateZip,
        openHouses,
        listingRowId,
        listingRecordId,
        listingMlsBoardId,
        listingPrefix,
        listingUrl,
        listingUrlSource: listingUrl ? "flexmls_row" : "missing",
        statusText,
        markerText,
        area,
        subdivision,
        propertyTypeCode,
        subtypeCode,
        bedrooms,
        bathrooms,
        squareFootage,
        photoUrls: photoUrl ? [photoUrl] : [],
        listingAgentName,
        listingBrokerage,
        listingAgentMemberId,
        listingRecordTechId,
      });
    }

    const listings = [] as typeof results;
    for (const row of results) {
      if (row.mlsNumber) listings.push(row);
    }
    const linkSourceCounts: Record<string, number> = {};
    for (const row of listings) {
      const key = row.listingUrl ? row.listingUrlSource || "flexmls_row" : "missing";
      linkSourceCounts[key] = (linkSourceCounts[key] || 0) + 1;
    }
    return {
      listings,
      stats: {
        totalTableRows: rows.length,
        candidateRows,
        parsedRows: listings.length,
        parseMissCount: Math.max(candidateRows - listings.length, 0),
        parseMissSamples,
        missingLinkCount,
        missingLinkSamples,
        linkSourceCounts,
      },
    };
  });
}

async function persistCandidateSkeletons(candidates: HotSheetListing[]) {
  const detectedAt = new Date().toISOString();
  const payload: QueueCandidate[] = candidates.map((candidate) => ({
    mlsNumber: candidate.mlsNumber,
    address: candidate.address,
    cityStateZip: candidate.cityStateZip,
    displayAddress: [candidate.address, candidate.cityStateZip].filter(Boolean).join(', '),
    listingUrl: candidate.listingUrl,
    listingUrlSource: candidate.listingUrlSource,
    nightlyRentalAllowed: candidate.nightlyRentalAllowed,
    nightlyRentalAllowedSource: candidate.nightlyRentalAllowedSource,
    strApproved: candidate.strApproved,
    priceText: candidate.priceText,
    statusText: candidate.statusText,
    markerText: candidate.markerText,
    area: candidate.area,
    subdivision: candidate.subdivision,
    propertyTypeCode: candidate.propertyTypeCode,
    subtypeCode: candidate.subtypeCode,
    bedrooms: candidate.bedrooms,
    bathrooms: candidate.bathrooms,
    squareFootage: candidate.squareFootage,
    photoUrls: candidate.photoUrls || [],
    openHouses: candidate.openHouses || [],
    listingAgentName: candidate.listingAgentName,
    listingAgentEmail: candidate.listingAgentEmail,
    listingAgentPhone: candidate.listingAgentPhone,
    listingBrokerage: candidate.listingBrokerage,
    detectedAt,
    nextStep: "generate_revenue_evaluation",
    slackStatus: "hold_until_evaluation_ready",
  }));
  const existingQueue = await readReviewQueue();
  const merged = new Map<string, QueueCandidate>();
  for (const item of existingQueue) {
    if (!item?.mlsNumber) continue;
    merged.set(item.mlsNumber, item);
  }
  for (const item of payload) {
    merged.set(item.mlsNumber, item);
  }
  const mergedPayload = Array.from(merged.values());
  await writeFile(resolve(inboxDir, "mls-new-candidates.json"), `${JSON.stringify(payload, null, 2)}\n`);
  await writeFile(resolve(inboxDir, "mls-review-queue.json"), `${JSON.stringify(mergedPayload, null, 2)}\n`);
  return {
    newCandidates: payload,
    queueDepth: mergedPayload.length,
  };
}

async function persistLinkHealingQueue(candidates: HotSheetListing[], attempts: Array<LinkResolutionAttempt | EligibilityResolutionAttempt>) {
  const byMls = new Map<string, LinkResolutionAttempt | EligibilityResolutionAttempt>();
  for (const attempt of attempts) {
    byMls.set(attempt.mlsNumber, attempt);
  }

  const payload: LinkHealingCandidate[] = candidates.map((candidate) => {
    const attempt = byMls.get(candidate.mlsNumber);
    const attemptReason = !attempt
      ? ""
      : "finalSource" in attempt
        ? attempt.finalSource
        : attempt.source;
    const attemptMhtml = attempt?.mhtmlPath || "";
    return {
      mlsNumber: candidate.mlsNumber,
      address: candidate.address,
      cityStateZip: candidate.cityStateZip,
      listingUrl: candidate.listingUrl,
      listingUrlSource: candidate.listingUrlSource,
      nightlyRentalAllowed: candidate.nightlyRentalAllowed,
      nightlyRentalAllowedSource: candidate.nightlyRentalAllowedSource,
      strApproved: candidate.strApproved,
      listingRowId: candidate.listingRowId,
      listingRecordId: candidate.listingRecordId,
      listingMlsBoardId: candidate.listingMlsBoardId,
      reason: attemptReason || candidate.nightlyRentalAllowedSource || "missing_permalink_after_hotsheet_click",
      mhtmlPath: candidate.approvalMhtmlPath || attemptMhtml,
      detectedAt: new Date().toISOString(),
    };
  });

  let existing: LinkHealingCandidate[] = [];
  try {
    const raw = await readFile(linkHealingQueueFile, "utf8");
    const parsed = JSON.parse(raw) as LinkHealingCandidate[];
    existing = Array.isArray(parsed) ? parsed : [];
  } catch {
    existing = [];
  }

  const merged = new Map<string, LinkHealingCandidate>();
  for (const item of existing) {
    if (!item?.mlsNumber) continue;
    merged.set(item.mlsNumber, item);
  }
  for (const item of payload) {
    merged.set(item.mlsNumber, item);
  }

  const mergedPayload = Array.from(merged.values());
  await writeFile(linkHealingQueueFile, `${JSON.stringify(mergedPayload, null, 2)}\n`);
  return { count: payload.length, path: linkHealingQueueFile };
}

async function processReviewQueue() {
  const channel = process.env.SLACK_CHANNEL_ID;
  if (!channel) {
    await logLine("mls watcher: skipping queue processor because SLACK_CHANNEL_ID is missing");
    return null;
  }

  const result = spawnSync("npx", ["tsx", "scripts/workflows/process-mls-review-queue.ts", "--channel", channel], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    await logLine(`mls watcher: queue processor failed ${result.stderr || result.stdout || "unknown error"}`);
    return null;
  }

  const output = (result.stdout || "").trim();
  let parsed: Record<string, unknown> | null = null;
  if (output) {
    try {
      parsed = JSON.parse(output) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }
  if (output) {
    await logLine(`mls watcher: queue processor ${output.replace(/\s+/g, " ").slice(0, 1200)}`);
  }
  return parsed;
}

async function warmSearchSurface(page: Page) {
  let activePage: Page = page;

  if (await isPortalHome(activePage)) {
    activePage = (await enterFlexmlsFromPortal(activePage)) || activePage;
    await activePage.waitForTimeout(1500);
    await exportNavigationHtml(activePage, "warm-portal-entry");
  }

  if (!(await looksLoggedIn(activePage)) && (await isPortalHome(activePage))) {
    await logLine(`mls watcher: portal session live but not inside FlexMLS, going direct to ${flexmlsOpenIdUrl}`);
    await activePage.goto(flexmlsOpenIdUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    await activePage.waitForTimeout(2500);
    await exportNavigationHtml(activePage, "warm-openid-url");
  }

  const surface = await findFlexSurface(activePage);
  const body = await surfaceBodyText(surface);
  const needsDashboardJump = !body.includes("QuickLaunch") && !body.includes("Results:") && !body.includes("Change Search Template") && !body.includes("Hot Sheet For") && !body.includes("New Listings (");
  if (needsDashboardJump) {
    if (shuttingDown) return activePage;
    if (stopAfterStep4) {
      const mhtmlPath = await exportPageMhtml(activePage, "step4-pre-dashboard").catch(() => "");
      await saveState({
        mode: "paused_step_4",
        loggedIn: await looksLoggedIn(activePage),
        url: activePage.url(),
        reason: "FLEXMLS_STOP_AFTER_STEP4 enabled",
        mhtmlPath,
      });
      if (mhtmlPath) {
        await logLine(`mls watcher: saved step-4 MHTML to ${mhtmlPath}`);
      }
      await logLine("mls watcher: stopping at step 4 before forcing private dashboard/search view");
      throw new Error("Stopped at step 4 before private dashboard/search view.");
    }
    if (pauseAfterStep4Seconds > 0) {
      await logLine(
        `mls watcher: step-4 pause active for ${pauseAfterStep4Seconds}s before forcing private dashboard/search view`
      );
      await activePage.waitForTimeout(pauseAfterStep4Seconds * 1000);
    }
    await logLine("mls watcher: FlexMLS root loaded without search surface, jumping to private dashboard/search view");
    await activePage.goto(flexmlsDashboardUrl, {
      waitUntil: "domcontentloaded",
    }).catch(() => {});
    await activePage.waitForTimeout(2500);
    await exportNavigationHtml(activePage, "warm-dashboard-url");
  }

  return activePage;
}

async function scanOnce(page: Page) {
  const scanStartedAt = Date.now();
  const loginStartedAt = Date.now();
  await loginIfNeeded(page);
  const loginMs = elapsedMs(loginStartedAt);

  const warmStartedAt = Date.now();
  const activePage = await warmSearchSurface(page);
  const warmMs = elapsedMs(warmStartedAt);

  const hotSheetStartedAt = Date.now();
  const activeForListings = await goToHotSheetNewListings(activePage);
  const hotSheetMs = elapsedMs(hotSheetStartedAt);

  const body = await surfaceBodyText(activeForListings);
  if (stopAfterHotSheet) {
    const mhtmlPath = await exportPageMhtml(activePage, "hotsheet").catch(() => "");
    await saveState({
      mode: "paused_hotsheet",
      loggedIn: await looksLoggedIn(activePage),
      url: surfaceUrl(activeForListings),
      reason: "FLEXMLS_STOP_AFTER_HOTSHEET enabled",
      mhtmlPath,
    });
    if (mhtmlPath) {
      await logLine(`mls watcher: saved hotsheet MHTML to ${mhtmlPath}`);
    }
    await logLine("mls watcher: stopping at hotsheet before extraction");
    throw new Error("Stopped at hotsheet before extraction.");
  }

  const extractStartedAt = Date.now();
  const extracted = await extractHotSheetListings(activeForListings);
  const extractionMs = elapsedMs(extractStartedAt);
  const linkResolutionStartedAt = Date.now();
  const linkResolution = await resolveMissingListingUrls(activePage, extracted.listings);
  const candidates = dedupeListingsByMls(linkResolution.listings);
  const resolvedCandidates = candidates.filter((row) => Boolean(row.listingUrl));
  const unresolvedCandidates = candidates.filter((row) => !row.listingUrl);
  const linkResolutionMs = elapsedMs(linkResolutionStartedAt);
  let healingQueue: { count: number; path: string } | undefined;
  if (unresolvedCandidates.length > 0) {
    healingQueue = await persistLinkHealingQueue(unresolvedCandidates, linkResolution.attempts);
  }

  const dedupeStartedAt = Date.now();
  const knownMls = await existingPostedEvaluationMlsSet();
  const dedupeMs = elapsedMs(dedupeStartedAt);
  const newCandidates = resolvedCandidates.filter((row) => !knownMls.has(row.mlsNumber));

  const eligibilityStartedAt = Date.now();
  const eligibility = await resolveNightlyRentalAllowed(activePage, newCandidates);
  const eligibilityMs = elapsedMs(eligibilityStartedAt);
  const approvedCandidates = eligibility.listings.filter((row) => row.strApproved === true);
  const rejectedCandidates = eligibility.listings.filter((row) => row.strApproved === false);
  const unresolvedEligibilityCandidates = eligibility.listings.filter((row) => row.strApproved == null);
  if (unresolvedEligibilityCandidates.length > 0) {
    healingQueue = await persistLinkHealingQueue(unresolvedEligibilityCandidates, eligibility.attempts);
    await alertUnresolvedApprovalCandidates(unresolvedEligibilityCandidates);
  } else {
    await writeFile(
      approvalAlertStateFile,
      `${JSON.stringify({ updatedAt: new Date().toISOString(), unresolvedMls: [] }, null, 2)}\n`
    );
  }

  // Fill agent email/phone for the listings we'll actually post (name + brokerage
  // are already on the row from extraction). Runs on the still-loaded hot-sheet
  // surface where showBusinessCard() is defined. Best-effort — never blocks the scan.
  await resolveAgentContacts(activeForListings, eligibility.listings).catch(() => eligibility.listings);

  const persistStartedAt = Date.now();
  const queueState = await persistCandidateSkeletons(eligibility.listings);
  const persistMs = elapsedMs(persistStartedAt);

  let queueSummary: Record<string, unknown> | null = null;
  let queueMs = 0;
  if (queueState.queueDepth > 0) {
    const queueStartedAt = Date.now();
    queueSummary = await processReviewQueue();
    queueMs = elapsedMs(queueStartedAt);
  }

  const scanMs = elapsedMs(scanStartedAt);
  const rawMissingLinkCount = extracted.stats.missingLinkCount;
  const rawMissingLinkSamples = extracted.stats.missingLinkSamples;
  const unresolvedLinkCount = unresolvedCandidates.length;
  const timing = {
    loginMs,
    warmMs,
    hotSheetMs,
    extractionMs,
    missingLinkCount: unresolvedLinkCount,
    rawMissingLinkCount,
    eligibilityMs,
    dedupeMs,
    persistMs,
    linkResolutionMs,
    queueMs,
    totalMs: scanMs,
  };
  const resolvedLinkCounts = candidates.reduce<Record<string, number>>((counts, row) => {
    const key = row.listingUrl ? row.listingUrlSource || "flexmls_row" : "missing";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  const summary = {
    mode: "watching",
    loggedIn: await looksLoggedIn(page),
    insideFlexmls: surfaceUrl(activeForListings).includes("pc.flexmls.com") || body.includes("QuickLaunch") || body.includes("MLS # Search") || body.includes("Change Search Template") || body.includes("Hot Sheet For") || body.includes("New Listings ("),
    hasQuickLaunch: body.includes("QuickLaunch"),
    hasResults: body.includes("Results:") || body.includes("Hot Sheet For") || body.includes("New Listings ("),
    url: surfaceUrl(activeForListings),
    totalHotSheetListings: candidates.length,
    resolvedHotSheetListings: resolvedCandidates.length,
    unresolvedHotSheetListings: unresolvedCandidates.length,
    extraction: extracted.stats,
    linkResolution: {
      counts: resolvedLinkCounts,
      unresolvedMls: unresolvedCandidates.map((row) => row.mlsNumber),
      attempts: linkResolution.attempts,
    },
    newCandidateCount: approvedCandidates.length,
    newCandidates: approvedCandidates.slice(0, 10),
    rejectedCandidates: rejectedCandidates.slice(0, 10),
    unresolvedEligibilityCandidates: unresolvedEligibilityCandidates.slice(0, 10),
    healingQueue,
    queueDepth: queueState.queueDepth,
    lastQueueRun: queueSummary || undefined,
    timing,
    twoFactorAlertActive,
  };
  await saveState(summary);
  if (unresolvedLinkCount > 0 || linkResolution.attempts.length > 0) {
    await logLine(
      `mls watcher: link summary rowMissing=${unresolvedLinkCount} rawMissing=${rawMissingLinkCount} counts=${JSON.stringify(resolvedLinkCounts)} unresolved=${JSON.stringify(summary.linkResolution.unresolvedMls)}`
    );
    if (unresolvedLinkCount > 0 && rawMissingLinkSamples.length > 0) {
      await logLine(
        `mls watcher: missing row link sample ${JSON.stringify(rawMissingLinkSamples[0])}`
      );
    }
  }
  if (unresolvedCandidates.length > 0) {
    await logLine(
      `mls watcher: unresolved listings queued for healing ${JSON.stringify(unresolvedCandidates.map((row) => row.mlsNumber))} path=${healingQueue?.path || linkHealingQueueFile}`
    );
  }
  if (unresolvedEligibilityCandidates.length > 0) {
    await logLine(
      `mls watcher: unresolved nightly-rental checks queued for healing ${JSON.stringify(unresolvedEligibilityCandidates.map((row) => row.mlsNumber))} path=${healingQueue?.path || linkHealingQueueFile}`
    );
  }
  if (rejectedCandidates.length > 0) {
    await logLine(
      `mls watcher: nightly rental rejected ${JSON.stringify(rejectedCandidates.map((row) => ({ mlsNumber: row.mlsNumber, nightlyRentalAllowed: row.nightlyRentalAllowed || "" })))}`
    );
  }
  await logLine(
    `mls watcher: heartbeat loggedIn=${summary.loggedIn} url=${summary.url} hotSheet=${summary.totalHotSheetListings} parsed=${extracted.stats.parsedRows}/${extracted.stats.candidateRows} newCandidates=${summary.newCandidateCount} queueDepth=${queueState.queueDepth} timingMs=${JSON.stringify(timing)}`
  );
}

async function sleepWithCommandProcessing(
  mlsContext: BrowserContext,
  page: Page,
  zillowContext: BrowserContext,
  totalMs: number,
) {
  const sliceMs = 2000;
  const startedAt = Date.now();
  while (!shuttingDown && Date.now() - startedAt < totalMs) {
    await processWatcherCommands(mlsContext, page, zillowContext);
    const remainingMs = totalMs - (Date.now() - startedAt);
    if (remainingMs <= 0) break;
    await page.waitForTimeout(Math.min(sliceMs, remainingMs));
  }
}

async function main() {
  await ensureDirs();
  await logLine(
    `mls watcher: starting persistent sessions interval=${intervalSeconds}s mlsBackend=${mlsBrowserBackend} mlsOnDemandBackend=${mlsOnDemandBrowserBackend} zillowBackend=${zillowBrowserBackend} mlsHeadless=${headless} zillowHeadless=${zillowHeadless} scanEnabled=${scanEnabled} scanWindow=${scanWindowStartHour}:00-${scanWindowEndHour}:00MT`,
  );
  const mlsSession = await launchConfiguredPersistentContext({
    backend: mlsBrowserBackend,
    label: "flexmls-watch",
    log: logLine,
    persistentDir: profileDir,
    headless,
    viewport: watcherViewport,
  });
  const context = mlsSession.context;
  const zillowSession = await launchZillowContext();
  const zillowContext = zillowSession.context;
  await hardenZillowContext(zillowContext);

  const page = await getPage(context);
  page.setDefaultTimeout(20000);
  try {
    const zillowPage = await getZillowWarmPage(zillowContext);
    await logLine(`mls watcher: zillow warm page ready url=${zillowPage.url()}`);
    if (zillowBrowserBackend === "browser-run" && zillowSession.sessionId) {
      const targets = await listBrowserRunTargets(zillowSession.sessionId).catch(() => [] as Array<{
        devtoolsFrontendUrl?: string;
        title?: string;
        url?: string;
      }>);
      const liveView =
        targets.find((target) => target.url === zillowPage.url())?.devtoolsFrontendUrl ||
        targets.find((target) => /zillow\.com/i.test(target.url || ""))?.devtoolsFrontendUrl ||
        targets[0]?.devtoolsFrontendUrl;
      if (liveView) {
        await logLine(`mls watcher: zillow browser run live view sessionId=${zillowSession.sessionId} url=${liveView}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logLine(`mls watcher: zillow warm page preflight failed error=${message}`);
  }

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    shuttingDown = true;
    await logLine(`mls watcher: received ${signal}, shutting down`);
    await mlsOnDemandSession?.close().catch(() => {});
    await mlsSession.close().catch(() => {});
    await zillowSession.close().catch(() => {});
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  while (true) {
    try {
      await processWatcherCommands(context, page, zillowContext);
      const now = new Date();
      const withinWindow = isWithinScanWindow(now);
      if (scanEnabled && withinWindow) {
        await scanOnce(page);
        await processWatcherCommands(context, page, zillowContext);
        if (twoFactorAlertActive && (await looksLoggedIn(page))) {
          twoFactorAlertActive = false;
          await postSlackAlert("FlexMLS watcher cleared the 2FA / trusted-device block and is back in the logged-in session.");
        }
      } else {
        if (scanEnabled && !withinWindow) {
          await logLine(
            `mls watcher: outside scan window (MT ${scanWindowStartHour}:00–${scanWindowEndHour}:00, currently MT ${mountainTimeFormatter.format(now)}), skipping scan`,
          );
        }
        await saveState({
          mode: "command_only",
          loggedIn: await looksLoggedIn(page).catch(() => false),
          url: page.url(),
          insideFlexmls: false,
          reason: !scanEnabled
            ? "FLEXMLS_SCAN_ENABLED=false"
            : `outside_scan_window (MT ${scanWindowStartHour}:00-${scanWindowEndHour}:00)`,
        });
      }
    } catch (error) {
      if (isShutdownCancellation(error)) {
        break;
      }
      const message = error instanceof Error ? error.message : String(error);
      await logLine(`mls watcher: error ${message}`);
      await saveState({ error: message, loggedIn: false, url: page.url(), twoFactorAlertActive });
    }
    if (shuttingDown) {
      break;
    }
    try {
      await sleepWithCommandProcessing(context, page, zillowContext, intervalSeconds * 1000);
    } catch (error) {
      if (isShutdownCancellation(error)) {
        break;
      }
      throw error;
    }
  }
}

await main();
