/**
 * Compare sheet vs Firestore visited datetime for sample leads (incl. Kabir).
 */
import dotenv from "dotenv";
import path from "node:path";
import { google } from "googleapis";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { normalizeDateToIso, hasClockTime } from "../functions/src/sheetDateUtils.js";

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

const spreadsheetId = process.env.CRM_SYNC_SHEET_ID;
const sheetName = process.env.CRM_LEADS_SHEET_NAME || "Leads Data";
const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const auth = new google.auth.JWT({
  email: process.env.FIREBASE_CLIENT_EMAIL,
  key: privateKey,
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheets = google.sheets({ version: "v4", auth });
const response = await sheets.spreadsheets.values.get({
  spreadsheetId,
  range: `${sheetName}!A:AQ`,
  valueRenderOption: "UNFORMATTED_VALUE",
});
const headers = (response.data.values || [])[0] || [];
const headerNorm = headers.map((h) => String(h || "").trim().toLowerCase());
const idIdx = headerNorm.indexOf("lead unique id");
const nameIdx = headerNorm.indexOf("client name");
const visitedIdx = headerNorm.indexOf("consultation visited date");
const rows = (response.data.values || []).slice(1);

const needles = ["kabir", "abhijeet", "arun naidu", "akhil walia", "shikhar"];
const hits = [];
for (const row of rows) {
  const name = String(row[nameIdx] || "").toLowerCase();
  if (!needles.some((n) => name.includes(n))) continue;
  const id = String(row[idIdx] || "").trim();
  const sheetRaw = row[visitedIdx];
  const sheetIso = normalizeDateToIso(sheetRaw);
  let fb = null;
  if (id) {
    const snap = await db.collection("leads").doc(id).get();
    fb = snap.exists ? snap.data()?.consutlationVisitedDate ?? null : "DOC_MISSING";
  }
  hits.push({
    leadUniqueId: id,
    clientName: row[nameIdx],
    sheetRaw,
    sheetIso,
    sheetHasClock: hasClockTime(sheetRaw),
    firestoreValue: fb,
    firestoreIso: fb && fb !== "DOC_MISSING" ? normalizeDateToIso(fb) : fb,
    firestoreHasClock: fb && fb !== "DOC_MISSING" ? hasClockTime(fb) : false,
    wouldPatch: sheetIso && normalizeDateToIso(fb) !== sheetIso,
  });
}
console.log(JSON.stringify(hits, null, 2));
