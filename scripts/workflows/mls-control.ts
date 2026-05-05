import { appendFile, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { OnDemandListingScrape } from "./on-demand-listing.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
const inboxDir = resolve(repoRoot, "data/inbox");
export const stateFile = resolve(inboxDir, "mls-watch-state.json");
export const commandFile = resolve(inboxDir, "mls-commands.jsonl");
export const commandResultsFile = resolve(inboxDir, "mls-command-results.jsonl");

export type SubmitMls2faCommand = {
  id: string;
  type: "submit_2fa_code";
  code: string;
  submittedBy?: string;
  createdAt: string;
};

export type ScrapeZillowListingCommand = {
  id: string;
  type: "scrape_zillow_listing";
  url: string;
  requestKey?: string;
  submittedBy?: string;
  createdAt: string;
};

export type ScrapeMlsListingCommand = {
  id: string;
  type: "scrape_mls_listing";
  url: string;
  requestKey?: string;
  submittedBy?: string;
  createdAt: string;
};

export type MlsCommand = SubmitMls2faCommand | ScrapeZillowListingCommand | ScrapeMlsListingCommand;

type SubmitMls2faCommandInput = Omit<SubmitMls2faCommand, "id" | "createdAt">;
type ScrapeZillowListingCommandInput = Omit<ScrapeZillowListingCommand, "id" | "createdAt">;
type ScrapeMlsListingCommandInput = Omit<ScrapeMlsListingCommand, "id" | "createdAt">;

export type MlsCommandResult =
  | {
      commandId: string;
      ok: true;
      action: "submitted_mls_2fa_code";
      createdAt: string;
    }
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

export async function readMlsState() {
  try {
    return JSON.parse(await readFile(stateFile, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function enqueueMlsCommand(command: SubmitMls2faCommandInput): Promise<SubmitMls2faCommand>;
export async function enqueueMlsCommand(command: ScrapeZillowListingCommandInput): Promise<ScrapeZillowListingCommand>;
export async function enqueueMlsCommand(command: ScrapeMlsListingCommandInput): Promise<ScrapeMlsListingCommand>;
export async function enqueueMlsCommand(command: SubmitMls2faCommandInput | ScrapeZillowListingCommandInput | ScrapeMlsListingCommandInput) {
  await mkdir(inboxDir, { recursive: true });
  const base = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    submittedBy: command.submittedBy,
  };
  const full: MlsCommand = command.type === "submit_2fa_code"
    ? { ...base, type: "submit_2fa_code", code: command.code }
    : command.type === "scrape_zillow_listing"
      ? { ...base, type: "scrape_zillow_listing", url: command.url, requestKey: command.requestKey }
      : { ...base, type: "scrape_mls_listing", url: command.url, requestKey: command.requestKey };
  await appendFile(commandFile, `${JSON.stringify(full)}\n`);
  return full;
}

export async function waitForMlsCommandResult(commandId: string, timeoutMs = 180000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const raw = await readFile(commandResultsFile, "utf8");
      const lines = raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const parsed = JSON.parse(lines[index]) as MlsCommandResult;
        if (parsed.commandId === commandId) return parsed;
      }
    } catch {
      // Keep polling.
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 1000));
  }
  return null;
}
