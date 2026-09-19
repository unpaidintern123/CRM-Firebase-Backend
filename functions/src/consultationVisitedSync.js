import { updateMultipleLeadRowsInSheets } from "./sheetsExport.js";
import { google } from "googleapis";
import { getFirestore } from "./firebase.js";
import { ApiError } from "./errors.js";
import { normalizeDateToIso } from "./sheetDateUtils.js";

function nowIso() {
  return new Date().toISOString();
}

function getGoogleAuth() {
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  return new google.auth.JWT({
    email: process.env.FIREBASE_CLIENT_EMAIL,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
}

function normalizeMobile(value) {
  if (value === null || value === undefined) return "";
  let raw = String(value).trim();
  if (!raw) return "";
  if (/^\d+\.0$/.test(raw)) raw = raw.replace(/\.0$/, "");
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (!/^\d{10}$/.test(digits)) return "";
  return digits;
}

function parseSheetsDateValue(value) {
  return normalizeDateToIso(value);
}

function toMs(iso) {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function setLatestByMobile(map, mobile, candidate) {
  if (!mobile || !candidate.isoDate) return;
  const prev = map.get(mobile);
  if (!prev || candidate.dateMs >= prev.dateMs) {
    map.set(mobile, candidate);
  }
}

function createCandidate(source, sourceRow, isoDate) {
  return {
    source,
    sourceRow,
    isoDate,
    dateMs: toMs(isoDate),
  };
}

function pickLatestCandidate(fmsCandidate, afterCandidate) {
  if (!fmsCandidate) return afterCandidate || null;
  if (!afterCandidate) return fmsCandidate;
  return afterCandidate.dateMs >= fmsCandidate.dateMs ? afterCandidate : fmsCandidate;
}

function asNormalized(value) {
  return String(value || "").trim().toLowerCase();
}

export async function syncConsultationVisitedLeads(options = {}) {
  const {
    dryRun = false,
    limit = null,
    triggeredBy = "manual",
  } = options;

  const spreadsheetId = process.env.CONSULTATION_SYNC_SPREADSHEET_ID || process.env.CRM_SYNC_SHEET_ID;
  if (!spreadsheetId) {
    throw new ApiError(400, "MISSING_SPREADSHEET_ID", "Set CONSULTATION_SYNC_SPREADSHEET_ID or CRM_SYNC_SHEET_ID");
  }

  const summary = {
    dryRun,
    spreadsheetId,
    scannedBookedLeads: 0,
    leadsWithInvalidMobile: 0,
    fmsRowsRead: 0,
    afterRowsRead: 0,
    matchedViaFms: 0,
    matchedViaAfterConsultation: 0,
    updatesPlanned: 0,
    updatesApplied: 0,
    skippedAlreadyVisited: 0,
    skippedNoCandidate: 0,
    skippedNoDate: 0,
    errors: [],
    startedAt: nowIso(),
    finishedAt: null,
    samples: [],
  };

  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const resp = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: ["Consultation FMS!A7:L", "After Consultation!A2:AG"],
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const ranges = resp.data.valueRanges || [];
  const fmsRows = ranges[0]?.values || [];
  const afterRows = ranges[1]?.values || [];
  summary.fmsRowsRead = fmsRows.length;
  summary.afterRowsRead = afterRows.length;

  const fmsByMobile = new Map();
  for (let i = 0; i < fmsRows.length; i += 1) {
    const row = fmsRows[i] || [];
    const mobile = normalizeMobile(row[2]);
    if (!mobile) continue;
    const isoDate = parseSheetsDateValue(row[0]); // old logic row[0]
    if (!isoDate) continue;
    setLatestByMobile(fmsByMobile, mobile, createCandidate("consultation_fms", i + 7, isoDate));
  }

  const afterByMobile = new Map();
  for (let i = 0; i < afterRows.length; i += 1) {
    const row = afterRows[i] || [];
    const mobile = normalizeMobile(row[2]);
    if (!mobile) continue;
    const consultationType = asNormalized(row[4]);
    const status = asNormalized(row[5]);
    // Match legacy behavior: exclude In-person and No Show rows.
    if (consultationType === "in-person") continue;
    if (status === "no show") continue;
    // Legacy writes row[32] from Apps Script; A2:AG provides equivalent at row[32] index.
    const isoDate = parseSheetsDateValue(row[32]);
    if (!isoDate) continue;
    setLatestByMobile(afterByMobile, mobile, createCandidate("after_consultation", i + 2, isoDate));
  }

  const db = getFirestore();
  // Exact status string required (same as CRM UI option value).
  const snap = await db.collection("leads").where("leadStatus", "==", "Consultation Booked").get();
  const docs = limit != null ? snap.docs.slice(0, Number(limit)) : snap.docs;
  summary.scannedBookedLeads = docs.length;

  const updates = [];
  for (const doc of docs) {
    const lead = doc.data() || {};
    const status = String(lead.leadStatus || "").trim();
    // Extra spaces / wrong casing would have been excluded by the query already;
    // keep an explicit guard for clarity.
    if (status !== "Consultation Booked") {
      continue;
    }

    const mobile = normalizeMobile(lead.mobileNo);
    if (!mobile) {
      summary.leadsWithInvalidMobile += 1;
      summary.skippedNoCandidate += 1;
      continue;
    }

    const fmsCandidate = fmsByMobile.get(mobile) || null;
    const afterCandidate = afterByMobile.get(mobile) || null;
    if (!fmsCandidate && !afterCandidate) {
      summary.skippedNoCandidate += 1;
      continue;
    }
    if (fmsCandidate) summary.matchedViaFms += 1;
    if (afterCandidate) summary.matchedViaAfterConsultation += 1;

    const chosen = pickLatestCandidate(fmsCandidate, afterCandidate);
    if (!chosen || !chosen.isoDate) {
      summary.skippedNoDate += 1;
      continue;
    }

    if (String(lead.leadStatus || "").trim() === "Consultation Visited") {
      summary.skippedAlreadyVisited += 1;
      continue;
    }

    updates.push({
      ref: doc.ref,
      leadUniqueId: doc.id,
      previousStatus: lead.leadStatus || "",
      isoDate: chosen.isoDate,
      source: chosen.source,
      sourceRow: chosen.sourceRow,
      actor: "consultation_visited_sync",
    });
  }

  summary.updatesPlanned = updates.length;
  summary.samples = updates.slice(0, 20).map((u) => ({
    leadUniqueId: u.leadUniqueId,
    source: u.source,
    sourceRow: u.sourceRow,
    consutlationVisitedDate: u.isoDate,
  }));

  if (!dryRun && updates.length) {
    let batch = db.batch();
    let ops = 0;
    for (const u of updates) {
      const stamp = nowIso();
      batch.set(
        u.ref,
        {
          leadStatus: "Consultation Visited",
          consutlationVisitedDate: u.isoDate,
          updatedAt: stamp,
          crmUpdatedAt: stamp,
          consultationVisitedSource: u.source,
          consultationVisitedSourceRow: u.sourceRow,
          consultationVisitedSyncedAt: stamp,
          consultationVisitedSyncedBy: triggeredBy,
        },
        { merge: true }
      );

      const trackingRef = db.collection("leadStatusTracking").doc();
      batch.set(trackingRef, {
        leadUniqueId: u.leadUniqueId,
        previousStatus: u.previousStatus,
        newStatus: "Consultation Visited",
        changedBy: u.actor,
        createdAt: stamp,
        source: "consultationVisitedSync",
      });

      const activityRef = db.collection("userActivityLogs").doc();
      batch.set(activityRef, {
        leadUniqueId: u.leadUniqueId,
        action: "CONSULTATION_VISITED_SYNCED",
        actor: u.actor,
        createdAt: stamp,
        metadata: {
          source: u.source,
          sourceRow: u.sourceRow,
        },
      });

      ops += 3;
      if (ops >= 450) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }
    if (ops > 0) {
      await batch.commit();
    }
    summary.updatesApplied = updates.length;

    // Trigger batch single-row update to Leads Data sheet
    try {
      const updatedIds = updates.map((u) => String(u.leadUniqueId)).filter(Boolean);
      if (updatedIds.length) {
        const updatedLeads = [];
        // Firestore getAll is safest in chunks of 100.
        for (let i = 0; i < updatedIds.length; i += 100) {
          const chunk = updatedIds.slice(i, i + 100);
          const updatedSnaps = await db.getAll(...chunk.map((id) => db.collection("leads").doc(id)));
          for (const s of updatedSnaps) {
            if (!s.exists) continue;
            // Always include doc id — some leads omit leadUniqueId field on the document body.
            updatedLeads.push({ ...s.data(), leadUniqueId: s.id });
          }
        }
        await updateMultipleLeadRowsInSheets(updatedLeads);
      }
    } catch (err) {
      console.error("Failed to sync consultation visited rows to sheets:", err);
      summary.errors.push(String(err?.message || err));
    }
  }

  summary.finishedAt = nowIso();
  return summary;
}
