import { config as dotenvConfig } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchOrdersToVisitedLeads, formatOrderMatchSuccessMessage } from "../functions/src/orderMatchSync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, "../.env") });

const dryRun = process.argv.includes("--dry-run");

const summary = await matchOrdersToVisitedLeads({
  dryRun,
  triggeredBy: "cli_sync_order_match",
});

console.log(formatOrderMatchSuccessMessage(summary));
console.log(JSON.stringify(summary, null, 2));
