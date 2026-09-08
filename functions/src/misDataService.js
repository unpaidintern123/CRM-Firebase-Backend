import { google } from "googleapis";
import { ApiError } from "./errors.js";

const DEFAULT_MIS_SPREADSHEET_ID = "1seVqJ5xPqva1Si6CXDpuZSePvP40PDO2fzJSJfss8GU";
const DEFAULT_MIS_SHEET_NAME = "MIS Data";

function getGoogleAuth() {
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  return new google.auth.JWT({
    email: process.env.FIREBASE_CLIENT_EMAIL,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
}

function parseWeekEndDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const DAY_MS = 86400000;
    const SHEETS_EPOCH_MS = Date.UTC(1899, 11, 30);
    const parsed = new Date(SHEETS_EPOCH_MS + value * DAY_MS);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  if (typeof value === "string" && value.includes("/")) {
    const parts = value.split("/");
    if (parts.length === 3) {
      const parsed = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
  }
  return null;
}

/**
 * Mirrors dashboardCal.js getLatestWeekEndData — returns rows for the MIS week
 * closest to today. Frontend expects JSON.stringify(row[]) with name at [0], score at [3].
 */
export async function getLatestWeekEndData() {
  const spreadsheetId = process.env.MIS_SPREADSHEET_ID || DEFAULT_MIS_SPREADSHEET_ID;
  const sheetName = process.env.MIS_SHEET_NAME || DEFAULT_MIS_SHEET_NAME;
  if (!spreadsheetId) {
    throw new ApiError(400, "MISSING_MIS_SPREADSHEET", "Set MIS_SPREADSHEET_ID");
  }

  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A:Z`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const allData = resp.data.values || [];
  if (!allData.length) return "[]";

  const headers = allData[0];
  const rows = allData.slice(1);
  const dateColIndex = headers.indexOf("Week End Date");
  if (dateColIndex === -1) {
    throw new ApiError(400, "MIS_COLUMN_MISSING", '"Week End Date" column not found in MIS Data');
  }

  const today = new Date();
  const parsedData = [];

  rows.forEach((row) => {
    const parsedDate = parseWeekEndDate(row[dateColIndex]);
    if (parsedDate) {
      const diff = Math.abs(parsedDate.getTime() - today.getTime());
      parsedData.push({ row, parsedDate, diff });
    }
  });

  if (!parsedData.length) return "[]";

  parsedData.sort((a, b) => a.diff - b.diff);
  const closestTime = parsedData[0].parsedDate.getTime();
  const result = parsedData
    .filter((entry) => entry.parsedDate.getTime() === closestTime)
    .map((entry) => entry.row);

  return JSON.stringify(result);
}
