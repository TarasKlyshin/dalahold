// Portable anonymous local TEST records. SHA-256 checks consistency, not origin.
// This module intentionally has no database, SDK, network or signing dependency.
import { createHash } from 'node:crypto';
import { TextDecoder, types } from 'node:util';
import { canonicalDraftTerms, fingerprintDraftTerms } from './terms.mjs';

export const PARTICIPANT_EVIDENCE_SCHEMA = 'dalahold.local-test-participant-evidence.v1';
export const PARTICIPANT_EVIDENCE_MODE = 'offline_integrity_and_consistency_only';
export const PARTICIPANT_EVIDENCE_MAX_BYTES = 16 * 1024 * 1024;
export const PARTICIPANT_EVIDENCE_MAX_VERSIONS = 2000;
// Kept independent of test-documents.mjs so the offline verifier needs no SQLite.
export const PARTICIPANT_EVIDENCE_MAX_DOCUMENTS = 1024;
export const PARTICIPANT_EVIDENCE_MAX_DOCUMENT_BYTES = 262_144;
export const PARTICIPANT_EVIDENCE_MAX_TOTAL_DOCUMENT_BYTES = 8 * 1024 * 1024;
export const PARTICIPANT_EVIDENCE_LIMITATIONS = Object.freeze([
  'Checks only file integrity and internal consistency. SHA-256 values are recomputable and are not signatures.',
  'Provenance and authenticity are not established. Anyone can change all contents and recompute all hashes.',
  'Personal TEST NCA receipt fields are historical local assertions. This check does not verify CMS, SDK execution, signer identity, fresh OCSP or wall-clock chronology.',
  'This file proves no legal contract, corporate authority, Solana transaction or payment.',
]);

const UNSIGNED_SCOPE = 'local_test_participant_statements_only';
const SIGNED_SCOPE = 'local_personal_test_signed_deal_only';
const UNSIGNED_SOURCE = 'unsigned_test_participant_statement';
const SIGNED_SOURCE = 'personal_test_nca_statement';
const SCOPES = [UNSIGNED_SCOPE, SIGNED_SCOPE];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const ROLES = ['seller', 'buyer'];
const STATES = ['draft', 'offered', 'agreed', 'handed_over', 'accepted', 'disputed'];
const CATEGORIES = ['contract', 'delivery', 'quality', 'other'];
const ACTIONS = {
  offer: { role: 'seller', from: ['draft'], to: 'offered' },
  agree: { role: 'buyer', from: ['offered'], to: 'agreed' },
  handover: { role: 'seller', from: ['agreed'], to: 'handed_over' },
  accept: { role: 'buyer', from: ['handed_over'], to: 'accepted' },
  dispute: { role: null, from: ['agreed', 'handed_over'], to: 'disputed' },
};
const INPUT_FIELDS = ['exportedAt', 'deal', 'versions', 'documents', 'receipts'];
const PAYLOAD_FIELDS = ['schema', 'scope', 'exportedAt', 'verification', 'limitations', 'deal', 'versions', 'documents', 'receipts'];
const DEAL_FIELDS = ['id', 'creatorId', 'version', 'scenario', 'quantity', 'amount', 'date', 'state',
  'stateRevision', 'termsFingerprint', 'role', 'participants', 'documents', 'documentHistory', 'events', 'scope', 'snapshotHash'];
const VERSION_FIELDS = ['version', 'scenario', 'quantity', 'amount', 'date', 'termsFingerprint'];
const VERSION_EVIDENCE_FIELDS = [...VERSION_FIELDS, 'canonicalTerms', 'byteLength', 'sha256', 'documentManifest', 'documentManifestHash'];
// Field order below is also the legacy ParticipantStore JSON hash order.
const DOCUMENT_FIELDS = ['id', 'dealId', 'termsVersion', 'category', 'byteLength', 'sha256', 'createdAt', 'scope', 'fileKind'];
const EVENT_FIELDS = ['id', 'dealId', 'action', 'actorId', 'role', 'termsVersion', 'stateRevision',
  'snapshotHash', 'termsFingerprint', 'documentManifestHash', 'createdAt', 'stateFrom', 'stateTo', 'source', 'scope'];
