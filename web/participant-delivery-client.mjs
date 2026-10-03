// Browser-only transport helpers: no DOM, Node imports, SDK or network writes.
// Reputation is unsigned local feedback, including on personal TEST deals.
// Evidence download checks transport/schema/selection and the package checksum.
// It is not the offline business-consistency verifier, a signature check, a
// provenance guarantee, or proof of current certificate status or chronology.
const UNSIGNED_SCOPE = 'local_test_participant_statements_only';
const SIGNED_SCOPE = 'local_personal_test_signed_deal_only';
const FEEDBACK_SCOPE = 'local_test_role_reputation_only';
const FEEDBACK_SOURCE = 'unsigned_test_participant_review';
const SCOPES = [UNSIGNED_SCOPE, SIGNED_SCOPE];
const ROLES = ['seller', 'buyer'];
const STATES = ['draft', 'offered', 'agreed', 'handed_over', 'accepted', 'disputed'];
const ACTIONS = ['offer', 'agree', 'handover', 'accept', 'dispute'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_VERSIONS = 2000;
const MAX_DOCUMENTS = 1024;
const MAX_DOCUMENT_BYTES = 262144;
const MAX_DOCUMENT_TOTAL_BYTES = 8 * 1024 * 1024;
const LIMITATIONS = [
  'Checks only file integrity and internal consistency. SHA-256 values are recomputable and are not signatures.',
  'Provenance and authenticity are not established. Anyone can change all contents and recompute all hashes.',
  'Personal TEST NCA receipt fields are historical local assertions. This check does not verify CMS, SDK execution, signer identity, fresh OCSP or wall-clock chronology.',
  'This file proves no legal contract, corporate authority, Solana transaction or payment.',
];
const DEAL_FIELDS = ['id', 'creatorId', 'version', 'scenario', 'quantity', 'amount', 'date', 'state',
  'stateRevision', 'termsFingerprint', 'role', 'participants', 'documents', 'events', 'scope', 'snapshotHash'];
const DOCUMENT_FIELDS = ['id', 'dealId', 'termsVersion', 'category', 'byteLength', 'sha256', 'createdAt', 'scope', 'fileKind'];
const EVENT_FIELDS = ['id', 'dealId', 'action', 'actorId', 'role', 'termsVersion', 'stateRevision',
  'snapshotHash', 'termsFingerprint', 'documentManifestHash', 'createdAt', 'stateFrom', 'stateTo', 'source', 'scope'];
const AUTH_FIELDS = ['receiptId', 'intentHash', 'certificateDigest', 'bindingId', 'authEpoch', 'statusSource'];
const REVIEW_FIELDS = ['id', 'dealId', 'authorId', 'authorRole', 'targetId', 'targetRole', 'score', 'termsVersion',
  'stateRevision', 'snapshotHash', 'acceptedEventId', 'createdAt', 'source', 'scope', 'dealScope'];
const REPUTATION_FIELDS = ['participant', 'roles', 'scope', 'source', 'dealScope', 'signatureVerified', 'eligibility'];
const VERSION_FIELDS = ['version', 'scenario', 'quantity', 'amount', 'date', 'termsFingerprint',
  'canonicalTerms', 'byteLength', 'sha256', 'documentManifest', 'documentManifestHash'];
const RECEIPT_FIELDS = ['id', 'intentId', 'intentHash', 'actorId', 'action', 'dealId', 'eventId', 'snapshotHash',
  'bindingId', 'authEpoch', 'certificateDigest', 'verifiedAt', 'validUntil', 'statusSource', 'scope'];
const PACKAGE_FIELDS = ['schema', 'scope', 'exportedAt', 'verification', 'limitations', 'deal', 'versions',
  'documents', 'receipts', 'packageSha256'];
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const uuid = value => typeof value === 'string' && UUID.test(value);
const hash = value => typeof value === 'string' && HASH.test(value);
const localErrors = new WeakSet();
const fail = code => {
  const error = Object.assign(new Error(code), { code });
  localErrors.add(error);
  throw error;
};

// Accessor values are never read, and no field value is coerced. Inputs obtained
// from JSON.parse are plain objects. Browser JavaScript has no general-purpose
// proxy introspection; these helpers do not treat arbitrary executable JS as a
// trusted data transport. Every returned record/array is newly constructed.
function exact(value, fields, code = 'invalid_response') {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || !fields.every(field => keys.includes(field))) fail(code);
  const checked = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
    checked[field] = descriptor.value;
  }
  return checked;
}
function array(value, maximum, fn, code = 'invalid_response') {
  if (!Array.isArray(value) || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) fail(code);
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
    return fn(descriptor.value);
  });
}
function unique(rows, field, code = 'invalid_response') {
  if (new Set(rows.map(row => row[field])).size !== rows.length) fail(code);
}
function participant(value, role = false, code = 'invalid_response') {
  const checked = exact(value, role ? ['id', 'label', 'role'] : ['id', 'label'], code);
  if (!uuid(checked.id) || typeof checked.label !== 'string' || !/^TEST participant \d{3}$/.test(checked.label) ||
      (role && !ROLES.includes(checked.role))) fail(code);
  return checked;
}
function terms(value, code = 'invalid_response') {
  const { scenario, quantity, amount, date } = value;
  if (!['grain', 'livestock'].includes(scenario) || !integer(quantity, 1, 100000) ||
      !integer(amount, 1, 999999999999) || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(code);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) fail(code);
  return { scenario, quantity, amount, date };
}
function documentMetadata(value, dealId, code = 'invalid_response') {
  const checked = exact(value, DOCUMENT_FIELDS, code);
  if (!uuid(checked.id) || checked.dealId !== dealId || !integer(checked.termsVersion, 1, MAX_VERSIONS) ||
      !['contract', 'delivery', 'quality', 'other'].includes(checked.category) || !integer(checked.byteLength, 1, MAX_DOCUMENT_BYTES) ||
      !hash(checked.sha256) || !integer(checked.createdAt) || checked.scope !== 'local_test_document_only' || checked.fileKind !== 'text') fail(code);
  return checked;
}
function authorization(value, code = 'invalid_response') {
  const checked = exact(value, AUTH_FIELDS, code);
  if (!uuid(checked.receiptId) || !hash(checked.intentHash) || !hash(checked.certificateDigest) ||
      !uuid(checked.bindingId) || checked.authEpoch !== 0 || checked.statusSource !== 'test_ocsp') fail(code);
  return checked;
}
function event(value, dealId, scope, code = 'invalid_response') {
  const signed = scope === SIGNED_SCOPE, checked = exact(value, signed ? [...EVENT_FIELDS, 'authorization'] : EVENT_FIELDS, code);
  if (!uuid(checked.id) || checked.dealId !== dealId || !uuid(checked.actorId) || !ROLES.includes(checked.role) ||
      !ACTIONS.includes(checked.action) || !integer(checked.termsVersion, 1, MAX_VERSIONS) || !integer(checked.stateRevision, 1, 5) ||
      !hash(checked.snapshotHash) || !hash(checked.termsFingerprint) || !hash(checked.documentManifestHash) ||
      !integer(checked.createdAt) || !STATES.includes(checked.stateFrom) || !STATES.includes(checked.stateTo) ||
      checked.scope !== scope || checked.source !== (signed ? 'personal_test_nca_statement' : 'unsigned_test_participant_statement')) fail(code);
  if (signed) checked.authorization = authorization(checked.authorization, code);
  return checked;
}
function checkedDeal(value, code = 'invalid_response', requireHistory = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const hasHistory = Object.hasOwn(value, 'documentHistory');
  if (requireHistory && !hasHistory) fail(code);
  const checked = exact(value, hasHistory ? [...DEAL_FIELDS, 'documentHistory'] : DEAL_FIELDS, code);
  if (!uuid(checked.id) || !uuid(checked.creatorId) || !integer(checked.version, 1, MAX_VERSIONS) ||
      !STATES.includes(checked.state) || !integer(checked.stateRevision, 0, 5) || !hash(checked.termsFingerprint) ||
      !ROLES.includes(checked.role) || !SCOPES.includes(checked.scope) || !hash(checked.snapshotHash)) fail(code);
  Object.assign(checked, terms(checked, code));
  checked.participants = array(checked.participants, 2, row => participant(row, true, code), code);
  unique(checked.participants, 'id', code); unique(checked.participants, 'role', code); unique(checked.participants, 'label', code);
  if (!checked.participants.length || !checked.participants.some(row => row.id === checked.creatorId) ||
      !checked.participants.some(row => row.role === checked.role)) fail(code);
  checked.documents = array(checked.documents, 10, row => documentMetadata(row, checked.id, code), code);
  unique(checked.documents, 'id', code);
  if (checked.documents.some(row => row.termsVersion !== checked.version)) fail(code);
  if (hasHistory) {
    checked.documentHistory = array(checked.documentHistory, MAX_DOCUMENTS, row => documentMetadata(row, checked.id, code), code);
    unique(checked.documentHistory, 'id', code);
    if (checked.documentHistory.some(row => row.termsVersion > checked.version)) fail(code);
  }
  checked.events = array(checked.events, 5, row => event(row, checked.id, checked.scope, code), code);
  unique(checked.events, 'id', code);
  if (checked.events.length !== checked.stateRevision || checked.events.some((row, index) => row.stateRevision !== index + 1 ||
      row.termsVersion > checked.version || !checked.participants.some(party => party.id === row.actorId && party.role === row.role))) fail(code);
  return checked;
}
function acceptedTerminal(deal) {
  const terminal = deal.events.at(-1);
  return deal.state === 'accepted' && deal.participants.length === 2 && terminal?.action === 'accept' &&
    terminal.stateFrom === 'handed_over' && terminal.stateTo === 'accepted' && terminal.role === 'buyer' &&
    terminal.termsVersion === deal.version && terminal.stateRevision === deal.stateRevision &&
    terminal.snapshotHash === deal.snapshotHash && terminal.termsFingerprint === deal.termsFingerprint ? terminal : null;
}
function review(value, deal) {
  const checked = exact(value, REVIEW_FIELDS), terminal = acceptedTerminal(deal);
  const author = deal.participants.find(party => party.id === checked.authorId);
  const target = deal.participants.find(party => party.id === checked.targetId);
  if (!terminal || !uuid(checked.id) || checked.dealId !== deal.id || !author || !target || author.id === target.id ||
      checked.authorRole !== author.role || checked.targetRole !== target.role || !integer(checked.score, 1, 5) ||
      checked.termsVersion !== deal.version || checked.stateRevision !== deal.stateRevision ||
      checked.snapshotHash !== deal.snapshotHash || checked.acceptedEventId !== terminal.id ||
      !integer(checked.createdAt, terminal.createdAt) || checked.source !== FEEDBACK_SOURCE ||
      checked.scope !== FEEDBACK_SCOPE || checked.dealScope !== deal.scope) fail('invalid_response');
  return checked;
}
function roleSummary(value) {
  const checked = exact(value, ['count', 'scoreTotal', 'average']);
  if (!integer(checked.count, 0, 100) || !integer(checked.scoreTotal, 0, 500) ||
      checked.scoreTotal < checked.count || checked.scoreTotal > 5 * checked.count) fail('invalid_response');
  const expected = checked.count ? Number((checked.scoreTotal / checked.count).toFixed(2)) : null;
  if (checked.average !== expected) fail('invalid_response');
  return checked;
}
function reputation(value, scope) {
  const checked = exact(value, REPUTATION_FIELDS);
  if (checked.scope !== FEEDBACK_SCOPE || checked.source !== FEEDBACK_SOURCE || checked.dealScope !== scope ||
      checked.signatureVerified !== false || checked.eligibility !== 'accepted_local_test_deals_only') fail('invalid_response');
  checked.participant = participant(checked.participant);
  const roles = exact(checked.roles, ROLES);
  checked.roles = { seller: roleSummary(roles.seller), buyer: roleSummary(roles.buyer) };
  if (checked.roles.seller.count + checked.roles.buyer.count > 100) fail('invalid_response');
  return checked;
}
function feedbackEnvelope(value, property, scope) {
  const checked = exact(value, [property, 'scope', 'dealScope']);
  if (checked.scope !== FEEDBACK_SCOPE || checked.dealScope !== scope) fail('invalid_response');
  return checked[property];
}

