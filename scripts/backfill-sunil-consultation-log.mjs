import dotenv from "dotenv";
import path from "node:path";
import { google } from "googleapis";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { normalizeDateToIso } from "../functions/src/sheetDateUtils.js";
import { getLegacyConsultationPayload } from "../functions/src/leadService.js";

dotenv.config({ path: path.resolve(".env") });

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
const auth = new google.auth.JWT({
  email: process.env.FIREBASE_CLIENT_EMAIL,
  key: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });
const spreadsheetId = process.env.CRM_SYNC_SHEET_ID || process.env.CRM_SYNC_SPREADSHEET_ID;
const leadId = "Lead ID - 25285";

function parseDate(s) {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(String(s))) return new Date(s);
  const m = String(s).match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? new Date(`${m[3]}-${m[2]}-${m[1]}`) : new Date(s);
}

const leadSnap = await db.collection("leads").doc(leadId).get();
if (!leadSnap.exists) throw new Error("Lead missing in Firebase");
const lead = leadSnap.data();

const existing = await db.collection("consultationLogs").where("leadUniqueId", "==", leadId).get();
if (!existing.empty) {
  console.log(JSON.stringify({ action: "already_exists", count: existing.size }, null, 2));
  process.exit(0);
}

const res = await sheets.spreadsheets.values.get({
  spreadsheetId,
  range: "Consultation Booked Logs!A:Q",
  valueRenderOption: "FORMATTED_VALUE",
});
const rows = res.data.values || [];
const h = rows[0].map((x) => String(x || "").trim().toLowerCase());
const idIdx = h.indexOf("lead unique id");
const tsIdx = h.indexOf("timestamp");
const bookedIdx = h.indexOf("consultation booked date");
const typeIdx = h.indexOf("consultation type");
const asgIdx = h.indexOf("assigned to");

let sheetRow = null;
for (let i = 1; i < rows.length; i += 1) {
  if (String(rows[i][idIdx] || "").trim() === leadId) {
    sheetRow = { row: i + 1, cells: rows[i] };
  }
}
if (!sheetRow) throw new Error("Sheet consultation log row not found");

const createdAt = normalizeDateToIso(sheetRow.cells[tsIdx]) || new Date().toISOString();
const consultationBookedDate =
  normalizeDateToIso(sheetRow.cells[bookedIdx]) ||
  normalizeDateToIso(lead.consutlationBookedDate) ||
  createdAt;
const consultationType = String(sheetRow.cells[typeIdx] || lead.consultationType || "").trim();
const createdBy = String(sheetRow.cells[asgIdx] || lead.assignedTo || "backfill").trim();

const doc = {
  leadUniqueId: leadId,
  consultationBookedDate,
  consultationType,
  createdBy,
  createdAt,
  source: "sheet_backfill",
  backfilledAt: new Date().toISOString(),
};

const ref = await db.collection("consultationLogs").add(doc);
console.log(JSON.stringify({ action: "created", id: ref.id, doc }, null, 2));

const today = new Date();
const sunday = new Date(today);
sunday.setDate(today.getDate() - today.getDay());
sunday.setHours(0, 0, 0, 0);
const saturday = new Date(sunday.getTime() + 6 * 86400000);
saturday.setHours(23, 59, 59, 999);

const cons = JSON.parse(await getLegacyConsultationPayload());
const weekRahul = cons.filter((r) => {
  const d = parseDate(r.timestamp);
  return r["assigned to"] === "Rahul" && d && d >= sunday && d <= saturday;
});

console.log(
  JSON.stringify(
    {
      rahulWeekBookedNow: weekRahul.length,
      rows: weekRahul.map((r) => ({
        id: r["lead unique id"],
        name: r["client name"],
        ts: r.timestamp,
      })),
    },
    null,
    2
  )
);
