import admin from "firebase-admin";
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
import { pushLeadToOneinbox } from "./oneinboxSync.js";

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

let allLeadsCache = {
  docs: null,
  legacyString: null,
  cachedAt: 0,
};
const ALL_LEADS_CACHE_TTL_MS = 60 * 1000; // 60 seconds

// Per-user cache so reps do not trigger full Firestore scans or invalidate each other's cache
const userLeadsCache = new Map();
const USER_LEADS_CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes

let campaignOptionsCache = {
  data: null,
  cachedAt: 0,
};
const CAMPAIGN_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

let consultationCache = {
  data: null,
  cachedAt: 0,
};
const CONSULTATION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function invalidateUserLeadsCache(username) {
  if (username) {
    userLeadsCache.delete(String(username).trim());
  } else {
    userLeadsCache.clear();
  }
}

export function invalidateLeadsCache(options = {}) {
  allLeadsCache = { docs: null, legacyString: null, cachedAt: 0 };
  if (options.user) {
    invalidateUserLeadsCache(options.user);
  } else {
    userLeadsCache.clear();
  }
  consultationCache = { data: null, cachedAt: 0 };
  if (options.includeCampaigns) {
    campaignOptionsCache = { data: null, cachedAt: 0 };
  }
}

export function filterLeadsInMemory(leads, filters = {}) {
  let filtered = [...leads];

  if (filters.assignedTo) {
    filtered = filtered.filter((l) => l.assignedTo === filters.assignedTo);
  }
  if (filters.leadStatus) {
    filtered = filtered.filter((l) => l.leadStatus === filters.leadStatus);
  }
  if (filters.city) {
    filtered = filtered.filter((l) => l.city === filters.city);
  }
  if (filters.platform) {
    filtered = filtered.filter((l) => l.platform === filters.platform);
  }
  if (filters.fromDate) {
    const fromTs = new Date(filters.fromDate).getTime();
    if (!Number.isNaN(fromTs)) {
      filtered = filtered.filter((l) => {
        const d = new Date(l.leadDate || l.createdAt || 0).getTime();
        return d >= fromTs;
      });
    }
  }
  if (filters.toDate) {
    const toTs = new Date(filters.toDate).getTime();
    if (!Number.isNaN(toTs)) {
      filtered = filtered.filter((l) => {
        const d = new Date(l.leadDate || l.createdAt || 0).getTime();
        return d <= toTs;
      });
    }
  }
  if (filters.search) {
    const needle = filters.search.toLowerCase();
    filtered = filtered.filter((lead) =>
      [lead.clientName, lead.mobileNo, lead.city, lead.leadUniqueId]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle))
    );
  }

  filtered = filtered.filter((lead) => (lead.assignmentStatus || "assigned") !== "pending");

  if (filters.limit && Number(filters.limit) > 0) {
    filtered = filtered.slice(0, Number(filters.limit));
  }

  return filtered;
}