const AUTHORIZATION_FIELDS = ['receiptId', 'intentHash', 'certificateDigest', 'bindingId', 'authEpoch', 'statusSource'];
const RECEIPT_FIELDS = ['id', 'intentId', 'intentHash', 'actorId', 'action', 'dealId', 'eventId', 'snapshotHash',
  'bindingId', 'authEpoch', 'certificateDigest', 'verifiedAt', 'validUntil', 'statusSource', 'scope'];
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const uuid = value => typeof value === 'string' && UUID.test(value);
const hash = value => typeof value === 'string' && HASH.test(value);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const legacyHash = value => sha256(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const byId = (a, b) => a.id.localeCompare(b.id);
const byDocumentVersion = (a, b) => a.termsVersion - b.termsVersion || byId(a, b);
const byParty = (a, b) => a.role.localeCompare(b.role) || byId(a, b);

export class ParticipantEvidenceError extends Error {
  constructor(code = 'invalid_evidence') {
    super(code);
    this.name = 'ParticipantEvidenceError';
    this.code = code;
    this.status = code === 'evidence_limit' ? 413 : 400;
  }
}
const fail = code => { throw new ParticipantEvidenceError(code); };

// Reject accessors, proxies, coercions, symbols and unknown keys before reading.
function exact(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('invalid_evidence');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || !fields.every(field => keys.includes(field))) fail('invalid_evidence');
  const output = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('invalid_evidence');
    output[field] = descriptor.value;
  }
  return output;
}
function array(value, limit, fn) {
  if (!Array.isArray(value) || types.isProxy(value)) fail('invalid_evidence');
  if (value.length > limit) fail('evidence_limit');
  if (Reflect.ownKeys(value).length !== value.length + 1) fail('invalid_evidence');
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('invalid_evidence');
    return fn(descriptor.value);
  });
}
function ordered(rows, compare, strict) {
  const sorted = [...rows].sort(compare);
  if (strict && rows.some((row, index) => row !== sorted[index])) fail('noncanonical_evidence_order');
  return sorted;
}
function unique(rows, key, code = 'duplicate_evidence_record') {
  if (new Set(rows.map(row => row[key])).size !== rows.length) fail(code);
}
function checkedTerms(value) {
  const { scenario, quantity, amount, date } = value;
  if (!['grain', 'livestock'].includes(scenario) || !integer(quantity, 1, 100_000) ||
      !integer(amount, 1, 999_999_999_999) || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('invalid_evidence');
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) fail('invalid_evidence');
  return { scenario, quantity, amount, date };
}
function metadata(value, dealId, exportedAt) {
  const result = exact(value, DOCUMENT_FIELDS);
  if (!uuid(result.id) || result.dealId !== dealId || !integer(result.termsVersion, 1, PARTICIPANT_EVIDENCE_MAX_VERSIONS) ||
      !CATEGORIES.includes(result.category) || !integer(result.byteLength, 1) || !hash(result.sha256) ||
      !integer(result.createdAt, 0, exportedAt) || result.scope !== 'local_test_document_only' || result.fileKind !== 'text') fail('invalid_evidence');
  if (result.byteLength > PARTICIPANT_EVIDENCE_MAX_DOCUMENT_BYTES) fail('evidence_limit');
  return result;
}
function document(value, dealId, exportedAt) {
  const input = exact(value, [...DOCUMENT_FIELDS, 'contentBase64']);
  const checked = metadata(Object.fromEntries(DOCUMENT_FIELDS.map(field => [field, input[field]])), dealId, exportedAt);
  if (typeof input.contentBase64 !== 'string') fail('invalid_evidence');
  if (input.contentBase64.length > 4 * Math.ceil(PARTICIPANT_EVIDENCE_MAX_DOCUMENT_BYTES / 3)) fail('evidence_limit');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.contentBase64)) fail('invalid_document_content');
  const bytes = Buffer.from(input.contentBase64, 'base64');
  if (bytes.toString('base64') !== input.contentBase64 || bytes.length !== checked.byteLength) fail('document_size_mismatch');
  if (sha256(bytes) !== checked.sha256) fail('document_hash_mismatch');
  let text;
  try { text = decoder.decode(bytes); } catch { fail('invalid_document_content'); }
  if (/[\p{Cc}]/u.test(text.replace(/[\t\r\n]/g, '')) || text.replace(/^\ufeff/, '').startsWith('%PDF-')) fail('invalid_document_content');
  return { ...checked, contentBase64: input.contentBase64 };
}
function authorization(value) {
  const result = exact(value, AUTHORIZATION_FIELDS);
  if (!uuid(result.receiptId) || !hash(result.intentHash) || !hash(result.certificateDigest) ||
      !uuid(result.bindingId) || result.authEpoch !== 0 || result.statusSource !== 'test_ocsp') fail('invalid_evidence');
  return result;
}
function event(value, dealId, scope, exportedAt) {
  const signed = scope === SIGNED_SCOPE;
  const result = exact(value, signed ? [...EVENT_FIELDS, 'authorization'] : EVENT_FIELDS);
  if (result.scope !== scope || result.source !== (signed ? SIGNED_SOURCE : UNSIGNED_SOURCE)) fail('scope_mismatch');
  if (!uuid(result.id) || result.dealId !== dealId || !uuid(result.actorId) || !ROLES.includes(result.role) ||
      typeof result.action !== 'string' || !Object.hasOwn(ACTIONS, result.action) || !integer(result.termsVersion, 1) ||
      !integer(result.stateRevision, 1) || !hash(result.snapshotHash) || !hash(result.termsFingerprint) ||
      !hash(result.documentManifestHash) || !integer(result.createdAt, 0, exportedAt) ||
      !STATES.includes(result.stateFrom) || !STATES.includes(result.stateTo)) fail('invalid_evidence');
  if (signed) result.authorization = authorization(result.authorization);
  return result;
}
function receipt(value, dealId, exportedAt) {
  const result = exact(value, RECEIPT_FIELDS);
  if (!uuid(result.id) || !uuid(result.intentId) || !hash(result.intentHash) || !uuid(result.actorId) ||
      typeof result.action !== 'string' || !Object.hasOwn(ACTIONS, result.action) || result.dealId !== dealId ||
      !uuid(result.eventId) || !hash(result.snapshotHash) || !uuid(result.bindingId) || result.authEpoch !== 0 ||
      !hash(result.certificateDigest) || !integer(result.verifiedAt, 0, exportedAt) ||
      !integer(result.validUntil, 1) || result.validUntil <= result.verifiedAt || result.statusSource !== 'test_ocsp' ||
      result.scope !== SIGNED_SCOPE) fail('invalid_receipt');
  return result;
}
function deal(value, exportedAt, strict) {
  const input = exact(value, DEAL_FIELDS);
  if (!uuid(input.id) || !uuid(input.creatorId) || !integer(input.version, 1) ||
      !STATES.includes(input.state) || !integer(input.stateRevision) || !hash(input.termsFingerprint) ||
      !ROLES.includes(input.role) || !hash(input.snapshotHash) || !SCOPES.includes(input.scope)) fail('invalid_evidence');
  if (input.version > PARTICIPANT_EVIDENCE_MAX_VERSIONS) fail('evidence_limit');
  const participants = ordered(array(input.participants, 2, value => {
    const checked = exact(value, ['id', 'label', 'role']);
    if (!uuid(checked.id) || typeof checked.label !== 'string' || !/^TEST participant \d{3}$/.test(checked.label) ||
        !ROLES.includes(checked.role)) fail('invalid_evidence');
    return checked;
  }), byParty, strict);
  unique(participants, 'id'); unique(participants, 'role'); unique(participants, 'label');
  if (!participants.length || !participants.some(party => party.id === input.creatorId) ||
      !participants.some(party => party.role === input.role)) fail('participant_mismatch');
  const documents = ordered(array(input.documents, 10, value => metadata(value, input.id, exportedAt)), byId, strict);
  const documentHistory = ordered(array(input.documentHistory, PARTICIPANT_EVIDENCE_MAX_DOCUMENTS,
    value => metadata(value, input.id, exportedAt)), byDocumentVersion, strict);
  unique(documents, 'id'); unique(documentHistory, 'id');
  const events = ordered(array(input.events, 5, value => event(value, input.id, input.scope, exportedAt)),
    (a, b) => a.stateRevision - b.stateRevision, strict);
  unique(events, 'id');
  return { id: input.id, creatorId: input.creatorId, version: input.version, ...checkedTerms(input),
    state: input.state, stateRevision: input.stateRevision, termsFingerprint: input.termsFingerprint,
    role: input.role, participants, documents, documentHistory, events, scope: input.scope, snapshotHash: input.snapshotHash };
}
// The package digest uses recursively sorted object keys and compact JSON UTF-8.
// Array ordering is specified by each manifest, not inferred by this encoder.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function assemble(value, packaged) {
  const input = exact(value, packaged ? [...PAYLOAD_FIELDS, 'packageSha256'] : INPUT_FIELDS);
  if (packaged) {
    if (input.schema !== PARTICIPANT_EVIDENCE_SCHEMA) fail('unsupported_evidence_schema');
    if (input.verification !== PARTICIPANT_EVIDENCE_MODE || !same(array(input.limitations, 4, item => {
      if (typeof item !== 'string' || item.length > 300) fail('invalid_evidence');
      return item;
    }), PARTICIPANT_EVIDENCE_LIMITATIONS)) fail('scope_mismatch');
    if (!hash(input.packageSha256)) fail('invalid_evidence');
  }
  if (!integer(input.exportedAt)) fail('invalid_evidence');
  const checkedDeal = deal(input.deal, input.exportedAt, packaged);
  if (packaged && input.scope !== checkedDeal.scope) fail('scope_mismatch');
  const checkedDocuments = ordered(array(input.documents, PARTICIPANT_EVIDENCE_MAX_DOCUMENTS,
    value => document(value, checkedDeal.id, input.exportedAt)), byDocumentVersion, packaged);
  unique(checkedDocuments, 'id');
  const documentBytes = checkedDocuments.reduce((total, row) => total + row.byteLength, 0);
  if (documentBytes > PARTICIPANT_EVIDENCE_MAX_TOTAL_DOCUMENT_BYTES) fail('evidence_limit');
  const allMetadata = checkedDocuments.map(row => Object.fromEntries(DOCUMENT_FIELDS.map(field => [field, row[field]])));
  if (!same(allMetadata, checkedDeal.documentHistory)) fail('document_manifest_mismatch');
  const metadataByVersion = new Map();
  for (const row of allMetadata) {
    if (row.termsVersion > checkedDeal.version) fail('document_manifest_mismatch');
    const manifest = metadataByVersion.get(row.termsVersion) ?? [];
    manifest.push(row);
    if (manifest.length > 10) fail('evidence_limit');
    metadataByVersion.set(row.termsVersion, manifest);
  }
  const checkedVersions = ordered(array(input.versions, PARTICIPANT_EVIDENCE_MAX_VERSIONS, value => {
    const row = exact(value, packaged ? VERSION_EVIDENCE_FIELDS : VERSION_FIELDS);
    if (!integer(row.version, 1, PARTICIPANT_EVIDENCE_MAX_VERSIONS) || !hash(row.termsFingerprint)) fail('invalid_evidence');
    const terms = checkedTerms(row);
    const canonicalBytes = canonicalDraftTerms({ dealId: checkedDeal.id, version: row.version, ...terms });
    const fingerprint = fingerprintDraftTerms({ dealId: checkedDeal.id, version: row.version, ...terms });
    if (row.termsFingerprint !== fingerprint) fail('terms_hash_mismatch');
    const manifest = metadataByVersion.get(row.version) ?? [];
    const result = { version: row.version, ...terms, termsFingerprint: fingerprint,
      canonicalTerms: canonicalBytes.toString('utf8'), byteLength: canonicalBytes.length, sha256: sha256(canonicalBytes),
      documentManifest: manifest, documentManifestHash: legacyHash(manifest) };
    if (packaged) {
      const suppliedManifest = ordered(array(row.documentManifest, 10,
        value => metadata(value, checkedDeal.id, input.exportedAt)), byId, true);
      if (row.canonicalTerms !== result.canonicalTerms || row.byteLength !== result.byteLength || row.sha256 !== result.sha256) fail('terms_hash_mismatch');
      if (!same(suppliedManifest, result.documentManifest) || row.documentManifestHash !== result.documentManifestHash) fail('document_manifest_mismatch');
    }
    return result;
  }), (a, b) => a.version - b.version, packaged);
  if (checkedVersions.length !== checkedDeal.version || checkedVersions.some((row, index) => row.version !== index + 1)) fail('version_manifest_mismatch');
  const current = checkedVersions.at(-1);
  if (!same(checkedTerms(checkedDeal), checkedTerms(current)) || checkedDeal.termsFingerprint !== current.termsFingerprint) fail('terms_hash_mismatch');
  if (!same(checkedDeal.documents, current.documentManifest)) fail('document_manifest_mismatch');
  const snapshotHash = legacyHash({ schema: 'dalahold.local-test-participant-snapshot.v1',
    canonicalTerms: current.canonicalTerms, documents: current.documentManifest, participants: checkedDeal.participants });
  if (checkedDeal.snapshotHash !== snapshotHash) fail('snapshot_hash_mismatch');
  let derivedState = 'draft';
  for (const [index, row] of checkedDeal.events.entries()) {
    const policy = ACTIONS[row.action];
    if (row.stateRevision !== index + 1 || row.stateFrom !== derivedState || !policy.from.includes(row.stateFrom) ||
        row.stateTo !== policy.to || (policy.role && row.role !== policy.role) || row.termsVersion !== checkedDeal.version ||
        row.termsFingerprint !== current.termsFingerprint || row.snapshotHash !== snapshotHash ||
        row.documentManifestHash !== current.documentManifestHash ||
        !checkedDeal.participants.some(party => party.id === row.actorId && party.role === row.role)) fail('event_state_mismatch');
    derivedState = row.stateTo;
  }
  if (derivedState !== checkedDeal.state || checkedDeal.stateRevision !== checkedDeal.events.length ||
      (derivedState !== 'draft' && checkedDeal.participants.length !== 2)) fail('event_state_mismatch');
  const eventRevisions = new Map(checkedDeal.events.map(row => [row.id, row.stateRevision]));
  const checkedReceipts = ordered(array(input.receipts, 5, value => receipt(value, checkedDeal.id, input.exportedAt)),
    (a, b) => (eventRevisions.get(a.eventId) ?? 0) - (eventRevisions.get(b.eventId) ?? 0) || byId(a, b), packaged);
  unique(checkedReceipts, 'id'); unique(checkedReceipts, 'intentId'); unique(checkedReceipts, 'eventId');
  if (checkedDeal.scope === UNSIGNED_SCOPE) {
    if (checkedReceipts.length) fail('scope_mismatch');
  } else {
    if (checkedReceipts.length !== checkedDeal.events.length) fail('receipt_link_mismatch');
    const bindings = new Map(), bindingActors = new Map(), certificateActors = new Map();
    for (const [index, row] of checkedReceipts.entries()) {
      const linked = checkedDeal.events[index];
      const auth = { receiptId: row.id, intentHash: row.intentHash, certificateDigest: row.certificateDigest,
        bindingId: row.bindingId, authEpoch: row.authEpoch, statusSource: row.statusSource };
      if (row.eventId !== linked.id || row.actorId !== linked.actorId || row.action !== linked.action ||
          row.snapshotHash !== linked.snapshotHash || !same(auth, linked.authorization)) fail('receipt_link_mismatch');
      const binding = { bindingId: row.bindingId, certificateDigest: row.certificateDigest, authEpoch: row.authEpoch };
      if ((bindings.has(row.actorId) && !same(bindings.get(row.actorId), binding)) ||
          (bindingActors.has(row.bindingId) && bindingActors.get(row.bindingId) !== row.actorId) ||
          (certificateActors.has(row.certificateDigest) && certificateActors.get(row.certificateDigest) !== row.actorId)) fail('receipt_binding_mismatch');
      bindings.set(row.actorId, binding); bindingActors.set(row.bindingId, row.actorId); certificateActors.set(row.certificateDigest, row.actorId);
    }
  }
  const payload = { schema: PARTICIPANT_EVIDENCE_SCHEMA, scope: checkedDeal.scope, exportedAt: input.exportedAt,
    verification: PARTICIPANT_EVIDENCE_MODE, limitations: [...PARTICIPANT_EVIDENCE_LIMITATIONS],
    deal: checkedDeal, versions: checkedVersions, documents: checkedDocuments, receipts: checkedReceipts };
  const bytes = Buffer.from(canonical(payload), 'utf8');
  // Account for the omitted digest field as well as the canonical payload.
  if (bytes.length + 83 > PARTICIPANT_EVIDENCE_MAX_BYTES) fail('evidence_limit');
  const packageSha256 = sha256(bytes);
  if (packaged && input.packageSha256 !== packageSha256) fail('package_hash_mismatch');
  return { evidence: { ...payload, packageSha256 }, documentBytes };
}

