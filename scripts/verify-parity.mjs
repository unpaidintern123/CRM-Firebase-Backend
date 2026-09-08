import fs from "node:fs";
import path from "node:path";
import xlsx from "xlsx";
import dotenv from "dotenv";
import admin from "firebase-admin";

dotenv.config({ path: path.resolve(".env") });

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    }),
  });
}

const db = admin.firestore();
const workbookPath = path.resolve("../CRM Clone.xlsx");
if (!fs.existsSync(workbookPath)) throw new Error("CRM Clone.xlsx missing for parity check");
const workbook = xlsx.readFile(workbookPath);
const leadsRows = xlsx.utils.sheet_to_json(workbook.Sheets["Leads Data"], { defval: "" });

const snap = await db.collection("leads").get();
const firestoreCount = snap.size;
const sheetCount = leadsRows.filter((row) => row["Lead Unique ID"] || row["lead unique id"]).length;

const sampleIds = leadsRows
  .map((row) => row["Lead Unique ID"] || row["lead unique id"])
  .filter(Boolean)
  .slice(0, 25);

let sampleMissing = 0;
for (const id of sampleIds) {
  const doc = await db.collection("leads").doc(String(id)).get();
  if (!doc.exists) sampleMissing += 1;
}

console.log(
  JSON.stringify(
    {
      success: true,
      sheetCount,
      firestoreCount,
      delta: firestoreCount - sheetCount,
      sampleChecked: sampleIds.length,
      sampleMissing,
    },
    null,
    2
  )
);
