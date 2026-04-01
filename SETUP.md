# Setup Guide

See also: [ARCHITECTURE.md](/Users/spencerlee/projects/str-revenue-bot/ARCHITECTURE.md) for the end-to-end system flow.

## 1. Google Sheets

### Create the Sheet
1. Create a new Google Sheet
2. Create 5 tabs with these exact names and headers:

**Tab: Listings**
Row 1: `MLS #` | `Listing Source` | `Address` | `City` | `Region` | `Price` | `BD` | `BA` | `SqFt` | `Type` | `Amenities (JSON)` | `STR Eligible` | `Status` | `Listing Date` | `Agent` | `Photos (JSON)` | `Lat` | `Lng` | `Scraped At`

**Tab: Evaluations**
Row 1: `Eval ID` | `MLS #` | `Listing Source` | `BD` | `BA` | `Version` | `High Rev` | `Med Rev` | `Low Rev` | `High Occ` | `Med Occ` | `Low Occ` | `High ADR` | `Med ADR` | `Low ADR` | `Status` | `Slack Timestamp` | `PDF Path` | `Created At`

**Tab: Monthly Projections**
Row 1: `Eval ID` | `Month` | `High Rev` | `Med Rev` | `Low Rev` | `High Occ` | `Med Occ` | `Low Occ` | `High ADR` | `Med ADR` | `Low ADR`

**Tab: Comparables**
Row 1: `Eval ID` | `Source` | `Title` | `Address` | `BD` | `BA` | `Revenue` | `Occ Rate` | `ADR` | `Distance (mi)`

**Tab: Adjustments**
Row 1: `Adj ID` | `Eval ID` | `MLS #` | `Timestamp` | `Requested By` | `Request Text` | `Category` | `Prior High` | `Prior Med` | `Prior Low` | `New High` | `New Med` | `New Low` | `Delta %` | `Reasoning`

Use `Listing Source` values:
- `new_listing` for active/new inventory being evaluated
- `closed_deal` for closed MLS sales captured as reference data

### Deploy the Apps Script
1. Open your Google Sheet
2. Go to **Extensions → Apps Script**
3. Delete the default code
4. Paste the contents of `scripts/apps-script.js` from this project
5. Click **Deploy → New deployment**
6. Type: **Web app**
7. Execute as: **Me**
8. Who has access: **Anyone**
9. Click **Deploy**, authorize when prompted
10. Copy the **Web app URL** → put it in your `.env` as `GOOGLE_APPS_SCRIPT_URL`

## 2. Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Name it "STR Evaluator", select your workspace
3. Under **OAuth & Permissions**, add Bot Token Scopes:
   - `chat:write` — Post messages
   - `files:write` — Upload PDFs/images
   - `files:read` — Read file info
   - `channels:history` — Read channel messages (for polling)
   - `groups:history` — Read private channel messages
   - `reactions:read` — Read reactions
4. **Install to Workspace**
5. Copy the **Bot User OAuth Token** (`xoxb-...`)
6. Copy the **Signing Secret**
7. Invite the bot to your target channel: `/invite @STR Evaluator`
8. Get the channel ID (right-click channel → Copy link → the `C...` part)

## 3. API Keys

### AirDNA
- Sign up at [airdna.co](https://www.airdna.co)
- Get an API key from your account settings or contact their sales for API access

### PriceLabs
- Sign up at [pricelabs.co](https://www.pricelabs.co)
- Get API access from your account or contact support

## 4. Environment Variables

Copy `.env.example` to `.env` and fill in all values:
```bash
cp .env.example .env
```

## 5. Install Dependencies

```bash
cd ~/projects/str-revenue-bot
npm install
npx playwright install chromium
```

## 6. Test

```bash
# Test Google Sheets connection
tsx scripts/sheets.ts read "Listings"

# Test sheet writer without writing
tsx scripts/write-sheet-data.ts evaluation data/eval-12601192.json --dry-run

# Test Slack connection
tsx scripts/slack.ts post "$SLACK_CHANNEL_ID" "Hello from STR Bot!"
```

## 7. Schedule the Daily Pipeline

In Claude Code, run:
```
/schedule daily-str-pipeline
```
Set it to run daily at 7:00 AM Mountain Time.

## 8. Start Slack Polling

In Claude Code, run:
```
/loop 5m check-slack-threads
```
This polls Slack threads every 5 minutes for new user messages.
