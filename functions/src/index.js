import { onRequest } from "firebase-functions/v2/https";
import cors from "cors";
import { config as dotenvConfig } from "dotenv";
import { ApiError, errorResponse } from "./errors.js";
import {
  adminSyncAssigneesSchema,
  consultationVisitedSyncSchema,
  inboundSyncSchema,
  leadUpdateSchema,
  leadsQuerySchema,
  logsExportSyncSchema,
  syncSchema,
} from "./schema.js";
import {
  createLead,
  getCampaignNameOptions,
  getDashboardMetrics,
  getLegacyConsultationPayload,
  getLegacyLeadsPayload,
  getLeads,
  updateLead,
} from "./leadService.js";
import { runEndOfDaySync, runLogsExportSync } from "./sheetsExport.js";
import { syncLeadsSheetToFirestore } from "./sheetInboundSync.js";
import { syncConsultationVisitedLeads } from "./consultationVisitedSync.js";
import { getLatestWeekEndData } from "./misDataService.js";
import {
  formatOrderMatchSuccessMessage,
  matchOrdersToVisitedLeads,
} from "./orderMatchSync.js";
import { checkLogin } from "./authService.js";
import { toLegacyLead } from "./mapper.js";
import { getFirestore } from "./firebase.js";

import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, "../../.env") });
dotenvConfig({ path: path.resolve(__dirname, "../.env") });
dotenvConfig();

const corsHandler = cors({ origin: true });

function assertToken(req) {
  const configured = process.env.API_SHARED_TOKEN;
  if (!configured) {
    throw new ApiError(401, "UNAUTHORIZED", "API authentication is not configured");
  }
  const provided = req.get("x-api-token") || "";
  if (provided !== configured) {
    throw new ApiError(401, "UNAUTHORIZED", "Invalid API token");
  }
}

function sendJson(res, status, body) {
  res.status(status).json(body);
}

function wrap(handler) {
  return async (req, res) => {
    corsHandler(req, res, async () => {
      try {
        assertToken(req);
        await handler(req, res);
      } catch (err) {
        const formatted = errorResponse(err);
        sendJson(res, formatted.statusCode, formatted.body);
      }
    });
  };
}

