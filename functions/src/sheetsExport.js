import { google } from "googleapis";
import { getLeads } from "./leadService.js";
import { getFirestore } from "./firebase.js";
import { toSheetsSerialDate } from "./sheetDateUtils.js";
import { LEAD_FIELD_MAP } from "./mapper.js";

function getGoogleAuth() {
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  return new google.auth.JWT({
    email: process.env.FIREBASE_CLIENT_EMAIL,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

/**
 * Write dates as Sheets serial numbers (not text).
 * Column numberFormat still shows dd/MM/yyyy HH:mm:ss; formula bar has no leading apostrophe.
 */
function cellDate(value) {
  return toSheetsSerialDate(value);
}

/**
 * Phone as a real number cell (strips non-digits; drops leading 91 when 12 digits).
 * Empty / unparseable → "".
 */
function cellPhone(value) {
  if (value === null || value === undefined || value === "") return "";
  let digits = String(value).replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  const n = Number(digits);
  return Number.isFinite(n) ? n : "";
}

/** Numeric sheet cell; empty / non-numeric → "". */
function cellNumber(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const cleaned = String(value).replace(/,/g, "").trim();
  if (!cleaned) return "";
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : "";
}

/** Flatten multiline text so Sheets append/table detection cannot split a log across rows. */
function cellText(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const FIELD_TO_HEADER = Object.fromEntries(
  Object.entries(LEAD_FIELD_MAP).map(([header, field]) => [field, header])
);

const SHEET_DATE_FIELDS = new Set([
  "leadDate",
  "followUpDate",
  "consutlationBookedDate",
  "consutlationVisitedDate",
  "orderDate",
  "firstContactTimestamp",
]);

const SHEET_PHONE_FIELDS = new Set(["mobileNo", "secondaryMobileNo"]);

const SHEET_NUMBER_FIELDS = new Set([
  "noOfFollowups",
  "totalSalesAmount",
  "leadScore",
]);

/** Never patch these from CRM update → sheet (identity / server meta). */
const SHEET_PATCH_SKIP_FIELDS = new Set([
  "leadUniqueId",
  "leadDate",
  "actor",
  "idempotencyKey",
  "updatedAt",
  "crmUpdatedAt",
  "createdAt",
  "lastIdempotencyKey",
  "sheetRowNumber",
  "sheetSyncedAt",
  "sourceLastSyncedAt",
  "lastInboundSyncAt",
  "lastInboundSyncBy",
  "syncSource",
  "syncStatus",
  "assignmentStatus",
  "assignmentSource",
  "assignedAt",
]);

function formatSheetCellValue(field, value) {
  if (SHEET_DATE_FIELDS.has(field)) return cellDate(value);
  if (SHEET_PHONE_FIELDS.has(field)) return cellPhone(value);
  if (SHEET_NUMBER_FIELDS.has(field)) return cellNumber(value);
  if (value === undefined || value === null) return "";
  return value;
}

function toRow(lead) {
  return [
    cellDate(lead.leadDate),
    lead.leadUniqueId || "",
    lead.clientName || "",
    cellPhone(lead.mobileNo),
    lead.city || "",
    lead.town || "",
    lead.callType || "",
    lead.platform || "",
    lead.leadStatus || "",
    lead.rating || "",
    lead.assignedTo || "",
    lead.interestedIn || "",
    cellDate(lead.followUpDate),
    cellNumber(lead.noOfFollowups),
    cellDate(lead.consutlationBookedDate),
    cellDate(lead.consutlationVisitedDate),
    lead.consultationType || "",
    lead.initialRemark || "",
    lead.detailComment || "",
    lead.Q1 || "",
    lead.Q2 || "",
    lead.Q3 || "",
    lead.hairFallSince || "",
    lead.doneHairTransplantBefore || "",
    lead.gottenHairSystemBefore || "",
    lead.hearAboutUs || "",
    lead.campaignname || "",
    lead.adsetname || "",
    lead.adname || "",
    lead.campaignsource || "",
    lead.placement || "",
    lead.orderStatus || "",
    cellNumber(lead.totalSalesAmount),
    cellNumber(lead.leadScore),
    lead.leadQualification || "",
    lead.consultationStatus || "",
    lead.notBookedFeedback || "",
    cellDate(lead.orderDate),
    lead.consultationMode || "",
    cellPhone(lead.secondaryMobileNo),
    lead.preferredTimeToCall || "",
    cellDate(lead.firstContactTimestamp),
    lead.leadLabel || "",
  ];
}

function followUpLogToRow(log, lead) {
  return [
    cellDate(log.createdAt),
    cellDate(lead?.leadDate),
    cellText(log.leadUniqueId),
    cellText(lead?.clientName),
    cellPhone(lead?.mobileNo),
    cellText(lead?.city),
    cellText(lead?.town),
    cellText(lead?.callType),
    cellText(lead?.platform),
    cellText(log.leadStatus || lead?.leadStatus),
    cellText(lead?.rating),
    cellText(lead?.assignedTo),
    cellText(lead?.interestedIn),
    cellDate(log.followUpDate),
    cellText(lead?.initialRemark),
    cellText(log.remark || lead?.detailComment),
  ];
}

function consultationLogToRow(log, lead) {
  return [
    cellDate(log.createdAt),
    cellDate(lead?.leadDate),
    cellText(log.leadUniqueId),
    cellText(lead?.clientName),
    cellPhone(lead?.mobileNo),
    cellText(lead?.city),
    cellText(lead?.town),
    cellText(lead?.callType),
    cellText(lead?.platform),
    cellText(lead?.leadStatus),
    cellText(lead?.rating),
    cellText(lead?.assignedTo),
    cellText(lead?.interestedIn),
    cellDate(log.consultationBookedDate),
    cellText(lead?.initialRemark),
    cellText(lead?.detailComment),
    cellText(log.consultationType || lead?.consultationType),
    cellText(lead?.campaignname),
    cellText(lead?.adsetname),
    cellText(lead?.adname),
    cellText(lead?.campaignsource),
    cellText(lead?.placement),
  ];
}

async function loadLeadsByIds(db, ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();
  const refs = uniq.map((id) => db.collection("leads").doc(String(id)));
  const snaps = await db.getAll(...refs);
  return new Map(snaps.filter((s) => s.exists).map((s) => [s.id, s.data()]));
}

async function getSheetMetaByTitle(sheets, spreadsheetId, sheetName) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))",
  });
  const match = (meta.data.sheets || []).find(
    (s) => String(s.properties?.title || "") === String(sheetName)
  );
  if (!match?.properties) {
    throw new Error(`Sheet tab not found: ${sheetName}`);
  }
  return match.properties;
}

