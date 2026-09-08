import {
  updateSingleLeadRowInSheets,
  appendSingleConsultationLogToSheets,
  appendSingleFollowUpLogToSheets,
} from "./sheetsExport.js";
import { getFirestore } from "./firebase.js";
import { ApiError } from "./errors.js";
import { toLegacyLead } from "./mapper.js";
import { firestoreDateToDisplayString } from "./sheetDateUtils.js";

const FOLLOW_UP_STATUSES = new Set([
  "Warm Lead",
  "Cold Lead 1",
  "Cold Lead 2",
  "Deferred Lead",
  "Ringing / Busy",
  "Not Reachable",
]);

function nowIso() {
  return new Date().toISOString();
}

export async function getLeads(filters = {}) {
  const db = getFirestore();
  let query = db.collection("leads");

  if (filters.assignedTo) query = query.where("assignedTo", "==", filters.assignedTo);
  if (filters.leadStatus) query = query.where("leadStatus", "==", filters.leadStatus);
  if (filters.city) query = query.where("city", "==", filters.city);
  if (filters.platform) query = query.where("platform", "==", filters.platform);

  const requestedLimit = Math.min(filters.limit || 5000, 10000);
  query = query.limit(requestedLimit);

  let leads;
  try {
    // Fast path when composite indexes are available.
    const orderedSnap = await query.orderBy("updatedAt", "desc").get();
    leads = orderedSnap.docs.map((doc) => ({ ...doc.data(), leadUniqueId: doc.id }));
  } catch (err) {
    // Fallback path avoids update failures when an index is not created yet.
    const fallbackSnap = await query.get();
    leads = fallbackSnap.docs.map((doc) => ({ ...doc.data(), leadUniqueId: doc.id }));
    leads.sort((a, b) => {
      const aTs = new Date(a.updatedAt || a.createdAt || 0).getTime();
      const bTs = new Date(b.updatedAt || b.createdAt || 0).getTime();
      return bTs - aTs;
    });
  }

  if (filters.search) {
    const needle = filters.search.toLowerCase();
    leads = leads.filter((lead) =>
      [lead.clientName, lead.mobileNo, lead.city, lead.leadUniqueId]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle))
    );
  }

  return leads.filter((lead) => (lead.assignmentStatus || "assigned") !== "pending");
}

export async function getLegacyLeadsPayload(filters = {}) {
  const leads = await getLeads(filters);
  return JSON.stringify(leads.map(toLegacyLead));
}

