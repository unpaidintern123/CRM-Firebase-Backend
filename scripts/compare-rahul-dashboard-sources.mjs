import dotenv from "dotenv";
import path from "node:path";
import { google } from "googleapis";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getLegacyConsultationPayload, getLeads } from "../functions/src/leadService.js";
import { toLegacyLead } from "../functions/src/mapper.js";

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

const auth = new google.auth.JWT({
  email: process.env.FIREBASE_CLIENT_EMAIL,
  key: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });
const spreadsheetId = process.env.CRM_SYNC_SHEET_ID || process.env.CRM_SYNC_SPREADSHEET_ID;

function parseDate(s) {
  if (!s) return null;
  if (s instanceof Date && !Number.isNaN(s.getTime())) return s;
  const str = String(s);
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return new Date(str);
  const m = str.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return new Date(`${m[3]}-${m[2]}-${m[1]}`);
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}

function weekRange() {
  const today = new Date();
  const sunday = new Date(today);
  sunday.setDate(today.getDate() - today.getDay());
  sunday.setHours(0, 0, 0, 0);
  const saturday = new Date(sunday.getTime() + 6 * 86400000);
  saturday.setHours(23, 59, 59, 999);
  return { start: sunday, end: saturday };
}

const { start, end } = weekRange();

// --- Sheet: Consultation Booked Logs for Rahul this week ---
const consRes = await sheets.spreadsheets.values.get({
  spreadsheetId,
  range: "Consultation Booked Logs!A:Q",
  valueRenderOption: "FORMATTED_VALUE",
});
const consRows = consRes.data.values || [];
const ch = consRows[0].map((x) => String(x || "").trim().toLowerCase());
const cId = ch.indexOf("lead unique id");
const cTs = ch.indexOf("timestamp");
const cAsg = ch.indexOf("assigned to");
const cName = ch.indexOf("client name");
const cCity = ch.indexOf("city");

const sheetRahulWeek = [];
for (let i = 1; i < consRows.length; i += 1) {
  const asg = String(consRows[i][cAsg] || "").trim();
  if (asg !== "Rahul") continue;
  const ts = parseDate(consRows[i][cTs]);
  if (!ts || ts < start || ts > end) continue;
  sheetRahulWeek.push({
    row: i + 1,
    id: String(consRows[i][cId] || "").trim(),
    name: consRows[i][cName],
    city: consRows[i][cCity],
    ts: consRows[i][cTs],
  });
}

// --- Sheet: Leads Data Consultation Booked for Rahul this week ---
const leadsRes = await sheets.spreadsheets.values.get({
  spreadsheetId,
  range: "Leads Data!A:K",
  valueRenderOption: "FORMATTED_VALUE",
});
const leadRows = leadsRes.data.values || [];
const lh = leadRows[0].map((x) => String(x || "").trim().toLowerCase());
const lId = lh.indexOf("lead unique id");
const lDate = lh.indexOf("lead date");
const lStatus = lh.indexOf("lead status");
const lAsg = lh.indexOf("assigned to");
const lName = lh.indexOf("client name");

const sheetBookedLeads = [];
for (let i = 1; i < leadRows.length; i += 1) {
  if (String(leadRows[i][lAsg] || "").trim() !== "Rahul") continue;
  if (String(leadRows[i][lStatus] || "").trim() !== "Consultation Booked") continue;
  const d = parseDate(leadRows[i][lDate]);
  if (!d || d < start || d > end) continue;
  sheetBookedLeads.push({
    row: i + 1,
    id: String(leadRows[i][lId] || "").trim(),
    name: leadRows[i][lName],
    leadDate: leadRows[i][lDate],
  });
}

// --- Firebase personDashboard source ---
const fbCons = JSON.parse(await getLegacyConsultationPayload());
const fbLeads = (await getLeads({ limit: 5000 })).map((l) =>
  toLegacyLead({ ...l, leadUniqueId: l.leadUniqueId })
);

const fbRahulWeekLogs = fbCons.filter((r) => {
  const d = parseDate(r.timestamp);
  return r["assigned to"] === "Rahul" && d && d >= start && d <= end;
});

const fbRahulWeekBookedLeads = fbLeads.filter((r) => {
  const d = parseDate(r["lead date"]);
  return (
    r["assigned to"] === "Rahul" &&
    r["lead status"] === "Consultation Booked" &&
    d &&
    d >= start &&
    d <= end
  );
});

// Stages tab peek
let stagesSample = null;
try {
  const st = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Stages!A1:Z30",
    valueRenderOption: "FORMULA",
  });
  stagesSample = st.data.values || [];
} catch (e) {
  stagesSample = String(e.message || e);
}

console.log(
  JSON.stringify(
    {
      note: "CRM spreadsheet has NO individual dashboard tab. personDashboard web app uses Firebase when proxy on; OG used sheets.",
      week: { start: start.toISOString(), end: end.toISOString() },
      sheetConsultationLogsRahulWeek: {
        count: sheetRahulWeek.length,
        rows: sheetRahulWeek,
      },
      sheetLeadsConsultationBookedRahulWeek: {
        count: sheetBookedLeads.length,
        rows: sheetBookedLeads,
      },
      firebasePersonDashboardBookedMetric: {
        count: fbRahulWeekLogs.length,
        rows: fbRahulWeekLogs.map((r) => ({
          id: r["lead unique id"],
          name: r["client name"],
          city: r.city,
          ts: r.timestamp,
        })),
      },
      firebaseBookedStatusLeadsThisWeek: {
        count: fbRahulWeekBookedLeads.length,
        rows: fbRahulWeekBookedLeads.map((r) => ({
          id: r["lead unique id"],
          name: r["client name"],
          leadDate: r["lead date"],
        })),
      },
      stagesSample,
    },
    null,
    2
  )
);
