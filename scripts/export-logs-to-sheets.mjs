import dotenv from "dotenv";
import path from "node:path";
import { runLogsExportSync } from "../functions/src/sheetsExport.js";

dotenv.config({ path: path.resolve(".env") });

const dryRun = process.argv.includes("--dry-run");
const fullRebuild = process.argv.includes("--full-rebuild");
const batchArg = process.argv.find((a) => a.startsWith("--batch-size="));
const batchSize = batchArg ? Number(batchArg.split("=")[1]) : 1000;
const res = await runLogsExportSync({
  dryRun,
  fullRebuild,
  batchSize: Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 1000,
});
console.log(JSON.stringify(res, null, 2));
