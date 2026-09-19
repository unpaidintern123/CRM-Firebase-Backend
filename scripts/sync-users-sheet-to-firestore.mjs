import { google } from "googleapis";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import dotenv from "dotenv";
import path from "node:path";

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
const spreadsheetId = process.env.CRM_SYNC_SHEET_ID || process.env.CRM_SYNC_SPREADSHEET_ID || "1fiqGa4nRkSkun-nffI_QVtFQG4o4ubJGXkMIcEprI1k";

const auth = new google.auth.JWT({
  email: process.env.FIREBASE_CLIENT_EMAIL,
  key: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});

const sheets = google.sheets({ version: "v4", auth });

console.log("==========================================");
console.log("   SYNCING USERS SHEET TO FIRESTORE       ");
console.log("==========================================\n");

const resp = await sheets.spreadsheets.values.get({
  spreadsheetId,
  range: "Users!A:G",
});

const rows = resp.data.values || [];
const activeAssignees = [];
const mondayEligibleAssignees = [];
const allUsersStatus = [];

for (let i = 1; i < rows.length; i++) {
  const row = rows[i];
  const username = String(row[0] || "").trim();
  const status = String(row[3] || "").trim() || "Inactive";
  const nextMonday = String(row[4] || "").trim();

  if (username) {
    allUsersStatus.push({ username, status, nextMonday });
    if (status === "Active") {
      activeAssignees.push(username);
      if (nextMonday === "Coming") {
        mondayEligibleAssignees.push(username);
      }
    }
  }
}

console.log("Read from Users Sheet:");
console.log(" - Active Assignees:", activeAssignees);
console.log(" - Monday Eligible Assignees:", mondayEligibleAssignees);
console.log(" - Total Users:", allUsersStatus.length);

const now = new Date().toISOString();
const configRef = db.collection("config").doc("leadAssignment");

const snap = await configRef.get();
const prev = snap.exists ? snap.data() : {};
const previousAssignees = Array.isArray(prev.activeAssignees) ? prev.activeAssignees : [];

const removedAssignees = previousAssignees.filter((name) => !activeAssignees.includes(name));
const addedAssignees = activeAssignees.filter((name) => !previousAssignees.includes(name));

let nextIndex = Number.isInteger(prev.lastAssignedIndex) ? prev.lastAssignedIndex : -1;
if (nextIndex < 0 || nextIndex >= activeAssignees.length || addedAssignees.length || removedAssignees.length) {
  nextIndex = -1;
}

await configRef.set(
  {
    activeAssignees,
    mondayEligibleAssignees,
    source: "sync_users_script",
    updatedAt: now,
    lastAssignedIndex: nextIndex,
    addedAssignees,
    removedAssignees,
  },
  { merge: true }
);

allUsersStatus.forEach((u) => {
  const uRef = db.collection("users").doc(u.username);
  uRef.set({ status: u.status, updatedAt: now }, { merge: true });
});

console.log("\n✅ Successfully updated Firestore `config/leadAssignment` and `users` status!");
console.log("New Active Assignees Pool:", activeAssignees);
console.log("New Monday Pool:", mondayEligibleAssignees);
