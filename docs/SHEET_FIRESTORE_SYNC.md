# Sheet ↔ Firestore sync & assignment (operations guide)

## Lead flow column (F) — what it means in code

- In the **production** Google Sheet, column **F** is labeled `lead flow` and often stores **numeric** values (e.g. 10, 20, … 100), not Yes/No.
- **There is no older assignment logic in this repo** that reads column F; the only references are in `Code.js` (`isLeadFlowEnabled`, `getAssignmentEligibleUsers`) and this documentation.
- **Interpretation we use (safe default):** treat `lead flow` as an **eligibility + future weight hint**:
  - **Eligible for assignment** if the cell is a **number greater than 0**, or a text flag like `Yes` / `TRUE` / `Active` / `Enabled`.
  - **Not eligible** if blank, `0`, or text like `No` / `FALSE` / `Disabled`.
- **Weighted round-robin** (e.g. 100 vs 50 capacity) is **not** implemented. Distribution is still **equal round-robin** among eligible users. Numeric values only gate eligibility today; you can add true weighting later without changing the sheet structure.

### Optional future column (if you want strict Yes/No without overloading F)

- **Recommended later if HR wants clearer semantics:** add column **H** `assignment enabled` (Yes/No), keep **F** as numeric weight/capacity for reporting only. Until then, **numeric value greater than 0** remains the eligibility gate for column F.

---

## Source of truth

1. **`Users` tab** in Google Sheets is the **master** list for who may receive leads and who syncs into Firestore.
2. **Firestore `config/leadAssignment`** is updated by Apps Script **`syncAssignmentUsersToFirestoreConfig()`** (manual, menu, or time trigger). Backend **fallback assignment** reads only **`activeAssignees`** there.

### Eligibility rules (code)

| Field | Rule |
|--------|------|
| A username | non-blank |
| D status | `Active` |
| F lead flow | enabled (number &gt; 0 or allowed text flags) |
| Sheet `assignLeads()` **today** | `eligibleGeneral` and, **if Monday**, `E next monday` = `Coming` |
| Firestore **`activeAssignees`** | users with **`eligibleGeneral`** (no Monday filter) |

### Monday pool (audit field)

- **`mondayEligibleAssignees`** in Firestore = users with **`eligibleGeneral`** and **`next monday` = `Coming`** (stored for dashboards/audit regardless of weekday).

---

## Apps Script automation

| Mechanism | What it does |
|-----------|----------------|
| **Manual / editor** | Run `syncAssignmentUsersToFirestoreConfig()` once (authorizes UrlFetchApp). |
| **Menu `CRM Admin`** | **Sync Assignment Users to Firestore**, **Show Eligible Assignment Users**, **Run Lead Assignment** — uses **`SpreadsheetApp.getUi().alert()`** + **Logger**. |
| **Time triggers (optional)** | **Install hourly** or **Install 15-minute** → runs **`timedSyncAssignmentUsersToFirestore()`** → calls sync. **`Remove assignment sync triggers`** deletes those triggers. |

**Important:** Installing triggers requires running the installer once from the script editor so Apps Script can request trigger permissions.

We **do not** use `onEdit` for UrlFetch/sync (fragile quotas and concurrent edits).

---

## Login safety

- **`checkLogin`** uses the **same spreadsheet** as `getCrmSpreadsheetForSync()` (Script Property **`CRM_SYNC_SHEET_ID`** or fallback ID).
- If username/password match but **`D status` ≠ `Active`**, response is JSON with  
  **`"Your account is inactive. Please contact admin."`**  
  Same overall response shape as other login failures (`message`).

---

## Firestore (`config/leadAssignment`)

After **`POST /admin/sync-assignees`**, expect at minimum:

- `activeAssignees` — synced from **`eligibleGeneral`**
- `mondayEligibleAssignees` — **`eligibleMondayPool`**
- `usersSnapshot` — array including **`leadFlow`** (number or string)
- `source`, `syncedBy`, `updatedAt`, `addedAssignees`, `removedAssignees`
- `lastAssignedIndex` — adjusted if invalid

