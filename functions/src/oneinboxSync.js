/**
 * Best-effort push of lead stage/details to oneinbox.
 * Does not throw. No-op when ONEINBOX_WEBHOOK_URL is unset.
 * Fire-and-forget from updateLead — never blocks CRM response.
 * Does not touch Sheets, assignment, or other CRM logic.
 */

function digitsPhone(mobileNo) {
  const d = String(mobileNo || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.length === 10) return `91${d}`;
  return d;
}

export async function pushLeadToOneinbox(lead) {
  const url = String(process.env.ONEINBOX_WEBHOOK_URL || "").trim();
  if (!url || !lead) return;

  const body = {
    ProspectID: lead.leadUniqueId || "",
    ProspectAutoId: lead.leadUniqueId || "",
    Phone: digitsPhone(lead.mobileNo),
    ProspectStage: lead.leadStatus || "",
    FirstName: lead.clientName || "",
    OwnerIdName: lead.assignedTo || "",
    Source: lead.campaignsource || lead.platform || "CRM",
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn("[oneinboxSync] HTTP", res.status, await res.text().catch(() => ""));
    }
  } catch (e) {
    console.warn("[oneinboxSync] push failed:", e?.message || e);
  }
}
