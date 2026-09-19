import dotenv from "dotenv";
import path from "node:path";
import { google } from "googleapis";

dotenv.config({ path: path.resolve(".env") });

const auth = new google.auth.JWT({
  email: process.env.FIREBASE_CLIENT_EMAIL,
  key: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });
const spreadsheetId = process.env.CRM_SYNC_SHEET_ID || process.env.CRM_SYNC_SPREADSHEET_ID;

const meta = await sheets.spreadsheets.get({
  spreadsheetId,
  fields: "sheets(properties(title,sheetId,index))",
});
const titles = (meta.data.sheets || []).map((s) => s.properties.title);
console.log("TABS", JSON.stringify(titles, null, 2));

const interesting = titles.filter((t) =>
  /dash|rahul|person|crm|mis|score|individual|rep|elma|mehja|arantxa|jaieza/i.test(t)
);
console.log("INTERESTING", interesting);

async function scanFormulas(title) {
  const escaped = String(title).replace(/'/g, "''");
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${escaped}'!A1:AZ120`,
    valueRenderOption: "FORMULA",
  });
  const rows = res.data.values || [];
  const hits = [];
  for (let r = 0; r < rows.length; r += 1) {
    for (let c = 0; c < (rows[r] || []).length; c += 1) {
      const v = String(rows[r][c] || "");
      if (!v.startsWith("=")) continue;
      if (/COUNT|QUERY|FILTER|Consultation|Booked|Rahul|Assigned|IMPORTRANGE|SUMPRODUCT|UNIQUE/i.test(v)) {
        const col =
          c < 26
            ? String.fromCharCode(65 + c)
            : String.fromCharCode(64 + Math.floor(c / 26)) + String.fromCharCode(65 + (c % 26));
        hits.push({ cell: `${col}${r + 1}`, formula: v.slice(0, 350) });
      }
    }
  }
  return hits;
}

const toScan = interesting.length ? interesting : titles;
for (const title of toScan) {
  try {
    const hits = await scanFormulas(title);
    if (hits.length) {
      console.log(JSON.stringify({ title, hitCount: hits.length, hits: hits.slice(0, 50) }, null, 2));
    }
  } catch (err) {
    console.log("skip", title, String(err.message || err));
  }
}
