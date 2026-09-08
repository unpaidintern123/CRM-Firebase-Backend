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

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });
}

const db = admin.firestore();
const spreadsheetId = process.env.CRM_SYNC_SHEET_ID || process.env.CRM_SYNC_SPREADSHEET_ID;

function getGoogleAuth() {
  return new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
}

async function readUsersFromSheet() {
  if (!spreadsheetId) {
    throw new Error("Set CRM_SYNC_SHEET_ID in .env");
  }

  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Users!A:G",
  });

  const rows = resp.data.values || [];
  const users = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const username = String(row[0] || "").trim();
    if (!username) continue;

    users.push({
      username,
      password: String(row[1] || ""),
      permission: String(row[2] || "").trim() || "User",
      status: String(row[3] || "").trim() || "Inactive",
      nextMonday: String(row[4] || "").trim(),
      leadFlow: row[5],
      email: String(row[6] || "").trim(),
    });
  }

  return users;
}

const dryRun = process.argv.includes("--dry-run");

async function main() {
  const users = await readUsersFromSheet();
  let created = 0;
  let updated = 0;

  for (const user of users) {
    const ref = db.collection("users").doc(user.username);
    const snap = await ref.get();
    const passwordHash = user.password ? await bcrypt.hash(user.password, 10) : "";

    const doc = {
      username: user.username,
      passwordHash,
      permission: user.permission,
      status: user.status,
      email: user.email,
      homeLink: "",
      updatedAt: new Date().toISOString(),
      source: "users_sheet_migration",
    };

    if (!snap.exists) {
      doc.createdAt = doc.updatedAt;
      if (!dryRun) await ref.set(doc);
      created += 1;
    } else {
      if (!dryRun) await ref.set(doc, { merge: true });
      updated += 1;
    }
  }

  console.log(
    JSON.stringify(
      {
        dryRun,
        usersScanned: users.length,
        created,
        updated,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
