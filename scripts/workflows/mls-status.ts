import { readMlsState } from "./mls-control.ts";

async function main() {
  const state = await readMlsState();
  const awaiting2fa = state.mode === "awaiting_2fa" || state.twoFactorAlertActive === true;

  console.log(JSON.stringify({
    ok: true,
    action: "mls_status",
    watcherMode: state.mode || "unknown",
    awaiting2fa,
    loggedIn: state.loggedIn ?? false,
    url: state.url || "",
    updatedAt: state.updatedAt || "",
    lastFailure: state.lastFailure || state.error || "",
    totalHotSheetListings: state.totalHotSheetListings ?? 0,
    newCandidateCount: state.newCandidateCount ?? 0,
    queueDepth: state.queueDepth ?? 0,
    extraction: state.extraction || {},
    lastQueueRun: state.lastQueueRun || {},
    timing: state.timing || {},
  }, null, 2));
}

await main();
