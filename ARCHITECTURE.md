# Architecture

This service has three layers:

1. Ingest listings from MLS
2. Generate and review revenue evaluations
3. Finalize PDFs and learn from review outcomes

## End-To-End Flow

```text
                        +----------------------+
                        | Park City FlexMLS    |
                        | active + closed data |
                        +----------+-----------+
                                   |
                                   | scrape listing fields
                                   v
                        +----------------------+
                        | Listing extraction   |
                        | source/address/BD/BA |
                        | sqft/type/photos/etc |
                        +----------+-----------+
                                   |
                    +--------------+--------------+
                    |                             |
                    | write listing row           | download photo URLs
                    v                             v
          +----------------------+      +----------------------+
          | Google Sheet         |      | data/images/<mls>/   |
          | Listings             |      | photo-0.jpg ...      |
          +----------------------+      +----------------------+
                                   |
                                   | fetch comp + market inputs
                                   v
                        +----------------------+
                        | Evaluation analysis  |
                        | low / mid / high     |
                        | ADR / occ / monthly  |
                        | comparable set       |
                        +----------+-----------+
                                   |
                                   | save eval JSON
                                   v
                        +----------------------+
                        | data/eval-<mls>.json |
                        +----------+-----------+
                                   |
                                   | write structured rows
                                   v
         +-------------------+  +----------------------+  +------------------+
         | Evaluations       |  | Monthly Projections  |  | Comparables      |
         | 1 row per version |  | 12 rows per version  |  | 1 row per comp   |
         +---------+---------+  +----------+-----------+  +---------+--------+
                   \_______________________|_________________________/
                                           |
                                           | post review message
                                           v
                                +----------------------+
                                | Slack review thread  |
                                +----------+-----------+
                                           |
                         +-----------------+------------------+
                         |                                    |
                         | approve                            | request edits
                         v                                    v
             +----------------------+              +----------------------+
             | generate-pdf.ts      |              | adjustment loop      |
             | render PRE PDF       |              | revise projections   |
             +----------+-----------+              | log rationale        |
                        |                          | create new version   |
                        v                          +----------+-----------+
             +----------------------+                         |
             | data/pdfs/<mls>.pdf  |<------------------------+
             +----------+-----------+
                        |
                        | upload final PDF
                        v
             +----------------------+
             | Slack final PRE      |
             +----------------------+
```

## Script Map

```text
scripts/sheets.ts
  low-level Google Sheets client
  reads / appends / updates / finds rows

scripts/write-sheet-data.ts
  high-level writer
  listing mode:
    JSON -> Listings row
  evaluation mode:
    eval JSON -> Evaluations + Monthly Projections + Comparables

scripts/download-images.ts
  remote image URLs -> local files under data/images/<mls>/

scripts/generate-pdf.ts
  eval JSON + template assets -> final PDF

scripts/slack.ts
  review post / replies / upload final PDF

scripts/workflows/on-demand-request-store.ts
  Supabase-backed single-flight registry for on-demand Zillow/FlexMLS requests
  owns request_key uniqueness, lease ownership, and request lifecycle states
```

## Data Model

### Core files

- `data/eval-<mls>.json`
  Canonical evaluation payload for one listing version.
- `data/images/<mls>/photo-*.jpg`
  Downloaded source images for PDF rendering.
- `data/pdfs/<mls>.pdf`
  Final rendered PRE artifact.

### Google Sheet tabs

- `Listings`
  One row per MLS listing or closed-deal reference.
- `Evaluations`
  One row per evaluation version summary.
- `Monthly Projections`
  Twelve rows per evaluation version.
- `Comparables`
  One row per comp used for that version.
- `Adjustments`
  Human feedback and revision rationale.

### Operational control tables

- `on_demand_requests`
  Canonical registry for explicit listing eval requests.
  Each row is keyed by normalized `request_key`, so equivalent Zillow/FlexMLS URLs collapse to the same work item even across multiple workflow runners.
  Lease fields (`lease_owner`, `lease_expires_at`) provide cross-process single-flight ownership.
  Status is explicit: `queued`, `scraping`, `evaluating`, `posted`, `failed`.

## Review Loop

```text
model prediction v1
  -> reviewer accepts
     -> use as positive example

model prediction v1
  -> reviewer edits numbers
     -> edited version preferred over original
     -> log reason codes in Adjustments

model prediction v1
  -> reviewer rejects / reruns
     -> later chosen version preferred over rejected version
```

This is the basis for a forward-only preference-learning dataset without needing questionable vendor-history training data.

## Current State

Implemented in repo:

- sheet client and schema-aware row writing
- evaluation writer
- image downloading
- PDF generation
- Slack API utility
- live sheet schema with `Listing Source`, `BD`, and `BA`

Intended but still procedural or partially manual:

- fully automated FlexMLS scrape
- automated comp/vendor ingestion
- automatic Slack polling and re-evaluation loop
- preference-model training job

## Operational Model

The clean mental model is:

1. `Ingest`
   Capture listings and media.
2. `Evaluate`
   Build projections, comps, and sheet rows.
3. `Review`
   Human accepts or edits in Slack.
4. `Finalize`
   Render and upload PDF.
5. `Learn`
   Treat approvals and revisions as preference signals for future calibration.

For on-demand evals, there is one more important boundary:

1. `Normalize`
   Reduce the incoming Zillow/FlexMLS URL to a stable `request_key`.
2. `Claim`
   Acquire the unique request row in Supabase.
3. `Scrape`
   Hand the request to the persistent watcher browser.
4. `Evaluate`
   Write listing/eval artifacts and structured rows.
5. `Post`
   Anchor the canonical Slack review thread and mark the request `posted`.
