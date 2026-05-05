import { readFile, rm, writeFile } from "node:fs/promises";
import { chromium, type Browser, type BrowserContext } from "playwright";

export type BrowserBackend = "local" | "browser-run";

type LogFn = (message: string) => void | Promise<void>;

type LaunchBrowserOptions = {
  backend?: string;
  headless?: boolean;
  keepAliveMs?: number;
  label?: string;
  log?: LogFn;
};

type LaunchPersistentContextOptions = LaunchBrowserOptions & {
  persistentDir: string;
  viewport?: { width: number; height: number };
  channel?: string;
  ignoreDefaultArgs?: string[];
  args?: string[];
  browserRunSessionFilePath?: string;
};

export type ManagedBrowserContext = {
  backend: BrowserBackend;
  context: BrowserContext;
  sessionId?: string;
  close: () => Promise<void>;
};

type BrowserRunSessionRecord = {
  browserWSEndpoint: string;
  createdAt: string;
  keepAliveMs: number;
  label?: string;
  sessionId: string;
};

type BrowserRunTarget = {
  devtoolsFrontendUrl?: string;
  id?: string;
  title?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
};

const DEFAULT_BROWSER_RUN_KEEP_ALIVE_MS = 600_000;

function normalizeBackend(value: string | undefined): BrowserBackend {
  const normalized = (value || "local").trim().toLowerCase();
  if (
    normalized === "browser-run" ||
    normalized === "browser_rendering" ||
    normalized === "browser-rendering" ||
    normalized === "cloudflare"
  ) {
    return "browser-run";
  }
  return "local";
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

async function maybeLog(log: LogFn | undefined, message: string) {
  if (!log) return;
  await log(message);
}

function getBrowserRunConfig(keepAliveOverride?: number) {
  const accountId = (
    process.env.CLOUDFLARE_BROWSER_RUN_ACCOUNT_ID ||
    process.env.CF_ACCOUNT_ID ||
    ""
  ).trim();
  const apiToken = (
    process.env.CLOUDFLARE_BROWSER_RUN_API_TOKEN ||
    process.env.CF_API_TOKEN ||
    ""
  ).trim();
  const keepAliveMs = keepAliveOverride || parsePositiveInteger(
    process.env.CLOUDFLARE_BROWSER_RUN_KEEP_ALIVE_MS,
    DEFAULT_BROWSER_RUN_KEEP_ALIVE_MS,
  );

  if (!accountId || !apiToken) {
    throw new Error(
      "Browser Run requires CLOUDFLARE_BROWSER_RUN_ACCOUNT_ID and CLOUDFLARE_BROWSER_RUN_API_TOKEN (or CF_ACCOUNT_ID / CF_API_TOKEN).",
    );
  }

  const baseHttpUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/devtools/browser`;
  return { accountId, apiToken, baseHttpUrl, keepAliveMs };
}

function buildBrowserRunSessionWSEndpoint(accountId: string, sessionId: string) {
  return `wss://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/devtools/browser/${sessionId}`;
}

async function loadBrowserRunSessionRecord(path: string) {
  try {
    return JSON.parse(await readFile(path, "utf8")) as BrowserRunSessionRecord;
  } catch {
    return null;
  }
}

async function deleteBrowserRunSessionRecord(path: string) {
  await rm(path, { force: true }).catch(() => {});
}

async function saveBrowserRunSessionRecord(path: string, record: BrowserRunSessionRecord) {
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
}

async function createBrowserRunSession(options: LaunchBrowserOptions) {
  const { accountId, apiToken, baseHttpUrl, keepAliveMs } = getBrowserRunConfig(options.keepAliveMs);
  const url = `${baseHttpUrl}?${new URLSearchParams({ keep_alive: String(keepAliveMs) }).toString()}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Browser Run session create failed with status ${response.status}.`);
  }
  const payload = await response.json() as {
    sessionId?: string;
    webSocketDebuggerUrl?: string;
  };
  const sessionId = (payload.sessionId || "").trim();
  const browserWSEndpoint = (payload.webSocketDebuggerUrl || "").trim() || buildBrowserRunSessionWSEndpoint(accountId, sessionId);
  if (!sessionId || !browserWSEndpoint) {
    throw new Error("Browser Run session create returned no sessionId or websocket endpoint.");
  }
  return { browserWSEndpoint, keepAliveMs, sessionId };
}

async function connectBrowserRun(options: LaunchBrowserOptions & { browserWSEndpoint?: string }) {
  const { accountId, apiToken, keepAliveMs } = getBrowserRunConfig(options.keepAliveMs);
  const wsEndpoint =
    options.browserWSEndpoint ||
    `wss://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/devtools/browser?${new URLSearchParams({ keep_alive: String(keepAliveMs) }).toString()}`;
  await maybeLog(
    options.log,
    `browser: connecting to Cloudflare Browser Run label=${options.label || "unnamed"} keepAliveMs=${keepAliveMs}`,
  );
  return chromium.connectOverCDP(wsEndpoint, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
    },
  });
}

