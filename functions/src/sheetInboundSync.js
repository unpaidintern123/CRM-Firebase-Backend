import { google } from "googleapis";
import { getFirestore } from "./firebase.js";
import { LEAD_FIELD_MAP } from "./mapper.js";
import {
  DATE_FIELDS,
  normalizeDateToIso,
  normalizeLeadDatesFromSheet,
} from "./sheetDateUtils.js";

/**
 * Firebase is source of truth for existing leads.
 * Inbound sync creates new sheet rows only (skipExisting defaults true).
 * If skipExisting is forced false (rare repair), these server/meta fields still never overwrite.
 */
const NEVER_OVERWRITE_FROM_SHEET = new Set([
  "leadUniqueId",
  "createdAt",
  "updatedAt",
  "updatedBy",
  "crmUpdatedAt",
  "assignedAt",
  "lastIdempotencyKey",
  "syncSource",
  "sheetSyncedAt",
  "sourceLastSyncedAt",
  "sheetRowNumber",
  "lastInboundSyncAt",
  "lastInboundSyncBy",
  "dateTimeRepairedAt",
  "dateTimeRepairedFrom",
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
    if (NEVER_OVERWRITE_FROM_SHEET.has(key)) return;
    const currentValue = current[key];
    const incomingValue = incoming[key];
    const incomingNonEmpty =
      incomingValue !== undefined &&
      incomingValue !== null &&
      String(incomingValue).trim() !== "";
    if (!incomingNonEmpty) return; // never clear Firebase with blank sheet cells

    // Repair path only (skipExisting=false): sheet fills non-empty diffs.
    if (DATE_FIELDS.has(key)) {
      const incomingIso = normalizeDateToIso(incomingValue);
      if (!incomingIso) return;
      if (normalizeDateToIso(currentValue) !== incomingIso) {
        patch[key] = incomingIso;
      }
      return;
    }

    const normalizedIncoming =
      typeof incomingValue === "string" ? incomingValue.trim() : incomingValue;
    if (String(currentValue ?? "").trim() !== String(normalizedIncoming).trim()) {
      patch[key] = normalizedIncoming;
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

    // Match Apps Script assignLeads(): Mon = Active+Coming; other days = Active only.
    // Use Asia/Kolkata so "Monday" matches CRM business day.
    const weekday = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata",
      weekday: "short",
    }).format(new Date());
    const isMonday = weekday === "Mon";

    const activeAssignees = Array.isArray(data.activeAssignees)
      ? data.activeAssignees.map((a) => String(a || "").trim()).filter(Boolean)
      : [];
    const mondayAssignees = Array.isArray(data.mondayEligibleAssignees)
      ? data.mondayEligibleAssignees.map((a) => String(a || "").trim()).filter(Boolean)
      : [];

    const assignees = isMonday ? mondayAssignees : activeAssignees;

    if (!assignees.length) {
      return {
        assignedTo: null,
        error: isMonday
          ? "No Monday-eligible (Active + Coming) assignees configured"
          : "No active assignees configured",
      };
    }

    const rawIndex = Number.isInteger(data.lastAssignedIndex) ? data.lastAssignedIndex : -1;
    const safeIndex = rawIndex >= 0 && rawIndex < assignees.length ? rawIndex : -1;
    const nextIndex = (safeIndex + 1) % assignees.length;
    const assignedTo = assignees[nextIndex];

    tx.set(
      configRef,
      {
        activeAssignees,
        mondayEligibleAssignees: mondayAssignees,
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
    // Default: import new sheet leads only; never modify existing Firebase docs.
    skipExisting = true,
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
  const readRange = `${sheetName}!A:AQ`;
  // UNFORMATTED_VALUE keeps Sheets serials with fractional time (visit/booked clock).
  // FORMATTED_VALUE often returns date-only display text and drops time into Firebase.
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: readRange,
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "SERIAL_NUMBER",
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

      if (!incoming.assignedTo || incoming.assignedTo.trim().toLowerCase() === "unassigned") {
        incoming.assignedTo = "Unassigned";
        incoming.assignmentStatus = "pending";
        incoming.assignmentSource = "sheet_unassigned";
        summary.assignmentPending += 1;
        summary.skippedBlankAssignedTo += 1;
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
