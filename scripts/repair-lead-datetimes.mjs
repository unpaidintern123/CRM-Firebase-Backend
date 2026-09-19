/**
 * Force-repair lead date/time fields from Sheets → Firestore (UNFORMATTED serials).
 * Usage: node scripts/repair-lead-datetimes.mjs [--dry-run] [--limit=N]
 */
import dotenv from "dotenv";
import path from "node:path";
import { google } from "googleapis";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import {
  DATE_FIELDS,
  normalizeDateToIso,
  normalizeLeadDatesFromSheet,
  hasClockTime,
} from "../functions/src/sheetDateUtils.js";
import { LEAD_FIELD_MAP } from "../functions/src/mapper.js";

dotenv.config({ path: path.resolve(".env") });

const dryRun = process.argv.includes("--dry-run");
const limitRaw = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitRaw ? Number(limitRaw.split("=")[1]) : null;

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    }),
  });
}
const db = getFirestore();

function normalizeHeader(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function mapHeaderToField(header) {
  return LEAD_FIELD_MAP[normalizeHeader(header)] || null;
}

function rowToLead(headers, row) {
  const lead = {};
  headers.forEach((header, index) => {
    const field = mapHeaderToField(header);
    if (!field) return;
    lead[field] = row[index] ?? "";
  });
  lead.leadUniqueId = String(lead.leadUniqueId || "").trim();
  return lead;
}

const spreadsheetId = process.env.CRM_SYNC_SHEET_ID;
const sheetName = process.env.CRM_LEADS_SHEET_NAME || "Leads Data";
const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const auth = new google.auth.JWT({
  email: process.env.FIREBASE_CLIENT_EMAIL,
  key: privateKey,
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheets = google.sheets({ version: "v4", auth });

console.log("Reading sheet with UNFORMATTED_VALUE…");
const response = await sheets.spreadsheets.values.get({
  spreadsheetId,
  range: `${sheetName}!A:AQ`,
  valueRenderOption: "UNFORMATTED_VALUE",
  dateTimeRenderOption: "SERIAL_NUMBER",
});

const rows = response.data.values || [];
const headers = rows[0] || [];
const dataRows = rows.slice(1);
const summary = {
  dryRun,
  scanned: 0,
  patched: 0,
  skippedMissingDoc: 0,
  skippedNoChange: 0,
  clockTimesWritten: 0,
  samples: [],
  errors: [],
};

for (const row of dataRows) {
  if (limit != null && summary.scanned >= limit) break;
  const lead = normalizeLeadDatesFromSheet(rowToLead(headers, row));
  if (!lead.leadUniqueId) continue;
  summary.scanned += 1;

  try {
    const ref = db.collection("leads").doc(lead.leadUniqueId);
    const snap = await ref.get();
    if (!snap.exists) {
      summary.skippedMissingDoc += 1;
      continue;
    }
    const current = snap.data() || {};
    const patch = {};
    for (const field of DATE_FIELDS) {
      const incomingIso = normalizeDateToIso(lead[field]);
      if (!incomingIso) continue;
      const currentIso = normalizeDateToIso(current[field]);
      if (incomingIso !== currentIso) {
        patch[field] = incomingIso;
        if (hasClockTime(incomingIso)) summary.clockTimesWritten += 1;
      }
    }
    if (!Object.keys(patch).length) {
      summary.skippedNoChange += 1;
      continue;
    }
    patch.updatedAt = new Date().toISOString();
    patch.dateTimeRepairedAt = patch.updatedAt;
    patch.dateTimeRepairedFrom = "repair-lead-datetimes";
    if (!dryRun) {
      await ref.set(patch, { merge: true });
    }
    summary.patched += 1;
    if (summary.samples.length < 15 && patch.consutlationVisitedDate) {
      summary.samples.push({
        leadUniqueId: lead.leadUniqueId,
        before: current.consutlationVisitedDate || "",
        after: patch.consutlationVisitedDate,
      });
    }
  } catch (err) {
    summary.errors.push({
      leadUniqueId: lead.leadUniqueId,
      message: String(err && err.message ? err.message : err),
    });
  }
}

console.log(JSON.stringify(summary, null, 2));