export function validateReputationEnvelope(value, options) {
  try {
    const { scope, actorId } = exact(options, ['scope', 'actorId']);
    if (!SCOPES.includes(scope) || !uuid(actorId)) fail('invalid_response');
    const checked = reputation(feedbackEnvelope(value, 'reputation', scope), scope);
    if (checked.participant.id !== actorId) fail('invalid_response');
    return checked;
  } catch { fail('invalid_response'); }
}

export function validateDealFeedbackEnvelope(reviewValue, reputationValue, dealValue) {
  try {
    const deal = checkedDeal(dealValue);
    const reviews = array(feedbackEnvelope(reviewValue, 'reviews', deal.scope), 2, value => review(value, deal));
    unique(reviews, 'id'); unique(reviews, 'authorId');
    const summaries = array(feedbackEnvelope(reputationValue, 'reputation', deal.scope), 2, value => reputation(value, deal.scope));
    unique(summaries.map(row => row.participant), 'id');
    if (summaries.length !== deal.participants.length) fail('invalid_response');
    const parties = deal.participants.map(party => {
      const summary = summaries.find(row => row.participant.id === party.id);
      if (!summary || summary.participant.label !== party.label) fail('invalid_response');
      // Aggregate volume may include other accepted deals; it must still be
      // mathematically capable of containing this deal's immutable review.
      for (const received of reviews.filter(row => row.targetId === party.id)) {
        const role = summary.roles[received.targetRole], remainder = role.scoreTotal - received.score;
        if (role.count < 1 || remainder < role.count - 1 || remainder > 5 * (role.count - 1)) fail('invalid_response');
      }
      return { ...party, reputation: summary };
    });
    return { dealId: deal.id, snapshotHash: deal.snapshotHash, stateRevision: deal.stateRevision, parties, reviews };
  } catch { fail('invalid_response'); }
}

