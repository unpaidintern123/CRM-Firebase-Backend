import fs from "node:fs";
import path from "node:path";
import xlsx from "xlsx";
import admin from "firebase-admin";
import dotenv from "dotenv";
import { normalizeLeadDatesFromSheet } from "../functions/src/sheetDateUtils.js";

dotenv.config({ path: path.resolve(".env") });

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });
}

const db = admin.firestore();
const workbookPath = path.resolve("../CRM Clone.xlsx");
if (!fs.existsSync(workbookPath)) {
  throw new Error(`Workbook not found: ${workbookPath}`);
}

const workbook = xlsx.readFile(workbookPath);
const leadsSheet = workbook.Sheets["Leads Data"];
if (!leadsSheet) throw new Error("Leads Data sheet missing");

const leads = xlsx.utils.sheet_to_json(leadsSheet, { defval: "" });
let inserted = 0;
let updated = 0;

for (const row of leads) {
  const leadUniqueId = row["Lead Unique ID"] || row["lead unique id"] || "";
  if (!leadUniqueId) continue;
  const ref = db.collection("leads").doc(String(leadUniqueId));
  const snap = await ref.get();

  const doc = {
    leadUniqueId: String(leadUniqueId),
    leadDate: row["Lead Date"] || "",
    clientName: row["Client Name"] || "",
    mobileNo: row["Mobile No"] || "",
    secondaryMobileNo: row["Secondary Mobile No"] || "",
    city: row["City"] || "",
    town: row["Town"] || "",
    callType: row["Call Type"] || "",
    platform: row["Platform"] || "",
    leadStatus: row["Lead Status"] || "",
    rating: row["Rating"] || "",
    assignedTo: row["Assigned To"] || "",
    interestedIn: row["Interested In"] || "",
    followUpDate: row["Follow Up Date"] || "",
    noOfFollowups: row["No of Follow Ups"] || 0,
    consutlationBookedDate: row["Consultation Booked Date"] || "",
    consutlationVisitedDate: row["Consultation Visited Date"] || "",
    consultationType: row["Consultation Type"] || "",
    consultationStatus: row["Consultation Status"] || "",
    initialRemark: row["Initial Remark"] || "",
    detailComment: row["Detail Comment"] || "",
    Q1: row["How soon are you looking for solution?"] || "",
    Q2: row["Do you have a budget in mind?"] || "",
    Q3: row["Willing to visit to the center?"] || "",
    hearAboutUs: row["How did you hear about us?"] || "",
    orderStatus: row["Order Booked Status"] || "",
    totalSalesAmount: row["Sales Amount"] || "",
    notBookedFeedback: row["Not Booked Feedback"] || "",
    orderDate: row["Order Date"] || "",
    campaignname: row["CampaignName"] || "",
    adsetname: row["AdSetName"] || "",
    adname: row["AdName"] || "",
    campaignsource: row["CampaignSource"] || "",
    placement: row["Placement"] || "",
    preferredTimeToCall: row["Preferred Time To Call"] || "",
    consultationMode: row["Client Preference Consultation Mode"] || "",
    migratedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  normalizeLeadDatesFromSheet(doc);

  if (snap.exists) {
    await ref.set(doc, { merge: true });
    updated += 1;
  } else {
    await ref.set({ ...doc, createdAt: new Date().toISOString() });
    inserted += 1;
  }
}

console.log(JSON.stringify({ success: true, inserted, updated, totalRows: leads.length }, null, 2));
