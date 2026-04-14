import { enqueueMlsCommand, readMlsState } from "./mls-control.ts";

function argValue(flag: string) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const code = (argValue("--code") || "").trim();
  const submittedBy = (argValue("--by") || "").trim();
  if (!/^\d{4,8}$/.test(code)) {
    throw new Error("Pass a numeric 2FA code with 4-8 digits using --code.");
  }

  const state = await readMlsState();
  const command = await enqueueMlsCommand({
    type: "submit_2fa_code",
    code,
    submittedBy,
  });

  const awaiting2fa = state.mode === "awaiting_2fa" || state.twoFactorAlertActive === true;

  console.log(JSON.stringify({
    ok: true,
    action: "submitted_mls_2fa_code",
    awaiting2fa,
    submittedBy,
    commandId: command.id,
    message: awaiting2fa
      ? "I queued that MLS 2FA code for the persistent watcher. It should try the code on the current FlexMLS session shortly."
      : "I queued the MLS 2FA code, but the watcher does not currently report an active 2FA block.",
  }, null, 2));
}

await main();
