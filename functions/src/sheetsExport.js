import { google } from "googleapis";
import { getLeads } from "./leadService.js";
import { getFirestore } from "./firebase.js";
import { firestoreDateToDisplayString } from "./sheetDateUtils.js";

function getGoogleAuth() {
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  return new google.auth.JWT({
    email: process.env.FIREBASE_CLIENT_EMAIL,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

function cellDate(value) {
  return firestoreDateToDisplayString(value) || "";
}

function toRow(lead) {
  return [
    cellDate(lead.leadDate),
    lead.leadUniqueId || "",
    lead.clientName || "",
    lead.mobileNo || "",
    lead.city || "",
    lead.town || "",
    lead.callType || "",
    lead.platform || "",
    lead.leadStatus || "",
    lead.rating || "",
    lead.assignedTo || "",
    lead.interestedIn || "",
    cellDate(lead.followUpDate),
    lead.noOfFollowups || "",
    cellDate(lead.consutlationBookedDate),
    cellDate(lead.consutlationVisitedDate),
    lead.consultationType || "",
    lead.initialRemark || "",
    lead.detailComment || "",
    lead.Q1 || "",
    lead.Q2 || "",
    lead.Q3 || "",
    "",
    "",
    "",
    lead.hearAboutUs || "",
    lead.campaignname || "",
    lead.adsetname || "",
    lead.adname || "",
    lead.campaignsource || "",
    lead.placement || "",
    lead.orderStatus || "",
    lead.totalSalesAmount || "",
    "",
    "",
    lead.consultationStatus || "",
    lead.notBookedFeedback || "",
    cellDate(lead.orderDate),
    "",
    lead.preferredTimeToCall || "",
    lead.consultationMode || "",
  ];
}

function followUpLogToRow(log, lead) {
  return [
    cellDate(log.createdAt),
    cellDate(lead?.leadDate),
    log.leadUniqueId || "",
    lead?.clientName || "",
    lead?.mobileNo || "",
    lead?.city || "",
    lead?.town || "",
    lead?.callType || "",
    lead?.platform || "",
    log.leadStatus || lead?.leadStatus || "",
    lead?.rating || "",
    lead?.assignedTo || "",
    lead?.interestedIn || "",
    cellDate(log.followUpDate),
    lead?.initialRemark || "",
    log.remark || lead?.detailComment || "",
  ];
}

function consultationLogToRow(log, lead) {
  return [
    cellDate(log.createdAt),
    cellDate(lead?.leadDate),
    log.leadUniqueId || "",
    lead?.clientName || "",
    lead?.mobileNo || "",
    lead?.city || "",
    lead?.town || "",
    lead?.callType || "",
    lead?.platform || "",
    lead?.leadStatus || "",
    lead?.rating || "",
    lead?.assignedTo || "",
    lead?.interestedIn || "",
    cellDate(log.consultationBookedDate),
    lead?.initialRemark || "",
    lead?.detailComment || "",
    log.consultationType || lead?.consultationType || "",
    lead?.campaignname || "",
    lead?.adsetname || "",
    lead?.adname || "",
    lead?.campaignsource || "",
    lead?.placement || "",
  ];
}

async function loadLeadsByIds(db, ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();
  const refs = uniq.map((id) => db.collection("leads").doc(String(id)));
  const snaps = await db.getAll(...refs);
  return new Map(snaps.filter((s) => s.exists).map((s) => [s.id, s.data()]));
}

async function appendRows(sheets, spreadsheetId, range, rows) {
  if (!rows.length) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });
}

async function runLogsExportFullRebuild({ dryRun = false } = {}) {
  const startedAt = new Date().toISOString();
  const spreadsheetId = process.env.CRM_SYNC_SHEET_ID || "1awaq6gNQspr-sjp-yuaH-Nu5JJmhyplVRevoaj47JZw";
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
  const clearedRange = `${sheetName}!A2:AO`;
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
  const spreadsheetId = process.env.CRM_SYNC_SHEET_ID || "1awaq6gNQspr-sjp-yuaH-Nu5JJmhyplVRevoaj47JZw";

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
  const spreadsheetId = process.env.CRM_SYNC_SHEET_ID || "1awaq6gNQspr-sjp-yuaH-Nu5JJmhyplVRevoaj47JZw";
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


export async function updateSingleLeadRowInSheets(lead) {
  if (!lead || (!lead.leadUniqueId && !lead.mobileNo)) return { success: false, reason: "NO_LEAD_ID" };
  const spreadsheetId = process.env.CRM_SYNC_SHEET_ID || "1awaq6gNQspr-sjp-yuaH-Nu5JJmhyplVRevoaj47JZw";
  if (!spreadsheetId) return { success: false, reason: "NO_SPREADSHEET_ID" };

  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const sheetName = process.env.CRM_LEADS_SHEET_NAME || "Leads Data";

  // Fetch Columns B:D (Column B: leadUniqueId, Column D: mobileNo)
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!B:D`,
  });

  const rows = resp.data.values || [];
  const targetId = String(lead.leadUniqueId || "").trim().toLowerCase();
  const targetMobile = String(lead.mobileNo || "").replace(/\D/g, "").slice(-10);
  let foundRow = -1;

  for (let i = 0; i < rows.length; i++) {
    const idVal = String(rows[i]?.[0] || "").trim().toLowerCase();
    const mobileVal = String(rows[i]?.[2] || "").replace(/\D/g, "").slice(-10);

    if (targetId && idVal === targetId) {
      foundRow = i + 1;
      break;
    }
    if (targetMobile && mobileVal && mobileVal === targetMobile) {
      foundRow = i + 1;
      break;
    }
  }

  const rowValues = toRow(lead);

  if (foundRow > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A${foundRow}:AO${foundRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [rowValues] },
    });
    return { success: true, mode: "updated", row: foundRow };
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A:AO`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [rowValues] },
    });
    return { success: true, mode: "appended" };
  }
}

