/**
 * Reproduces createLead sheet-mirror cutoff:
 * consultation log sheet append is fire-and-forget after HTTP return.
 *
 * Usage:
 *   node scripts/test-create-lead-sheet-cutoff.mjs
 *   node scripts/test-create-lead-sheet-cutoff.mjs --backfill-30000
 */
import dotenv from "dotenv";
import path from "node:path";
import { google } from "googleapis";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { appendSingleConsultationLogToSheets } from "../functions/src/sheetsExport.js";

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

const spreadsheetId = process.env.CRM_SYNC_SHEET_ID || process.env.CRM_SYNC_SPREADSHEET_ID;
const sheetName = process.env.CRM_CONSULTATION_LOGS_SHEET_NAME || "Consultation Booked Logs";
const leadId = "Lead ID - 30000";

function getAuth() {
  return new google.auth.JWT({
    email: process.env.FIREBASE_CLIENT_EMAIL,
    key: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

async function countSheetHits(needle) {
  const sheets = google.sheets({ version: "v4", auth: getAuth() });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A:C`,
    valueRenderOption: "FORMATTED_VALUE",
  });
  const rows = res.data.values || [];
  let hits = 0;
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].some((c) => String(c || "").includes(needle))) hits += 1;
  }
  return { totalRows: Math.max(rows.length - 1, 0), hits };
}

async function loadMayur() {
  const db = getFirestore();
  const leadSnap = await db.collection("leads").doc(leadId).get();
  if (!leadSnap.exists) throw new Error(`${leadId} missing in Firestore`);
  const lead = { ...leadSnap.data(), leadUniqueId: leadId };
  const logs = await db.collection("consultationLogs").where("leadUniqueId", "==", leadId).get();
  if (logs.empty) throw new Error(`${leadId} has no consultationLogs in Firestore`);
  const log = { leadUniqueId: leadId, ...logs.docs[0].data() };
  return { lead, log };
}

async function testAwaitedAppend() {
  console.log("\n=== TEST A: awaited appendSingleConsultationLogToSheets ===");
  const before = await countSheetHits(leadId);
  console.log("before", before);

  const { lead, log } = await loadMayur();
  const t0 = Date.now();
  const result = await appendSingleConsultationLogToSheets(lead, log);
  const ms = Date.now() - t0;
  console.log("append result", result, `took ${ms}ms`);

  const after = await countSheetHits(leadId);
  console.log("after", after);
  console.log(
    after.hits > before.hits
      ? "PASS: sheet row written when awaited"
      : after.hits > 0
        ? "INFO: row already present / unchanged"
        : "FAIL: awaited append did not add sheet row"
  );
  return { ms, before, after, result };
}

/**
 * Simulates Cloud Function returning before background work finishes:
 * start sheet append, then hard-exit before it can complete.
 */
async function testFireAndForgetCutoff() {
  console.log("\n=== TEST B: fire-and-forget + early process.exit (simulates CF cutoff) ===");
  const marker = `CUTOFF-TEST-${Date.now()}`;
  const fakeLead = {
    leadUniqueId: marker,
    clientName: "Cutoff Test DoNotUse",
    mobileNo: "0000000000",
    city: "Test",
    town: "",
    callType: "Incoming",
    platform: "Incoming",
    leadStatus: "Consultation Booked",
    rating: "1",
    assignedTo: "TEST",
    interestedIn: "Hair Patch",
    leadDate: new Date().toISOString(),
    initialRemark: "cutoff test",
    detailComment: "delete me",
    consultationType: "In-person",
  };
  const fakeLog = {
    leadUniqueId: marker,
    consultationBookedDate: new Date().toISOString(),
    consultationType: "In-person",
    createdAt: new Date().toISOString(),
  };

  const before = await countSheetHits(marker);
  console.log("before marker hits", before.hits);

  // Same pattern as createLead: do not await sheet mirror.
  const pending = appendSingleConsultationLogToSheets(fakeLead, fakeLog)
    .then((r) => {
      console.log("background finished (should not see this if cutoff)", r);
      return r;
    })
    .catch((err) => {
      console.error("background error", err);
    });

  // Typical HTTP handler returns in tens of ms; sheet write measured ~1–3s+.
  const CUTOFF_MS = 80;
  console.log(`returning/exiting in ${CUTOFF_MS}ms without awaiting sheet write...`);
  await new Promise((r) => setTimeout(r, CUTOFF_MS));

  // Force exit like a serverless instance freezing unfinished work after response.
  // Child process is used so the parent can still inspect the sheet.
  return { marker, pendingStarted: true, cutoffMs: CUTOFF_MS, beforeHits: before.hits, pending };
}

async function runCutoffInChild() {
  console.log("\n=== TEST B (child): spawn early-exit writer ===");
  const { spawn } = await import("node:child_process");
  const childCode = `
    import dotenv from "dotenv";
    import path from "node:path";
    import { appendSingleConsultationLogToSheets } from "../functions/src/sheetsExport.js";
    dotenv.config({ path: path.resolve(".env") });
    const marker = process.env.CUTOFF_MARKER;
    const fakeLead = {
      leadUniqueId: marker, clientName: "Cutoff Test DoNotUse", mobileNo: "0000000000",
      city: "Test", town: "", callType: "Incoming", platform: "Incoming",
      leadStatus: "Consultation Booked", rating: "1", assignedTo: "TEST",
      interestedIn: "Hair Patch", leadDate: new Date().toISOString(),
      initialRemark: "cutoff test", detailComment: "delete me", consultationType: "In-person",
    };
    const fakeLog = {
      leadUniqueId: marker, consultationBookedDate: new Date().toISOString(),
      consultationType: "In-person", createdAt: new Date().toISOString(),
    };
    appendSingleConsultationLogToSheets(fakeLead, fakeLog).then(() => {
      console.log("CHILD_BG_DONE");
    }).catch((e) => console.error("CHILD_BG_ERR", e));
    setTimeout(() => {
      console.log("CHILD_EXIT_WITHOUT_AWAIT");
      process.exit(0);
    }, 80);
  `;

  const marker = `CUTOFF-TEST-${Date.now()}`;
  const before = await countSheetHits(marker);

  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", childCode],
      {
        cwd: path.resolve("."),
        env: { ...process.env, CUTOFF_MARKER: marker },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      out += d.toString();
    });
    child.on("exit", (code) => {
      console.log("child output:", out.trim());
      console.log("child exit code", code);
      resolve();
    });
    child.on("error", reject);
  });

  // Give Sheets a moment in case write sneaked through.
  await new Promise((r) => setTimeout(r, 2500));
  const after = await countSheetHits(marker);
  console.log("marker before/after", { before: before.hits, after: after.hits, marker });
  console.log(
    after.hits === 0
      ? "PASS: early exit cut off sheet write (row missing) — matches createLead risk"
      : "UNEXPECTED: row appeared despite early exit (race won)"
  );
  return { marker, before, after };
}

async function runAwaitedInChild() {
  console.log("\n=== TEST C (child): await sheet write then exit ===");
  const { spawn } = await import("node:child_process");
  const marker = `AWAIT-TEST-${Date.now()}`;
  const childCode = `
    import dotenv from "dotenv";
    import path from "node:path";
    import { appendSingleConsultationLogToSheets } from "../functions/src/sheetsExport.js";
    dotenv.config({ path: path.resolve(".env") });
    const marker = process.env.CUTOFF_MARKER;
    const fakeLead = {
      leadUniqueId: marker, clientName: "Await Test DoNotUse", mobileNo: "0000000001",
      city: "Test", town: "", callType: "Incoming", platform: "Incoming",
      leadStatus: "Consultation Booked", rating: "1", assignedTo: "TEST",
      interestedIn: "Hair Patch", leadDate: new Date().toISOString(),
      initialRemark: "await test", detailComment: "delete me", consultationType: "In-person",
    };
    const fakeLog = {
      leadUniqueId: marker, consultationBookedDate: new Date().toISOString(),
      consultationType: "In-person", createdAt: new Date().toISOString(),
    };
    const t0 = Date.now();
    await appendSingleConsultationLogToSheets(fakeLead, fakeLog);
    console.log("CHILD_AWAIT_DONE ms=" + (Date.now() - t0));
    process.exit(0);
  `;

  const before = await countSheetHits(marker);
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", childCode],
      {
        cwd: path.resolve("."),
        env: { ...process.env, CUTOFF_MARKER: marker },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      out += d.toString();
    });
    child.on("exit", (code) => {
      console.log("child output:", out.trim());
      console.log("child exit code", code);
      resolve();
    });
    child.on("error", reject);
  });

  await new Promise((r) => setTimeout(r, 1000));
  const after = await countSheetHits(marker);
  console.log("marker before/after", { before: before.hits, after: after.hits, marker });
  console.log(
    after.hits > 0
      ? "PASS: awaiting before exit writes the sheet row"
      : "FAIL: awaited write missing"
  );
  return { marker, before, after };
}

const doBackfill = process.argv.includes("--backfill-30000");
const skipBackfill = process.argv.includes("--no-backfill");

const summary = {
  createLeadPattern:
    "consultationLogs.add().then(appendToSheets) — NOT awaited before return",
};

if (doBackfill || !skipBackfill) {
  // Default: prove awaited write works (also backfills Mayur if missing).
  summary.testA = await testAwaitedAppend();
}

summary.testB = await runCutoffInChild();
summary.testC = await runAwaitedInChild();

console.log("\n=== SUMMARY ===");
console.log(
  JSON.stringify(
    {
      hypothesis:
        "createLead returns before sheet consultation append finishes; Cloud Run can drop unfinished work",
      evidence: {
        awaitedWriteWorks: summary.testA
          ? summary.testA.after.hits > 0
          : null,
        awaitedWriteMs: summary.testA?.ms ?? null,
        earlyExitCutoffMissingRow: summary.testB.after.hits === 0,
        awaitThenExitWritesRow: summary.testC.after.hits > 0,
      },
      markers: {
        cutoffTest: summary.testB.marker,
        awaitTest: summary.testC.marker,
      },
    },
    null,
    2
  )
);
