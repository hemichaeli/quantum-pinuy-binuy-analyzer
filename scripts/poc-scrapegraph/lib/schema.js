/**
 * Shared target schema for all three paths. Each path returns ONE object
 * with exactly these 11 fields; nulls allowed; types canonicalised here.
 *
 * "Complete row" = address + asking_price + rooms + area_sqm all present.
 * This is the rule that the brief uses for end-to-end yield.
 */

const FIELDS = [
  'address',         // string, e.g. "נחלת יהודה, ראשון לציון"
  'city',            // string, e.g. "ראשון לציון"
  'asking_price',    // integer ILS
  'rooms',           // float, e.g. 3.5
  'area_sqm',        // integer m²
  'floor',           // integer (ground floor = 0)
  'phone',           // string of digits 9-12 chars, or null
  'contact_name',    // string
  'title',           // string (page <title> or H1)
  'description',     // string up to 500 chars
  'source_listing_id'// string — modaaNum
];

const REQUIRED_FOR_COMPLETE = ['address', 'asking_price', 'rooms', 'area_sqm'];

function canonicalize(raw) {
  const out = {};
  for (const f of FIELDS) {
    const v = raw?.[f];
    if (v === undefined || v === null || v === '') {
      out[f] = null;
      continue;
    }
    if (f === 'asking_price' || f === 'area_sqm' || f === 'floor') {
      const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
      out[f] = Number.isFinite(n) ? n : null;
    } else if (f === 'rooms') {
      const n = parseFloat(String(v).replace(/[^\d.]/g, ''));
      out[f] = Number.isFinite(n) ? n : null;
    } else if (f === 'phone') {
      const digits = String(v).replace(/\D/g, '');
      if (digits.length < 9 || digits.length > 12) { out[f] = null; }
      else { out[f] = digits.startsWith('972') ? '0' + digits.slice(3) : digits; }
    } else {
      out[f] = String(v).trim().slice(0, 500) || null;
    }
  }
  return out;
}

function isComplete(row) {
  return REQUIRED_FOR_COMPLETE.every(f => row[f] !== null && row[f] !== undefined);
}

function countNonNull(row) {
  return FIELDS.filter(f => row[f] !== null && row[f] !== undefined).length;
}

module.exports = { FIELDS, REQUIRED_FOR_COMPLETE, canonicalize, isComplete, countNonNull };
