import { google } from "googleapis";
import { getFirestore } from "./firebase.js";
import { ApiError } from "./errors.js";

const DEFAULT_ORDER_SPREADSHEET_ID = "1BWQb_mxcwH6XCRpNYWCM_J3fYgZZ3Uq5hshqM0_d0l0";
const DEFAULT_ORDER_SHEET_NAME = "Order Forms";

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

function parseOrderDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const DAY_MS = 86400000;
    const SHEETS_EPOCH_MS = Date.UTC(1899, 11, 30);
    return new Date(SHEETS_EPOCH_MS + value * DAY_MS).toISOString();
  }
  const t = Date.parse(String(value));
  if (!Number.isNaN(t)) return new Date(t).toISOString();
  return "";
}

/**
 * Mirrors Code.js checkAndMatchOrder — matches Order Forms to Consultation Visited leads.
 */
export async function matchOrdersToVisitedLeads(options = {}) {
  const { dryRun = false, triggeredBy = "manual" } = options;

  const spreadsheetId = process.env.ORDER_FORMS_SPREADSHEET_ID || DEFAULT_ORDER_SPREADSHEET_ID;
  const sheetName = process.env.ORDER_FORMS_SHEET_NAME || DEFAULT_ORDER_SHEET_NAME;
  if (!spreadsheetId) {
    throw new ApiError(400, "MISSING_ORDER_SPREADSHEET", "Set ORDER_FORMS_SPREADSHEET_ID");
  }

  const summary = {
    dryRun,
    spreadsheetId,
    orderRowsRead: 0,
    visitedLeadsScanned: 0,
    matchesPlanned: 0,
    matchesApplied: 0,
    skippedNoMobile: 0,
    skippedNoOrderMatch: 0,
    samples: [],
    startedAt: nowIso(),
    finishedAt: null,
  };

  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A1:W`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const orderRows = (resp.data.values || []).slice(1);
  summary.orderRowsRead = orderRows.length;

  const ordersByMobile = new Map();
  for (const row of orderRows) {
    const mobile = normalizeMobile(row[2]);
    if (!mobile) continue;
    ordersByMobile.set(mobile, {
      mobile,
      orderDate: parseOrderDate(row[6]),
      salesAmount: row[22] != null ? String(row[22]) : "",
      sourceRow: row,
    });
  }

  const db = getFirestore();
  const snap = await db.collection("leads").where("leadStatus", "==", "Consultation Visited").get();
  summary.visitedLeadsScanned = snap.size;

  const updates = [];
  for (const doc of snap.docs) {
    const lead = doc.data() || {};
    const mobile = normalizeMobile(lead.mobileNo);
    if (!mobile) {
      summary.skippedNoMobile += 1;
      continue;
    }

    const order = ordersByMobile.get(mobile);
    if (!order) {
      summary.skippedNoOrderMatch += 1;
      continue;
    }

    const currentOrderStatus = String(lead.orderStatus || "").trim();
    if (currentOrderStatus === "Booked") {
      continue;
    }

    updates.push({
      ref: doc.ref,
      leadUniqueId: doc.id,
      orderDate: order.orderDate,
      totalSalesAmount: order.salesAmount,
    });
  }

  summary.matchesPlanned = updates.length;
  summary.samples = updates.slice(0, 20).map((u) => ({
    leadUniqueId: u.leadUniqueId,
    orderDate: u.orderDate,
    totalSalesAmount: u.totalSalesAmount,
  }));

  if (!dryRun && updates.length) {
    let batch = db.batch();
    let ops = 0;
    const stamp = nowIso();

    for (const u of updates) {
      batch.set(
        u.ref,
        {
          orderStatus: "Booked",
          totalSalesAmount: u.totalSalesAmount,
          orderDate: u.orderDate,
          updatedAt: stamp,
          crmUpdatedAt: stamp,
          orderMatchedAt: stamp,
          orderMatchedBy: triggeredBy,
        },
        { merge: true }
      );

      const activityRef = db.collection("userActivityLogs").doc();
      batch.set(activityRef, {
        leadUniqueId: u.leadUniqueId,
        action: "ORDER_MATCHED",
        actor: triggeredBy,
        createdAt: stamp,
        metadata: {
          orderStatus: "Booked",
          totalSalesAmount: u.totalSalesAmount,
          orderDate: u.orderDate,
        },
      });

      ops += 2;
      if (ops >= 450) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }

    if (ops > 0) {
      await batch.commit();
    }
    summary.matchesApplied = updates.length;
  }

  summary.finishedAt = nowIso();
  return summary;
}

export function formatOrderMatchSuccessMessage(summary) {
  const count = summary.dryRun ? summary.matchesPlanned : summary.matchesApplied;
  return `Order Booked Status Updated Successfully (${count} lead(s)${summary.dryRun ? ", dry run" : ""})`;
}
