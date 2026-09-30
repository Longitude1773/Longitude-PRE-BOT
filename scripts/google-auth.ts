/**
 * One-time Google sign-in for the open-house tracker.
 *
 * Opens Google's consent page, catches the redirect on a loopback port, and
 * prints the refresh token to paste into .env as GOOGLE_OAUTH_REFRESH_TOKEN.
 * Needs GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET (a "Desktop app"
 * OAuth client) already in .env. Run it on the machine whose .env will hold
 * the token — the Mini, for production.
 *
 *   npx tsx scripts/google-auth.ts           # sign in, print the token
 *   npx tsx scripts/google-auth.ts --check   # verify the stored token + folder access
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";

import { GOOGLE_SCOPES, getDriveFolder } from "./google.ts";

const repoRoot = resolve(import.meta.dirname, "..");
try {
  for (const line of readFileSync(resolve(repoRoot, ".env"), "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0 && !line.trimStart().startsWith("#")) {
      const key = line.slice(0, i).trim();
      if (!process.env[key]) process.env[key] = line.slice(i + 1).trim();
    }
  }
} catch {
  /* env supplied by the environment instead */
}

const DEFAULT_FOLDER_ID = "1bgsLA7dWRvonPFqvUwStyusaUUV5N_3Z";

async function check() {
  const folderId = process.env.OPEN_HOUSE_TRACKER_FOLDER_ID || DEFAULT_FOLDER_ID;
  const folder = await getDriveFolder(folderId);
  console.log(`OK — token works and can see folder "${folder.name}" (${folder.id}).`);
}

async function signIn() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("Add GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to .env first.");
  }

  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}`;

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    // Force a refresh token even if this account consented before.
    prompt: "consent",
  }).toString();

  console.log("\nOpening Google sign-in. If no browser opens, paste this URL into one:\n");
  console.log(authUrl.toString(), "\n");
  spawn("open", [authUrl.toString()], { stdio: "ignore", detached: true }).on("error", () => {});

  const code = await new Promise<string>((done, fail) => {
    server.on("request", (req, res) => {
      const url = new URL(req.url || "/", redirectUri);
      const got = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(got ? "Signed in. You can close this tab and return to the terminal." : `Sign-in failed: ${error || "no code"}`);
      if (got) done(got);
      else if (error) fail(new Error(`Google returned: ${error}`));
    });
  });
  server.close();

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });
  const body = (await res.json()) as { refresh_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.refresh_token) {
    throw new Error(`Token exchange failed: ${body.error || res.status} ${body.error_description || ""}`);
  }

  console.log("Add this line to .env (replace any existing one):\n");
  console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${body.refresh_token}\n`);
  console.log("Then verify with: npx tsx scripts/google-auth.ts --check");
}

(process.argv.includes("--check") ? check() : signIn()).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
