import {
  updateSingleLeadRowInSheets,
  updateLeadLabelInSheets,
  appendSingleConsultationLogToSheets,
  appendSingleFollowUpLogToSheets,
} from "./sheetsExport.js";
import { getFirestore } from "./firebase.js";
import { ApiError } from "./errors.js";
import { toLegacyLead } from "./mapper.js";
import {
  firestoreDateToDisplayString,
  normalizeDateToIso,
  normalizeLeadDatesForWrite,
  DATE_FIELDS,
} from "./sheetDateUtils.js";
import { assignLeadBackendRoundRobin } from "./sheetInboundSync.js";

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

function normalizeDateForCompare(value) {
  return normalizeDateToIso(value) || "";
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

export async function updateLead(payload, options = {}) {
  const db = getFirestore();
  const leadRef = db.collection("leads").doc(payload.leadUniqueId);
  const idempotencyKey = payload.idempotencyKey || null;
  // Prefer keys from the raw HTTP body so Zod defaults do not mark every column "changed".
  const rawChangedKeys = Array.isArray(options.changedKeys)
    ? options.changedKeys
    : Object.keys(payload || {});

  const result = await db.runTransaction(async (tx) => {
    const leadSnap = await tx.get(leadRef);
    if (!leadSnap.exists) {
      throw new ApiError(404, "LEAD_NOT_FOUND", `Lead ${payload.leadUniqueId} not found`);
    }

    const current = leadSnap.data();

    // Form update may omit priority and other non-form fields. Never let null/undefined
    // (or blank for protected fields) wipe values already stored on the lead.
    const sanitizedPayload = normalizeLeadDatesForWrite({ ...payload });
    for (const key of Object.keys(sanitizedPayload)) {
      if (sanitizedPayload[key] === undefined || sanitizedPayload[key] === null) {
        delete sanitizedPayload[key];
      }
    }
    const preserveIfBlank = [
      "platform",
      "callType",
      "campaignname",
      "adsetname",
      "adname",
      "campaignsource",
      "placement",
      "leadScore",
      "leadQualification",
      "consultationMode",
      "preferredTimeToCall",
      "firstContactTimestamp",
      "secondaryMobileNo",
    ];
    for (const key of preserveIfBlank) {
      if (
        Object.prototype.hasOwnProperty.call(sanitizedPayload, key) &&
        String(sanitizedPayload[key]).trim() === ""
      ) {
        delete sanitizedPayload[key];
      }
    }

    // Merge incoming payload with current state to properly support partial updates
    const mergedPayload = { ...current, ...sanitizedPayload };

    if (idempotencyKey && current.lastIdempotencyKey === idempotencyKey) {
      return { updatedLead: { ...current, leadUniqueId: leadRef.id }, noOp: true };
    }

    const followUpDateBefore = current.followUpDate || "";
    const consultationDateBefore = current.consutlationBookedDate || "";
    let followUpDateValue = mergedPayload.followUpDate || "";

    // Only stamp follow-up date when status *becomes* Lost/Dead — not on every
    // unrelated field patch (e.g. priority/label), which was creating extra log rows.
    const previousStatus = String(current.leadStatus || "");
    const nextStatus = String(mergedPayload.leadStatus || "");
    const lostStatuses = ["Lost", "Dead", "Not Visited Lost"];
    const becameLost =
      lostStatuses.includes(nextStatus) && !lostStatuses.includes(previousStatus);
    if (becameLost) {
      followUpDateValue = nowIso();
    }

    const followUpChanged =
      Boolean(followUpDateValue) &&
      normalizeDateForCompare(followUpDateBefore) !== normalizeDateForCompare(followUpDateValue);
    const followCountSnap = await tx.get(
      db.collection("followUpLogs").where("leadUniqueId", "==", mergedPayload.leadUniqueId)
    );
    const followUpCount = followCountSnap.size + (followUpChanged ? 1 : 0);

    const safePayload = { ...mergedPayload };
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
        leadUniqueId: mergedPayload.leadUniqueId,
        followUpDate: followUpDateValue,
        leadStatus: mergedPayload.leadStatus || "",
        remark: mergedPayload.detailComment || mergedPayload.initialRemark || "",
        createdBy: mergedPayload.actor || mergedPayload.assignedTo || "system",
        createdAt: nowIso(),
      };
      tx.set(followRef, newFollowUpLog);
    }

    const consultationChanged =
      normalizeDateForCompare(mergedPayload.consutlationBookedDate || "") !==
      normalizeDateForCompare(consultationDateBefore);
    const shouldLogConsultation = consultationChanged && ["New", "Consultation Re-Booked"].includes(mergedPayload.consultationStatus || "");
    let newConsultationLog = null;
    if (shouldLogConsultation) {
      const consultationRef = db.collection("consultationLogs").doc();
      newConsultationLog = {
        leadUniqueId: mergedPayload.leadUniqueId,
        consultationBookedDate: mergedPayload.consutlationBookedDate,
        consultationType: mergedPayload.consultationType || "",
        createdBy: mergedPayload.actor || mergedPayload.assignedTo || "system",
        createdAt: nowIso(),
      };
      tx.set(consultationRef, newConsultationLog);
    }

    const trackingRef = db.collection("leadStatusTracking").doc();
    tx.set(trackingRef, {
      leadUniqueId: mergedPayload.leadUniqueId,
      previousStatus: current.leadStatus || "",
      newStatus: mergedPayload.leadStatus || "",
      changedBy: mergedPayload.actor || mergedPayload.assignedTo || "system",
      createdAt: nowIso(),
      source: "updateLead",
    });

    const activityRef = db.collection("userActivityLogs").doc();
    tx.set(activityRef, {
      leadUniqueId: mergedPayload.leadUniqueId,
      action: "LEAD_UPDATED",
      actor: mergedPayload.actor || mergedPayload.assignedTo || "system",
      createdAt: nowIso(),
      metadata: {
        fields: Object.keys(payload), // intentionally keeping payload here to see which fields were touched
      },
    });

    // Only sheet-patch fields that were actually present on the request (plus forced follow-up).
    const rawKeySet = new Set(rawChangedKeys);
    const changedFields = Object.keys(sanitizedPayload).filter(
      (k) =>
        rawKeySet.has(k) &&
        !["leadUniqueId", "actor", "idempotencyKey", "leadDate"].includes(k)
    );
    if (followUpChanged || becameLost) {
      if (!changedFields.includes("followUpDate")) changedFields.push("followUpDate");
      if (!changedFields.includes("noOfFollowups")) changedFields.push("noOfFollowups");
    }

    return {
      updatedLead: {
        ...current,
        ...updateDoc,
        noOfFollowups: followUpCount,
        leadUniqueId: mergedPayload.leadUniqueId,
        // Never trust a stale inbound sheet row number on the next write.
        sheetRowNumber: undefined,
      },
      changedFields,
      newFollowUpLog,
      newConsultationLog,
      noOp: false,
    };
  });

  if (!result.noOp && result.updatedLead) {
    // Non-blocking: patch only changed columns so UI stays fast and other cells stay intact.
    updateSingleLeadRowInSheets(result.updatedLead, {
      changedFields: result.changedFields || [],
    }).catch((err) => {
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

/**
 * Priority/label-only patch. Avoids full updateLead side effects (follow-up logs,
 * status tracking noise, full sheet row rewrite/append).
 */
export async function updateLeadPriority({ leadUniqueId, leadLabel }) {
  const id = String(leadUniqueId || "").trim();
  const priority = String(leadLabel || "").trim();
  if (!id) {
    throw new ApiError(400, "MISSING_LEAD_ID", "Missing lead unique ID");
  }

  const db = getFirestore();
  const leadRef = db.collection("leads").doc(id);
  const snap = await leadRef.get();
  if (!snap.exists) {
    throw new ApiError(404, "LEAD_NOT_FOUND", `Lead ${id} not found`);
  }

  const current = snap.data() || {};
  const updatedAt = nowIso();
  await leadRef.set(
    {
      leadLabel: priority,
      updatedAt,
      crmUpdatedAt: updatedAt,
    },
    { merge: true }
  );

  const updatedLead = {
    ...current,
    leadUniqueId: id,
    leadLabel: priority,
    updatedAt,
    crmUpdatedAt: updatedAt,
  };

  updateLeadLabelInSheets(updatedLead).catch((err) => {
    console.error("Background lead-label sheet update error:", err);
  });

  return {
    success: true,
    updatedLead,
    noOp: false,
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

  const normalized = normalizeLeadDatesForWrite({ ...(payload || {}) });

  // Keep full clock time on every date field (same as Sheets / OG).
  for (const fieldName of DATE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(normalized, fieldName)) continue;
    const raw = normalized[fieldName];
    if (raw === null || raw === undefined || String(raw).trim() === "") {
      normalized[fieldName] = "";
      continue;
    }
    normalized[fieldName] = normalizeDateToIso(raw) || "";
  }

  // New leads always get a real leadDate with time (form datetime-local or now).
  if (!normalized.leadDate) {
    normalized.leadDate = now;
  }
  if (!normalized.firstContactTimestamp) {
    normalized.firstContactTimestamp = now;
  }

  let leadUniqueId = String(normalized.leadUniqueId || payload?.leadUniqueId || "").trim();
  if (!leadUniqueId) {
    leadUniqueId = await allocateNextLeadId(db);
  }

  const ref = db.collection("leads").doc(String(leadUniqueId));
  const snap = await ref.get();
  if (snap.exists) {
    throw new ApiError(409, "LEAD_ALREADY_EXISTS", `Lead ${leadUniqueId} already exists`);
  }

  let assignedTo = String(normalized.assignedTo || payload?.assignedTo || "").trim();
  const assignmentStatus = String(normalized.assignmentStatus || payload?.assignmentStatus || "").trim();
  const syncStatus = String(normalized.syncStatus || payload?.syncStatus || "").trim();
  const isPendingSyncLead = assignmentStatus === "pending" && syncStatus === "needs_assignment";
  const isExplicitUnassigned = assignedTo.toLowerCase() === "unassigned";

  if (!assignedTo && !isPendingSyncLead && !isExplicitUnassigned) {
    const roundRobinResult = await assignLeadBackendRoundRobin(db);
    if (roundRobinResult && roundRobinResult.assignedTo) {
      assignedTo = roundRobinResult.assignedTo;
    } else {
      console.warn("Auto-assignment warn:", roundRobinResult?.error || "No active assignees available");
    }
  }

  if (isExplicitUnassigned) {
    assignedTo = "Unassigned";
  }

  const doc = {
    ...normalized,
    assignedTo,
    leadUniqueId,
    leadStatus: normalized.leadStatus || "New Lead",
    platform: normalized.platform || "",
    callType: normalized.callType || "",
    noOfFollowups: Number(normalized.noOfFollowups) || 0,
    createdAt: now,
    updatedAt: now,
    assignmentStatus: assignmentStatus || (assignedTo ? "assigned" : "pending"),
    syncStatus: syncStatus || (assignedTo ? "synced" : "needs_assignment"),
    assignmentSource: normalized.assignmentSource || "crm_upload",
  };
  await ref.set(doc);

  await db.collection("userActivityLogs").add({
    action: "LEAD_CREATED",
    leadUniqueId,
    actor: payload?.actor || assignedTo || "system",
    createdAt: now,
  });

  // Mirror to sheets before returning so Cloud Run cannot drop unfinished writes,
  // and so grid/append failures surface in the upload response path/logs.
  const sheetJobs = [
    updateSingleLeadRowInSheets(doc, { allowAppend: true }).catch((err) => {
      console.error("Background new-lead sheet append error:", err);
    }),
  ];

  if (doc.followUpDate) {
    const followLog = {
      leadUniqueId,
      followUpDate: doc.followUpDate,
      leadStatus: doc.leadStatus || "",
      remark: doc.detailComment || doc.initialRemark || "",
      createdBy: payload?.actor || assignedTo || "system",
      createdAt: now,
    };
    sheetJobs.push(
      db
        .collection("followUpLogs")
        .add(followLog)
        .then(() => appendSingleFollowUpLogToSheets(doc, followLog))
        .catch((err) => console.error("New-lead follow-up log error:", err))
    );
  }

  if (
    doc.consutlationBookedDate &&
    ["New", "Consultation Re-Booked"].includes(String(doc.consultationStatus || ""))
  ) {
    const consLog = {
      leadUniqueId,
      consultationBookedDate: doc.consutlationBookedDate,
      consultationType: doc.consultationType || "",
      createdBy: payload?.actor || assignedTo || "system",
      createdAt: now,
    };
    sheetJobs.push(
      db
        .collection("consultationLogs")
        .add(consLog)
        .then(() => appendSingleConsultationLogToSheets(doc, consLog))
        .catch((err) => console.error("New-lead consultation log error:", err))
    );
  }

  await Promise.all(sheetJobs);

  return { success: true, leadUniqueId, lead: doc };
}

/**
 * Allocates next Lead ID using an atomic transaction on config/leadIds counter.
 * Fast (10ms), eliminates 25,000+ Firestore reads per lead, and avoids Google Sheets API latency.
 */
async function allocateNextLeadId(db) {
  const counterRef = db.collection("config").doc("leadIds");
  const nextNum = await db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    let next = snap.exists ? Number(snap.data()?.nextId) : 1;
    if (!Number.isFinite(next) || next < 1) next = 1;

    tx.set(
      counterRef,
      {
        nextId: next + 1,
        updatedAt: nowIso(),
      },
      { merge: true }
    );
    return next;
  });
  return `Lead ID - ${nextNum}`;
}
