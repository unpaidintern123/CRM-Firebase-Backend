# CRM Migration Changes Log (Sheets -> Firestore)

This document records the implemented migration changes in this repository, including date normalization fixes and consultation-visited automation.

It is intentionally code-accurate and references only behavior that exists in source files.

---

## 1) High-level migration outcome

- Live CRM reads/updates moved to Firebase Cloud Functions + Firestore.
- Legacy frontend contract preserved through `/gas/*` compatibility endpoints.
- Firestore is now the operational source for leads and activity logs.
- Sheets remains integrated via:
  - inbound sync (`/sync/sheet-to-firestore`)
  - outbound lead export (`/sync/eod-to-sheets`), **Leads Data** only (clear `A2:AO`, rewrite)
  - logs export (`/sync/logs-to-sheets`), **Follow-up Logs** + **Consultation Booked Logs** (incremental append by default)
  - consultation-visited sync (`/sync/consultation-visited`)

---

## 2) New/updated backend entry points

Implemented in `functions/src/index.js`:

- `GET /health`
- Legacy-compatible reads:
  - `GET /gas/retriveLeadData`
  - `GET /gas/retriveLeadData2`
  - `GET /gas/retriveConsData`
  - `GET /gas/getCampaignName`
- Legacy-compatible writes:
  - `POST /gas/checkLogin`
  - `POST /gas/newLeadUpload`
  - `POST /gas/updateLeadDetails`
- Native API:
  - `PATCH /leads/:leadUniqueId`
  - `GET /dashboard/metrics`
- Sync/Admin:
  - `POST /sync/eod-to-sheets`
  - `POST /sync/sheet-to-firestore`
  - `POST /sync/logs-to-sheets` (Follow-up + Consultation log tabs; incremental or full rebuild)
  - `POST /sync/consultation-visited`
  - `POST /admin/sync-assignees`
  - `GET /admin/assignment-audit`

All routes are protected by `x-api-token` when `API_SHARED_TOKEN` is configured.

---

## 3) Firestore lead update behavior (replacement for slow Apps Script update)

Implemented in `functions/src/leadService.js`:

- **`leadDate` is not applied from the update payload** (`delete safePayload.leadDate`) so the UI cannot overwrite a correct lead date with bad values (this was the root cause of `01/01/1970`-style corruption when epoch or serial numbers were sent by mistake).
- Fetches one lead doc by `leadUniqueId`.
- Transactional update of:
  - lead fields
  - follow-up count (`noOfFollowups`)
  - status tracking logs
  - user activity logs
- Creates follow-up log when follow-up date changes.
- Creates consultation log when consultation date changes and consultation status is `New` or `Consultation Re-Booked`.
- Returns compact response (`updatedLead`, `impactedMetrics`) instead of full dataset.

---

## 4) Date normalization fix (1970 issue)

Implemented in `functions/src/sheetDateUtils.js` and wired in three paths:

1. Inbound sync (`sheetInboundSync.js`):
   - `normalizeLeadDatesFromSheet()` converts known date fields from sheets-serial doubles to ISO.
2. Legacy mapper (`mapper.js`):
   - `firestoreDateToDisplayString()` safely converts numeric legacy values for UI payload.
3. EOD export (`sheetsExport.js`):
   - date cells are normalized before writing to Sheets.
4. Logs export (`sheetsExport.js`):
   - `cellDate()` / row builders use the same display-safe date path for exported log rows.

Additional utilities added:
- `scripts/backfill-lead-sheet-serial-dates.mjs` for one-time rewrite of existing Firestore serial dates.

---

## 5) Consultation Visited automation migration

New implementation: `functions/src/consultationVisitedSync.js`

What it does:
- Reads:
  - `Consultation FMS!A7:L`
  - `After Consultation!A2:AG`
- Uses `UNFORMATTED_VALUE` render option.
- Normalizes mobile numbers (handles `.0`, `91`, `00`, leading `0`, and non-digit cleanup).
- Builds candidate map per mobile:
  - FMS candidate date from row index `0` (timestamp)
  - After Consultation candidate date from row index `32` (legacy-equivalent column usage)
  - After rows excluded when:
    - consultation type is `In-person`
    - status is `No Show`
- Chooses latest candidate by timestamp when both sources or duplicates exist.
- Scans Firestore leads with `leadStatus == "Consultation Booked"`.
- Updates all matching booked leads for matched mobile:
  - `leadStatus = "Consultation Visited"`
  - `consutlationVisitedDate`
  - sync metadata (`consultationVisitedSource`, row, syncedAt/by)
- Writes:
  - `leadStatusTracking` entry
  - `userActivityLogs` entry
- Supports `dryRun` and `limit`.

API route:
- `POST /sync/consultation-visited`

CLI runner:
- `scripts/sync-consultation-visited.mjs`

---

## 6) Inbound and outbound sync behavior

