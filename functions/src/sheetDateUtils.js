/**
 * Google Sheets / Excel store datetimes as serial numbers:
 * integer part = days since 1899-12-30 (Sheets-compatible), fractional part = time of day.
 * If we store that raw double in Firestore, the CRM treats it like milliseconds → epoch 1970.
 */

const MS_PER_DAY = 86400000;
/** Sheets / Excel-compatible epoch (Dec 30, 1899 UTC). Same as Sheets `DATEVALUE` baseline. */
const SHEETS_SERIAL_EPOCH_MS = Date.UTC(1899, 11, 30);

/** Typical serial range for modern leads (~1980–2070 day indices). Outside this we skip. */
const MIN_SERIAL_DAY = 20000;
const MAX_SERIAL_DAY = 120000;

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
 * Convert Sheets serial to ISO 8601 string (UTC).
 * @param {number} serial
 * @returns {string}
 */
export function sheetsSerialToIso(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n)) return "";
  const ms = SHEETS_SERIAL_EPOCH_MS + n * MS_PER_DAY;
  return new Date(ms).toISOString();
}

const DATE_FIELDS = new Set([
  "leadDate",
  "followUpDate",
  "consutlationBookedDate",
  "consutlationVisitedDate",
  "orderDate",
]);

/**
 * Normalize a single field: serial → ISO; leave strings/empty as-is (trim strings).
 * @param {string} fieldName
 * @param {unknown} value
 * @returns {unknown}
 */
export function normalizeSheetDateField(fieldName, value) {
  if (!DATE_FIELDS.has(fieldName)) return value;
  if (value === null || value === undefined || value === "") return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (looksLikeSheetsSerialDate(trimmed)) {
      return sheetsSerialToIso(Number(trimmed));
    }
    return trimmed;
  }
  if (typeof value === "number" && looksLikeSheetsSerialDate(value)) {
    return sheetsSerialToIso(value);
  }
  return value;
}

/**
 * Mutates and returns `lead`: converts Sheets-style serial doubles to ISO on known date keys.
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
 * Convert Firestore-stored value to a string safe for legacy CRM / HTML date inputs.
 * Handles legacy mistakes: serial doubles stored in Firestore.
 * @param {unknown} value
 * @returns {string}
 */
export function firestoreDateToDisplayString(value) {
  if (value === null || value === undefined || value === "") return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "object" && value !== null && typeof value.toDate === "function") {
    try {
      const d = value.toDate();
      if (d instanceof Date && !Number.isNaN(d.getTime())) return d.toISOString();
    } catch {
      /* ignore */
    }
  }
  if (typeof value === "number" && looksLikeSheetsSerialDate(value)) {
    return sheetsSerialToIso(value);
  }
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return "";
    if (looksLikeSheetsSerialDate(t)) return sheetsSerialToIso(Number(t));
    return t;
  }
  return String(value);
}
