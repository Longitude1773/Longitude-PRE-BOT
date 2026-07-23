import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

import { uploadImageToR2 } from "../r2.ts";
import { appendSheetRow, readSheet } from "../sheets.ts";
import { buildListingRow } from "../write-sheet-data.ts";
import {
  acquireOnDemandRequestLease,
  ensureOnDemandRequest,
  readOnDemandRequest,
  releaseOnDemandRequestLease,
  saveOnDemandRequestState,
  type OnDemandRequestCommandType,
} from "./on-demand-request-store.ts";
import {
  asString,
  buildReviewMessage,
  inferEvalPath,
  inferListingPath,
  logSlackEvent,
  readPostedReviewRecord,
  repoRoot,
  resolveEvaluationByMls,
  savePostedReviewRecord,
  updateEvaluationSummaryRow,
  upsertThreadContext,
  writeEvaluationVersion,
} from "./lib.ts";
import { enqueueMlsCommand, readMlsState, waitForMlsCommandResult } from "./mls-control.ts";
import { isFlexMlsUrl, isZillowUrl, normalizeOnDemandRequestKey, type OnDemandListingScrape } from "./on-demand-listing.ts";
import { buildGroundedUnderwriteBundle } from "./underwrite-research.ts";

const watcherCommandTimeoutMs = Number(process.env.ZILLOW_WATCHER_COMMAND_TIMEOUT_MS || "240000");
const onDemandRequestLeaseMs = Number(process.env.ON_DEMAND_REQUEST_LEASE_MS || String(watcherCommandTimeoutMs + 120000));
const onDemandRequestLeasePollMs = Number(process.env.ON_DEMAND_REQUEST_LEASE_POLL_MS || "1000");

function envFlag(name: string, fallback: boolean) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

function argValue(flag: string) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function emitExistingRequestResult(
  requestKey: string,
  channel: string,
  eventPath: string,
  dryRun: boolean,
) {
  const existing = await readOnDemandRequest(requestKey);
  const listingId = asString(existing?.listingId || "");
  if (!listingId) return false;

  const resolved = await resolveEvaluationByMls(listingId).catch(() => null);
  const existingThreadTs = resolved ? asString(resolved.row["Slack Timestamp"]) : asString(existing?.threadTs || "");
  if (existingThreadTs) {
    console.log(JSON.stringify({
      ok: true,
      action: "existing_request",
      listingId,
      threadTs: existingThreadTs,
      evalId: resolved ? asString(resolved.row["Eval ID"]) : asString(existing?.evalId || ""),
      version: resolved ? Number(resolved.row.Version) : Number(existing?.version || 0),
      eventPath,
      dryRun,
    }, null, 2));
    return true;
  }

  const postedRecord = await readPostedReviewRecord(channel, listingId).catch(() => null);
  const recoveredThreadTs = postedRecord ? asString(postedRecord.record.threadTs) : "";
  if (recoveredThreadTs) {
    if (!dryRun && resolved) {
      const nextRow = await updateEvaluationSummaryRow(resolved.row, { Status: "posted", "Slack Timestamp": recoveredThreadTs });
      await upsertThreadContext({
        threadTs: recoveredThreadTs,
        row: nextRow,
        data: resolved.data,
        slackChannelId: channel,
        event: {
          kind: "posted-recovery",
          note: "Recovered existing on-demand review post after waiting on the active request owner to finish.",
          status: "posted",
          version: Number(nextRow.Version),
          eventPath,
        },
      });
      await saveOnDemandRequestState(requestKey, {
        listingId,
        threadTs: recoveredThreadTs,
        evalId: asString(nextRow["Eval ID"]),
        version: Number(nextRow.Version),
        status: "posted",
        eventPath,
      });
    }
    console.log(JSON.stringify({
      ok: true,
      action: "recovered_existing_request",
      listingId,
      threadTs: recoveredThreadTs,
      eventPath,
      dryRun,
    }, null, 2));
    return true;
  }

  return false;
}

async function listingExists(listingId: string) {
  const rows = await readSheet("Listings").catch(() => []);
  return (rows as Array<Record<string, unknown>>).some((row) => asString(row["MLS #"]) === listingId);
}

