import dotenv from "dotenv";
import path from "node:path";
import { syncLeadsSheetToFirestore } from "../functions/src/sheetInboundSync.js";

dotenv.config({ path: path.resolve(".env") });

function parseArg(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const dryRun = process.argv.includes("--dry-run");
const limitRaw = parseArg("limit");
const limit = limitRaw != null ? Number(limitRaw) : null;

try {
  const result = await syncLeadsSheetToFirestore({
    dryRun,
    limit: Number.isFinite(limit) ? limit : null,
    triggeredBy: "cli",
  });
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error(
    JSON.stringify(
      {
        success: false,
        error: String(err && err.message ? err.message : err),
      },
      null,
      2
    )
  );
  process.exit(1);
}
