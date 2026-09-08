import crypto from "node:crypto";

const baseUrl = process.env.CRM_API_BASE_URL;
const token = process.env.API_SHARED_TOKEN;
const leadUniqueId = process.env.TEST_LEAD_ID;

if (!baseUrl || !leadUniqueId) {
  throw new Error("Set CRM_API_BASE_URL and TEST_LEAD_ID env vars before running perf test");
}

const start = Date.now();
const res = await fetch(`${baseUrl}/leads/${encodeURIComponent(leadUniqueId)}`, {
  method: "PATCH",
  headers: {
    "Content-Type": "application/json",
    ...(token ? { "x-api-token": token } : {}),
  },
  body: JSON.stringify({
    detailComment: `Perf test ${new Date().toISOString()}`,
    idempotencyKey: crypto.randomUUID(),
  }),
});

const data = await res.json();
console.log(
  JSON.stringify(
    {
      status: res.status,
      elapsedMs: Date.now() - start,
      success: data?.success,
      error: data?.error || null,
    },
    null,
    2
  )
);