**Backend round-robin** (`assignLeadBackendRoundRobin`) uses **only** `activeAssignees`.

---

## 1. Local code checklist (before deploy)

- [ ] `Code.js` includes **`onOpen`** menu and **`isLeadFlowEnabled`** supports numeric **`> 0`**.
- [ ] `firebase-backend/functions/src/index.js` exposes **`POST /admin/sync-assignees`** and **`GET /admin/assignment-audit`**.
- [ ] `.env` has API + Firebase + **`CRM_SYNC_SHEET_ID`** / **`CRM_SYNC_SPREADSHEET_ID`**.

---

## 2. Apps Script deployment checklist

- [ ] Copy/push **`Code.js`** to the Apps Script project **bound** to the CRM spreadsheet (or use **clasp**).
- [ ] Set **Script Properties** (Project Settings → Script properties):

  | Key | Purpose |
  |-----|---------|
  | **`CRM_SYNC_SHEET_ID`** | Spreadsheet ID for `Users` / `Leads Data` master file |
  | **`CRM_API_BASE_URL`** | Base URL of Cloud Function API (no trailing slash) |
  | **`CRM_API_TOKEN`** | Value matching **`API_SHARED_TOKEN`** on backend |

- [ ] In Apps Script editor, run **`syncAssignmentUsersToFirestoreConfig()`** once → approve **external URL fetch** permission.
- [ ] Reload the Sheet → verify **CRM Admin** menu appears (**`onOpen`**).
- [ ] Optionally run **`installAssignmentSyncHourlyTrigger()`** or **`installAssignmentSync15MinTrigger()`** once → approve trigger permission.

---

## 3. Firebase deployment checklist

- [ ] From `firebase-backend/functions`: **`npm ci`** / **`npm install`** if deps changed.
- [ ] **`firebase deploy --only functions`** (or your CI path).
- [ ] **`API_SHARED_TOKEN`** matches Script Property **`CRM_API_TOKEN`**.

---

## 4. Required environment variables (backend `.env`)

