# CRM System End-to-End Reference

This is the technical handover doc for new developers/operators.

It explains:
- runtime architecture
- request/data flow
- file-by-file responsibilities
- where to modify logic safely

Scope: `firebase-backend/` and integrated Apps Script behavior that calls the API.

---

## 1) Runtime architecture

### 1.1 Primary runtime

- **Firebase Cloud Functions (2nd gen)** in `asia-south1`
- Single HTTP function: `api`
- Firestore is the primary live datastore

### 1.2 Integrations

- **Google Sheets API** is used by backend for:
  - Sheet -> Firestore inbound sync
  - Firestore -> Sheet export (Leads Data + Logs tabs)
  - consultation-visited status derivation
- **Apps Script frontend** calls backend through `CRM_API_BASE_URL`.
- **Cloud Scheduler** triggers periodic backend sync endpoints.

### 1.3 Security model

- API route guard: `x-api-token` compared with `API_SHARED_TOKEN`.
- Firestore client rules deny direct reads/writes (`allow read, write: if false`).
- Backend service account performs Firestore + Sheets access.

---

## 2) End-to-end data flow

### 2.1 CRM page load and data fetch

1. Browser renders Apps Script HTML.
2. `apiClient.html` selects:
   - backend API if `CRM_API_BASE_URL` exists
   - fallback `google.script.run` otherwise
3. Pages request data via `/gas/*` endpoints.
4. Backend reads Firestore, maps to legacy payload shape with `mapper.js`.

### 2.2 Lead update flow

1. Frontend posts to `/gas/updateLeadDetails` (legacy-compatible path).
2. `leadUpdateSchema` validates payload.
3. `leadService.updateLead()` runs Firestore transaction:
   - updates lead doc (**`leadDate` is stripped from the payload** so it cannot be overwritten by mistaken UI values)
   - follow-up/log/tracking side effects
4. API returns compact structured response (`updatedLead`, metrics).
5. Frontend patches local state (no full reload required in migrated path).

### 2.3 Assignment sync flow

1. Apps Script reads `Users` tab.
2. Posts assignee config to `/admin/sync-assignees`.
3. Backend writes `config/leadAssignment`.
4. Inbound sync fallback assignment reads this config for blank-assignee rows.

### 2.4 Sheet inbound flow

1. Scheduler/manual calls `/sync/sheet-to-firestore`.
2. Backend reads Leads sheet rows.
3. Maps + normalizes + dedupes.
4. Creates/updates Firestore leads with protected merge rules.

### 2.5 Consultation visited flow

1. Scheduler/manual calls `/sync/consultation-visited`.
2. Backend reads `Consultation FMS` and `After Consultation`.
3. Resolves latest candidate per normalized mobile.
4. Converts matching Firestore `Consultation Booked` leads to `Consultation Visited`.
5. Writes status tracking + activity logs.

### 2.6 Export flow

1. Scheduler/manual calls `/sync/eod-to-sheets`.
2. Backend reads Firestore leads.
3. Clears `A2:AO` and writes fresh rows to Leads sheet.

### 2.7 Logs export flow

1. Scheduler/manual calls `POST /sync/logs-to-sheets` (validated by `logsExportSyncSchema`).
2. **Default (`fullRebuild:false`): incremental append**
   - Reads cursors from `config/sheetExportCursors` (`followUpLastCreatedAt`, `consultationLastCreatedAt`).
   - Queries each log collection for documents with `createdAt` greater than the cursor, ordered ascending, capped by `batchSize` (default `1000`).
   - Loads only the `leads` documents needed for those log rows (`loadLeadsByIds`).
   - **Appends** rows to Sheets (`appendRows`): `Follow-up Logs!A:P`, `Consultation Booked Logs!A:V`.
   - Merges new max `createdAt` values back into `config/sheetExportCursors`.
3. **`fullRebuild:true`:** runs `runLogsExportFullRebuild` — loads all logs + leads, **clears** the two tab body ranges, then **rewrites** (repair / initial alignment only).

Runner: `npm run export:logs` (`scripts/export-logs-to-sheets.mjs`). Optional env overrides: `CRM_FOLLOWUP_LOGS_SHEET_NAME`, `CRM_CONSULTATION_LOGS_SHEET_NAME`.

---

## 3) File-by-file reference

## Root files

- `package.json`
  - workspace root scripts for deploy/sync/migration tooling.
- `firebase.json`
  - points functions source to `functions`, attaches firestore rules/indexes.
- `firestore.rules`
  - currently denies all direct Firestore client access.
- `firestore.indexes.json`
  - composite indexes for leads + logs queries.
- `README.md`
  - quick start; high-level overview.

## `functions/src/`

- `index.js`
  - HTTP router, auth token enforcement, endpoint dispatch (`/sync/eod-to-sheets`, `/sync/logs-to-sheets`, `/sync/sheet-to-firestore`, `/sync/consultation-visited`, plus `/gas/*` and `/leads/*`).
- `schema.js`
  - all request body/query validation schemas (`zod`).
- `firebase.js`
  - Firebase Admin app and Firestore singleton initialization.