export async function updateLead(payload) {
  const db = getFirestore();
  const leadRef = db.collection("leads").doc(payload.leadUniqueId);
  const idempotencyKey = payload.idempotencyKey || null;

  const result = await db.runTransaction(async (tx) => {
    const leadSnap = await tx.get(leadRef);
    if (!leadSnap.exists) {
      throw new ApiError(404, "LEAD_NOT_FOUND", `Lead ${payload.leadUniqueId} not found`);
    }

    const current = leadSnap.data();
    if (idempotencyKey && current.lastIdempotencyKey === idempotencyKey) {
      return { updatedLead: { ...current, leadUniqueId: leadRef.id }, noOp: true };
    }

    const followUpDateBefore = current.followUpDate || "";
    const consultationDateBefore = current.consutlationBookedDate || "";
    let followUpDateValue = payload.followUpDate || "";

    if (["Lost", "Dead", "Not Visited Lost"].includes(payload.leadStatus)) {
      followUpDateValue = nowIso();
    }

    const followUpChanged = followUpDateValue && followUpDateBefore !== followUpDateValue;
    const followCountSnap = await tx.get(
      db.collection("followUpLogs").where("leadUniqueId", "==", payload.leadUniqueId)
    );
    const followUpCount = followCountSnap.size + (followUpChanged ? 1 : 0);

    const safePayload = { ...payload };
    // leadDate is treated as immutable in update flow; this prevents accidental
    // epoch-style corruption (e.g. 1970) when frontend payload carries bad date strings.
    delete safePayload.leadDate;
    if (
      Object.prototype.hasOwnProperty.call(safePayload, "assignedTo") &&
      String(safePayload.assignedTo || "").trim() === ""
    ) {
      delete safePayload.assignedTo;
    }

    const updateDoc = {
      ...safePayload,
      followUpDate: followUpDateValue,
      noOfFollowups: followUpCount,
      updatedAt: nowIso(),
      crmUpdatedAt: nowIso(),
      lastIdempotencyKey: idempotencyKey,
    };

    tx.set(leadRef, updateDoc, { merge: true });

    let newFollowUpLog = null;
    if (followUpChanged) {
      const followRef = db.collection("followUpLogs").doc();
      newFollowUpLog = {
        leadUniqueId: payload.leadUniqueId,
        followUpDate: followUpDateValue,
        leadStatus: payload.leadStatus || current.leadStatus || "",
        remark: payload.detailComment || payload.initialRemark || "",
        createdBy: payload.actor || payload.assignedTo || "system",
        createdAt: nowIso(),
      };
      tx.set(followRef, newFollowUpLog);
    }

    const consultationChanged = (payload.consutlationBookedDate || "") !== consultationDateBefore;
    const shouldLogConsultation = consultationChanged && ["New", "Consultation Re-Booked"].includes(payload.consultationStatus || "");
    let newConsultationLog = null;
    if (shouldLogConsultation) {
      const consultationRef = db.collection("consultationLogs").doc();
      newConsultationLog = {
        leadUniqueId: payload.leadUniqueId,
        consultationBookedDate: payload.consutlationBookedDate,
        consultationType: payload.consultationType || "",
        createdBy: payload.actor || payload.assignedTo || "system",
        createdAt: nowIso(),
      };
      tx.set(consultationRef, newConsultationLog);
    }

    const trackingRef = db.collection("leadStatusTracking").doc();
    tx.set(trackingRef, {
      leadUniqueId: payload.leadUniqueId,
      previousStatus: current.leadStatus || "",
      newStatus: payload.leadStatus || current.leadStatus || "",
      changedBy: payload.actor || payload.assignedTo || "system",
      createdAt: nowIso(),
      source: "updateLead",
    });

    const activityRef = db.collection("userActivityLogs").doc();
    tx.set(activityRef, {
      leadUniqueId: payload.leadUniqueId,
      action: "LEAD_UPDATED",
      actor: payload.actor || payload.assignedTo || "system",
      createdAt: nowIso(),
      metadata: {
        fields: Object.keys(payload),
      },
    });

    return {
      updatedLead: {
        ...current,
        ...updateDoc,
        noOfFollowups: followUpCount,
        leadUniqueId: payload.leadUniqueId,
      },
      newFollowUpLog,
      newConsultationLog,
      noOp: false,
    };
  });

  if (!result.noOp && result.updatedLead) {
    // Non-blocking background sync to Sheets so UI response is instant (~50ms)
    updateSingleLeadRowInSheets(result.updatedLead).catch((err) => {
      console.error("Background single-row sheet update error:", err);
    });

    if (result.newFollowUpLog) {
      appendSingleFollowUpLogToSheets(result.updatedLead, result.newFollowUpLog).catch((err) => {
        console.error("Background follow-up log sheet append error:", err);
      });
    }

    if (result.newConsultationLog) {
      appendSingleConsultationLogToSheets(result.updatedLead, result.newConsultationLog).catch((err) => {
        console.error("Background consultation log sheet append error:", err);
      });
    }
  }

  return {
    success: true,
    updatedLead: result.updatedLead,
    // Commented out to prevent 5,000 Firestore reads per lead update:
    // impactedMetrics: await getDashboardMetrics({ assignedTo: result.updatedLead.assignedTo }),
    noOp: result.noOp,
  };
}

export async function getDashboardMetrics(filters = {}) {
  const leads = await getLeads({ assignedTo: filters.assignedTo, limit: 5000 });

  const metrics = {
    total: leads.length,
    contacted: leads.filter((l) => !["Ringing / Busy", "Not Reachable"].includes(l.leadStatus)).length,
    booked: leads.filter((l) => l.leadStatus === "Consultation Booked").length,
    visited: leads.filter((l) => l.leadStatus === "Consultation Visited").length,
    followup: leads.filter((l) => FOLLOW_UP_STATUSES.has(l.leadStatus)).length,
    lost: leads.filter((l) => l.leadStatus === "Lost").length,
    dead: leads.filter((l) => l.leadStatus === "Dead").length,
    pendingFollowup: leads.filter((l) => FOLLOW_UP_STATUSES.has(l.leadStatus) && l.followUpDate).length,
  };

  return metrics;
}

export async function getCampaignNameOptions() {
  const leads = await getLeads({ limit: 5000 });
  const uniq = (name) => [...new Set(leads.map((l) => l[name]).filter(Boolean))].sort();
  return {
    campaignNames: uniq("campaignname"),
    adNames: uniq("adname"),
    adSetNames: uniq("adsetname"),
    platforms: uniq("platform"),
    placements: uniq("placement"),
  };
}