- `API_SHARED_TOKEN`
- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`
- `CRM_SYNC_SPREADSHEET_ID` or `CRM_SYNC_SHEET_ID` (for Sheets API read in inbound sync)

---

## 5. Required Script Properties (Apps Script)

- **`CRM_SYNC_SHEET_ID`**
- **`CRM_API_BASE_URL`**
- **`CRM_API_TOKEN`**
- Existing: **`CRM_API_*`** injected into HTML for client API calls

Optional: clear **`lastAssignedUser`** after team changes.

---

## 6. Required Firestore config

Created/updated by **`POST /admin/sync-assignees`**. Initial empty state → leads may go **pending** until first sync.

---

## 7. Test `Users` tab setup

Prepare rows:

1. **`TEST_INACTIVE`** — correct password later; **`status`** = anything except Active → cannot login after change.
2. **`TEST_FLOW_OFF`** — Active, **`lead flow`** = **0** or blank → not in **`activeAssignees`**.
3. **`TEST_FLOW_ON`** — Active, **`lead flow`** = **50** → appears in **`activeAssignees`**.
4. **`TEST_MONDAY_NO`** — Active, **`lead flow`** = **100**, **`next monday`** = empty or not `Coming` → in **`activeAssignees`** but not in **`mondayEligibleAssignees`**.
5. **`TEST_MONDAY_YES`** — Active, **`lead flow`** = **100**, **`next monday`** = `Coming` → in both lists.

Remove test users after QA.

---

## 8–11. Operational tests

8. Eligibility → use **CRM Admin → Show Eligible Assignment Users**.
9. **Sync** → **CRM Admin → Sync Assignment Users to Firestore**, or **`syncAssignmentUsersToFirestoreConfig()`** in editor.
10. **`GET /admin/assignment-audit`** with header **`x-api-token`** — lists Firestore **`activeAssignees`**, **`mondayEligibleAssignees`**, **`usersSnapshot`**.
11. **Sheet → Firestore inbound** dry run:  
    `npm run sync:sheet-to-firestore -- --dry-run --limit=5`

---

## 12–14. Fallback & login tests

12. Real inbound sync: **`POST /sync/sheet-to-firestore`**. For **scheduled** jobs, prefer `{"dryRun":false,"skipExisting":true}` so each run does not rewrite every existing lead (reduces timeouts). Use `skipExisting:false` only for deliberate bulk repair.
13. Blank **`Assigned To`**: fallback must pick only names from **`activeAssignees`**.
14. Inactive login: deactivate user **`D`** → login returns inactive message string above.

---

## 15–18. Regression & rollback

15. Former employees must be removed from **`activeAssignees`** (set **inactive** + sync). Optional audit: **`GET /admin/assignment-audit?former=Name1,Name2`**.
16. **Monday**: temporarily set system date context by setting **`next monday`** / **`Coming`** correctly and run **`assignLeads()`** or **Run Lead Assignment** on a calendar Monday **or** review **Show Eligible** output on Monday.
17. **Leads export (EOD-style schedule)** — **`POST /sync/eod-to-sheets`**: clears and overwrites **`Leads Data`** range **`A2:AO`** from Firestore. It does **not** refresh the **Follow-up Logs** or **Consultation Booked Logs** tabs.
18. **Logs export** — separate job: **`POST /sync/logs-to-sheets`** (see `docs/03_TRIGGERS_AND_SCHEDULERS_RUNBOOK.md`). Default mode **appends** new rows using cursors in Firestore **`config/sheetExportCursors`**. Use **`fullRebuild:true`** only for repair.

### Rollback

1. Deploy previous Git revision of **`Code.js`** and **`functions`**.
2. Restore previous **`Users`/`Leads`** from Sheet version history if needed.
3. **`POST /admin/sync-assignees`** with known-good **`activeAssignees`** payload via curl (manual repair).

---

## cURL examples (replace placeholders)

Audit:

```bash
curl -sS -H "x-api-token: YOUR_TOKEN" "https://YOUR_REGION-YOUR_PROJECT.cloudfunctions.net/YOUR_FN_URL/admin/assignment-audit"
```

Sync assignees from Apps Script is preferred (reads Sheet). Emergency manual POST:

```bash
curl -sS -X POST -H "Content-Type: application/json" -H "x-api-token: YOUR_TOKEN" \
  -d '{"activeAssignees":["A","B"],"source":"manual_repair","syncedBy":"admin","usersSnapshot":[]}' \
  "https://YOUR_FUNCTIONS_BASE/admin/sync-assignees"
```

Inbound sheet sync dry-run:

```bash
curl -sS -X POST -H "Content-Type: application/json" -H "x-api-token: YOUR_TOKEN" \
  -d '{"dryRun":true,"limit":5}' \
  "https://YOUR_FUNCTIONS_BASE/sync/sheet-to-firestore"
```

Incremental logs export dry-run:

```bash
curl -sS -X POST -H "Content-Type: application/json" -H "x-api-token: YOUR_TOKEN" \
  -d '{"dryRun":true,"fullRebuild":false,"batchSize":1000}' \
  "https://YOUR_FUNCTIONS_BASE/sync/logs-to-sheets"
```

---

## clasp push (Apps Script)

From machine with clasp authenticated:

```bash
cd "/path/to/project-with-.clasp.json"
clasp push
```

Alternatively paste **`Code.js`** functions into Apps Script IDE.

---

## HR / admin ongoing process

1. Update **`Users`** (status, lead flow, Monday flag).
2. **CRM Admin → Sync Assignment Users to Firestore** (or wait for hourly trigger).
3. **GET /admin/assignment-audit** (optional) → confirm **`activeAssignees`**.
4. Deactivate leavers:** `status ≠ Active`** → blocked at login → removed from **`activeAssignees`** on sync.
