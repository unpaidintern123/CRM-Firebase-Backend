import { google } from "googleapis";
import admin from "firebase-admin";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

if (!projectId || !clientEmail || !privateKey) {
  console.error("❌ Missing FIREBASE_* credentials in .env");
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });
}

const db = admin.firestore();
const spreadsheetId = process.env.CRM_SYNC_SHEET_ID || "1fiqGa4nRkSkun-nffI_QVtFQG4o4ubJGXkMIcEprI1k";

const auth = new google.auth.JWT({
  email: clientEmail,
  key: privateKey,
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});

const sheets = google.sheets({ version: "v4", auth });

const isDryRun = process.argv.includes("--dry-run");

async function syncAllUsers() {
  console.log("=================================================");
  console.log(`   SYNC ALL USERS & FIELDS (SHEET -> FIRESTORE) ${isDryRun ? "[DRY RUN]" : "[LIVE UPDATE]"}`);
  console.log("=================================================\n");
  console.log("Reading sheet: " + spreadsheetId + " (tab: Users)");

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Users!A:Z",
  });

  const rows = resp.data.values || [];
  if (rows.length < 2) {
    console.log("⚠️ No user rows found in sheet!");
    return;
  }

  const header = rows[0].map(h => String(h || "").trim());
  console.log("Detected Columns:", header.join(" | "));
  console.log("\nRaw Sheet Rows:");
  rows.forEach((r, idx) => console.log(`Row ${idx}:`, JSON.stringify(r)));
  console.log("\n");

  const now = new Date().toISOString();
  const activeAssignees = [];
  const mondayEligibleAssignees = [];
  const results = {
    totalScanned: 0,
    created: [],
    updated: [],
    unchanged: [],
  };

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const username = String(row[0] || "").trim();
    if (!username) continue;

    results.totalScanned++;

    const plainPassword = String(row[1] || "").trim();
    let permission = String(row[2] || "").trim() || "CRM Executive";
    if (permission.includes("@") || permission === plainPassword) {
      console.log(`⚠️ User ${username} had password/email in permission column ('${permission}'). Defaulting to 'CRM Executive'.`);
      permission = "CRM Executive";
    }
    const status = String(row[3] || "").trim() || "Inactive";
    const nextMonday = String(row[4] || "").trim();
    const leadFlow = row[5] !== undefined ? String(row[5]).trim() : "";
    const email = String(row[6] || "").trim();

    if (status.toLowerCase() === "active") {
      activeAssignees.push(username);
      if (nextMonday.toLowerCase() === "coming") {
        mondayEligibleAssignees.push(username);
      }
    }

    const userRef = db.collection("users").doc(username);
    const snap = await userRef.get();
    const existing = snap.exists ? snap.data() : null;

    let passwordHash = existing?.passwordHash || "";
    let passwordChanged = false;

    if (plainPassword) {
      if (!passwordHash) {
        passwordHash = await bcrypt.hash(plainPassword, 10);
        passwordChanged = true;
      } else {
        const matches = await bcrypt.compare(plainPassword, passwordHash);
        if (!matches) {
          passwordHash = await bcrypt.hash(plainPassword, 10);
          passwordChanged = true;
        }
      }
    }

    const userData = {
      username,
      passwordHash,
      permission,
      status,
      email,
      nextMonday,
      leadFlow,
      homeLink: existing?.homeLink || "",
      updatedAt: now,
      source: "users_sheet_full_sync",
    };

    if (!existing) {
      userData.createdAt = now;
      if (!isDryRun) await userRef.set(userData);
      results.created.push({ username, permission, status, email, hasPassword: Boolean(passwordHash) });
      console.log(`✨ Created user: ${username} [permission: ${permission}, status: ${status}, email: ${email}]`);
    } else {
      if (!existing.createdAt) userData.createdAt = now;
      if (!isDryRun) await userRef.set(userData, { merge: true });
      results.updated.push({ username, permission, status, email, passwordChanged });
      console.log(`🔄 Updated user: ${username} [permission: ${permission}, status: ${status}, passwordUpdated: ${passwordChanged}]`);
    }
  }

  // Update leadAssignment config
  const configRef = db.collection("config").doc("leadAssignment");
  const configSnap = await configRef.get();
  const prevConfig = configSnap.exists ? configSnap.data() : {};
  const prevAssignees = Array.isArray(prevConfig.activeAssignees) ? prevConfig.activeAssignees : [];

  const addedAssignees = activeAssignees.filter(u => !prevAssignees.includes(u));
  const removedAssignees = prevAssignees.filter(u => !activeAssignees.includes(u));

  let nextIndex = Number.isInteger(prevConfig.lastAssignedIndex) ? prevConfig.lastAssignedIndex : -1;
  if (nextIndex < 0 || nextIndex >= activeAssignees.length || addedAssignees.length || removedAssignees.length) {
    nextIndex = -1;
  }

  if (!isDryRun) {
    await configRef.set(
      {
        activeAssignees,
        mondayEligibleAssignees,
        source: "sync_all_users_complete",
        updatedAt: now,
        lastAssignedIndex: nextIndex,
        addedAssignees,
        removedAssignees,
      },
      { merge: true }
    );
  }

  console.log("\n=================================================");
  console.log("   SYNC COMPLETE SUMMARY");
  console.log("=================================================");
  console.log(`Total Users Scanned: ${results.totalScanned}`);
  console.log(`Newly Created: ${results.created.length}`, results.created);
  console.log(`Updated Existing: ${results.updated.length}`);
  console.log(`Active Assignees Pool (${activeAssignees.length}):`, activeAssignees);
  console.log(`Monday Eligible Assignees Pool (${mondayEligibleAssignees.length}):`, mondayEligibleAssignees);
  console.log("=================================================\n");
}

syncAllUsers().catch(err => {
  console.error("❌ Error syncing users:", err);
  process.exit(1);
});