/**
 * Write rows starting at column A of the next free row.
 * Avoids spreadsheets.values.append table-detection, which can shift new rows
 * (e.g. start at column H) when a prior log left empty leading cells / sparse rows.
 * Expands the sheet grid when full (Apps Script appendRow does this automatically).
 */
async function appendRows(sheets, spreadsheetId, range, rows) {
  if (!rows.length) return;

  const bang = String(range).lastIndexOf("!");
  const sheetName = bang >= 0 ? String(range).slice(0, bang) : String(range);
  const a1 = bang >= 0 ? String(range).slice(bang + 1) : "A:A";
  const endColMatch = a1.match(/:([A-Za-z]+)\d*$/);
  const endCol = endColMatch ? endColMatch[1].toUpperCase() : "A";

  const colAResp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A:A`,
    majorDimension: "ROWS",
  });
  const colA = colAResp.data.values || [];
  let lastRowWithA = 0;
  for (let i = colA.length - 1; i >= 0; i -= 1) {
    if (String(colA[i]?.[0] ?? "").trim() !== "") {
      lastRowWithA = i + 1;
      break;
    }
  }
  // Keep header on row 1; never write over it.
  const startRow = Math.max(lastRowWithA + 1, 2);
  const endRow = startRow + rows.length - 1;
  const writeRange = `${sheetName}!A${startRow}:${endCol}${endRow}`;

  const props = await getSheetMetaByTitle(sheets, spreadsheetId, sheetName);
  const rowCount = Number(props.gridProperties?.rowCount || 0);
  const neededExtraRows = endRow - rowCount;
  if (neededExtraRows > 0) {
    // Grow in chunks so repeated uploads don't fail at the exact grid edge.
    const growBy = Math.max(neededExtraRows, 500);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            appendDimension: {
              sheetId: props.sheetId,
              dimension: "ROWS",
              length: growBy,
            },
          },
        ],
      },
    });
  }

  // USER_ENTERED so date strings (dd/MM/yyyy HH:mm:ss) become real date cells
  // (RAW stored them as text and Sheets showed a leading apostrophe in the formula bar).
  // Same option used by Leads Data / full-rebuild writers.
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: writeRange,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows },
  });
}

async function runLogsExportFullRebuild({ dryRun = false } = {}) {
  const startedAt = new Date().toISOString();
  const spreadsheetId = process.env.CRM_SYNC_SHEET_ID || "1fiqGa4nRkSkun-nffI_QVtFQG4o4ubJGXkMIcEprI1k";
  const followUpSheetName = process.env.CRM_FOLLOWUP_LOGS_SHEET_NAME || "Follow-up Logs";
  const consultationSheetName = process.env.CRM_CONSULTATION_LOGS_SHEET_NAME || "Consultation Booked Logs";
  const db = getFirestore();

  const [leadsSnap, followSnap, consultationSnap] = await Promise.all([
    db.collection("leads").get(),
    db.collection("followUpLogs").orderBy("createdAt", "asc").get(),
    db.collection("consultationLogs").orderBy("createdAt", "asc").get(),
  ]);

  const leadById = new Map(leadsSnap.docs.map((d) => [d.id, d.data()]));
  const followRows = followSnap.docs.map((d) => {
    const log = d.data() || {};
    return followUpLogToRow(log, leadById.get(String(log.leadUniqueId || "")));
  });
  const consultationRows = consultationSnap.docs.map((d) => {
    const log = d.data() || {};
    return consultationLogToRow(log, leadById.get(String(log.leadUniqueId || "")));
  });

  const followClearedRange = `${followUpSheetName}!A2:P`;
  const followUpdateRange = `${followUpSheetName}!A2`;
  const consultationClearedRange = `${consultationSheetName}!A2:V`;
  const consultationUpdateRange = `${consultationSheetName}!A2`;

  if (dryRun) {
    return {
      success: true,
      mode: "full_rebuild",
      dryRun: true,
      leadsRead: leadsSnap.size,
      followUpLogsRead: followSnap.size,
      consultationLogsRead: consultationSnap.size,
      followRowsPrepared: followRows.length,
      consultationRowsPrepared: consultationRows.length,
      followClearedRange,
      consultationClearedRange,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });

  await sheets.spreadsheets.values.batchClear({
    spreadsheetId,
    requestBody: {
      ranges: [followClearedRange, consultationClearedRange],
    },
  });

  if (followRows.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: followUpdateRange,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: followRows },
    });
  }
  if (consultationRows.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: consultationUpdateRange,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: consultationRows },
    });
  }

  return {
    success: true,
    mode: "full_rebuild",
    leadsRead: leadsSnap.size,
    followUpLogsRead: followSnap.size,
    consultationLogsRead: consultationSnap.size,
    followRowsSynced: followRows.length,
    consultationRowsSynced: consultationRows.length,
    followUpSheetName,
    consultationSheetName,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

export async function runEndOfDaySync({ dryRun = false } = {}) {
  const startedAt = new Date().toISOString();
  const leads = await getLeads({ limit: 10000 });
  const rows = leads.map(toRow);
  const sheetName = process.env.CRM_LEADS_SHEET_NAME || "Leads Data";
  const clearedRange = `${sheetName}!A2:AQ`;
  const updatedRange = `${sheetName}!A2`;

  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      firestoreLeadsRead: leads.length,
      rowsPrepared: rows.length,
      clearedRange,
      updatedRange,
      finishedAt: new Date().toISOString(),
      startedAt,
    };
  }

  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const spreadsheetId = process.env.CRM_SYNC_SHEET_ID || "1fiqGa4nRkSkun-nffI_QVtFQG4o4ubJGXkMIcEprI1k";

  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: clearedRange,
  });

  if (rows.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: updatedRange,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: rows },
    });
  }

  return {
    success: true,
    firestoreLeadsRead: leads.length,
    rowsSynced: rows.length,
    spreadsheetId,
    sheetName,
    clearedRange,
    updatedRange,
    writeMode: "clear_then_update",
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

export async function runLogsExportSync({ dryRun = false, fullRebuild = false, batchSize = 1000 } = {}) {
  if (fullRebuild) {
    return runLogsExportFullRebuild({ dryRun });
  }
  const startedAt = new Date().toISOString();
  const spreadsheetId = process.env.CRM_SYNC_SHEET_ID || "1fiqGa4nRkSkun-nffI_QVtFQG4o4ubJGXkMIcEprI1k";
  const followUpSheetName = process.env.CRM_FOLLOWUP_LOGS_SHEET_NAME || "Follow-up Logs";
  const consultationSheetName = process.env.CRM_CONSULTATION_LOGS_SHEET_NAME || "Consultation Booked Logs";
  const db = getFirestore();

  const cursorRef = db.collection("config").doc("sheetExportCursors");
  const cursorSnap = await cursorRef.get();
  const cursor = cursorSnap.exists ? cursorSnap.data() || {} : {};
  const followCursor = String(cursor.followUpLastCreatedAt || "");
  const consultationCursor = String(cursor.consultationLastCreatedAt || "");

  const followQuery = db
    .collection("followUpLogs")
    .where("createdAt", ">", followCursor)
    .orderBy("createdAt", "asc")
    .limit(Math.max(1, Number(batchSize) || 1000));
  const consultationQuery = db
    .collection("consultationLogs")
    .where("createdAt", ">", consultationCursor)
    .orderBy("createdAt", "asc")
    .limit(Math.max(1, Number(batchSize) || 1000));

  const [followSnap, consultationSnap] = await Promise.all([followQuery.get(), consultationQuery.get()]);
  const leadIds = [
    ...followSnap.docs.map((d) => String(d.data()?.leadUniqueId || "")).filter(Boolean),
    ...consultationSnap.docs.map((d) => String(d.data()?.leadUniqueId || "")).filter(Boolean),
  ];
  const leadById = await loadLeadsByIds(db, leadIds);

  const followRows = followSnap.docs.map((d) => {
    const log = d.data() || {};
    return followUpLogToRow(log, leadById.get(String(log.leadUniqueId || "")));
  });
  const consultationRows = consultationSnap.docs.map((d) => {
    const log = d.data() || {};
    return consultationLogToRow(log, leadById.get(String(log.leadUniqueId || "")));
  });
  const followMaxCreatedAt = followSnap.docs.length ? String(followSnap.docs[followSnap.docs.length - 1].data()?.createdAt || "") : followCursor;
  const consultationMaxCreatedAt = consultationSnap.docs.length
    ? String(consultationSnap.docs[consultationSnap.docs.length - 1].data()?.createdAt || "")
    : consultationCursor;

  if (dryRun) {
    return {
      success: true,
      mode: "incremental",
      dryRun: true,
      batchSize: Math.max(1, Number(batchSize) || 1000),
      cursorBefore: {
        followUpLastCreatedAt: followCursor || null,
        consultationLastCreatedAt: consultationCursor || null,
      },
      followUpLogsRead: followSnap.size,
      consultationLogsRead: consultationSnap.size,
      followRowsPrepared: followRows.length,
      consultationRowsPrepared: consultationRows.length,
      cursorAfter: {
        followUpLastCreatedAt: followMaxCreatedAt || null,
        consultationLastCreatedAt: consultationMaxCreatedAt || null,
      },
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });

  await appendRows(sheets, spreadsheetId, `${followUpSheetName}!A:P`, followRows);
  await appendRows(sheets, spreadsheetId, `${consultationSheetName}!A:V`, consultationRows);

  await cursorRef.set(
    {
      followUpLastCreatedAt: followMaxCreatedAt || followCursor || "",
      consultationLastCreatedAt: consultationMaxCreatedAt || consultationCursor || "",
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );

  return {
    success: true,
    mode: "incremental",
    batchSize: Math.max(1, Number(batchSize) || 1000),
    followUpLogsRead: followSnap.size,
    consultationLogsRead: consultationSnap.size,
    followRowsSynced: followRows.length,
    consultationRowsSynced: consultationRows.length,
    cursorBefore: {
      followUpLastCreatedAt: followCursor || null,
      consultationLastCreatedAt: consultationCursor || null,
    },
    cursorAfter: {
      followUpLastCreatedAt: followMaxCreatedAt || followCursor || null,
      consultationLastCreatedAt: consultationMaxCreatedAt || consultationCursor || null,
    },
    followUpSheetName,
    consultationSheetName,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}


function mergeLeadRowValues(existingValues = [], lead) {
  const newRowValues = toRow(lead);
  const mergedValues = [];
  const totalCols = Math.max(newRowValues.length, existingValues.length, 43);
  for (let i = 0; i < totalCols; i++) {
    const newVal = newRowValues[i];
    const existingVal = existingValues[i];
    if (newVal !== undefined && newVal !== null && String(newVal).trim() !== "") {
      mergedValues[i] = newVal;
    } else if (existingVal !== undefined && existingVal !== null && String(existingVal).trim() !== "") {
      mergedValues[i] = existingVal;
    } else {
      mergedValues[i] = "";
    }
  }
  return mergedValues;
}

const leadRowCacheMap = new Map();

function normalizeLeadId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

async function findLeadRowNumber(sheets, spreadsheetId, sheetName, lead) {
  const cleanTargetId = normalizeLeadId(lead?.leadUniqueId);
  const targetDigits = String(lead?.mobileNo || "").replace(/\D/g, "");
  const targetMobile10 = targetDigits.slice(-10);

  const candidateRows = [];
  if (typeof lead?.sheetRowNumber === "number" && lead.sheetRowNumber > 1) {
    candidateRows.push(lead.sheetRowNumber);
  }
  if (cleanTargetId && leadRowCacheMap.has(cleanTargetId)) {
    candidateRows.push(leadRowCacheMap.get(cleanTargetId));
  }

  const matchesPhone = (rowPhone) => {
    const digits = String(rowPhone || "").replace(/\D/g, "");
    if (!digits || !targetDigits) return false;
    if (digits === targetDigits) return true;
    if (targetMobile10 && digits.slice(-10) === targetMobile10) return true;
    return false;
  };

  // Verify cached/stale sheetRowNumber still points at THIS lead before using it.
  for (const candidate of candidateRows) {
    try {
      const probe = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!B${candidate}:D${candidate}`,
      });
      const row = (probe.data.values && probe.data.values[0]) || [];
      const cleanIdVal = normalizeLeadId(row[0]);
      const mobileVal = row[2];
      if (cleanTargetId && cleanIdVal === cleanTargetId) {
        return candidate;
      }
      if (
        matchesPhone(mobileVal) &&
        (!cleanIdVal || cleanIdVal === cleanTargetId)
      ) {
        return candidate;
      }
    } catch (_) {
      // Fall through to full scan.
    }
  }

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!B:D`,
  });
  const rows = resp.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    const idVal = String(rows[i]?.[0] || "").trim().toLowerCase();
    const cleanIdVal = normalizeLeadId(idVal);
    const mobileVal = rows[i]?.[2];

    if (cleanTargetId && cleanIdVal === cleanTargetId) {
      return i + 1;
    }
    if (
      matchesPhone(mobileVal) &&
      (!cleanIdVal || cleanIdVal === cleanTargetId)
    ) {
      return i + 1;
    }
  }

  return null;
}

export async function updateSingleLeadRowInSheets(lead, options = {}) {
  if (!lead || (!lead.leadUniqueId && !lead.mobileNo)) return { success: false, reason: "NO_LEAD_ID" };
  const { allowAppend = false, changedFields = null } = options;

  // Fast path: only rewrite columns that were actually updated.
  if (Array.isArray(changedFields) && changedFields.length) {
    return patchLeadFieldsInSheets(lead, changedFields);
  }

  const spreadsheetId = process.env.CRM_SYNC_SHEET_ID || "1fiqGa4nRkSkun-nffI_QVtFQG4o4ubJGXkMIcEprI1k";
  if (!spreadsheetId) return { success: false, reason: "NO_SPREADSHEET_ID" };

  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const sheetName = process.env.CRM_LEADS_SHEET_NAME || "Leads Data";
  const cleanTargetId = normalizeLeadId(lead.leadUniqueId);

  const foundRow = await findLeadRowNumber(sheets, spreadsheetId, sheetName, lead);
  const newRowValues = toRow(lead);

  if (foundRow && foundRow > 1) {
    if (cleanTargetId) leadRowCacheMap.set(cleanTargetId, foundRow);

    // Legacy full-row path: merge blanks with existing so we never wipe untouched columns.
    let existingValues = [];
    try {
      const existingResp = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A${foundRow}:AQ${foundRow}`,
      });
      existingValues = (existingResp.data.values && existingResp.data.values[0]) || [];
    } catch (_) {
      existingValues = [];
    }

    const totalCols = Math.max(newRowValues.length, existingValues.length, 43);
    const mergedValues = [];
    for (let i = 0; i < totalCols; i++) {
      const newVal = newRowValues[i];
      const existingVal = existingValues[i];
      if (newVal !== undefined && newVal !== null && String(newVal).trim() !== "") {
        mergedValues[i] = newVal;
      } else if (existingVal !== undefined && existingVal !== null && String(existingVal).trim() !== "") {
        mergedValues[i] = existingVal;
      } else {
        mergedValues[i] = newVal === undefined || newVal === null ? "" : newVal;
      }
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A${foundRow}:AQ${foundRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [mergedValues] },
    });
    return { success: true, mode: "updated", row: foundRow };
  } else if (allowAppend) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A:AQ`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [newRowValues] },
    });
    return { success: true, mode: "appended" };
  } else {
    console.warn(`Lead ${lead.leadUniqueId} not found in sheet for update; skipping append to prevent duplicate rows.`);
    return { success: false, reason: "LEAD_ROW_NOT_FOUND" };
  }
}

/**
 * Patch only the given camelCase lead fields onto the matching Leads Data row.
 * Other columns are left untouched. Never appends a new row.
 */
export async function patchLeadFieldsInSheets(lead, changedFields = []) {
  if (!lead || !lead.leadUniqueId) return { success: false, reason: "NO_LEAD_ID" };
  const fields = [...new Set((changedFields || []).filter(Boolean))].filter(
    (f) => !SHEET_PATCH_SKIP_FIELDS.has(f) && FIELD_TO_HEADER[f]
  );
  if (!fields.length) return { success: true, mode: "noop", updatedCells: 0 };

  const spreadsheetId = process.env.CRM_SYNC_SHEET_ID || "1fiqGa4nRkSkun-nffI_QVtFQG4o4ubJGXkMIcEprI1k";
  if (!spreadsheetId) return { success: false, reason: "NO_SPREADSHEET_ID" };

  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const sheetName = process.env.CRM_LEADS_SHEET_NAME || "Leads Data";
  const cleanTargetId = normalizeLeadId(lead.leadUniqueId);

  const headerResp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!1:1`,
  });
  const headers = (headerResp.data.values && headerResp.data.values[0]) || [];
  const headerIndex = new Map();
  headers.forEach((h, idx) => {
    const key = String(h || "").trim().toLowerCase();
    if (key && !headerIndex.has(key)) headerIndex.set(key, idx);
  });

  const foundRow = await findLeadRowNumber(sheets, spreadsheetId, sheetName, lead);
  if (!foundRow || foundRow < 2) {
    console.warn(
      `Lead ${lead.leadUniqueId} not found in sheet for partial patch; skipping to prevent duplicate rows.`
    );
    return { success: false, reason: "LEAD_ROW_NOT_FOUND" };
  }
  if (cleanTargetId) leadRowCacheMap.set(cleanTargetId, foundRow);

  const data = [];
  const missingHeaders = [];
  for (const field of fields) {
    const headerName = FIELD_TO_HEADER[field];
    const colIdx = headerIndex.get(String(headerName).toLowerCase());
    if (colIdx === undefined) {
      missingHeaders.push(headerName);
      continue;
    }
    const colLetter = columnIndexToA1(colIdx);
    data.push({
      range: `${sheetName}!${colLetter}${foundRow}`,
      values: [[formatSheetCellValue(field, lead[field])]],
    });
  }

  if (!data.length) {
    return {
      success: false,
      reason: "NO_MAPPED_COLUMNS",
      missingHeaders,
    };
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data,
    },
  });

  return {
    success: true,
    mode: "partial_patch",
    row: foundRow,
    updatedCells: data.length,
    missingHeaders,
  };
}

