import dotenv from "dotenv";
import path from "node:path";
import { runEndOfDaySync } from "../functions/src/sheetsExport.js";

dotenv.config({ path: path.resolve(".env") });

const dryRun = process.argv.includes("--dry-run");
const res = await runEndOfDaySync({ dryRun });
console.log(JSON.stringify(res, null, 2));