export function validateReviewEnvelope(value, options) {
  try {
    const input = exact(options, ['deal', 'actorId', 'score']);
    const deal = checkedDeal(input.deal), actor = deal.participants.find(row => row.id === input.actorId);
    if (!actor || actor.role !== deal.role || !integer(input.score, 1, 5)) fail('invalid_response');
    const checked = exact(value, ['review', 'historical', 'scope', 'dealScope']);
    if (checked.scope !== FEEDBACK_SCOPE || checked.dealScope !== deal.scope || typeof checked.historical !== 'boolean') fail('invalid_response');
    checked.review = review(checked.review, deal);
    if (checked.review.authorId !== input.actorId || checked.review.score !== input.score) fail('invalid_response');
    return { review: checked.review, historical: checked.historical };
  } catch { fail('invalid_response'); }
}

export function buildReviewPayload(value) {
  try {
    const input = exact(value, ['deal', 'actorId', 'score', 'requestId', 'consent'], 'invalid_request');
    if (input.consent !== true) fail('review_consent_required');
    if (!uuid(input.actorId) || !uuid(input.requestId) || !integer(input.score, 1, 5)) fail('invalid_request');
    const deal = checkedDeal(input.deal, 'invalid_request'), actor = deal.participants.find(row => row.id === input.actorId);
    if (!acceptedTerminal(deal) || !actor || actor.role !== deal.role) fail('review_not_allowed');
    return { requestId: input.requestId, expectedVersion: deal.version, expectedStateRevision: deal.stateRevision,
      snapshotHash: deal.snapshotHash, score: input.score };
  } catch (error) {
    // Never inspect fields on an arbitrary thrown value from untrusted input.
    fail(localErrors.has(error) ? error.code : 'invalid_request');
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function evidenceDocument(value, dealId) {
  const checked = exact(value, [...DOCUMENT_FIELDS, 'contentBase64']);
  const metadata = documentMetadata(Object.fromEntries(DOCUMENT_FIELDS.map(field => [field, checked[field]])), dealId);
  const content = checked.contentBase64;
  if (typeof content !== 'string' || !content.length || content.length > 4 * Math.ceil(MAX_DOCUMENT_BYTES / 3) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) fail('invalid_response');
  const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0;
  if (content.length / 4 * 3 - padding !== metadata.byteLength) fail('invalid_response');
  // Reject nonzero padding bits without decoding, interpreting or rewriting the
  // attachment. Per-document hashes/text policy belong to the offline verifier.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if (padding && alphabet.indexOf(content.at(-padding - 1)) % (padding === 2 ? 16 : 4)) fail('invalid_response');
  return { ...metadata, contentBase64: content };
}
function evidencePackage(value, selection) {
  const checked = exact(value, PACKAGE_FIELDS);
  if (checked.schema !== 'dalahold.local-test-participant-evidence.v1' || checked.verification !== 'offline_integrity_and_consistency_only' ||
      checked.scope !== selection.scope || !integer(checked.exportedAt) || !hash(checked.packageSha256)) fail('invalid_response');
  checked.limitations = array(checked.limitations, 4, value => {
    if (typeof value !== 'string' || value.length > 300) fail('invalid_response');
    return value;
  });
  if (checked.limitations.length !== LIMITATIONS.length || checked.limitations.some((value, index) => value !== LIMITATIONS[index])) fail('invalid_response');
  checked.deal = checkedDeal(checked.deal, 'invalid_response', true);
  const deal = checked.deal, member = deal.participants.find(party => party.id === selection.actorId);
  if (deal.id !== selection.dealId || deal.scope !== selection.scope || deal.role !== selection.role || !member || member.role !== selection.role) fail('invalid_response');
  let manifestCount = 0;
  checked.versions = array(checked.versions, MAX_VERSIONS, value => {
    const row = exact(value, VERSION_FIELDS);
    if (!integer(row.version, 1, MAX_VERSIONS) || !hash(row.termsFingerprint) || !hash(row.sha256) || !hash(row.documentManifestHash) ||
        typeof row.canonicalTerms !== 'string' || !integer(row.byteLength, 1, 512) || row.canonicalTerms.length > 512) fail('invalid_response');
    Object.assign(row, terms(row));
    // This field has a fixed public grammar, not an arbitrary metadata text
    // slot. Check the encoding shape without recalculating its cryptographic
    // fingerprint; exact attachment bytes remain in contentBase64 only.
    const canonicalTerms = `dalahold.unsigned-local-draft-terms.v1\ndealId=${deal.id}\nversion=${row.version}\nscenario=${row.scenario}\nquantity=${row.quantity}\namount=${row.amount}\ndate=${row.date}\n`;
    if (row.canonicalTerms !== canonicalTerms || row.byteLength !== canonicalTerms.length) fail('invalid_response');
    row.documentManifest = array(row.documentManifest, 10, value => documentMetadata(value, deal.id));
    manifestCount += row.documentManifest.length;
    if (manifestCount > MAX_DOCUMENTS || row.documentManifest.some(doc => doc.termsVersion !== row.version)) fail('invalid_response');
    unique(row.documentManifest, 'id');
    return row;
  });
  if (checked.versions.length !== deal.version || checked.versions.some((row, index) => row.version !== index + 1)) fail('invalid_response');
  let totalBytes = 0;
  const perVersion = new Map();
  checked.documents = array(checked.documents, MAX_DOCUMENTS, value => {
    const row = evidenceDocument(value, deal.id);
    totalBytes += row.byteLength;
    const count = (perVersion.get(row.termsVersion) ?? 0) + 1;
    if (row.termsVersion > deal.version || count > 10 || totalBytes > MAX_DOCUMENT_TOTAL_BYTES) fail('invalid_response');
    perVersion.set(row.termsVersion, count);
    return row;
  });
  unique(checked.documents, 'id');
  checked.receipts = array(checked.receipts, 5, value => {
    const row = exact(value, RECEIPT_FIELDS);
    if (deal.scope !== SIGNED_SCOPE || !uuid(row.id) || !uuid(row.intentId) || !hash(row.intentHash) ||
        !deal.participants.some(party => party.id === row.actorId) || !ACTIONS.includes(row.action) || row.dealId !== deal.id ||
        !deal.events.some(event => event.id === row.eventId) || !hash(row.snapshotHash) || !uuid(row.bindingId) ||
        row.authEpoch !== 0 || !hash(row.certificateDigest) || !integer(row.verifiedAt) || !integer(row.validUntil, 1) ||
        row.validUntil <= row.verifiedAt || row.statusSource !== 'test_ocsp' || row.scope !== SIGNED_SCOPE) fail('invalid_response');
    return row;
  });
  unique(checked.receipts, 'id'); unique(checked.receipts, 'intentId'); unique(checked.receipts, 'eventId');
  if ((deal.scope === SIGNED_SCOPE && checked.receipts.length !== deal.events.length) ||
      (deal.scope === UNSIGNED_SCOPE && checked.receipts.length)) fail('invalid_response');
  return checked;
}

// Reject duplicate serialized keys before JSON.parse can overwrite them. The
// bounded nesting scanner only parses data; string contents are never executed.
function parseJson(text) {
  let offset = 0;
  const whitespace = () => { while (/[ \r\n\t]/.test(text[offset] ?? 'x')) offset++; };
  const string = () => {
    if (text[offset] !== '"') fail('invalid_response');
    const start = offset++;
    while (offset < text.length) {
      const character = text[offset++];
      if (character === '\\') offset++;
      else if (character === '"') return text.slice(start, offset);
    }
    fail('invalid_response');
  };
  const value = depth => {
    if (depth > 32) fail('invalid_response');
    whitespace();
    if (text[offset] === '{') {
      offset++; whitespace(); const keys = new Set();
      if (text[offset] === '}') { offset++; return; }
      for (;;) {
        whitespace(); const key = JSON.parse(string());
        if (keys.has(key)) fail('invalid_response');
        keys.add(key); whitespace();
        if (text[offset++] !== ':') fail('invalid_response');
        value(depth + 1); whitespace(); const end = text[offset++];
        if (end === '}') return;
        if (end !== ',') fail('invalid_response');
      }
    } else if (text[offset] === '[') {
      offset++; whitespace();
      if (text[offset] === ']') { offset++; return; }
      for (;;) {
        value(depth + 1); whitespace(); const end = text[offset++];
        if (end === ']') return;
        if (end !== ',') fail('invalid_response');
      }
    } else if (text[offset] === '"') string();
    else {
      const start = offset;
      while (offset < text.length && !/[,}\]\s]/.test(text[offset])) offset++;
      if (offset === start) fail('invalid_response');
    }
  };
  value(0); whitespace();
  if (offset !== text.length) fail('invalid_response');
  return JSON.parse(text);
}