export async function getLeads(filters = {}) {
  const now = Date.now();
  const assignedTo = filters.assignedTo ? String(filters.assignedTo).trim() : "";

  // 1. If assignedTo is specified, check per-user cache
  if (assignedTo) {
    const userCache = userLeadsCache.get(assignedTo);
    if (userCache?.docs && now - userCache.cachedAt < USER_LEADS_CACHE_TTL_MS) {
      return filterLeadsInMemory(userCache.docs, filters);
    }
  } else {
    // Check full cache if warm
    if (allLeadsCache.docs && now - allLeadsCache.cachedAt < ALL_LEADS_CACHE_TTL_MS) {
      return filterLeadsInMemory(allLeadsCache.docs, filters);
    }
  }

  const db = getFirestore();
  const isUnconstrained =
    !assignedTo &&
    !filters.leadStatus &&
    !filters.city &&
    !filters.platform &&
    !filters.search &&
    !filters.fromDate &&
    !filters.toDate &&
    (!filters.limit || Number(filters.limit) >= 5000);

  let query = db.collection("leads");

  if (assignedTo) query = query.where("assignedTo", "==", assignedTo);
  if (filters.leadStatus) query = query.where("leadStatus", "==", filters.leadStatus);
  if (filters.city) query = query.where("city", "==", filters.city);
  if (filters.platform) query = query.where("platform", "==", filters.platform);

  // Safety: if no assignedTo is passed and limit is missing/large, default limit to 200
  // to prevent accidental 25,000 document reads from blowing the daily free tier
  if (filters.limit && Number(filters.limit) > 0) {
    query = query.limit(Number(filters.limit));
  } else if (!assignedTo) {
    query = query.limit(200);
  }

  let leads;
  try {
    // Fast path when composite indexes are available
    const orderedSnap = await query.orderBy("updatedAt", "desc").get();
    leads = orderedSnap.docs.map((doc) => ({ ...doc.data(), leadUniqueId: doc.id }));
  } catch (err) {
    // Fallback path if composite index is still building
    const fallbackSnap = await query.get();
    leads = fallbackSnap.docs.map((doc) => ({ ...doc.data(), leadUniqueId: doc.id }));
    leads.sort((a, b) => {
      const aTs = new Date(a.updatedAt || a.createdAt || 0).getTime();
      const bTs = new Date(b.updatedAt || b.createdAt || 0).getTime();
      return bTs - aTs;
    });
  }

  if (assignedTo) {
    const existing = userLeadsCache.get(assignedTo) || {};
    userLeadsCache.set(assignedTo, {
      ...existing,
      docs: leads,
      cachedAt: now,
    });
  } else if (isUnconstrained) {
    allLeadsCache.docs = leads;
    allLeadsCache.cachedAt = now;
    allLeadsCache.legacyString = null;
  }

  return filterLeadsInMemory(leads, filters);
}

export async function getLegacyLeadsPayload(filters = {}) {
  const now = Date.now();
  const assignedTo = filters.assignedTo ? String(filters.assignedTo).trim() : "";

  // Check per-user cache for simple user lead requests
  const isSimpleUserFetch =
    assignedTo &&
    !filters.leadStatus &&
    !filters.city &&
    !filters.platform &&
    !filters.search &&
    !filters.fromDate &&
    !filters.toDate &&
    !filters.limit;

  if (isSimpleUserFetch) {
    const userCache = userLeadsCache.get(assignedTo);
    if (userCache?.legacyString && now - userCache.cachedAt < USER_LEADS_CACHE_TTL_MS) {
      return userCache.legacyString;
    }
  }

  const isUnconstrained =
    !assignedTo &&
    !filters.leadStatus &&
    !filters.city &&
    !filters.platform &&
    !filters.search &&
    !filters.fromDate &&
    !filters.toDate &&
    !filters.limit;

  if (
    isUnconstrained &&
    allLeadsCache.legacyString &&
    now - allLeadsCache.cachedAt < ALL_LEADS_CACHE_TTL_MS
  ) {
    return allLeadsCache.legacyString;
  }

  const leads = await getLeads(filters);
  const jsonStr = JSON.stringify(leads.map(toLegacyLead));

  if (isSimpleUserFetch) {
    const existing = userLeadsCache.get(assignedTo) || {};
    userLeadsCache.set(assignedTo, {
      ...existing,
      docs: leads,
      legacyString: jsonStr,
      cachedAt: now,
    });
  } else if (isUnconstrained) {
    allLeadsCache.legacyString = jsonStr;
    allLeadsCache.cachedAt = now;
  }

  return jsonStr;
}

