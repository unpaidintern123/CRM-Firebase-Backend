# CRM Firestore Backend

This directory contains the Firestore-first backend for the CRM with Firebase Cloud Functions.

## What this migration changes
- Firestore becomes live database for leads and activity logs.
- Frontend remains visually unchanged (existing Apps Script HTML pages).
- Frontend data calls use `apiClient.html` and can hit Cloud Functions.
- Scheduled **`/sync/eod-to-sheets`** exports live Firestore **Leads Data** to Google Sheets (clear + rewrite).
- Scheduled **`/sync/logs-to-sheets`** appends **Follow-up Logs** and **Consultation Booked Logs** to Sheets incrementally (cursors in `config/sheetExportCursors`), with optional full rebuild when repairing.

## Setup
1. Copy env template:
   - `cp .env.example .env`
2. Fill `.env` values (`FIREBASE_PROJECT_ID`, service account, sheet IDs, API token).
3. Install deps:
   - `npm install`
   - `npm --workspace functions install`
4. Deploy functions:
   - `npm run deploy`

## Endpoints
- `GET /health`
- `GET /gas/retriveLeadData`
- `GET /gas/retriveLeadData2`
- `GET /gas/retriveConsData`
- `GET /gas/getCampaignName`
- `POST /gas/checkLogin`
- `POST /gas/newLeadUpload`
- `POST /gas/updateLeadDetails`
- `GET /gas/getLatestWeekEndData` — MIS weekly scores for dashboards
- `GET /gas/checkAndMatchOrder` — order reconciliation from Order Forms sheet
- `GET /dashboard/metrics`
- `PATCH /leads/:leadUniqueId`
- `POST /sync/eod-to-sheets` — **Leads Data** export
- `POST /sync/logs-to-sheets` — log tabs export (incremental or `fullRebuild`)
- `POST /sync/sheet-to-firestore` — sheet → Firestore (supports `skipExisting`)
- `POST /sync/consultation-visited` — visited status from consultation sheets
- `POST /admin/sync-assignees` / `GET /admin/assignment-audit`

All mutating routes expect `x-api-token` when `API_SHARED_TOKEN` is set.

## Scripts
- `npm run migrate` - one-time import from `CRM Clone.xlsx` to Firestore.
- `npm run migrate:users` - import Users sheet into Firestore `users` (bcrypt passwords).
- `npm run sync:order-match` - match Order Forms to Consultation Visited leads.
- `npm run verify:parity` - count/sample parity check.
- `npm run perf:update` - lead update latency probe.
- `npm run export:eod` - manual Leads Data export.
- `npm run export:logs` - manual logs export (`--dry-run`, `--full-rebuild`, `--batch-size=N`).
- `npm run sync:sheet-to-firestore` / `npm run sync:consultation-visited` - CLI runners for scheduled jobs.

Deploy: `npm run deploy:functions` (wraps `npx firebase-tools@latest`). Reauth: `npm run firebase -- login --reauth`.

## Frontend configuration
Set these in **Apps Script Script Properties** (server-side only):
- `CRM_API_BASE_URL` — Cloud Function base URL (no trailing slash)
- `CRM_API_TOKEN` — must match backend `API_SHARED_TOKEN`

When `CRM_API_BASE_URL` is set, `apiClient.html` routes all API calls through `crmApiProxy` in `Code.js` so the token is never sent to the browser.

If `CRM_API_BASE_URL` is empty, the frontend falls back to legacy `google.script.run` / Sheets.

## Detailed documentation
- `docs/01_MIGRATION_CHANGES_LOG.md` - implementation-level migration delta and what changed.
- `docs/02_SYSTEM_END_TO_END_REFERENCE.md` - full end-to-end architecture and file-by-file ownership.
- `docs/03_TRIGGERS_AND_SCHEDULERS_RUNBOOK.md` - trigger/scheduler operations, troubleshooting, and rollback.
- `docs/SHEET_FIRESTORE_SYNC.md` - users/assignment sync operational details.
