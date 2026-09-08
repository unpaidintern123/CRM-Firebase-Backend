import { google } from "googleapis";
import { getFirestore } from "./firebase.js";
import { LEAD_FIELD_MAP } from "./mapper.js";
import { normalizeLeadDatesFromSheet } from "./sheetDateUtils.js";

const CRM_PROTECTED_FIELDS = new Set([
  "leadStatus",
  "detailComment",
  "comment",
  "followUpDate",
  "nextFollowUpDate",
  "lastFollowUpDate",
  "consultationStatus",
  "noOfFollowups",
  "assignedTo",
  "assignedAt",
  "updatedAt",
  "updatedBy",
  "crmUpdatedAt",
]);

const INGEST_OWNED_FIELDS = new Set([
  "leadDate",
  "clientName",
  "mobileNo",
  "secondaryMobileNo",
  "city",
  "town",
  "callType",
  "platform",
  "rating",
  "interestedIn",
  "consutlationBookedDate",
  "consutlationVisitedDate",
  "consultationType",
  "initialRemark",
  "Q1",
  "Q2",
  "Q3",
  "hearAboutUs",
  "orderStatus",
  "totalSalesAmount",
  "notBookedFeedback",
  "orderDate",
  "campaignname",
  "adsetname",
  "adname",
  "campaignsource",
  "placement",
  "preferredTimeToCall",
  "consultationMode",
]);

const HEADER_ALIASES = {
  campaignname: "campaignname",
  "campaign name": "campaignname",
  adsetname: "adsetname",
  "adset name": "adsetname",
  adname: "adname",
  "ad name": "adname",
  campaignsource: "campaignsource",
  "campaign source": "campaignsource",
  placement: "placement",
  "preferred time to call": "preferredTimeToCall",
  "preffered time to connect": "preferredTimeToCall",
  "client preference consultation mode": "consultationMode",
  "consultation mode": "consultationMode",
};