export const api = onRequest(
  { timeoutSeconds: 120, memory: "512MiB", region: "asia-south1" },
  wrap(async (req, res) => {
    const method = req.method;
    const path = (req.path || "/").replace(/^\/api/, "") || "/";

    if (method === "GET" && path === "/health") {
      return sendJson(res, 200, { success: true, message: "ok" });
    }

    if (method === "GET" && path === "/gas/retriveLeadData") {
      const query = leadsQuerySchema.parse(req.query || {});
      const data = await getLegacyLeadsPayload(query);
      return sendJson(res, 200, { success: true, data });
    }

    if (method === "GET" && path === "/gas/retriveLeadData2") {
      const query = leadsQuerySchema.parse(req.query || {});
      const leads = await getLeads(query);
      return sendJson(res, 200, { success: true, data: JSON.stringify(leads.map(toLegacyLead)) });
    }

    if (method === "GET" && path === "/gas/retriveConsData") {
      const data = await getLegacyConsultationPayload();
      return sendJson(res, 200, { success: true, data });
    }

    if (method === "GET" && path === "/gas/getCampaignName") {
      const data = await getCampaignNameOptions();
      return sendJson(res, 200, { success: true, data });
    }

    if (method === "POST" && path === "/gas/checkLogin") {
      const data = await checkLogin(req.body || {});
      return sendJson(res, 200, { success: true, data: JSON.stringify(data) });
    }

    if (method === "POST" && path === "/gas/newLeadUpload") {
      const data = await createLead(req.body || {});
      return sendJson(res, 200, { success: true, data: JSON.stringify(data) });
    }

    if (method === "GET" && path === "/gas/getLatestWeekEndData") {
      const data = await getLatestWeekEndData();
      return sendJson(res, 200, { success: true, data });
    }

    if (method === "POST" && path === "/gas/checkAndMatchOrder") {
      const dryRun = Boolean(req.body?.dryRun);
      const summary = await matchOrdersToVisitedLeads({
        dryRun,
        triggeredBy: "gas_checkAndMatchOrder",
      });
      return sendJson(res, 200, {
        success: true,
        data: formatOrderMatchSuccessMessage(summary),
      });
    }

    if (method === "PATCH" && path.startsWith("/leads/")) {
      const leadUniqueId = decodeURIComponent(path.split("/")[2] || "");
      if (!leadUniqueId) throw new ApiError(400, "MISSING_LEAD_ID", "Missing lead id");
      const payload = leadUpdateSchema.parse({ ...req.body, leadUniqueId });
      const data = await updateLead(payload);
      return sendJson(res, 200, data);
    }

    if (method === "POST" && path === "/gas/updateLeadDetails") {
      const payload = leadUpdateSchema.parse(req.body || {});
      const data = await updateLead(payload);
      return sendJson(res, 200, {
        success: true,
        data,
      });
    }

    if (method === "GET" && path === "/dashboard/metrics") {
      const metrics = await getDashboardMetrics(req.query || {});
      return sendJson(res, 200, { success: true, data: metrics });
    }

    if (method === "POST" && path === "/sync/eod-to-sheets") {
      const body = syncSchema.parse(req.body || {});
      const result = await runEndOfDaySync(body);
      return sendJson(res, 200, { success: true, data: result });
    }

    if (method === "POST" && path === "/sync/logs-to-sheets") {
      const body = logsExportSyncSchema.parse(req.body || {});
      const result = await runLogsExportSync(body);
      return sendJson(res, 200, { success: true, data: result });
    }

    if (method === "POST" && path === "/sync/sheet-to-firestore") {
      const body = inboundSyncSchema.parse(req.body || {});
      const result = await syncLeadsSheetToFirestore({
        ...body,
        triggeredBy: body.triggeredBy || "http",
      });
      return sendJson(res, 200, { success: true, data: result });
    }

    if (method === "POST" && path === "/sync/consultation-visited") {
      const body = consultationVisitedSyncSchema.parse(req.body || {});
      const result = await syncConsultationVisitedLeads({
        ...body,
        triggeredBy: body.triggeredBy || "http",
      });
      return sendJson(res, 200, { success: true, data: result });
    }

    if (method === "POST" && path === "/admin/sync-assignees") {
      const body = adminSyncAssigneesSchema.parse(req.body || {});
      const db = getFirestore();
      const configRef = db.collection("config").doc("leadAssignment");
      const now = new Date().toISOString();
      const incoming = [...new Set((body.activeAssignees || []).map((a) => String(a || "").trim()).filter(Boolean))];
      const incomingMonday = [...new Set((body.mondayEligibleAssignees || []).map((a) => String(a || "").trim()).filter(Boolean))];
      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(configRef);
        const prev = snap.exists ? snap.data() : {};
        const previousAssignees = Array.isArray(prev.activeAssignees)
          ? prev.activeAssignees.map((a) => String(a || "").trim()).filter(Boolean)
          : [];
        const removedAssignees = previousAssignees.filter((name) => !incoming.includes(name));
        const addedAssignees = incoming.filter((name) => !previousAssignees.includes(name));
        const previousIndex = Number.isInteger(prev.lastAssignedIndex) ? prev.lastAssignedIndex : -1;
        let nextIndex = previousIndex;
        if (nextIndex < 0 || nextIndex >= incoming.length || addedAssignees.length || removedAssignees.length) {
          nextIndex = -1;
        }

        tx.set(
          configRef,
          {
            activeAssignees: incoming,
            mondayEligibleAssignees: incomingMonday,
            source: body.source || "google_sheet_users",
            syncedBy: body.syncedBy || "unknown",
            usersSnapshot: body.usersSnapshot || [],
            updatedAt: now,
            lastAssignedIndex: nextIndex,
            addedAssignees,
            removedAssignees,
          },
          { merge: true }
        );

        return {
          activeAssignees: incoming,
          mondayEligibleAssignees: incomingMonday,
          previousAssignees,
          addedAssignees,
          removedAssignees,
          lastAssignedIndex: nextIndex,
          updatedAt: now,
        };
      });

      return sendJson(res, 200, { success: true, data: result });
    }

    if (method === "GET" && path === "/admin/assignment-audit") {
      const db = getFirestore();
      const configRef = db.collection("config").doc("leadAssignment");
      const snap = await configRef.get();
      const data = snap.exists ? snap.data() : {};
      const activeAssignees = Array.isArray(data.activeAssignees)
        ? data.activeAssignees.map((a) => String(a || "").trim()).filter(Boolean)
        : [];
      const warnings = [];
      if (!activeAssignees.length) {
        warnings.push("activeAssignees is empty. Fallback assignment will mark leads pending.");
      }
      const former = String(req.query?.former || "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
      if (former.length) {
        const presentFormer = former.filter((name) => activeAssignees.includes(name));
        if (presentFormer.length) {
          warnings.push(`Former employee(s) still active in assignee list: ${presentFormer.join(", ")}`);
        }
      }
      return sendJson(res, 200, {
        success: true,
        data: {
          activeAssignees,
          mondayEligibleAssignees: data.mondayEligibleAssignees || [],
          lastAssignedIndex: Number.isInteger(data.lastAssignedIndex) ? data.lastAssignedIndex : -1,
          updatedAt: data.updatedAt || null,
          source: data.source || null,
          syncedBy: data.syncedBy || null,
          usersSnapshot: data.usersSnapshot || [],
          warnings,
        },
      });
    }

    throw new ApiError(404, "NOT_FOUND", `No route for ${method} ${path}`);
  })
);