export function buildParticipantEvidence(input) {
  return assemble(input, false).evidence;
}

// A successful report deliberately never calls the package authentic or its
// receipt fields genuine SDK verification. Its origin cannot be known offline.
export function verifyParticipantEvidence(value) {
  try {
    const { evidence, documentBytes } = assemble(value, true);
    return { valid: true, mode: PARTICIPANT_EVIDENCE_MODE, authenticityVerified: false,
      sdkVerificationPerformed: false, freshStatusChecked: false, chronologyVerified: false, scope: evidence.scope,
      dealId: evidence.deal.id, state: evidence.deal.state, version: evidence.deal.version,
      counts: { versions: evidence.versions.length, documents: evidence.documents.length,
        documentBytes, events: evidence.deal.events.length, receipts: evidence.receipts.length },
      packageSha256: evidence.packageSha256, errors: [], limitations: [...PARTICIPANT_EVIDENCE_LIMITATIONS] };
  } catch (error) {
    return { valid: false, mode: PARTICIPANT_EVIDENCE_MODE, authenticityVerified: false,
      sdkVerificationPerformed: false, freshStatusChecked: false, chronologyVerified: false,
      errors: [error instanceof ParticipantEvidenceError ? error.code : 'invalid_evidence'],
      limitations: [...PARTICIPANT_EVIDENCE_LIMITATIONS] };
  }
}
