import { z } from "zod";

const nullableString = z.string().optional().nullable().transform((v) => (v ?? ""));

export const leadUpdateSchema = z.object({
  leadUniqueId: z.string().min(1),
  leadDate: nullableString,
  clientName: nullableString,
  mobileNo: nullableString,
  secondaryMobileNo: nullableString,
  city: nullableString,
  town: nullableString,
  callType: nullableString,
  platform: nullableString,
  leadStatus: nullableString,
  rating: nullableString,
  assignedTo: nullableString,
  interestedIn: nullableString,
  followUpDate: nullableString,
  noOfFollowups: z.union([z.number(), z.string()]).optional(),
  consutlationBookedDate: nullableString,
  consutlationVisitedDate: nullableString,
  consultationType: nullableString,
  consultationStatus: nullableString,
  initialRemark: nullableString,
  detailComment: nullableString,
  Q1: nullableString,
  Q2: nullableString,
  Q3: nullableString,
  hearAboutUs: nullableString,
  orderStatus: nullableString,
  totalSalesAmount: z.union([z.number(), z.string()]).optional(),
  notBookedFeedback: nullableString,
  orderDate: nullableString,
  actor: nullableString,
  idempotencyKey: nullableString,
});

export const leadsQuerySchema = z.object({
  assignedTo: nullableString,
  leadStatus: nullableString,
  fromDate: nullableString,
  toDate: nullableString,
  city: nullableString,
  platform: nullableString,
  search: nullableString,
  limit: z.coerce.number().optional().default(5000),
});

export const syncSchema = z.object({
  dryRun: z.boolean().optional().default(false),
  date: nullableString,
});

export const inboundSyncSchema = z.object({
  dryRun: z.boolean().optional().default(false),
  limit: z.coerce.number().optional().nullable(),
  startRow: z.coerce.number().optional().default(2),
  allowBackendFallbackAssignment: z.boolean().optional().default(true),
  skipExisting: z.boolean().optional().default(false),
  triggeredBy: nullableString.optional().default("manual"),
});

export const consultationVisitedSyncSchema = z.object({
  dryRun: z.boolean().optional().default(false),
  limit: z.coerce.number().optional().nullable(),
  triggeredBy: nullableString.optional().default("manual"),
});

export const logsExportSyncSchema = z.object({
  dryRun: z.boolean().optional().default(false),
  fullRebuild: z.boolean().optional().default(false),
  batchSize: z.coerce.number().optional().default(1000),
});

export const adminSyncAssigneesSchema = z.object({
  activeAssignees: z.array(z.string()).default([]),
  mondayEligibleAssignees: z.array(z.string()).optional().default([]),
  source: nullableString.optional().default("google_sheet_users"),
  syncedBy: nullableString.optional().default("unknown"),
  usersSnapshot: z.array(z.any()).optional().default([]),
});
