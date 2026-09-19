import dotenv from "dotenv";
import path from "node:path";
import { google } from "googleapis";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { normalizeDateToIso } from "../functions/src/sheetDateUtils.js";

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
const sheetName = process.env.CRM_FOLLOWUP_LOGS_SHEET_NAME || "Follow-up Logs";

console.log(`Starting Follow-up Logs sync from Sheet "${sheetName}" (${spreadsheetId})...`);
if (dryRun) {
  console.log("--- DRY RUN MODE (No changes will be written to Firestore) ---");
}

// 1. Fetch existing Firestore followUpLogs for duplicate checking
console.log("Fetching existing followUpLogs from Firestore...");
const existingLogsSnap = await db.collection("followUpLogs").get();
const existingKeys = new Set();

existingLogsSnap.docs.forEach((docSnap) => {
  const data = docSnap.data() || {};
  const leadId = String(data.leadUniqueId || "").trim().toLowerCase();
  const followUpDate = String(data.followUpDate || "").trim();
  const createdAt = String(data.createdAt || "").trim();
  if (leadId) {
    // Duplicate match key: leadUniqueId + followUpDate or createdAt
    existingKeys.add(`${leadId}|${followUpDate}`);
    existingKeys.add(`${leadId}|${createdAt}`);
  }
});

console.log(`Found ${existingLogsSnap.size} existing followUpLogs in Firestore.`);

// 2. Fetch rows from Google Sheet
const res = await sheets.spreadsheets.values.get({
  spreadsheetId,
  range: `${sheetName}!A2:P`,
  valueRenderOption: "FORMATTED_VALUE",
});

const rows = res.data.values || [];
console.log(`Found ${rows.length} rows in "${sheetName}" sheet.`);

let newLogsToInsert = [];
let skippedDuplicates = 0;
let skippedEmpty = 0;

for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  const createdAtRaw = String(row[0] || "").trim(); // Col A
  const leadUniqueId = String(row[2] || "").trim(); // Col C
  const leadStatus = String(row[9] || "").trim();  // Col J
  const assignedTo = String(row[11] || "").trim(); // Col L
  const followUpDateRaw = String(row[13] || "").trim(); // Col N
  const initialRemark = String(row[14] || "").trim(); // Col O
  const detailRemark = String(row[15] || "").trim();  // Col P

  if (!leadUniqueId || (!followUpDateRaw && !createdAtRaw)) {
    skippedEmpty++;
    continue;
  }

  const createdAtIso = normalizeDateToIso(createdAtRaw) || new Date().toISOString();
  const followUpDateIso = normalizeDateToIso(followUpDateRaw) || "";

  const key1 = `${leadUniqueId.toLowerCase()}|${followUpDateIso}`;
  const key2 = `${leadUniqueId.toLowerCase()}|${createdAtIso}`;

  if (existingKeys.has(key1) || existingKeys.has(key2)) {
    skippedDuplicates++;
    continue;
  }

  // Mark keys as added to prevent duplicates within the sheet itself
  existingKeys.add(key1);
  existingKeys.add(key2);

  newLogsToInsert.push({
    leadUniqueId,
    followUpDate: followUpDateIso,
    leadStatus,
    remark: detailRemark || initialRemark || "",
    createdBy: assignedTo || "sheet_sync",
    createdAt: createdAtIso,
    source: "sheet_backfill",
  });
}

console.log(`Summary:`);
console.log(` - Total sheet rows evaluated: ${rows.length}`);
console.log(` - Skipped empty/invalid rows: ${skippedEmpty}`);
console.log(` - Skipped duplicates (already in Firestore): ${skippedDuplicates}`);
console.log(` - New follow-up logs to insert: ${newLogsToInsert.length}`);

if (newLogsToInsert.length === 0) {
  console.log("No new follow-up logs to upload. Firestore is fully up-to-date!");
  process.exit(0);
}

if (dryRun) {
  console.log("\n[DRY RUN COMPLETE] Run without --dry-run to commit changes to Firestore.");
  process.exit(0);
}

// 3. Perform batch write to Firestore
console.log(`Uploading ${newLogsToInsert.length} logs to Firestore in batches...`);
const BATCH_SIZE = 400;
let batch = db.batch();
let operationCount = 0;
let totalUploaded = 0;
const affectedLeadIds = new Set();

for (const logDoc of newLogsToInsert) {
  const docRef = db.collection("followUpLogs").doc();
  batch.set(docRef, logDoc);
  affectedLeadIds.add(logDoc.leadUniqueId);
  operationCount++;
  totalUploaded++;

  if (operationCount >= BATCH_SIZE) {
    await batch.commit();
    console.log(` Committed ${totalUploaded} / ${newLogsToInsert.length} logs...`);
    batch = db.batch();
    operationCount = 0;
  }
}

if (operationCount > 0) {
  await batch.commit();
  console.log(` Committed final batch. Total uploaded: ${totalUploaded}`);
}

// 4. Update noOfFollowups count on affected leads in Firestore
console.log(`Recalculating noOfFollowups for ${affectedLeadIds.size} unique leads...`);
let leadUpdateCount = 0;
for (const leadId of affectedLeadIds) {
  const logsSnap = await db.collection("followUpLogs").where("leadUniqueId", "==", leadId).get();
  const count = logsSnap.size;

  const leadRef = db.collection("leads").doc(leadId);
  const leadDoc = await leadRef.get();
  if (leadDoc.exists) {
    await leadRef.update({
      noOfFollowups: count,
      updatedAt: new Date().toISOString(),
    });
    leadUpdateCount++;
  }
}

console.log(`Updated follow-up counts for ${leadUpdateCount} lead documents in Firestore.`);
console.log("Sync complete!");
