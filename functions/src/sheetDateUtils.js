/**
 * Google Sheets / Excel store datetimes as serial numbers:
 * integer part = days since 1899-12-30 (Sheets-compatible), fractional part = time of day.
 * If we store that raw double in Firestore, the CRM treats it like milliseconds → epoch 1970.
 *
 * CRM writes should always land as ISO 8601 UTC strings that preserve wall-clock time
 * from Sheets serials and from datetime-local / dd/MM/yyyy HH:mm:ss inputs (Asia/Kolkata).
 */

const MS_PER_DAY = 86400000;
/** Sheets / Excel-compatible epoch (Dec 30, 1899 UTC). Same as Sheets `DATEVALUE` baseline. */
const SHEETS_SERIAL_EPOCH_MS = Date.UTC(1899, 11, 30);

/** Typical serial range for modern leads (~1980–2070 day indices). Outside this we skip. */
const MIN_SERIAL_DAY = 20000;
const MAX_SERIAL_DAY = 120000;

const IST_OFFSET = "+05:30";

export const DATE_FIELDS = new Set([
  "leadDate",
  "followUpDate",
  "consutlationBookedDate",
  "consutlationVisitedDate",
  "orderDate",
  "firstContactTimestamp",
]);

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function looksLikeSheetsSerialDate(value) {
  if (value === null || value === undefined || value === "") return false;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return false;
  if (n < MIN_SERIAL_DAY || n > MAX_SERIAL_DAY) return false;
  return true;
}

/**
 * Convert Sheets serial to ISO 8601 UTC.
 * Serial fraction is timezone-naive wall-clock time as shown in the CRM sheet (Asia/Kolkata),
 * matching Apps Script getValues() / OG card times — not UTC wall-clock.
 * @param {number} serial
 * @returns {string}
 */
export function sheetsSerialToIso(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n)) return "";
  // Unpack day + time-of-day from the Excel/Sheets serial as UTC components, then
  // re-interpret those components as Asia/Kolkata wall clock (same as the live sheet).
  const unpacked = new Date(SHEETS_SERIAL_EPOCH_MS + n * MS_PER_DAY);
  return isoFromIstParts(
    unpacked.getUTCFullYear(),
    unpacked.getUTCMonth() + 1,
    unpacked.getUTCDate(),
    unpacked.getUTCHours(),
    unpacked.getUTCMinutes(),
    unpacked.getUTCSeconds()
  );
}

/**
 * Inverse of sheetsSerialToIso: any CRM date → Sheets serial number (numeric cell).
 * Packs Asia/Kolkata wall-clock into the serial so the sheet displays the same IST time.
 * @param {unknown} value
 * @returns {number | ""}
 */
export function toSheetsSerialDate(value) {
  const iso = normalizeDateToIso(value);
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const get = (type) => Number(parts.find((p) => p.type === type)?.value || 0);
    const packedMs = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
      get("second")
    );
    return (packedMs - SHEETS_SERIAL_EPOCH_MS) / MS_PER_DAY;
  } catch {
    return "";
  }
}

/**
 * Build ISO from Asia/Kolkata wall-clock parts.
 * @param {number} year
 * @param {number} month 1-12
 * @param {number} day
 * @param {number} hours
 * @param {number} minutes
 * @param {number} seconds
 * @returns {string}
 */
