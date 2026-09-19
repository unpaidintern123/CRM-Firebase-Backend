/**
 * Repair Lead IDs that jumped to 30000+ back onto the continuous sequence
 * after the highest ID below 30000 (e.g. 30000 → 25290).
 *
 * Updates:
 *  - Firestore leads (copy doc → new id, delete old)
 *  - consultationLogs / followUpLogs / leadStatusTracking / userActivityLogs
 *  - Google Sheets: Leads Data, Consultation Booked Logs, Follow-up Logs
 *  - config/leadIds counter
 *
 * Usage:
 *   node scripts/repair-lead-ids-30000.mjs              # dry-run
 *   node scripts/repair-lead-ids-30000.mjs --apply      # write
 *   node scripts/repair-lead-ids-30000.mjs --apply --min-bad=30000
 */
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
const apply = process.argv.includes("--apply");
const minBadRaw = process.argv.find((a) => a.startsWith("--min-bad="));
const MIN_BAD = minBadRaw ? Number(minBadRaw.split("=")[1]) : 30000;

const spreadsheetId = process.env.CRM_SYNC_SHEET_ID || process.env.CRM_SYNC_SPREADSHEET_ID;
const REF_COLLECTIONS = [
  "consultationLogs",
  "followUpLogs",
  "leadStatusTracking",
  "userActivityLogs",
];

function parseLeadIdNumber(leadUniqueId) {
  const match = String(leadUniqueId || "").trim().match(/(\d+)\s*$/);
  if (!match) return 0;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : 0;
}

function formatLeadId(n) {
  return `Lead ID - ${n}`;
}

function getSheetsClient() {
  const auth = new google.auth.JWT({
    email: process.env.FIREBASE_CLIENT_EMAIL,
    key: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function buildRenamePlan() {
  const snap = await db.collection("leads").get();
  let maxGood = 0;
  const bad = [];
  for (const doc of snap.docs) {
    const n = parseLeadIdNumber(doc.id);
    if (n >= MIN_BAD) {
      bad.push({
        id: doc.id,
        n,
        data: doc.data() || {},
      });
    } else if (n > maxGood) {
      maxGood = n;
    }
  }
  bad.sort((a, b) => a.n - b.n);

  const mapping = bad.map((item, index) => {
    const toNum = maxGood + 1 + index;
    return {
      from: item.id,
      to: formatLeadId(toNum),
      fromNum: item.n,
      toNum,
      clientName: item.data.clientName || "",
      assignedTo: item.data.assignedTo || "",
      data: item.data,
    };
  });

  // Safety: target must not already exist
  const existingIds = new Set(snap.docs.map((d) => d.id));
  for (const m of mapping) {
    if (existingIds.has(m.to)) {
      throw new Error(`Target ID already exists in Firestore: ${m.to}`);
    }
  }

  return { maxGood, mapping };
}

async function rewriteLeadDoc(fromId, toId, data) {
  const payload = {
    ...data,
    leadUniqueId: toId,
    idRepairedAt: new Date().toISOString(),
    idRepairedFrom: fromId,
  };
  await db.collection("leads").doc(toId).set(payload, { merge: false });
  await db.collection("leads").doc(fromId).delete();
}

async function rewriteRefs(fromId, toId) {
  const summary = {};
  for (const col of REF_COLLECTIONS) {
    const snap = await db.collection(col).where("leadUniqueId", "==", fromId).get();
    summary[col] = snap.size;
    if (!apply || snap.empty) continue;
    let batch = db.batch();
    let ops = 0;
    for (const doc of snap.docs) {
      batch.update(doc.ref, {
        leadUniqueId: toId,
        idRepairedAt: new Date().toISOString(),
        idRepairedFrom: fromId,
      });
      ops += 1;
      if (ops >= 400) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }
    if (ops) await batch.commit();
  }
  return summary;
}

async function rewriteSheetTab(sheets, sheetName, idColumnHeader, mappingByFrom) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A:Z`,
    valueRenderOption: "FORMATTED_VALUE",
  });
  const rows = res.data.values || [];
  if (!rows.length) return { sheetName, updatedCells: 0 };

  const headers = rows[0].map((h) => String(h || "").trim().toLowerCase());
  const idIdx = headers.indexOf(String(idColumnHeader).toLowerCase());
  if (idIdx < 0) {
    return { sheetName, updatedCells: 0, error: `header not found: ${idColumnHeader}` };
  }

  const data = [];
  let updatedCells = 0;
  for (let r = 1; r < rows.length; r += 1) {
    const oldId = String(rows[r][idIdx] || "").trim();
    const neu = mappingByFrom.get(oldId);
    if (!neu) continue;
    const colLetter =
      idIdx < 26
        ? String.fromCharCode(65 + idIdx)
        : String.fromCharCode(64 + Math.floor(idIdx / 26)) + String.fromCharCode(65 + (idIdx % 26));
    const a1 = `${sheetName}!${colLetter}${r + 1}`;
    data.push({ range: a1, values: [[neu]] });
    updatedCells += 1;
  }

  if (apply && data.length) {
    // batchUpdate in chunks of 100
    for (let i = 0; i < data.length; i += 100) {
      const chunk = data.slice(i, i + 100);
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: "RAW",
          data: chunk,
        },
      });
    }
  }

  return { sheetName, updatedCells, sample: data.slice(0, 5).map((d) => d.range) };
}

async function updateCounter(nextId) {
  if (!apply) return;
  await db.collection("config").doc("leadIds").set(
    {
      nextId,
      updatedAt: new Date().toISOString(),
      repairedBy: "repair-lead-ids-30000",
    },
    { merge: true }
  );
}

const { maxGood, mapping } = await buildRenamePlan();
const mappingByFrom = new Map(mapping.map((m) => [m.from, m.to]));

console.log(
  JSON.stringify(
    {
      mode: apply ? "APPLY" : "DRY_RUN",
      minBad: MIN_BAD,
      maxGood,
      renameCount: mapping.length,
      renames: mapping.map((m) => ({
        from: m.from,
        to: m.to,
        clientName: m.clientName,
        assignedTo: m.assignedTo,
      })),
      nextCounterAfterRepair: maxGood + mapping.length + 1,
    },
    null,
    2
  )
);

if (!mapping.length) {
  console.log("Nothing to repair.");
  process.exit(0);
}

const results = [];
for (const m of mapping) {
  const refs = await rewriteRefs(m.from, m.to);
  if (apply) {
    await rewriteLeadDoc(m.from, m.to, m.data);
  }
  results.push({ from: m.from, to: m.to, refs, leadRewritten: apply });
}

let sheetResults = [];
if (spreadsheetId) {
  const sheets = getSheetsClient();
  sheetResults = [
    await rewriteSheetTab(sheets, "Leads Data", "lead unique id", mappingByFrom),
    await rewriteSheetTab(sheets, "Consultation Booked Logs", "lead unique id", mappingByFrom),
    await rewriteSheetTab(sheets, "Follow-up Logs", "lead unique id", mappingByFrom),
  ];
} else {
  sheetResults = [{ error: "No CRM_SYNC_SHEET_ID configured" }];
}

await updateCounter(maxGood + mapping.length + 1);

console.log(
  JSON.stringify(
    {
      firestore: results,
      sheets: sheetResults,
      done: apply,
      hint: apply
        ? "Repair applied. Next upload should allocate after the new max."
        : "Dry-run only. Re-run with --apply to write changes.",
    },
    null,
    2
  )
);
