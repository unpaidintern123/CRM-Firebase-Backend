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
const apply = process.argv.includes("--apply");
const dryRun = !apply;

if (!projectId || !clientEmail || !privateKey) {
  throw new Error("Missing FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, or FIREBASE_PRIVATE_KEY in .env");
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });
}

const db = admin.firestore();

function hasValue(value) {
  return String(value || "").trim().length > 0;
}

async function main() {
  const usersSnap = await db.collection("users").get();
  const summary = {
    dryRun,
    usersScanned: usersSnap.size,
    migrated: 0,
    skippedAlreadyHasHash: 0,
    skippedMissingPassword: 0,
  };

  for (const userSnap of usersSnap.docs) {
    const user = userSnap.data();
    const username = String(user.username || userSnap.id);

    if (hasValue(user.passwordHash)) {
      summary.skippedAlreadyHasHash += 1;
      continue;
    }

    if (!hasValue(user.password)) {
      summary.skippedMissingPassword += 1;
      continue;
    }

    const passwordHash = await bcrypt.hash(String(user.password), 12);
    if (!dryRun) {
      await userSnap.ref.set({ passwordHash }, { merge: true });
    }

    console.log(`${dryRun ? "Would migrate" : "Migrated"} password hash for user: ${username}`);
    summary.migrated += 1;
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
