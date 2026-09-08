# Triggers and Scheduler Runbook

This runbook documents all current automation triggers and scheduler jobs used by the CRM migration.

---

## 1) Automation sources in this system

There are two automation mechanisms:

1. **Apps Script time trigger(s)**
2. **Google Cloud Scheduler HTTP jobs**

Current intended production pattern:
- Keep Apps Script trigger only for assignee sync (optional but active in current setup).
- Use Cloud Scheduler for data sync/export jobs.

---

## 2) Apps Script trigger (current)

Observed/expected function:
- `timedSyncAssignmentUsersToFirestore`

Purpose:
- Pushes Users-tab assignee pool to backend `/admin/sync-assignees`.
- Keeps Firestore `config/leadAssignment` in sync with sheet-managed eligibility.

Dependencies:
- Script properties:
  - `CRM_API_BASE_URL`
  - `CRM_API_TOKEN`
  - `CRM_SYNC_SHEET_ID`

If this trigger fails:
- New sheet-origin leads with blank assignee may become pending if fallback pool is stale/empty.

---

## 3) Cloud Scheduler jobs (current)

Project example (replace with yours):
- `ahl-crm-database`

Region example:
- `asia-south1`

Base URL example (Firebase 2nd gen Cloud Run URL; replace with the URL printed after `firebase deploy`):
- `https://api-<hash>-<region>.a.run.app`

Header auth:
- `x-api-token: <API_SHARED_TOKEN>` — must match backend `API_SHARED_TOKEN` exactly.

**Important (empty header bug):** When updating a job with `gcloud`, **export the token in your shell first** (for example `export CRM_API_TOKEN='…'`) before running the command, or paste the literal token. If the variable is unset, `gcloud` may store an **empty** `x-api-token`, and the function returns **401**.

**`gcloud` syntax:** Use `--update-headers` to change headers on an existing HTTP job (`--headers` on `update` is not valid for current `gcloud` versions).

### 3.1 `crm-consultation-visited-sync`

- Schedule: `0 10-21 * * *` (Every hour at the top of the hour from 10:00 AM to 9:00 PM Asia/Kolkata).
- Endpoint: `POST https://<your-run-host>/sync/consultation-visited`
- Example body: `{"dryRun":false,"triggeredBy":"cloud_scheduler"}`


### 3.2 `crm-sheet-to-firestore-sync`

- Schedule: `*/15 * * * *` (Asia/Kolkata) — adjust if needed.
- Endpoint: `POST https://<your-run-host>/sync/sheet-to-firestore`
- Recommended body for **scheduled** runs (avoids re-processing thousands of existing rows and reduces timeouts):
  ```json
  {"dryRun":false,"skipExisting":true,"triggeredBy":"cloud_scheduler"}
  ```
  Use `skipExisting:false` only for intentional bulk re-syncs (may exceed function timeout on large sheets).

### 3.3 `crm-eod-export`

- Schedule: `0 19 * * *` (7:00 PM Asia/Kolkata) — daily evening export at 7:00 PM; updates **Leads Data** only (clear `A2:AO`, rewrite from Firestore).
- Endpoint: `POST https://<your-run-host>/sync/eod-to-sheets`
- Body: `{"dryRun":false}`
- **Effect:** Updates **Leads Data** only (clear `A2:AO`, rewrite from Firestore).

### 3.4 `crm-logs-export`

- Purpose: Push new **Follow-up Logs** and **Consultation Booked Logs** rows from Firestore to Sheets with **near-real-time** incremental appends.
- Schedule (example): `*/2 * * * *` (Asia/Kolkata) = every 2 minutes — tune for cost vs latency (1–5 minutes is typical).
- Endpoint: `POST https://<your-run-host>/sync/logs-to-sheets`
- Example body (incremental — default behavior in code when `fullRebuild` is omitted/false):
  ```json
  {"dryRun":false,"fullRebuild":false,"batchSize":1000}
  ```
- **Behavior:**
  - Reads cursors from Firestore `config/sheetExportCursors` (`followUpLastCreatedAt`, `consultationLastCreatedAt`).
  - Appends new rows to the two log tabs; updates cursors after success.
### 3.5 `crm-order-match-sync`

- Purpose: Matches `Order Forms` sheet entries against `Consultation Visited` leads and updates `orderStatus = "Booked"`.
- Schedule: `45 18 * * *` (6:45 PM Asia/Kolkata daily) — runs after consultation visited sync and before EOD export.
- Endpoint: `POST https://<your-run-host>/gas/checkAndMatchOrder`
- Example body: `{"dryRun":false}`

### Example: create or update `crm-logs-export` (HTTP, POST, JSON)

Replace `PROJECT`, `REGION`, `JOB_NAME`, `URI`, and token as appropriate.

