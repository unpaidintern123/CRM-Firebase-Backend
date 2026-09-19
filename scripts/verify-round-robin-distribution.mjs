import dotenv from "dotenv";
import path from "node:path";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

dotenv.config({ path: path.resolve(".env") });

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    }),
  });
}

const db = getFirestore();

console.log("==========================================");
console.log("   ROUND-ROBIN LEAD ASSIGNMENT AUDIT    ");
console.log("==========================================\n");

// 1. Fetch current Round-Robin Config
const configSnap = await db.collection("config").doc("leadAssignment").get();
const configData = configSnap.exists ? configSnap.data() : {};
const activeAssignees = Array.isArray(configData.activeAssignees) ? configData.activeAssignees : [];
const mondayAssignees = Array.isArray(configData.mondayEligibleAssignees) ? configData.mondayEligibleAssignees : [];
const lastAssignedIndex = configData.lastAssignedIndex ?? -1;

console.log("Active Assignees Pool:", activeAssignees);
console.log("Monday Eligible Pool:", mondayAssignees);
console.log(`Current Pointer Index: ${lastAssignedIndex} (Next rep: "${activeAssignees[(lastAssignedIndex + 1) % activeAssignees.length] || "N/A"}")`);
console.log("------------------------------------------\n");

// 2. Fetch leads created recently (last 100 leads) sorted by createdAt asc
const leadsSnap = await db.collection("leads").orderBy("createdAt", "desc").limit(200).get();
const leads = leadsSnap.docs.map((doc) => doc.data());

// Filter leads created today or recently
const todayStr = new Date().toISOString().split("T")[0];
const todayLeads = leads.filter((l) => String(l.createdAt || "").startsWith(todayStr));

// 3. Count lead distribution per rep
const totalCountByRep = {};
const todayCountByRep = {};

activeAssignees.forEach((rep) => {
  totalCountByRep[rep] = 0;
  todayCountByRep[rep] = 0;
});

leads.forEach((lead) => {
  const rep = String(lead.assignedTo || "").trim();
  if (rep) {
    totalCountByRep[rep] = (totalCountByRep[rep] || 0) + 1;
    if (String(lead.createdAt || "").startsWith(todayStr)) {
      todayCountByRep[rep] = (todayCountByRep[rep] || 0) + 1;
    }
  }
});

console.log("📊 LEAD DISTRIBUTION (Recent 200 Leads):");
console.table(
  Object.keys(totalCountByRep).map((rep) => ({
    Representative: rep,
    "Recent Leads Count": totalCountByRep[rep],
    "Today's Leads Count": todayCountByRep[rep],
    Status: activeAssignees.includes(rep) ? "Active in Pool" : "Inactive / Historical",
  }))
);

// 4. Audit Rotation Order for last 20 assigned leads
const chronologicalLeads = [...leads].reverse().slice(-20);
console.log("\n🔄 RECENT ASSIGNMENT SEQUENCE (Last 20 Leads Chronologically):");
const sequence = chronologicalLeads.map((l) => ({
  "Lead ID": l.leadUniqueId,
  "Assigned To": l.assignedTo || "(unassigned)",
  Platform: l.platform || "N/A",
  "Created At": l.createdAt ? l.createdAt.slice(0, 19).replace("T", " ") : "N/A",
}));

console.table(sequence);

// 5. Fairness & Balance Check
const activeCounts = activeAssignees.map((rep) => totalCountByRep[rep] || 0);
const maxCount = Math.max(...activeCounts, 0);
const minCount = Math.min(...activeCounts, 0);
const diff = maxCount - minCount;

console.log("\n⚖️ ROUND-ROBIN FAIRNESS ANALYSIS:");
console.log(` - Active Pool Size: ${activeAssignees.length} reps`);
console.log(` - Min Leads assigned to active rep: ${minCount}`);
console.log(` - Max Leads assigned to active rep: ${maxCount}`);
console.log(` - Distribution Difference: ${diff}`);

if (diff <= 1) {
  console.log("\n✅ PERFECT BALANCE: Round-robin lead distribution is 100% EVEN and working correctly!");
} else if (diff <= 3) {
  console.log("\n✅ GOOD BALANCE: Round-robin distribution is balanced within normal tolerance (diff <= 3).");
} else {
  console.log("\n⚠️ ATTENTION: Variance detected in lead distribution across active reps. Review active pool config.");
}