export async function readEvidenceResponse(response, options, cryptoImpl = globalThis.crypto) {
  let reader, ended = false;
  try {
    const selection = exact(options, ['scope', 'actorId', 'dealId', 'role']);
    if (!SCOPES.includes(selection.scope) || !uuid(selection.actorId) || !uuid(selection.dealId) || !ROLES.includes(selection.role)) fail('invalid_response');
    if (!response || response.ok !== true || response.status !== 200 || !response.body ||
        typeof response.body.getReader !== 'function' || typeof response.headers?.get !== 'function') fail('invalid_response');
    const contentType = response.headers.get('content-type'), declaredLength = response.headers.get('content-length');
    if (typeof contentType !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) fail('invalid_response');
    if (declaredLength !== null && (typeof declaredLength !== 'string' || !/^\d{1,9}$/.test(declaredLength) || Number(declaredLength) > MAX_BYTES)) fail('invalid_response');
    reader = response.body.getReader();
    const chunks = []; let byteLength = 0, reads = 0;
    for (;;) {
      if (++reads > 65536) fail('invalid_response');
      const chunk = exact(await reader.read(), ['done', 'value']);
      if (typeof chunk.done !== 'boolean') fail('invalid_response');
      if (chunk.done) { ended = true; break; }
      if (!(chunk.value instanceof Uint8Array)) fail('invalid_response');
      byteLength += chunk.value.byteLength;
      if (byteLength > MAX_BYTES) fail('invalid_response');
      chunks.push(new Uint8Array(chunk.value));
    }
    if (!byteLength) fail('invalid_response');
    const bytes = new Uint8Array(byteLength); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const evidence = evidencePackage(parseJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), selection);
    const { packageSha256, ...payload } = evidence, canonicalBytes = new TextEncoder().encode(canonical(payload));
    if (canonicalBytes.byteLength + 83 > MAX_BYTES || typeof cryptoImpl?.subtle?.digest !== 'function') fail('invalid_response');
    const digest = await cryptoImpl.subtle.digest('SHA-256', canonicalBytes);
    if (!(digest instanceof ArrayBuffer) || digest.byteLength !== 32 ||
        [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') !== packageSha256) fail('invalid_response');
    const text = JSON.stringify(evidence) + '\n';
    if (new TextEncoder().encode(text).byteLength > MAX_BYTES) fail('invalid_response');
    return { evidence, text };
  } catch { fail('invalid_response'); }
  finally {
    if (reader) {
      if (!ended) { try { await reader.cancel(); } catch {} }
      try { reader.releaseLock(); } catch {}
    }
  }
}