async function connectBrowserRunWithReuse(options: LaunchPersistentContextOptions) {
  const config = getBrowserRunConfig(options.keepAliveMs);
  const sessionFilePath = options.browserRunSessionFilePath?.trim();
  if (sessionFilePath) {
    const cached = await loadBrowserRunSessionRecord(sessionFilePath);
    if (cached?.sessionId) {
      await maybeLog(
        options.log,
        `browser: attempting to reuse Cloudflare Browser Run session label=${options.label || "unnamed"} sessionId=${cached.sessionId}`,
      );
      try {
        const browser = await connectBrowserRun({
          ...options,
          browserWSEndpoint: cached.browserWSEndpoint || buildBrowserRunSessionWSEndpoint(config.accountId, cached.sessionId),
        });
        return {
          browser,
          sessionId: cached.sessionId,
          reused: true,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await maybeLog(
          options.log,
          `browser: failed to reuse Cloudflare Browser Run session label=${options.label || "unnamed"} sessionId=${cached.sessionId} error=${message}`,
        );
        await deleteBrowserRunSessionRecord(sessionFilePath);
      }
    }
  }

  const created = await createBrowserRunSession(options);
  await maybeLog(
    options.log,
    `browser: created Cloudflare Browser Run session label=${options.label || "unnamed"} sessionId=${created.sessionId}`,
  );
  if (sessionFilePath) {
    await saveBrowserRunSessionRecord(sessionFilePath, {
      browserWSEndpoint: created.browserWSEndpoint,
      createdAt: new Date().toISOString(),
      keepAliveMs: created.keepAliveMs,
      label: options.label,
      sessionId: created.sessionId,
    });
  }
  const browser = await connectBrowserRun({
    ...options,
    browserWSEndpoint: created.browserWSEndpoint,
  });
  return {
    browser,
    sessionId: created.sessionId,
    reused: false,
  };
}

export function getBrowserBackend(override?: string): BrowserBackend {
  return normalizeBackend(override || process.env.BROWSER_BACKEND);
}

export async function launchConfiguredBrowser(options: LaunchBrowserOptions = {}): Promise<Browser> {
  const backend = getBrowserBackend(options.backend);
  if (backend === "browser-run") {
    if (options.headless === false) {
      await maybeLog(options.log, "browser: Browser Run ignores headless=false because the browser is hosted remotely.");
    }
    const created = await createBrowserRunSession(options);
    return connectBrowserRun({
      ...options,
      browserWSEndpoint: created.browserWSEndpoint,
    });
  }
  return chromium.launch({ headless: options.headless ?? true });
}

export async function listBrowserRunTargets(sessionId: string, keepAliveOverride?: number) {
  const { apiToken, baseHttpUrl } = getBrowserRunConfig(keepAliveOverride);
  const response = await fetch(`${baseHttpUrl}/${sessionId}/json/list`, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Browser Run target list failed with status ${response.status}.`);
  }
  return await response.json() as BrowserRunTarget[];
}

export async function launchConfiguredPersistentContext(
  options: LaunchPersistentContextOptions,
): Promise<ManagedBrowserContext> {
  const backend = getBrowserBackend(options.backend);
  if (backend === "browser-run") {
    if (options.channel) {
      await maybeLog(options.log, `browser: ignoring local browser channel=${options.channel} in Browser Run mode.`);
    }
    if (options.ignoreDefaultArgs?.length || options.args?.length) {
      await maybeLog(options.log, "browser: ignoring local Chromium launch args in Browser Run mode.");
    }
    if (options.headless === false) {
      await maybeLog(options.log, "browser: Browser Run ignores headless=false because the browser is hosted remotely.");
    }
    await maybeLog(
      options.log,
      `browser: using session-based Browser Run context for ${options.label || "unnamed"}; local Playwright profile dirs are not reused.`,
    );

    const { browser, sessionId } = await connectBrowserRunWithReuse(options);
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close().catch(() => {});
      throw new Error("Browser Run did not expose a default browser context.");
    }

    const page = context.pages()[0] || await context.newPage();
    if (options.viewport) {
      await page.setViewportSize(options.viewport).catch(() => {});
    }

    return {
      backend,
      context,
      sessionId,
      close: async () => {
        await browser.close();
      },
    };
  }

  const context = await chromium.launchPersistentContext(options.persistentDir, {
    headless: options.headless,
    viewport: options.viewport,
    channel: options.channel,
    ignoreDefaultArgs: options.ignoreDefaultArgs,
    args: options.args,
  });

  return {
    backend,
    context,
    close: async () => {
      await context.close();
    },
  };
}