/**
 * Update only the "Lead Label" cell for an existing lead. Never appends a new row.
 */
export async function updateLeadLabelInSheets(lead) {
  return patchLeadFieldsInSheets(lead, ["leadLabel"]);
}

function columnIndexToA1(index) {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export async function updateMultipleLeadRowsInSheets(leads, options = {}) {
  if (!Array.isArray(leads) || !leads.length) return { success: true, updatedCount: 0 };
  const { allowAppend = false } = options;
  const spreadsheetId = process.env.CRM_SYNC_SHEET_ID || "1fiqGa4nRkSkun-nffI_QVtFQG4o4ubJGXkMIcEprI1k";
  if (!spreadsheetId) return { success: false, reason: "NO_SPREADSHEET_ID" };

  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const sheetName = process.env.CRM_LEADS_SHEET_NAME || "Leads Data";

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A:AQ`,
  });

  const allRows = resp.data.values || [];
  const idToRowMap = new Map();
  const idToExistingValuesMap = new Map();

  for (let i = 1; i < allRows.length; i++) {
    const val = String(allRows[i]?.[1] || "").trim().toLowerCase();
    const cleanVal = val.replace(/[^a-z0-9]/g, "");
    if (val) {
      idToRowMap.set(val, i + 1);
      idToExistingValuesMap.set(val, allRows[i]);
    }
    if (cleanVal) {
      idToRowMap.set(cleanVal, i + 1);
      idToExistingValuesMap.set(cleanVal, allRows[i]);
    }
  }

  const updateData = [];
  const appendData = [];
  let skippedMissing = 0;

  for (const lead of leads) {
    if (!lead || !lead.leadUniqueId) continue;
    const targetId = String(lead.leadUniqueId).trim().toLowerCase();
    const cleanTargetId = targetId.replace(/[^a-z0-9]/g, "");
    const newRowValues = toRow(lead);
    const existingValues =
      idToExistingValuesMap.get(targetId) ||
      idToExistingValuesMap.get(cleanTargetId) ||
      [];
    const foundRow = idToRowMap.get(targetId) || idToRowMap.get(cleanTargetId);

    const mergedValues = [];
    const totalCols = Math.max(newRowValues.length, existingValues.length, 43);
    for (let i = 0; i < totalCols; i++) {
      const newVal = newRowValues[i];
      const existingVal = existingValues[i];
      if (newVal !== undefined && newVal !== null && String(newVal).trim() !== "") {
        mergedValues[i] = newVal;
      } else if (existingVal !== undefined && existingVal !== null && String(existingVal).trim() !== "") {
        mergedValues[i] = existingVal;
      } else {
        mergedValues[i] = "";
      }
    }

    if (foundRow) {
      updateData.push({
        range: `${sheetName}!A${foundRow}:AQ${foundRow}`,
        values: [mergedValues],
      });
    } else if (allowAppend) {
      appendData.push(mergedValues);
    } else {
      skippedMissing += 1;
      console.warn(
        `Lead ${lead.leadUniqueId} not found in sheet for batch update; skipping append to prevent duplicate rows.`
      );
    }
  }

  if (updateData.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: updateData,
      },
    });
  }

  if (appendData.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A:AQ`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: appendData },
    });
  }

  return {
    success: true,
    updatedCount: updateData.length,
    appendedCount: appendData.length,
    skippedMissing,
  };
}