- `errors.js`
  - typed API error and standardized error response envelope.
- `authService.js`
  - login logic from Firestore `users` collection.
- `leadService.js`
  - core lead CRUD/update business logic and dashboard metrics.
- `mapper.js`
  - legacy field-name mapping and UI payload compatibility transforms.
- `sheetDateUtils.js`
  - date normalization helpers (serial <-> ISO safety).
- `sheetInboundSync.js`
  - Leads sheet ingestion + merge policy + assignment fallback; supports `skipExisting` for lightweight scheduled runs.
- `sheetsExport.js`
  - Firestore -> Sheets exporters:
    - Leads Data (`runEndOfDaySync`) — clear + rewrite `A2:AO`
    - Follow-up Logs + Consultation Booked Logs (`runLogsExportSync`, `runLogsExportFullRebuild`) — incremental append vs full rebuild
- `consultationVisitedSync.js`
  - consultation sheet scanner + visited-status updater.

## `scripts/`

- `migrate-sheets-to-firestore.mjs`
  - one-time XLSX import from `CRM Clone.xlsx`.
- `sync-sheet-to-firestore.mjs`
  - CLI runner for inbound sync.
- `sync-consultation-visited.mjs`
  - CLI runner for consultation visited sync.
- `eod-export-to-sheets.mjs`
  - CLI runner for export.
- `export-logs-to-sheets.mjs`
  - CLI runner for logs export.
- `backfill-lead-sheet-serial-dates.mjs`
  - one-time date cleanup script for existing Firestore docs.
- `verify-parity.mjs`
  - count/sample parity helper vs local workbook.
- `perf-update-lead.mjs`
  - latency probe for PATCH `/leads/:id`.

## `docs/`

- `SHEET_FIRESTORE_SYNC.md`
  - assignment sync operations and runbook for users-tab integration.
- `01_MIGRATION_CHANGES_LOG.md`
  - migration delta log (this release).
- `03_TRIGGERS_AND_SCHEDULERS_RUNBOOK.md`
  - scheduler, triggers, and operational cadence.

---

## 4) Collections and document purpose

- `leads/{leadUniqueId}`
  - primary lead state used by all CRM screens.
- `followUpLogs/{doc}`
  - append-only follow-up events.
- `consultationLogs/{doc}`
  - consultation booking events from update flow.
- `leadStatusTracking/{doc}`
  - status transition audit history.
- `userActivityLogs/{doc}`
  - user/system activity entries.
- `users/{username}`
  - authentication records for login endpoint.
- `config/leadAssignment`
  - active assignee pool and round-robin index.
- `config/sheetExportCursors`
  - last exported `createdAt` per log stream for incremental Sheets log export (`followUpLastCreatedAt`, `consultationLastCreatedAt`, `updatedAt`).

---

## 5) Change points for future developers

### If you need to add a new API endpoint

1. Add schema in `schema.js`.
2. Add service logic in dedicated service file.
3. Wire route in `index.js`.
4. Add script runner if operational.
5. Document endpoint and scheduler impact.

### If you need to modify lead update business logic

- Edit `leadService.updateLead()` only.
- Keep transaction atomic for lead + logs side effects.
- Preserve `idempotencyKey` semantics.

### If you need to change sheet column mapping

- Primary mappings in `mapper.js` + `sheetInboundSync.js` aliases.
- Export row shape in `sheetsExport.js`:
  - `toRow()` for Leads Data
  - `followUpLogToRow()` for Follow-up Logs
  - `consultationLogToRow()` for Consultation Booked Logs
- Keep column order in sync with Leads sheet.

### If you need to change date behavior

- Centralize in `sheetDateUtils.js`.
- Re-test:
  - inbound sync
  - mapper outputs
  - EOD export
  - logs export
  - backfill script

### If you need to change consultation visited policy

- Update `consultationVisitedSync.js`:
  - ranges
  - match filters
  - source precedence
  - duplicate/tie-break rules
- Run `--dry-run` first and inspect summary samples.

---

## 6) Operational checklist for safe changes

1. Run relevant `scripts/*.mjs` with `--dry-run` where supported.
2. Verify API response shape still matches legacy consumers.
3. Deploy functions.
4. Manually run Cloud Scheduler jobs once.
5. Check logs for 401/500.
6. Validate 2-3 sample leads in Firestore and UI.
7. Update docs in `docs/` for every behavior change.

---

## 7) Known current behavior notes

- `/gas/getLatestWeekEndData` currently returns empty array.
- `/gas/checkAndMatchOrder` currently returns informational message.
- Firestore rules are backend-only (client direct access blocked).
- `consultationVisitedSync.js` currently excludes `In-person` rows from After Consultation source by policy.
- Logs export joins `followUpLogs`/`consultationLogs` with current `leads` snapshot for non-log columns; incremental mode **appends** new rows and does not delete older sheet rows.
- If `createdAt` on log documents were ever missing or non-sortable, incremental cursors could behave incorrectly — the current write path sets `createdAt` as ISO strings in `leadService.updateLead()`.