function consultationEntryToLegacyRow(log, lead) {
  const legacy = toLegacyLead({
    ...lead,
    leadUniqueId: lead.leadUniqueId || log.leadUniqueId,
    consutlationBookedDate: log.consultationBookedDate || lead.consutlationBookedDate,
    consultationType: log.consultationType || lead.consultationType,
  });

  return {
    timestamp: firestoreDateToDisplayString(log.createdAt) || log.createdAt || "",
    "lead date": legacy["lead date"],
    "lead unique id": legacy["lead unique id"],
    "client name": legacy["client name"],
    "mobile no": legacy["mobile no"],
    city: legacy.city,
    town: legacy.town,
    "call type": legacy["call type"],
    platform: legacy.platform,
    "lead status": legacy["lead status"],
    rating: legacy.rating,
    "assigned to": legacy["assigned to"],
    "interested in": legacy["interested in"],
    "consultation booked date":
      firestoreDateToDisplayString(log.consultationBookedDate) || legacy["consultation booked date"],
    "initial remark": legacy["initial remark"],
    "detail comment": legacy["detail comment"],
    "consultation type": log.consultationType || legacy["consultation type"] || "",
    campaignname: legacy.campaignname,
    adsetname: legacy.adsetname,
    adname: legacy.adname,
    campaignsource: legacy.campaignsource,
    placement: legacy.placement,
  };
}

/**
 * Legacy-compatible payload for Consultation Booked Logs dashboards.
 * Prefer consultationLogs joined to leads; fall back to leads with booked dates.
 */
export async function getLegacyConsultationPayload() {
  const db = getFirestore();
  let logsSnap;
  try {
    logsSnap = await db.collection("consultationLogs").orderBy("createdAt", "desc").limit(5000).get();
  } catch (err) {
    logsSnap = await db.collection("consultationLogs").limit(5000).get();
  }

  if (!logsSnap.empty) {
    const leadIds = [...new Set(logsSnap.docs.map((d) => d.data().leadUniqueId).filter(Boolean))];
    let leadMap = new Map();
    if (leadIds.length) {
      const leadSnaps = await db.getAll(...leadIds.map((id) => db.collection("leads").doc(String(id))));
      leadMap = new Map(
        leadSnaps.filter((s) => s.exists).map((s) => [s.id, { ...s.data(), leadUniqueId: s.id }])
      );
    }

    const rows = logsSnap.docs.map((doc) => {
      const log = doc.data();
      const lead = leadMap.get(log.leadUniqueId) || {};
      return consultationEntryToLegacyRow(log, lead);
    });

    return JSON.stringify(rows);
  }

  const leads = await getLeads({ limit: 5000 });
  const rows = leads
    .filter((lead) => lead.consutlationBookedDate)
    .map((lead) =>
      consultationEntryToLegacyRow(
        {
          createdAt: lead.consutlationBookedDate,
          consultationBookedDate: lead.consutlationBookedDate,
          consultationType: lead.consultationType,
          leadUniqueId: lead.leadUniqueId,
        },
        lead
      )
    );

  return JSON.stringify(rows);
}

export async function createLead(payload) {
  const db = getFirestore();
  const now = nowIso();
  const leadUniqueId =
    payload.leadUniqueId ||
    `Lead ID - ${Date.now()}`;

  const ref = db.collection("leads").doc(String(leadUniqueId));
  const snap = await ref.get();
  if (snap.exists) {
    throw new ApiError(409, "LEAD_ALREADY_EXISTS", `Lead ${leadUniqueId} already exists`);
  }

  const assignedTo = String(payload.assignedTo || "").trim();
  const assignmentStatus = String(payload.assignmentStatus || "").trim();
  const syncStatus = String(payload.syncStatus || "").trim();
  const isPendingSyncLead = assignmentStatus === "pending" && syncStatus === "needs_assignment";
  if (!assignedTo && !isPendingSyncLead) {
    throw new ApiError(
      400,
      "ASSIGNED_TO_REQUIRED",
      "assignedTo is required unless assignmentStatus=pending and syncStatus=needs_assignment"
    );
  }

  const doc = {
    ...payload,
    assignedTo,
    leadUniqueId,
    createdAt: now,
    updatedAt: now,
  };
  await ref.set(doc);

  await db.collection("userActivityLogs").add({
    action: "LEAD_CREATED",
    leadUniqueId,
    actor: payload.actor || payload.assignedTo || "system",
    createdAt: now,
  });

  return { success: true, leadUniqueId, lead: doc };
}