async function downloadListingImages(listingId: string, photoUrls: string[]) {
  if (photoUrls.length === 0) return [] as string[];
  const result = spawnSync("npx", ["tsx", "scripts/download-images.ts", listingId, JSON.stringify(photoUrls), "1"], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
  });
  if (result.status !== 0) return [] as string[];
  let photos: string[] = [];
  try {
    const parsed = JSON.parse((result.stdout || "[]").trim() || "[]");
    photos = Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string" && value.length > 0) : [];
  } catch {
    photos = [];
  }
  // Mirror the hero photo to the PUBLIC R2 images bucket so the PRE Site can show
  // it at img.longitude.network/<mls>/photo-0.jpg. Best-effort: an image upload
  // failure must NEVER block PRE processing. (Matches the MLS-review-queue path.)
  if (photos.length > 0) {
    try {
      await uploadImageToR2(`${listingId}/photo-0.jpg`, photos[0]);
    } catch (err) {
      console.error(`R2 image upload failed for ${listingId}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return photos;
}

async function main() {
  const url = argValue("--url");
  const channel = argValue("--channel") || process.env.SLACK_CHANNEL_ID;
  const threadTs = argValue("--thread-ts");
  const forcePost = process.argv.includes("--force-post");
  const dryRun = process.argv.includes("--dry-run");
  const enableWebResearch =
    process.argv.includes("--web-research") ||
    (!process.argv.includes("--no-web-research") && envFlag("UNDERWRITE_WEB_RESEARCH_ENABLED", true));

  if (!url) throw new Error("Usage: tsx scripts/workflows/create-zillow-eval.ts --url <listing-url> [--channel <id>] [--thread-ts <ts>] [--force-post] [--web-research|--no-web-research] [--dry-run]");
  if (!channel) throw new Error("Missing --channel or SLACK_CHANNEL_ID.");
  if (!isZillowUrl(url) && !isFlexMlsUrl(url)) throw new Error("Expected a Zillow or FlexMLS listing URL.");
  const isZillowRequest = isZillowUrl(url);
  const commandType: OnDemandRequestCommandType = isZillowRequest ? "scrape_zillow_listing" : "scrape_mls_listing";
  const requestKey = normalizeOnDemandRequestKey(url);

  const eventPath = await logSlackEvent("on-demand-eval-request", {
    url,
    requestKey,
    channel,
    threadTs,
    commandType,
    forcePost,
    enableWebResearch,
    dryRun,
    receivedAt: new Date().toISOString(),
  });

  await ensureOnDemandRequest({
    requestKey,
    sourceUrl: url,
    commandType,
    channel,
    threadTs,
    eventPath,
  });

  const lease = await acquireOnDemandRequestLease({
    requestKey,
    timeoutMs: onDemandRequestLeaseMs,
    leaseMs: onDemandRequestLeaseMs,
    pollMs: onDemandRequestLeasePollMs,
  });

  try {
    await saveOnDemandRequestState(requestKey, {
      sourceUrl: url,
      channel,
      threadTs,
      status: "queued",
      eventPath,
      error: null,
    }, { leaseOwner: lease.leaseOwner });

    if (!forcePost && (await emitExistingRequestResult(requestKey, channel, eventPath, dryRun))) {
      return;
    }

    const watcherState = await readMlsState();
    if (!asString(watcherState.updatedAt)) {
      throw new Error("MLS watcher is not running. Start the STR stack before requesting an on-demand eval.");
    }

    const command = isZillowRequest
      ? await enqueueMlsCommand({ type: "scrape_zillow_listing", url, requestKey })
      : await enqueueMlsCommand({ type: "scrape_mls_listing", url, requestKey });
    await saveOnDemandRequestState(requestKey, {
      commandId: command.id,
      status: "queued",
      eventPath,
    }, { leaseOwner: lease.leaseOwner });
    const result = await waitForMlsCommandResult(command.id, watcherCommandTimeoutMs);
    if (!result) {
      throw new Error(`Timed out waiting for the live watcher browser to scrape the listing. Command ID: ${command.id}`);
    }
    if (result.action !== commandType) {
      throw new Error(`Watcher returned an unexpected command result for the on-demand scrape. Command ID: ${command.id}`);
    }
    if (!result.ok) {
      const paths = [result.htmlPath, result.mhtmlPath].filter(Boolean).join(" | ");
      throw new Error(`${result.error}${paths ? ` Artifacts: ${paths}` : ""}`);
    }

    const scraped: OnDemandListingScrape = result.data;
    const listingId = scraped.source === "zillow" ? `ZPID-${scraped.listingId || safeTimestamp()}` : scraped.listingId || safeTimestamp();
    await saveOnDemandRequestState(requestKey, {
      listingId,
      listingUrl: scraped.url,
      status: "evaluating",
      eventPath,
      error: null,
    }, { leaseOwner: lease.leaseOwner });
    const photoPaths = dryRun ? [] : await downloadListingImages(listingId, scraped.photoUrls);

    const underwrite = await buildGroundedUnderwriteBundle({
      listingId,
      listingSource: scraped.listingSource,
      identifierLabel: scraped.identifierLabel,
      skipMarketGate: true,
      address: scraped.address,
      listingUrl: scraped.url,
      city: scraped.city,
      state: scraped.state,
      zip: scraped.zip,
      price: scraped.price,
      bedrooms: scraped.bedrooms,
      bathrooms: scraped.bathrooms,
      squareFootage: scraped.squareFootage,
      propertyType: scraped.propertyType,
      propertyTypeCode: scraped.propertyTypeCode,
      subtypeCode: scraped.subtypeCode,
      area: scraped.area,
      subdivision: scraped.subdivision,
      nightlyRentalAllowed: scraped.nightlyRentalAllowed,
      nightlyRentalAllowedSource: scraped.nightlyRentalAllowedSource,
      strApproved: scraped.strApproved,
      photoUrls: photoPaths.length > 0 ? photoPaths : scraped.photoUrls,
      openHouses: scraped.openHouses,
      rentZestimate: scraped.rentZestimate,
      description: scraped.description,
      latitude: scraped.latitude,
      longitude: scraped.longitude,
    }, {
      enableWebSearch: enableWebResearch,
      saveReport: !dryRun,
    });

    const listingPath = inferListingPath(listingId);
    const evalPath = inferEvalPath(listingId);

    if (!dryRun) {
      await writeFile(listingPath, `${JSON.stringify(underwrite.listingData, null, 2)}\n`);
      await writeFile(evalPath, `${JSON.stringify(underwrite.evalData, null, 2)}\n`);
    }

    const hasListingRow = await listingExists(listingId);
    if (!hasListingRow && !dryRun) {
      await appendSheetRow("Listings", buildListingRow(underwrite.listingData, { source: scraped.listingSource, status: "Active" }));
    }

    let resolved = await resolveEvaluationByMls(listingId);
    let createdEvalId = "";
    let createdVersion = 0;

    if (!resolved) {
      if (!dryRun) {
        const rows = await writeEvaluationVersion(underwrite.evalData, {
          source: scraped.listingSource,
          status: "pending_review",
          version: "1",
        });
        createdEvalId = asString(rows.evalId);
        createdVersion = 1;
        resolved = await resolveEvaluationByMls(listingId);
      } else {
        createdVersion = 1;
      }
    }

    if (!resolved && !dryRun) {
      throw new Error(`Could not resolve evaluation for ${listingId} after writing sheet rows.`);
    }

    const existingThreadTs = resolved ? asString(resolved.row["Slack Timestamp"]) : "";
    if (existingThreadTs && !forcePost) {
      await saveOnDemandRequestState(requestKey, {
        listingId,
        threadTs: existingThreadTs,
        evalId: resolved ? asString(resolved.row["Eval ID"]) : createdEvalId,
        version: resolved ? Number(resolved.row.Version) : createdVersion,
        status: "posted",
        eventPath,
        error: null,
      }, { leaseOwner: lease.leaseOwner });
      console.log(JSON.stringify({
        ok: true,
        action: "already_posted",
        listingId,
        threadTs: existingThreadTs,
        evalId: resolved ? asString(resolved.row["Eval ID"]) : createdEvalId,
        version: resolved ? Number(resolved.row.Version) : createdVersion,
        eventPath,
        dryRun,
      }, null, 2));
      return;
    }

    const postedRecord = !forcePost ? await readPostedReviewRecord(channel, listingId).catch(() => null) : null;
    const recoveredThreadTs = postedRecord ? asString(postedRecord.record.threadTs) : "";
    if (recoveredThreadTs && !forcePost) {
      if (!dryRun && resolved) {
        const nextRow = await updateEvaluationSummaryRow(resolved.row, { Status: "posted", "Slack Timestamp": recoveredThreadTs });
        await upsertThreadContext({
          threadTs: recoveredThreadTs,
          row: nextRow,
          data: resolved.data,
          slackChannelId: channel,
          event: {
            kind: "posted-recovery",
            note: "Recovered existing on-demand review post from local post ledger.",
            status: "posted",
            version: Number(nextRow.Version),
            eventPath,
          },
        });
        await saveOnDemandRequestState(requestKey, {
          listingId,
          threadTs: recoveredThreadTs,
          evalId: asString(nextRow["Eval ID"]),
          version: Number(nextRow.Version),
          status: "posted",
          eventPath,
          error: null,
        }, { leaseOwner: lease.leaseOwner });
      }
      console.log(JSON.stringify({
        ok: true,
        action: "recovered_existing_post",
        listingId,
        threadTs: recoveredThreadTs,
        eventPath,
        dryRun,
      }, null, 2));
      return;
    }

    let postedThreadTs = existingThreadTs;
    if (!dryRun) {
      const { post, reply } = await import("../slack.ts");
      if (!resolved) {
        throw new Error(`Could not resolve evaluation for ${listingId} before posting to Slack.`);
      }
      const active = resolved;
      const text = await buildReviewMessage(active.data);

      if (threadTs) {
        await reply(channel, threadTs, text);
        postedThreadTs = threadTs;
      } else {
        const result = await post(channel, text);
        postedThreadTs = asString((result as { ts?: string })?.ts || "");
      }

      if (postedThreadTs) {
        await savePostedReviewRecord({
          channel,
          mlsNumber: listingId,
          threadTs: postedThreadTs,
          source: scraped.listingSource,
          eventPath,
          evalId: asString(active.row["Eval ID"]),
          version: Number(active.row.Version),
        });
        await saveOnDemandRequestState(requestKey, {
          listingId,
          threadTs: postedThreadTs,
          evalId: asString(active.row["Eval ID"]),
          version: Number(active.row.Version),
          status: "posted",
          eventPath,
          error: null,
        }, { leaseOwner: lease.leaseOwner });
      }
      const nextRow = await updateEvaluationSummaryRow(active.row, { Status: "posted", "Slack Timestamp": postedThreadTs });
      await upsertThreadContext({
        threadTs: postedThreadTs,
        row: nextRow,
        data: active.data,
        slackChannelId: channel,
        event: {
          kind: "posted",
          note: "Initial on-demand evaluation review posted to Slack.",
          status: "posted",
          version: Number(nextRow.Version),
          eventPath,
        },
      });
    }

    console.log(JSON.stringify({
      ok: true,
      action: existingThreadTs && forcePost ? "reposted" : "posted",
      listingId,
      listingUrl: scraped.url,
      address: scraped.address,
      threadTs: postedThreadTs,
      confidence: underwrite.confidence,
      marketEligible: underwrite.marketEligible,
      marketEligibleReason: underwrite.marketEligibleReason,
      researchPath: underwrite.researchPath || "",
      webResearchResults: underwrite.research.results.length,
      eventPath,
      dryRun,
    }, null, 2));
  } catch (error) {
    await saveOnDemandRequestState(requestKey, {
      status: "failed",
      eventPath,
      error: error instanceof Error ? error.message : String(error),
    }, { leaseOwner: lease.leaseOwner }).catch(() => {});
    throw error;
  } finally {
    await releaseOnDemandRequestLease(requestKey, lease.leaseOwner).catch(() => {});
  }
}

await main();
