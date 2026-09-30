// Unsigned local draft-terms fingerprint. It proves no signature, identity, authority or payment.
import { createHash } from 'node:crypto';

const SCHEMA = 'dalahold.unsigned-local-draft-terms.v1';
const FIELDS = ['dealId', 'version', 'scenario', 'quantity', 'amount', 'date'];
// Lowercase RFC 9562 form only, so a deal has one spelling; nil and max UUIDs are rejected.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function invalid(reason) {
  return new TypeError(`invalid draft terms: ${reason}`);
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function canonicalDraftTerms(terms) {
  if (!terms || typeof terms !== 'object' || Array.isArray(terms)) throw invalid('object');
  const keys = Reflect.ownKeys(terms);
  if (keys.length !== FIELDS.length || !FIELDS.every((field) => keys.includes(field))) {
    throw invalid('keys');
  }
  // Read each field once so the validated values are exactly the encoded values.
  const { dealId, version, scenario, quantity, amount, date } = terms;
  if (typeof dealId !== 'string' || !UUID.test(dealId)) throw invalid('dealId');
  if (!isPositiveInteger(version)) throw invalid('version');
  if (scenario !== 'livestock' && scenario !== 'grain') throw invalid('scenario');
  if (!isPositiveInteger(quantity)) throw invalid('quantity');
  if (!isPositiveInteger(amount)) throw invalid('amount');
  if (!isCalendarDate(date)) throw invalid('date');
  // Schema line, then one LF-terminated field=value line per term in this fixed order.
  const lines = [
    SCHEMA, `dealId=${dealId}`, `version=${version}`, `scenario=${scenario}`,
    `quantity=${quantity}`, `amount=${amount}`, `date=${date}`,
  ];
  return Buffer.from(lines.map((line) => `${line}\n`).join(''), 'utf8');
}

export function fingerprintDraftTerms(terms) {
  return createHash('sha256').update(canonicalDraftTerms(terms)).digest('hex');
}