export async function updateLead(payload, options = {}) {
  const db = getFirestore();
  const leadRef = db.collection("leads").doc(payload.leadUniqueId);
  const idempotencyKey = payload.idempotencyKey || null;
  let previousAssignedTo = "";
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
    previousAssignedTo = current.assignedTo || "";

    // Form update or partial patch: only allow fields that were explicitly sent in changedKeys
    // to overwrite existing values. This prevents Zod empty string defaults from wiping untouched fields.
    const rawKeySet = new Set(rawChangedKeys);
    const sanitizedPayload = normalizeLeadDatesForWrite({ ...payload });
    for (const key of Object.keys(sanitizedPayload)) {
      if (!rawKeySet.has(key) || sanitizedPayload[key] === undefined || sanitizedPayload[key] === null) {
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
    const previousFollowCount = Number(current.noOfFollowups) || 0;
    const followUpCount = previousFollowCount + (followUpChanged ? 1 : 0);

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

    // Best-effort oneinbox stage sync — never blocks CRM / Sheets.
    void pushLeadToOneinbox(result.updatedLead);
  }

  if (result.updatedLead) {
    const assignedUser = result.updatedLead.assignedTo;
    invalidateUserLeadsCache(assignedUser);
    if (previousAssignedTo && previousAssignedTo !== assignedUser) {
      invalidateUserLeadsCache(previousAssignedTo);
    }
    if (result.newConsultationLog || result.updatedLead?.consutlationBookedDate) {
      consultationCache = { data: null, cachedAt: 0 };
    }
    recordCampaignMetadata(db, result.updatedLead).catch(() => {});
  }

  if (allLeadsCache.docs && result.updatedLead) {
    const idx = allLeadsCache.docs.findIndex(
      (l) => l.leadUniqueId === result.updatedLead.leadUniqueId
    );
    if (idx !== -1) {
      allLeadsCache.docs[idx] = { ...allLeadsCache.docs[idx], ...result.updatedLead };
    } else {
      allLeadsCache.docs.unshift(result.updatedLead);
    }
    allLeadsCache.legacyString = null;
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

  if (updatedLead.assignedTo) {
    invalidateUserLeadsCache(updatedLead.assignedTo);
  }

  if (allLeadsCache.docs) {
    const idx = allLeadsCache.docs.findIndex((l) => l.leadUniqueId === id);
    if (idx !== -1) {
      allLeadsCache.docs[idx] = { ...allLeadsCache.docs[idx], ...updatedLead };
    }
    allLeadsCache.legacyString = null;
  }

  return {
    success: true,
    updatedLead,
    noOp: false,
  };
}

export async function getDashboardMetrics(filters = {}) {
  const db = getFirestore();
  let baseQuery = db.collection("leads");

  if (filters.assignedTo) {
    baseQuery = baseQuery.where("assignedTo", "==", String(filters.assignedTo).trim());
  }
  if (filters.city) {
    baseQuery = baseQuery.where("city", "==", filters.city);
  }
  if (filters.platform) {
    baseQuery = baseQuery.where("platform", "==", filters.platform);
  }

  // Use low-cost Firestore aggregation count() queries (1 read per 1,000 index entries)
  try {
    const [
      totalSnap,
      newLeadSnap,
      bookedSnap,
      visitedSnap,
      lostSnap,
      deadSnap,
    ] = await Promise.all([
      baseQuery.count().get(),
      baseQuery.where("leadStatus", "==", "New Lead").count().get(),
      baseQuery.where("leadStatus", "==", "Consultation Booked").count().get(),
      baseQuery.where("leadStatus", "==", "Consultation Visited").count().get(),
      baseQuery.where("leadStatus", "==", "Lost").count().get(),
      baseQuery.where("leadStatus", "==", "Dead").count().get(),
    ]);

    const total = totalSnap.data().count;
    const newLead = newLeadSnap.data().count;
    const booked = bookedSnap.data().count;
    const visited = visitedSnap.data().count;
    const lost = lostSnap.data().count;
    const dead = deadSnap.data().count;

    let followup = 0;
    try {
      const followupSnap = await baseQuery
        .where("leadStatus", "in", [
          "Warm Lead",
          "Cold Lead 1",
          "Cold Lead 2",
          "Deferred Lead",
          "Ringing / Busy",
          "Not Reachable",
        ])
        .count()
        .get();
      followup = followupSnap.data().count;
    } catch (e) {
      followup = Math.max(0, total - (newLead + booked + visited + lost + dead));
    }

    return {
      total,
      newLead,
      booked,
      visited,
      lost,
      dead,
      followup,
    };
  } catch (err) {
    console.warn("Aggregation count failed, computing from user cache:", err?.message);
    const leads = await getLeads({ assignedTo: filters.assignedTo, limit: 1000 });
    return {
      total: leads.length,
      newLead: leads.filter((l) => l.leadStatus === "New Lead").length,
      booked: leads.filter((l) => l.leadStatus === "Consultation Booked").length,
      visited: leads.filter((l) => l.leadStatus === "Consultation Visited").length,
      lost: leads.filter((l) => l.leadStatus === "Lost").length,
      dead: leads.filter((l) => l.leadStatus === "Dead").length,
      followup: leads.filter((l) =>
        [
          "Warm Lead",
          "Cold Lead 1",
          "Cold Lead 2",
          "Deferred Lead",
          "Ringing / Busy",
          "Not Reachable",
        ].includes(l.leadStatus)
      ).length,
    };
  }
}

export async function recordCampaignMetadata(db, leadData = {}) {
  const updates = {};
  const { FieldValue } = admin.firestore;

  const campaign = String(leadData.campaignname || "").trim();
  const ad = String(leadData.adname || "").trim();
  const adset = String(leadData.adsetname || "").trim();
  const platform = String(leadData.platform || "").trim();
  const placement = String(leadData.placement || "").trim();

  if (campaign) updates.campaignNames = FieldValue.arrayUnion(campaign);
  if (ad) updates.adNames = FieldValue.arrayUnion(ad);
  if (adset) updates.adSetNames = FieldValue.arrayUnion(adset);
  if (platform) updates.platforms = FieldValue.arrayUnion(platform);
  if (placement) updates.placements = FieldValue.arrayUnion(placement);

  if (Object.keys(updates).length > 0) {
    updates.updatedAt = nowIso();
    try {
      await db.collection("config").doc("campaignMetadata").set(updates, { merge: true });
      campaignOptionsCache = { data: null, cachedAt: 0 };
    } catch (e) {
      console.warn("recordCampaignMetadata warning:", e?.message);
    }
  }
}

export async function getCampaignNameOptions(options = {}) {
  const now = Date.now();
  if (
    !options.forceRefresh &&
    campaignOptionsCache.data &&
    now - campaignOptionsCache.cachedAt < CAMPAIGN_CACHE_TTL_MS
  ) {
    return campaignOptionsCache.data;
  }

  const db = getFirestore();
  const metaRef = db.collection("config").doc("campaignMetadata");

  // Fast path: 1 Firestore read from config/campaignMetadata singleton document
  try {
    const snap = await metaRef.get();
    if (snap.exists) {
      const docData = snap.data() || {};
      const data = {
        campaignNames: (docData.campaignNames || []).sort(),
        adNames: (docData.adNames || []).sort(),
        adSetNames: (docData.adSetNames || []).sort(),
        platforms: (docData.platforms || []).sort(),
        placements: (docData.placements || []).sort(),
      };
      campaignOptionsCache = { data, cachedAt: now };
      return data;
    }
  } catch (err) {
    console.warn("Failed to read config/campaignMetadata, falling back to limited scan:", err?.message);
  }

  // Fallback if config/campaignMetadata has not been created yet: scan only 100 recent leads (NEVER 3,000!)
  let snap;
  try {
    snap = await db
      .collection("leads")
      .select("campaignname", "adname", "adsetname", "platform", "placement")
      .orderBy("updatedAt", "desc")
      .limit(100)
      .get();
  } catch (err) {
    snap = await db
      .collection("leads")
      .select("campaignname", "adname", "adsetname", "platform", "placement")
      .limit(100)
      .get();
  }

  const leads = snap.docs.map((doc) => doc.data());
  const uniq = (name) => [...new Set(leads.map((l) => l[name]).filter(Boolean))].sort();
  const data = {
    campaignNames: uniq("campaignname"),
    adNames: uniq("adname"),
    adSetNames: uniq("adsetname"),
    platforms: uniq("platform"),
    placements: uniq("placement"),
  };

  // Seed the metadata document so future calls only consume 1 read
  metaRef.set({ ...data, updatedAt: nowIso() }, { merge: true }).catch((e) => {
    console.warn("Could not save initial campaignMetadata:", e?.message);
  });

  campaignOptionsCache = { data, cachedAt: now };
  return data;
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
 * When assignedTo is given, derives directly from user's cached leads to save reads.
 */
export async function getLegacyConsultationPayload(options = {}) {
  const now = Date.now();
  const assignedTo = options.assignedTo ? String(options.assignedTo).trim() : "";

  // If assignedTo is provided, derive from user's cached leads — saves 100+ reads!
  if (assignedTo) {
    let userLeads = userLeadsCache.get(assignedTo)?.docs;
    if (!userLeads) {
      userLeads = await getLeads({ assignedTo });
    }
    const booked = userLeads
      .filter((lead) => lead.consutlationBookedDate || lead.leadStatus === "Consultation Booked" || lead.leadStatus === "Consultation Visited")
      .map((lead) =>
        consultationEntryToLegacyRow(
          {
            createdAt: lead.consutlationBookedDate || lead.leadDate || lead.createdAt,
            consultationBookedDate: lead.consutlationBookedDate,
            consultationType: lead.consultationType,
            leadUniqueId: lead.leadUniqueId,
          },
          lead
        )
      );
    return JSON.stringify(booked);
  }

  if (
    !options.forceRefresh &&
    consultationCache.data &&
    now - consultationCache.cachedAt < CONSULTATION_CACHE_TTL_MS
  ) {
    return consultationCache.data;
  }

  const db = getFirestore();
  let logsSnap;
  try {
    logsSnap = await db.collection("consultationLogs").orderBy("createdAt", "desc").limit(200).get();
  } catch (err) {
    logsSnap = await db.collection("consultationLogs").limit(200).get();
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

    const result = JSON.stringify(rows);
    consultationCache = { data: result, cachedAt: now };
    return result;
  }

  const leads = await getLeads({ limit: 100 });
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

  const result = JSON.stringify(rows);
  consultationCache = { data: result, cachedAt: now };
  return result;
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
  const originalRequestedId = leadUniqueId;
  let allocatedNewId = false;

  if (leadUniqueId) {
    const ref = db.collection("leads").doc(String(leadUniqueId));
    const snap = await ref.get();
    if (snap.exists) {
      // If that ID already exists in DB, replace it with a newly allocated unique ID
      leadUniqueId = await allocateNextLeadId(db);
      allocatedNewId = true;
    }
  } else {
    leadUniqueId = await allocateNextLeadId(db);
    allocatedNewId = true;
  }

  const ref = db.collection("leads").doc(String(leadUniqueId));

  let assignedTo = String(normalized.assignedTo || payload?.assignedTo || "").trim();
  const assignmentStatus = String(normalized.assignmentStatus || payload?.assignmentStatus || "").trim();
  const syncStatus = String(normalized.syncStatus || payload?.syncStatus || "").trim();
  const isPendingSyncLead = assignmentStatus === "pending" && syncStatus === "needs_assignment";
  const isExplicitUnassigned = assignedTo.toLowerCase() === "unassigned";

  // If assignedTo is empty (e.g. incoming marketing leads from sendLeadToFirebase),
  // auto-assign via backend round-robin unless explicitly marked as pending or unassigned.
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
    assignmentStatus: assignmentStatus || (assignedTo && assignedTo !== "Unassigned" ? "assigned" : "pending"),
    syncStatus: syncStatus || (assignedTo && assignedTo !== "Unassigned" ? "synced" : "needs_assignment"),
    assignmentSource: normalized.assignmentSource || (assignedTo && assignedTo !== "Unassigned" ? "crm_upload" : "sheet_unassigned"),
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
    updateSingleLeadRowInSheets(doc, {
      allowAppend: true,
      originalLeadUniqueId: allocatedNewId && originalRequestedId ? originalRequestedId : null,
      targetRow: payload?.sheetRowNumber || null,
    }).catch((err) => {
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

  if (doc.assignedTo) {
    invalidateUserLeadsCache(doc.assignedTo);
  }
  recordCampaignMetadata(db, doc).catch(() => {});

  if (allLeadsCache.docs) {
    allLeadsCache.docs.unshift(doc);
    allLeadsCache.legacyString = null;
  }

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