export async function updateMultipleLeadRowsInSheets(leads) {
  if (!Array.isArray(leads) || !leads.length) return { success: true, updatedCount: 0 };
  const spreadsheetId = process.env.CRM_SYNC_SHEET_ID || "1awaq6gNQspr-sjp-yuaH-Nu5JJmhyplVRevoaj47JZw";
  if (!spreadsheetId) return { success: false, reason: "NO_SPREADSHEET_ID" };

  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const sheetName = process.env.CRM_LEADS_SHEET_NAME || "Leads Data";

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!B:B`,
  });

  const colValues = resp.data.values || [];
  const idToRowMap = new Map();
  for (let i = 0; i < colValues.length; i++) {
    const val = String(colValues[i]?.[0] || "").trim();
    if (val) idToRowMap.set(val, i + 1);
  }

  const updateData = [];
  const appendData = [];

  for (const lead of leads) {
    if (!lead || !lead.leadUniqueId) continue;
    const targetId = String(lead.leadUniqueId).trim();
    const rowValues = toRow(lead);
    const foundRow = idToRowMap.get(targetId);

    if (foundRow) {
      updateData.push({
        range: `${sheetName}!A${foundRow}:AO${foundRow}`,
        values: [rowValues],
      });
    } else {
      appendData.push(rowValues);
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
      range: `${sheetName}!A:AO`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: appendData },
    });
  }

  return { success: true, updatedCount: updateData.length, appendedCount: appendData.length };
}

export async function appendSingleConsultationLogToSheets(lead, log) {
  if (!lead || !log) return { success: false, reason: "NO_DATA" };
  const spreadsheetId = process.env.CRM_SYNC_SHEET_ID || "1awaq6gNQspr-sjp-yuaH-Nu5JJmhyplVRevoaj47JZw";
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
  const spreadsheetId = process.env.CRM_SYNC_SHEET_ID || "1awaq6gNQspr-sjp-yuaH-Nu5JJmhyplVRevoaj47JZw";
  if (!spreadsheetId) return { success: false, reason: "NO_SPREADSHEET_ID" };

  const followUpSheetName = process.env.CRM_FOLLOWUP_LOGS_SHEET_NAME || "Follow-up Logs";
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const row = followUpLogToRow(log, lead);

  await appendRows(sheets, spreadsheetId, `${followUpSheetName}!A:P`, [row]);
  return { success: true };
}


