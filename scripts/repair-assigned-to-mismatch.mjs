import dotenv from "dotenv";
import path from "node:path";
import { google } from "googleapis";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

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
const dryRun = process.argv.includes("--dry-run");

const auth = new google.auth.JWT({
  email: process.env.FIREBASE_CLIENT_EMAIL,
  key: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });
const spreadsheetId = process.env.CRM_SYNC_SHEET_ID || process.env.CRM_SYNC_SPREADSHEET_ID || "1fiqGa4nRkSkun-nffI_QVtFQG4o4ubJGXkMIcEprI1k";
const sheetName = process.env.CRM_LEADS_SHEET_NAME || "Leads Data";

console.log(`Starting Assigned To Repair Script...`);
console.log(`Target Sheet: "${sheetName}" (${spreadsheetId})`);
if (dryRun) {
  console.log("--- DRY RUN MODE (No sheet cells will be updated) ---");
}

// 1. Fetch all leads from Firebase
console.log("Fetching all leads from Firestore...");
const leadsSnap = await db.collection("leads").get();
const firebaseLeads = new Map();

leadsSnap.docs.forEach((docSnap) => {
  const data = docSnap.data() || {};
  const leadUniqueId = String(data.leadUniqueId || docSnap.id || "").trim();
  const assignedTo = String(data.assignedTo || "").trim();
  if (leadUniqueId) {
    firebaseLeads.set(leadUniqueId.toLowerCase(), {
      leadUniqueId,
      assignedTo,
      clientName: data.clientName || "",
    });
  }
});

console.log(`Loaded ${firebaseLeads.size} leads from Firestore.`);

// 2. Fetch all rows from Google Sheet
console.log(`Fetching rows from Google Sheet "${sheetName}"...`);
const res = await sheets.spreadsheets.values.get({
  spreadsheetId,
  range: `${sheetName}!A1:K`,
  valueRenderOption: "FORMATTED_VALUE",
});

const rows = res.data.values || [];
if (rows.length < 2) {
  console.log("No data rows found in Google Sheet.");
  process.exit(0);
}

const headers = rows[0].map((h) => String(h || "").trim().toLowerCase());
const idColIdx = headers.indexOf("lead unique id");
const assignColIdx = headers.indexOf("assigned to");

if (idColIdx === -1 || assignColIdx === -1) {
  throw new Error(`Required headers "Lead Unique ID" or "Assigned To" not found in row 1.`);
}

console.log(`Header indices -> Lead Unique ID: col ${idColIdx + 1}, Assigned To: col ${assignColIdx + 1}`);

// 3. Compare Sheet vs Firebase assignedTo
const mismatches = [];

for (let i = 1; i < rows.length; i++) {
  const rowNum = i + 1;
  const row = rows[i];
  const sheetLeadId = String(row[idColIdx] || "").trim();
  const sheetAssignedTo = String(row[assignColIdx] || "").trim();

  if (!sheetLeadId) continue;

  const fbLead = firebaseLeads.get(sheetLeadId.toLowerCase());
  if (!fbLead) continue; // Lead not in Firebase

  const fbAssignedTo = fbLead.assignedTo;

  if (fbAssignedTo && sheetAssignedTo !== fbAssignedTo) {
    mismatches.push({
      rowNum,
      leadUniqueId: sheetLeadId,
      clientName: fbLead.clientName,
      sheetAssignedTo: sheetAssignedTo || "(empty)",
      firebaseAssignedTo: fbAssignedTo,
    });
  }
}

console.log(`\nFound ${mismatches.length} rows with Assigned To mismatch.`);

if (mismatches.length === 0) {
  console.log("All Google Sheet rows match Firebase assignedTo! No repairs needed.");
  process.exit(0);
}

console.log("\nMismatch Sample (first 10):");
mismatches.slice(0, 10).forEach((m) => {
  console.log(` Row ${m.rowNum} [${m.leadUniqueId} - ${m.clientName}]: Sheet="${m.sheetAssignedTo}" -> Firebase="${m.firebaseAssignedTo}"`);
});

if (dryRun) {
  console.log(`\n[DRY RUN COMPLETE] Run without --dry-run to update ${mismatches.length} rows in Google Sheet.`);
  process.exit(0);
}

// 4. Update Google Sheet rows in batch
console.log(`\nUpdating ${mismatches.length} mismatched cells in Google Sheet...`);

const dataUpdates = mismatches.map((m) => {
  // Convert 0-indexed column index to letter (e.g. index 10 = Column K)
  const colLetter = String.fromCharCode(65 + assignColIdx);
  return {
    range: `${sheetName}!${colLetter}${m.rowNum}`,
    values: [[m.firebaseAssignedTo]],
  };
});

// Update in batches of 200 requests to respect Google Sheets API limits
const BATCH_SIZE = 200;
let updatedTotal = 0;

for (let i = 0; i < dataUpdates.length; i += BATCH_SIZE) {
  const batchData = dataUpdates.slice(i, i + BATCH_SIZE);
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: batchData,
    },
  });
  updatedTotal += batchData.length;
  console.log(` Updated ${updatedTotal} / ${mismatches.length} sheet rows...`);
}

console.log(`\nRepair complete! ${updatedTotal} Google Sheet rows successfully updated to match Firebase assignedTo.`);
