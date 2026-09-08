# Firestore Cutover Checklist

## Pre-Cutover
- Deploy `api` function to staging and production.
- Run `npm run migrate` from `firebase-backend` (requires `CRM Clone.xlsx`).
- Run `npm run migrate:users` to populate Firestore `users` from the Users sheet.
- Run `npm run verify:parity` and confirm acceptable delta.
- Configure API token in Apps Script **Script Properties** as `CRM_API_TOKEN` (server-side only — not injected into HTML).
- Configure base URL in Apps Script **Script Properties** as `CRM_API_BASE_URL`.
- Share MIS and Order Forms spreadsheets with the Firebase service account email.

## Security (Phase 1 complete in code)
- Frontend uses `crmApiProxy` in `Code.js` — token never sent to browser.
- Pages set `CRM_USE_API_PROXY` only (no `CRM_API_TOKEN` in HTML).
- Rotate `API_SHARED_TOKEN` if it was ever exposed in the browser.

## Cutover
- `clasp push` Apps Script changes (`Code.js`, `apiClient.html`, HTML shells).
- Deploy functions: `cd firebase-backend && npm run deploy:functions`.
- Validate: login, lead update, dashboards (MIS scores, consultation funnel).
- Test order match: open `missingConsultationVisited.html` → Refresh.

## End of Day Sync
- Trigger `POST /sync/eod-to-sheets` (cron: 9am, 4pm, 8pm IST per runbook).
- Confirm `Leads Data` row counts.
- Spot check follow-up and consultation log tabs.

## Optional schedulers
- `POST /sync/order-match` or `npm run sync:order-match` for order reconciliation.

## Rollback
- Set `CRM_API_BASE_URL` empty in Apps Script properties.
- Frontend auto-falls back to `google.script.run` (legacy Sheets path).

## Verify production
- [ ] Apps Script: `CRM_API_BASE_URL` and `CRM_API_TOKEN` set (Properties, not HTML).
- [ ] Browser DevTools: no `x-api-token` header on network requests.
- [ ] Cloud Scheduler jobs running (see `docs/03_TRIGGERS_AND_SCHEDULERS_RUNBOOK.md`).
- [ ] `GET /health` returns 200 with valid token.