function isoFromIstParts(year, month, day, hours = 0, minutes = 0, seconds = 0) {
  const y = String(year).padStart(4, "0");
  const m = String(month).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  const parsed = new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}${IST_OFFSET}`);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString();
}

/**
 * Normalize any CRM / Sheets date value to ISO UTC, preserving time when present.
 * Empty / unparseable → "".
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeDateToIso(value) {
  if (value === null || value === undefined || value === "") return "";

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }

  if (typeof value === "object" && value !== null) {
    if (typeof value.toDate === "function") {
      try {
        const d = value.toDate();
        if (d instanceof Date && !Number.isNaN(d.getTime())) return d.toISOString();
      } catch {
        /* ignore */
      }
    }
    if (typeof value._seconds === "number") {
      return new Date(value._seconds * 1000).toISOString();
    }
  }

  if (typeof value === "number" && looksLikeSheetsSerialDate(value)) {
    return sheetsSerialToIso(value);
  }

  if (typeof value !== "string" && typeof value !== "number") {
    return "";
  }

  const trimmed = String(value).trim();
  if (!trimmed) return "";

  if (looksLikeSheetsSerialDate(trimmed)) {
    return sheetsSerialToIso(Number(trimmed));
  }

  // datetime-local: 2025-09-10T14:30 or with seconds (no timezone) → IST wall clock
  const localMatch = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/
  );
  if (localMatch) {
    return isoFromIstParts(
      Number(localMatch[1]),
      Number(localMatch[2]),
      Number(localMatch[3]),
      Number(localMatch[4]),
      Number(localMatch[5]),
      Number(localMatch[6] || 0)
    );
  }

  // Date-only yyyy-MM-dd → IST midnight
  const ymdMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymdMatch) {
    return isoFromIstParts(Number(ymdMatch[1]), Number(ymdMatch[2]), Number(ymdMatch[3]));
  }

  // Indian Sheets display: dd/MM/yyyy [HH:mm[:ss]] [AM|PM]
  const dmyMatch = trimmed.match(
    /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?\s*(AM|PM)?)?$/i
  );
  if (dmyMatch) {
    let hours = dmyMatch[4] ? Number(dmyMatch[4]) : 0;
    const minutes = dmyMatch[5] ? Number(dmyMatch[5]) : 0;
    const seconds = dmyMatch[6] ? Number(dmyMatch[6]) : 0;
    const ampm = dmyMatch[7] ? dmyMatch[7].toUpperCase() : null;
    if (ampm === "PM" && hours < 12) hours += 12;
    if (ampm === "AM" && hours === 12) hours = 0;
    return isoFromIstParts(
      Number(dmyMatch[3]),
      Number(dmyMatch[2]),
      Number(dmyMatch[1]),
      hours,
      minutes,
      seconds
    );
  }

  // Already ISO / RFC3339 (with Z or offset)
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString();
  }

  return trimmed;
}

/**
 * True when the value carries a real clock time (not date-only / midnight).
 * @param {unknown} value
 * @returns {boolean}
 */
export function hasClockTime(value) {
  if (value === null || value === undefined || value === "") return false;

  if (typeof value === "number" && looksLikeSheetsSerialDate(value)) {
    return Math.abs(value % 1) > 1e-10;
  }

  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return false;
    if (looksLikeSheetsSerialDate(t)) {
      return Math.abs(Number(t) % 1) > 1e-10;
    }
    // Pure date forms (no time token)
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return false;
    if (/^\d{1,2}[-/]\d{1,2}[-/]\d{4}$/.test(t)) return false;
    // Explicit time in display / datetime-local
    if (/\d{1,2}:\d{2}/.test(t)) {
      const iso = normalizeDateToIso(t);
      if (!iso) return true;
      // Midnight wall-clock in IST or UTC still counts as date-only for healing.
      if (/T00:00:00(\.0+)?Z$/i.test(iso)) return false;
      if (/T18:30:00(\.0+)?Z$/i.test(iso)) return false;
      return true;
    }
  }

  const iso = normalizeDateToIso(value);
  if (!iso) return false;
  if (/T00:00:00(\.0+)?Z$/i.test(iso)) return false;
  if (/T18:30:00(\.0+)?Z$/i.test(iso)) return false;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(new Date(iso));
    const get = (type) => Number(parts.find((p) => p.type === type)?.value || 0);
    return get("hour") !== 0 || get("minute") !== 0 || get("second") !== 0;
  } catch {
    return true;
  }
}

/**
 * Prefer sheet/incoming datetime when it carries real time and stored value is empty or midnight-only.
 * @param {unknown} currentValue
 * @param {unknown} incomingValue
 * @returns {boolean}
 */
export function shouldPreferIncomingDate(currentValue, incomingValue) {
  const incomingIso = normalizeDateToIso(incomingValue);
  if (!incomingIso) return false;
  const currentIso = normalizeDateToIso(currentValue);
  if (!currentIso) return true;
  if (incomingIso === currentIso) return false;
  return hasClockTime(incomingIso) && !hasClockTime(currentIso);
}

/**
 * Normalize a single field: serial / CRM strings → ISO; empty stays "".
 * @param {string} fieldName
 * @param {unknown} value
 * @returns {unknown}
 */
export function normalizeSheetDateField(fieldName, value) {
  if (!DATE_FIELDS.has(fieldName)) return value;
  return normalizeDateToIso(value);
}

/**
 * Mutates and returns `lead`: converts Sheets-style serials / display strings to ISO.
 * Call on every row parsed from the Leads sheet before writing to Firestore.
 * @param {Record<string, unknown>} lead
 * @returns {Record<string, unknown>}
 */
export function normalizeLeadDatesFromSheet(lead) {
  if (!lead || typeof lead !== "object") return lead;
  for (const fieldName of DATE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(lead, fieldName)) {
      lead[fieldName] = normalizeSheetDateField(fieldName, lead[fieldName]);
    }
  }
  return lead;
}

/**
 * Normalize date fields on a CRM create/update payload before Firestore write.
 * @param {Record<string, unknown>} payload
 * @returns {Record<string, unknown>}
 */
export function normalizeLeadDatesForWrite(payload) {
  if (!payload || typeof payload !== "object") return payload;
  for (const fieldName of DATE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(payload, fieldName)) continue;
    const raw = payload[fieldName];
    if (raw === null || raw === undefined) continue;
    if (String(raw).trim() === "") {
      payload[fieldName] = "";
      continue;
    }
    payload[fieldName] = normalizeDateToIso(raw);
  }
  return payload;
}

/**
 * Convert Firestore-stored value to a string safe for legacy CRM / HTML date inputs.
 * Handles legacy mistakes: serial doubles stored in Firestore.
 * @param {unknown} value
 * @returns {string}
 */
export function firestoreDateToDisplayString(value) {
  return normalizeDateToIso(value) || (value === null || value === undefined || value === "" ? "" : String(value));
}