export async function appendSingleConsultationLogToSheets(lead, log) {
  if (!lead || !log) return { success: false, reason: "NO_DATA" };
  const spreadsheetId = process.env.CRM_SYNC_SHEET_ID || "1fiqGa4nRkSkun-nffI_QVtFQG4o4ubJGXkMIcEprI1k";
  if (!spreadsheetId) return { success: false, reason: "NO_SPREADSHEET_ID" };

  const consultationSheetName = process.env.CRM_CONSULTATION_LOGS_SHEET_NAME || "Consultation Booked Logs";
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const row = consultationLogToRow(log, lead);

  await appendRows(sheets, spreadsheetId, `${consultationSheetName}!A:V`, [row]);
  return { success: true };
}

export async function appendSingleFollowUpLogToSheets(lead, log) {
  if (!lead || !log) return { success: false, reason: "NO_DATA" };
  const spreadsheetId = process.env.CRM_SYNC_SHEET_ID || "1fiqGa4nRkSkun-nffI_QVtFQG4o4ubJGXkMIcEprI1k";
  if (!spreadsheetId) return { success: false, reason: "NO_SPREADSHEET_ID" };

  const followUpSheetName = process.env.CRM_FOLLOWUP_LOGS_SHEET_NAME || "Follow-up Logs";
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const row = followUpLogToRow(log, lead);

  await appendRows(sheets, spreadsheetId, `${followUpSheetName}!A:P`, [row]);
  return { success: true };
}