function getGoogleAuth() {
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  return new google.auth.JWT({
    email: process.env.FIREBASE_CLIENT_EMAIL,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeHeader(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function mapHeaderToField(header) {
  const normalized = normalizeHeader(header);
  return LEAD_FIELD_MAP[normalized] || HEADER_ALIASES[normalized] || null;
}

function rowToLead(headers, row) {
  const lead = {};
  headers.forEach((header, index) => {
    const field = mapHeaderToField(header);
    if (!field) return;
    lead[field] = row[index] ?? "";
  });
  lead.leadUniqueId = String(lead.leadUniqueId || "").trim();
  if (lead.mobileNo !== undefined) {
    lead.mobileNo = String(lead.mobileNo || "").trim();
  }
  if (lead.assignedTo !== undefined) {
    lead.assignedTo = String(lead.assignedTo || "").trim();
  }
  return lead;
}

function buildCreateDoc(lead, meta) {
  const doc = {};
  Object.keys(lead).forEach((key) => {
    if (lead[key] === undefined) return;
    doc[key] = lead[key];
  });
  return {
    ...doc,
    createdAt: meta.syncedAt,
    updatedAt: meta.syncedAt,
    sourceLastSyncedAt: meta.syncedAt,
    sheetSyncedAt: meta.syncedAt,
    sheetRowNumber: meta.sheetRowNumber,
    syncSource: "leads_sheet_inbound",
    syncStatus: meta.syncStatus,
    lastInboundSyncAt: meta.syncedAt,
    lastInboundSyncBy: meta.triggeredBy,
  };
}

function buildUpdateDoc(current, incoming, meta) {
  const patch = {
    sourceLastSyncedAt: meta.syncedAt,
    sheetSyncedAt: meta.syncedAt,
    sheetRowNumber: meta.sheetRowNumber,
    lastInboundSyncAt: meta.syncedAt,
    lastInboundSyncBy: meta.triggeredBy,
    syncSource: "leads_sheet_inbound",
  };

  Object.keys(incoming).forEach((key) => {
    if (key === "leadUniqueId") return;
    if (CRM_PROTECTED_FIELDS.has(key)) return;
    if (!INGEST_OWNED_FIELDS.has(key)) return;
    const currentValue = current[key];
    const incomingValue = incoming[key];
    if ((currentValue === undefined || currentValue === null || currentValue === "") && incomingValue !== "") {
      patch[key] = incomingValue;
      return;
    }
    if (incomingValue !== "" && currentValue !== incomingValue && current.crmUpdatedAt == null) {
      patch[key] = incomingValue;
    }
  });

  if ((!current.assignedTo || String(current.assignedTo).trim() === "") && incoming.assignedTo) {
    patch.assignedTo = incoming.assignedTo;
    patch.assignedAt = current.assignedAt || meta.syncedAt;
    patch.assignmentSource = current.assignmentSource || incoming.assignmentSource || "sheet";
    patch.assignmentStatus = "assigned";
    patch.syncStatus = "synced";
  }

  if (!patch.syncStatus) {
    patch.syncStatus = meta.syncStatus;
  }
  return patch;
}

export async function assignLeadBackendRoundRobin(dbParam = null) {
  const db = dbParam || getFirestore();
  const configRef = db.collection("config").doc("leadAssignment");
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(configRef);
    const data = snap.exists ? snap.data() : {};
    const assignees = Array.isArray(data.activeAssignees)
      ? data.activeAssignees.map((a) => String(a || "").trim()).filter(Boolean)
      : [];

    if (!assignees.length) {
      return { assignedTo: null, error: "No active assignees configured" };
    }

    const rawIndex = Number.isInteger(data.lastAssignedIndex) ? data.lastAssignedIndex : -1;
    const safeIndex = rawIndex >= 0 && rawIndex < assignees.length ? rawIndex : -1;
    const nextIndex = (safeIndex + 1) % assignees.length;
    const assignedTo = assignees[nextIndex];

    tx.set(
      configRef,
      {
        activeAssignees: assignees,
        lastAssignedIndex: nextIndex,
        updatedAt: nowIso(),
      },
      { merge: true }
    );

    return { assignedTo, error: null };
  });
}

export async function syncLeadsSheetToFirestore(options = {}) {
  const startedAt = nowIso();
  const {
    dryRun = false,
    limit = null,
    startRow = 2,
    allowBackendFallbackAssignment = true,
    skipExisting = false,
    triggeredBy = "manual",
  } = options;

  const spreadsheetId = process.env.CRM_SYNC_SPREADSHEET_ID || process.env.CRM_SYNC_SHEET_ID;
  const sheetName = process.env.CRM_LEADS_SHEET_NAME || "Leads Data";
  const summary = {
    dryRun,
    totalRowsRead: 0,
    validRows: 0,
    skippedMissingLeadUniqueId: 0,
    duplicateLeadUniqueIds: [],
    possibleDuplicatePhones: [],
    created: 0,
    updated: 0,
    skippedExisting: 0,
    skippedBlankAssignedTo: 0,
    backendAssigned: 0,
    assignmentPending: 0,
    errors: [],
    startedAt,
    finishedAt: null,
  };

  if (!spreadsheetId) {
    throw new Error("Missing CRM_SYNC_SPREADSHEET_ID (or CRM_SYNC_SHEET_ID) environment variable.");
  }

  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const readRange = `${sheetName}!A:AO`;
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: readRange,
  });
  const rows = response.data.values || [];
  if (!rows.length) {
    summary.finishedAt = nowIso();
    return summary;
  }

  const headers = rows[0];
  const rawRows = rows.slice(Math.max(startRow - 1, 1));
  summary.totalRowsRead = rawRows.length;

  const deduped = new Map();
  const seenPhones = new Map();
  for (let index = 0; index < rawRows.length; index += 1) {
    if (limit != null && deduped.size >= Number(limit)) break;
    const row = rawRows[index];
    const rowNumber = Math.max(startRow, 2) + index;
    const lead = normalizeLeadDatesFromSheet(rowToLead(headers, row));
    if (!lead.leadUniqueId) {
      summary.skippedMissingLeadUniqueId += 1;
      continue;
    }
    if (deduped.has(lead.leadUniqueId)) {
      summary.duplicateLeadUniqueIds.push({
        leadUniqueId: lead.leadUniqueId,
        keptRowNumber: deduped.get(lead.leadUniqueId).sheetRowNumber,
        duplicateRowNumber: rowNumber,
      });
      continue;
    }
    if (lead.mobileNo) {
      if (seenPhones.has(lead.mobileNo) && seenPhones.get(lead.mobileNo) !== lead.leadUniqueId) {
        summary.possibleDuplicatePhones.push({
          mobileNo: lead.mobileNo,
          leadUniqueId: lead.leadUniqueId,
          otherLeadUniqueId: seenPhones.get(lead.mobileNo),
        });
      } else {
        seenPhones.set(lead.mobileNo, lead.leadUniqueId);
      }
    }
    deduped.set(lead.leadUniqueId, { lead, sheetRowNumber: rowNumber });
  }

  summary.validRows = deduped.size;
  const db = getFirestore();
  const syncedAt = nowIso();

  for (const [leadUniqueId, item] of deduped.entries()) {
    try {
      const { lead, sheetRowNumber } = item;
      const ref = db.collection("leads").doc(String(leadUniqueId));
      const snap = await ref.get();
      const existing = snap.exists ? snap.data() : null;

      if (existing && skipExisting) {
        summary.skippedExisting += 1;
        continue;
      }

      const incoming = { ...lead };
      let syncStatus = "synced";

      if (!incoming.assignedTo) {
        if (allowBackendFallbackAssignment) {
          const fallback = await assignLeadBackendRoundRobin(db);
          if (fallback.assignedTo) {
            incoming.assignedTo = fallback.assignedTo;
            incoming.assignedAt = syncedAt;
            incoming.assignmentSource = "backend_sheet_sync_fallback";
            incoming.assignmentStatus = "assigned";
            summary.backendAssigned += 1;
          } else {
            incoming.assignmentStatus = "pending";
            incoming.assignmentError = fallback.error || "Assignment failed";
            syncStatus = "needs_assignment";
            summary.assignmentPending += 1;
            summary.skippedBlankAssignedTo += 1;
          }
        } else {
          incoming.assignmentStatus = "pending";
          incoming.assignmentError = "assignedTo blank in sheet and backend fallback disabled";
          syncStatus = "needs_assignment";
          summary.assignmentPending += 1;
          summary.skippedBlankAssignedTo += 1;
        }
      } else {
        incoming.assignedAt = incoming.assignedAt || syncedAt;
        incoming.assignmentSource = incoming.assignmentSource || "sheet";
        incoming.assignmentStatus = "assigned";
      }

      const meta = { syncedAt, sheetRowNumber, triggeredBy, syncStatus };
      if (!existing) {
        const createDoc = buildCreateDoc(incoming, meta);
        if (!dryRun) {
          await ref.set(createDoc, { merge: false });
        }
        summary.created += 1;
      } else {
        const patch = buildUpdateDoc(existing, incoming, meta);
        if (!dryRun) {
          await ref.set(patch, { merge: true });
        }
        summary.updated += 1;
      }
    } catch (err) {
      summary.errors.push({
        leadUniqueId,
        message: String(err && err.message ? err.message : err),
      });
    }
  }

  summary.finishedAt = nowIso();
  return summary;
}
