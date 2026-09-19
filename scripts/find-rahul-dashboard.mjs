import dotenv from "dotenv";
import path from "node:path";
import { google } from "googleapis";

dotenv.config({ path: path.resolve(".env") });

const auth = new google.auth.JWT({
  email: process.env.FIREBASE_CLIENT_EMAIL,
  key: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  scopes: [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/spreadsheets.readonly",
  ],
});
const drive = google.drive({ version: "v3", auth });
const sheets = google.sheets({ version: "v4", auth });

async function search(query) {
  const res = await drive.files.list({
    q: query,
    fields: "files(id,name,webViewLink,owners)",
    pageSize: 25,
  });
  return res.data.files || [];
}

const searches = [
  "name contains 'Rahul Performance' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
  "name contains 'Performance Dashboard' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
  "name = 'Rahul' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
  "fullText contains 'Daily Performance' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
];

for (const q of searches) {
  try {
    const files = await search(q);
    console.log("\nQUERY:", q);
    console.log(JSON.stringify(files, null, 2));
  } catch (err) {
    console.log("\nQUERY FAIL:", q, String(err.message || err));
  }
}
