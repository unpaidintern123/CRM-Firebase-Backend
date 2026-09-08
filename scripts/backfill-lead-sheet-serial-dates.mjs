/**
 * One-time: rewrite Firestore leads where date fields were stored as Sheets/Excel serial
 * doubles (e.g. 46043.7). Converts them to ISO strings using the same rules as inbound sync.
 *
 * Usage (from firebase-backend, with .env present):
 *   node scripts/backfill-lead-sheet-serial-dates.mjs --dry-run
 *   node scripts/backfill-lead-sheet-serial-dates.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import admin from "firebase-admin";
import dotenv from "dotenv";
import { normalizeSheetDateField } from "../functions/src/sheetDateUtils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });
}

const DATE_KEYS = [
  "leadDate",
  "followUpDate",
  "consutlationBookedDate",
  "consutlationVisitedDate",
  "orderDate",
];

const dryRun = process.argv.includes("--dry-run");
const db = admin.firestore();

function buildPatch(data) {
  const patch = {};
  for (const k of DATE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
    const next = normalizeSheetDateField(k, data[k]);
    if (next !== data[k]) patch[k] = next;
  }
  return patch;
}

const snap = await db.collection("leads").get();
let changed = 0;
let batch = db.batch();
let batchOps = 0;
const now = new Date().toISOString();

for (const doc of snap.docs) {
  const patch = buildPatch(doc.data());
  if (!Object.keys(patch).length) continue;
  changed += 1;
  if (dryRun) continue;
  batch.update(doc.ref, { ...patch, updatedAt: now });
  batchOps += 1;
  if (batchOps >= 400) {
    await batch.commit();
    batch = db.batch();
    batchOps = 0;
  }
}

if (!dryRun && batchOps > 0) {
  await batch.commit();
}

console.log(
  JSON.stringify(
    {
      success: true,
      dryRun,
      totalDocs: snap.size,
      docsWithDateRewrites: changed,
    },
    null,
    2
  )
);