### Inbound: `functions/src/sheetInboundSync.js`

- Reads leads sheet range `A:AO`.
- Maps headers with `LEAD_FIELD_MAP` + aliases.
- Dedupe by `leadUniqueId`.
- Optional duplicate-phone warning collection.
- Honors CRM-protected fields during merge (`leadStatus`, `followUpDate`, etc.).
- Supports backend fallback assignment via `config/leadAssignment`.
- **`skipExisting`:** when `true`, rows whose `leadUniqueId` already exists in Firestore are skipped (intended for recurring Cloud Scheduler syncs to avoid timeouts and unnecessary writes).

### Outbound (EOD — Leads Data): `functions/src/sheetsExport.js` (`runEndOfDaySync`)

- Reads leads from Firestore (`getLeads`).
- Writes rows to **Leads Data**:
  - clear range `A2:AO`
  - update from `A2`
- Supports dry run.

### Outbound (logs — Follow-up / Consultation tabs): `functions/src/sheetsExport.js` (`runLogsExportSync`)

- **Default mode: incremental** — reads cursors from Firestore `config/sheetExportCursors`:
  - `followUpLastCreatedAt`
  - `consultationLastCreatedAt`
- For each collection, queries `followUpLogs` / `consultationLogs` with `createdAt` **greater than** the stored cursor, `orderBy("createdAt","asc")`, capped by `batchSize` (default `1000`).
- Joins each log to the current `leads/{leadUniqueId}` snapshot for non-log columns.
- **Appends** rows via Sheets API (does not clear the tab on each run).
- After a successful write, merges updated cursors (max `createdAt` seen in the batch) into `config/sheetExportCursors`.
- **`fullRebuild: true`** — runs `runLogsExportFullRebuild`: reads all logs + leads, **clears** `Follow-up Logs!A2:P` and `Consultation Booked Logs!A2:V`, then **rewrites** (use sparingly; for repair or first-time alignment).
- Sheet names overridable via env: `CRM_FOLLOWUP_LOGS_SHEET_NAME`, `CRM_CONSULTATION_LOGS_SHEET_NAME` (defaults: `Follow-up Logs`, `Consultation Booked Logs`).

API route: `POST /sync/logs-to-sheets` (body validated by `logsExportSyncSchema`).

CLI: `scripts/export-logs-to-sheets.mjs` → `npm run export:logs`.

---

## 7) Schema and validation updates

Updated `functions/src/schema.js`:

- Added `consultationVisitedSyncSchema` for `/sync/consultation-visited` body:
  - `dryRun?: boolean`
  - `limit?: number | null`
  - `triggeredBy?: string`
- Added `logsExportSyncSchema` for `/sync/logs-to-sheets` body:
  - `dryRun?: boolean`
  - `fullRebuild?: boolean` (default `false`)
  - `batchSize?: number` (default `1000`)

Existing schemas remain:
- `leadUpdateSchema`
- `leadsQuerySchema`
- `syncSchema`
- `inboundSyncSchema` (includes `skipExisting` for recurring sheet→Firestore jobs)
- `adminSyncAssigneesSchema`

---

## 8) Script commands available now

From `firebase-backend/package.json`:

- `npm run deploy:functions`
- `npm run migrate`
- `npm run sync:sheet-to-firestore`
- `npm run sync:consultation-visited` (new)
- `npm run export:eod`
- `npm run export:logs` (logs to Sheets; supports `--dry-run`, `--full-rebuild`, `--batch-size`)
- `npm run verify:parity`
- `npm run perf:update`

---

## 9) Environment variables currently used

Core:
- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`
- `API_SHARED_TOKEN`

Sheets:
- `CRM_SYNC_SHEET_ID` / `CRM_SYNC_SPREADSHEET_ID`
- `CRM_LEADS_SHEET_NAME` (optional, defaults to `Leads Data`)
- `CRM_FOLLOWUP_LOGS_SHEET_NAME` (optional, default `Follow-up Logs`)
- `CRM_CONSULTATION_LOGS_SHEET_NAME` (optional, default `Consultation Booked Logs`)
- `CONSULTATION_SYNC_SPREADSHEET_ID` (consultation sync source; falls back to `CRM_SYNC_SHEET_ID`)

Testing/ops:
- `CRM_API_BASE_URL` (for perf script)
- `TEST_LEAD_ID` (for perf script)

---

## 10) Collections actively used by backend

- `leads`
- `followUpLogs`
- `consultationLogs`
- `leadStatusTracking`
- `userActivityLogs`
- `users` (login)
- `config/leadAssignment` (assignment state)
- `config/sheetExportCursors` (logs export incremental cursors)

---

## 11) What was intentionally not changed

- Frontend UI layout/DOM flow remains unchanged.
- Legacy Apps Script pages continue to work via API compatibility routes.
- No direct client Firestore access is enabled (`firestore.rules` denies all).