```bash
export CRM_API_TOKEN='YOUR_API_SHARED_TOKEN_VALUE'

gcloud scheduler jobs create http crm-logs-export \
  --project=PROJECT \
  --location=REGION \
  --schedule="*/2 * * * *" \
  --time-zone="Asia/Kolkata" \
  --uri="https://YOUR-HOST/sync/logs-to-sheets" \
  --http-method=POST \
  --headers="Content-Type=application/json,x-api-token=${CRM_API_TOKEN}" \
  --message-body='{"dryRun":false,"fullRebuild":false,"batchSize":1000}' \
  --attempt-deadline=300s
```

To **update** headers on an existing job:

```bash
export CRM_API_TOKEN='YOUR_API_SHARED_TOKEN_VALUE'

gcloud scheduler jobs update http crm-logs-export \
  --project=PROJECT \
  --location=REGION \
  --update-headers="Content-Type=application/json,x-api-token=${CRM_API_TOKEN}"
```

---

## 4) Required backend env for these jobs

- `API_SHARED_TOKEN`
- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`
- `CRM_SYNC_SHEET_ID` (or `CRM_SYNC_SPREADSHEET_ID`)
- `CONSULTATION_SYNC_SPREADSHEET_ID` (for consultation source sheet; falls back to CRM sheet id)

---

## 5) Validation and smoke tests

## 5.1 List scheduler jobs

```bash
gcloud scheduler jobs list --project=YOUR_GCP_PROJECT --location=YOUR_REGION
```

## 5.2 Run once manually

```bash
gcloud scheduler jobs run crm-consultation-visited-sync --project=YOUR_GCP_PROJECT --location=YOUR_REGION
gcloud scheduler jobs run crm-sheet-to-firestore-sync --project=YOUR_GCP_PROJECT --location=YOUR_REGION
gcloud scheduler jobs run crm-eod-export --project=YOUR_GCP_PROJECT --location=YOUR_REGION
gcloud scheduler jobs run crm-logs-export --project=YOUR_GCP_PROJECT --location=YOUR_REGION
```

## 5.3 Local dry-run equivalents

```bash
cd "/Users/ketan/Desktop/Kunal CRM Code/firebase-backend"
npm run sync:consultation-visited -- --dry-run
npm run sync:sheet-to-firestore -- --dry-run --limit=50
npm run export:eod -- --dry-run
npm run export:logs -- --dry-run
```

---

## 6) Troubleshooting matrix

### Error: `The caller does not have permission` (consultation sync)

Cause:
- Service account (`FIREBASE_CLIENT_EMAIL`) is not shared on source spreadsheet.

Fix:
- Share spreadsheet with service account email as Viewer/Editor.

### Error: 401 Unauthorized from scheduler jobs

Cause:
- Scheduler `x-api-token` mismatch with backend `API_SHARED_TOKEN`.

Fix:
- Rotate/update token in:
  - backend env
  - Apps Script `CRM_API_TOKEN`
  - all scheduler job headers

### No rows updated in consultation sync

Check:
- `CONSULTATION_SYNC_SPREADSHEET_ID` is correct.
- Firestore has `Consultation Booked` leads.
- mobile normalization overlap exists.
- source sheets contain eligible rows under configured policy.

### EOD export appears to revert statuses

Cause:
- Firestore not updated before export.

Fix:
- Run **`/sync/consultation-visited`** on a cadence **before** EOD windows so **`Consultation Visited`** is written in Firestore first.
- Prefer **`skipExisting:true`** on recurring **`/sync/sheet-to-firestore`** so sheet→Firestore jobs do not fight UI/consultation updates for existing leads.
- Confirm scheduler enabled state.

### Logs tab missing newest rows / duplicate suspicion

Check:
- `crm-logs-export` job is **enabled** and returns `200`; inspect last execution in Cloud Scheduler.
- Incremental cursor doc: Firestore **`config/sheetExportCursors`** — do not edit unless you understand replay implications.
- For a one-time repair of the sheet tabs vs Firestore: run **`POST /sync/logs-to-sheets`** with **`fullRebuild:true`** (heavy; clears log ranges then rewrites).

### Firebase CLI “credentials no longer valid”

Fix:
- From `firebase-backend`: `npm run firebase -- login --reauth` (uses `npx firebase-tools@latest` per `package.json`).

---

## 7) Change management for triggers/jobs

When changing schedules:

1. Update job schedule via `gcloud scheduler jobs update http ...`.
2. Manually run once.
3. Validate logs and sampled Firestore rows.
4. Update this document with new cron + reason.

When adding new periodic jobs:

1. Define endpoint and schema in backend.
2. Add dry-run support.
3. Add CLI script.
4. Add scheduler with token header.
5. Add runbook section with rollback steps.

---

## 8) Rollback

If scheduler automation causes issues:

1. Pause problematic job:
   ```bash
   gcloud scheduler jobs pause JOB_ID --project=YOUR_GCP_PROJECT --location=YOUR_REGION
   ```
2. Run affected sync manually in dry-run mode.
3. Revert function code (if needed) and redeploy.
4. Resume only after validation:
   ```bash
   gcloud scheduler jobs resume JOB_ID --project=YOUR_GCP_PROJECT --location=YOUR_REGION
   ```

