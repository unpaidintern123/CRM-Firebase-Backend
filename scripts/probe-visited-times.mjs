/**
 * Probe: do Leads Data visit datetimes have clock time, and would inbound write them?
 * Usage: node scripts/probe-visited-times.mjs [--limit=20]
 */
import dotenv from "dotenv";
import path from "node:path";
import { google } from "googleapis";
import {
  normalizeDateToIso,
  hasClockTime,
  sheetsSerialToIso,
} from "../functions/src/sheetDateUtils.js";

dotenv.config({ path: path.resolve(".env") });

const spreadsheetId = process.env.CRM_SYNC_SHEET_ID;
const sheetName = process.env.CRM_LEADS_SHEET_NAME || "Leads Data";
const limit = Number((process.argv.find((a) => a.startsWith("--limit=")) || "--limit=25").split("=")[1]);

const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const auth = new google.auth.JWT({
  email: process.env.FIREBASE_CLIENT_EMAIL,
  key: privateKey,
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheets = google.sheets({ version: "v4", auth });

const [unf, fmt] = await Promise.all([
  sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A:AQ`,
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "SERIAL_NUMBER",
  }),
  sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A:AQ`,
    valueRenderOption: "FORMATTED_VALUE",
  }),
]);

const headers = (unf.data.values || [])[0] || [];
const headerNorm = headers.map((h) => String(h || "").trim().toLowerCase());
const idIdx = headerNorm.indexOf("lead unique id");
const nameIdx = headerNorm.indexOf("client name");
const visitedIdx = headerNorm.indexOf("consultation visited date");
const bookedIdx = headerNorm.indexOf("consultation booked date");

console.log(
  JSON.stringify(
    {
      spreadsheetId,
      sheetName,
      visitedHeaderIndex: visitedIdx,
      bookedHeaderIndex: bookedIdx,
      visitedHeaderRaw: headers[visitedIdx],
    },
    null,
    2
  )
);

if (visitedIdx < 0) {
  console.error("Consultation Visited Date column not found");
  process.exit(1);
}

const unfRows = (unf.data.values || []).slice(1);
const fmtRows = (fmt.data.values || []).slice(1);
let withFraction = 0;
let withFormattedTime = 0;
let samples = [];

for (let i = 0; i < unfRows.length; i++) {
  const u = unfRows[i]?.[visitedIdx];
  const f = fmtRows[i]?.[visitedIdx];
  if (u === "" || u == null) continue;
  const isNum = typeof u === "number" && Number.isFinite(u);
  const frac = isNum ? Math.abs(u % 1) > 1e-10 : false;
  if (frac) withFraction += 1;
  if (/\d{1,2}:\d{2}/.test(String(f || ""))) withFormattedTime += 1;
  if (samples.length < limit && (frac || /\d{1,2}:\d{2}/.test(String(f || "")) || samples.length < 5)) {
    samples.push({
      leadUniqueId: unfRows[i]?.[idIdx],
      clientName: unfRows[i]?.[nameIdx],
      unformattedType: typeof u,
      unformatted: u,
      formatted: f,
      isoFromUnf: normalizeDateToIso(u),
      isoFromFmt: normalizeDateToIso(f),
      hasClockFromUnf: hasClockTime(u),
      hasClockFromFmt: hasClockTime(f),
      serialIso: isNum ? sheetsSerialToIso(u) : "",
    });
  }
}

console.log(
  JSON.stringify(
    {
      rowsWithVisitedValue: unfRows.filter((r) => r?.[visitedIdx] !== "" && r?.[visitedIdx] != null).length,
      unformattedWithTimeFraction: withFraction,
      formattedShowingTime: withFormattedTime,
      samples,
    },
    null,
    2
  )
);
