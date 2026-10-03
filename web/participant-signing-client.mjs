// Exact personal TEST intent validation. No business, login or payment authority.
export const SIGNED_SCOPE = 'local_personal_test_signed_deal_only';
export const SIGNATURE_DOMAIN = 'dalahold:participant-personal-test-signatures:v1';
export const SIGNATURE_STATEMENT = 'Personal TEST certificate statement for this local capability account and exact TEST deal only. Enrollment is not login or corporate authority. No real legal agreement, wallet transfer, payment or production action is authorized. A separate anchor statement can authorize only the fixed operator-configured devnet Memo.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const INTENT_FIELDS = ['domain', 'purpose', 'scope', 'statement', 'action', 'nonce', 'actorId', 'sessionHash', 'issuedAt', 'expiresAt', 'statusSource', 'binding', 'snapshot', 'request', 'operation'];
const SNAPSHOT_FIELDS = ['dealId', 'version', 'canonicalTerms', 'termsFingerprint', 'documents', 'participants', 'role', 'state', 'stateRevision', 'snapshotHash', 'terminalEventId'];
const DOCUMENT_FIELDS = ['id', 'dealId', 'termsVersion', 'category', 'byteLength', 'sha256', 'createdAt', 'scope', 'fileKind'];
const PARTY_FIELDS = ['id', 'role', 'bindingId', 'certificateDigest', 'authEpoch'];
const BINDING_FIELDS = ['bindingId', 'certificateDigest', 'authEpoch', 'scope'];
const REQUEST_FIELDS = ['requestId', 'action', 'expectedVersion', 'expectedStateRevision', 'snapshotHash'];
const RECEIPT_FIELDS = ['id', 'intentId', 'intentHash', 'actorId', 'action', 'dealId', 'eventId', 'snapshotHash', 'bindingId', 'authEpoch', 'certificateDigest', 'verifiedAt', 'validUntil', 'statusSource', 'scope'];
const ACTIONS = { offer: ['seller', 'draft'], agree: ['buyer', 'offered'], handover: ['seller', 'agreed'], accept: ['buyer', 'handed_over'], dispute: [null, 'agreed', 'handed_over'] };
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const fail = (code = 'invalid_response') => Object.assign(new Error(code), { code });
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const uuid = value => typeof value === 'string' && UUID.test(value);
const hash = value => typeof value === 'string' && HASH.test(value);
const exact = (value, fields) => Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...fields].sort().join(','));
const select = (value, fields) => Object.fromEntries(fields.map(key => [key, value[key]]));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const encode = value => JSON.stringify(value, null, 2) + '\n';
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const digest = async (value, cryptoImpl) => hex(new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', typeof value === 'string' ? new TextEncoder().encode(value) : value)));
function decode(value, maximum = 12000) {
  if (typeof value !== 'string' || !value || value.length > maximum || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw fail();
  const bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0));
  if (btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')) !== value) throw fail();
  return bytes;
}
function chainValid(chain) {
  return Array.isArray(chain) && chain.length === 2 && chain.every(value => typeof value === 'string' && value.length <= 8000 &&
    /^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\r\n]+\n-----END CERTIFICATE-----\n?$/.test(value));
}
export function validateReadiness(value, now = Date.now()) {
  const fields = ['ready', 'chain', 'validUntil', 'statusSource', 'scope'];
  if ((!exact(value, fields) && !exact(value, [...fields, 'anchorEnabled'])) || value.ready !== true ||
      value.scope !== SIGNED_SCOPE || value.statusSource !== 'test_ocsp' || !integer(value.validUntil, now + 1) ||
      !chainValid(value.chain) || (Object.hasOwn(value, 'anchorEnabled') && typeof value.anchorEnabled !== 'boolean')) throw fail();
  return { ready: true, chain: [...value.chain], validUntil: value.validUntil, statusSource: 'test_ocsp', anchorEnabled: value.anchorEnabled === true };
}
export function validateBinding(value) {
  if (!exact(value, BINDING_FIELDS) || !uuid(value.bindingId) || !hash(value.certificateDigest) || value.authEpoch !== 0 || value.scope !== SIGNED_SCOPE) throw fail();
  return select(value, BINDING_FIELDS);
}
function canonicalTerms(deal) {
  return ['dalahold.unsigned-local-draft-terms.v1', `dealId=${deal.id}`, `version=${deal.version}`, `scenario=${deal.scenario}`,
    `quantity=${deal.quantity}`, `amount=${deal.amount}`, `date=${deal.date}`].map(line => line + '\n').join('');
}
const sortParties = parties => [...parties].sort((a, b) => a.role.localeCompare(b.role) || a.id.localeCompare(b.id));
async function validateSnapshot(value, context, cryptoImpl) {
  const deal = context.deal;
  if (!deal || deal.scope !== SIGNED_SCOPE || !exact(value, SNAPSHOT_FIELDS) || !Array.isArray(value.documents) || !Array.isArray(value.participants) || value.participants.length !== 2) throw fail();
  const documents = [...deal.documents].map(item => select(item, DOCUMENT_FIELDS)).sort((a, b) => a.id.localeCompare(b.id));
  if (value.documents.some(item => !exact(item, DOCUMENT_FIELDS)) || !equal(value.documents, documents)) throw fail();
  const parties = sortParties(deal.participants);
  const bindings = value.participants.map(item => {
    if (!exact(item, PARTY_FIELDS) || !uuid(item.id) || !['seller', 'buyer'].includes(item.role) || !uuid(item.bindingId) || !hash(item.certificateDigest) || item.authEpoch !== 0) throw fail();
    return select(item, PARTY_FIELDS);
  });
  if (!equal(bindings, sortParties(bindings)) || bindings[0].id === bindings[1].id || bindings[0].role === bindings[1].role ||
      bindings[0].bindingId === bindings[1].bindingId || bindings[0].certificateDigest === bindings[1].certificateDigest ||
      !equal(bindings.map(item => select(item, ['id', 'role'])), parties.map(item => select(item, ['id', 'role'])))) throw fail();
  const own = bindings.find(item => item.id === context.actorId && item.role === deal.role);
  if (!own || !context.binding || own.bindingId !== context.binding.bindingId || own.certificateDigest !== context.binding.certificateDigest || own.authEpoch !== context.binding.authEpoch) throw fail();
  const terms = canonicalTerms(deal);
  const termsFingerprint = await digest(terms, cryptoImpl);
  const snapshotHash = await digest(JSON.stringify({ schema: 'dalahold.local-test-participant-snapshot.v1', canonicalTerms: terms, documents,
    participants: parties.map(item => select(item, ['id', 'label', 'role'])) }), cryptoImpl);
  const expected = { dealId: deal.id, version: deal.version, canonicalTerms: terms, termsFingerprint, documents, participants: bindings,
    role: deal.role, state: deal.state, stateRevision: deal.stateRevision, snapshotHash, terminalEventId: deal.state === 'accepted' ? deal.events.at(-1)?.id : null };
  if (!hash(snapshotHash) || termsFingerprint !== deal.termsFingerprint || snapshotHash !== deal.snapshotHash || !equal(value, expected)) throw fail();
}
function walletValid(value) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let number = 0n;
  for (const character of value) number = number * 58n + BigInt(alphabet.indexOf(character));
  return value.match(/^1*/)[0].length + (number ? Math.ceil(number.toString(16).length / 2) : 0) === 32;
}
function validateOperation(value, snapshot) {
  const fields = ['cluster', 'programId', 'walletAddress', 'maxFeeLamports', 'memo', 'snapshotHash', 'eventId'];
  if (!exact(value, fields) || value.cluster !== 'devnet' || value.programId !== MEMO_PROGRAM || !walletValid(value.walletAddress) ||
      typeof value.maxFeeLamports !== 'string' || !/^[1-9]\d{0,4}$/.test(value.maxFeeLamports) || BigInt(value.maxFeeLamports) > 10000n ||
      value.snapshotHash !== snapshot.snapshotHash || value.eventId !== snapshot.terminalEventId || !uuid(value.eventId) ||
      value.memo !== `DalaHold TEST v1 ${snapshot.snapshotHash} ${snapshot.terminalEventId}`) throw fail();
}
export async function validateIntent(intent, context, now = Date.now(), cryptoImpl = globalThis.crypto) {
  try {
    if (!exact(intent, ['id', 'text', 'bytesBase64', 'hash', 'expiresAt']) || !uuid(intent.id) || typeof intent.text !== 'string' ||
        !hash(intent.hash) || !integer(intent.expiresAt, now + 1) || !uuid(context.actorId)) throw fail();
    const bytes = decode(intent.bytesBase64);
    if (bytes.length > 9000 || new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== intent.text) throw fail();
    const data = JSON.parse(intent.text);
    if (!exact(data, INTENT_FIELDS) || Object.keys(data).join(',') !== INTENT_FIELDS.join(',') ||
        data.domain !== SIGNATURE_DOMAIN || data.purpose !== 'TEST' || data.scope !== SIGNED_SCOPE || data.statement !== SIGNATURE_STATEMENT ||
        data.action !== context.action || data.nonce !== intent.id || data.actorId !== context.actorId || !hash(data.sessionHash) ||
        !integer(data.issuedAt) || data.issuedAt > now || data.expiresAt !== data.issuedAt + 300000 || data.expiresAt !== intent.expiresAt ||
        data.statusSource !== 'test_ocsp' || encode(data) !== intent.text || await digest(bytes, cryptoImpl) !== intent.hash) throw fail();
    const expectedBinding = context.binding === null ? null : validateBinding(context.binding);
    if (!equal(data.binding, expectedBinding)) throw fail();
    if (data.action === 'enroll_test_participant') {
      if (data.snapshot !== null || data.request !== null || data.operation !== null || context.deal !== null || context.request !== null) throw fail();
    } else {
      if (!expectedBinding) throw fail();
      await validateSnapshot(data.snapshot, context, cryptoImpl);
      if (!exact(data.request, REQUEST_FIELDS) || !uuid(data.request.requestId) || data.request.action !== data.action ||
          data.request.expectedVersion !== context.deal.version || data.request.expectedStateRevision !== context.deal.stateRevision ||
          data.request.snapshotHash !== context.deal.snapshotHash) throw fail();
      if (data.action === 'anchor_test_memo') {
        if (context.deal.state !== 'accepted' || context.request !== null) throw fail();
        validateOperation(data.operation, data.snapshot);
      } else {
        const policy = ACTIONS[data.action];
        if (!policy || (policy[0] && context.deal.role !== policy[0]) || !policy.slice(1).includes(context.deal.state) ||
            !equal(data.request, select(context.request, REQUEST_FIELDS)) || data.operation !== null) throw fail();
      }
    }
    return select(intent, ['id', 'text', 'bytesBase64', 'hash', 'expiresAt']);
  } catch { throw fail('invalid_signature_intent'); }
}
export function validateReceipt(value, intent, context) {
  const data = JSON.parse(intent.text);
  if (!exact(value, RECEIPT_FIELDS) || !uuid(value.id) || value.intentId !== intent.id || value.intentHash !== intent.hash ||
      value.actorId !== context.actorId || value.action !== context.action || !uuid(value.bindingId) || value.authEpoch !== 0 || !hash(value.certificateDigest) ||
      !integer(value.verifiedAt, data.issuedAt) || value.verifiedAt >= data.expiresAt || !integer(value.validUntil, value.verifiedAt + 1) ||
      value.statusSource !== 'test_ocsp' || value.scope !== SIGNED_SCOPE) throw fail();
  if (context.binding && (value.bindingId !== context.binding.bindingId || value.certificateDigest !== context.binding.certificateDigest || value.authEpoch !== context.binding.authEpoch)) throw fail();
  if (context.action === 'enroll_test_participant') {
    if (value.dealId !== null || value.eventId !== null || value.snapshotHash !== null) throw fail();
  } else if (value.dealId !== context.deal.id || value.snapshotHash !== context.deal.snapshotHash || !uuid(value.eventId) ||
      (context.action === 'anchor_test_memo' && value.eventId !== data.operation.eventId)) throw fail();
  return select(value, RECEIPT_FIELDS);
}
export async function signIntent(intent, chain, { moduleLoader = () => import(typeof document === 'undefined' ? '../nca/client.mjs' : './nca-client.mjs'),
  callImpl, assertCurrent = () => {} } = {}) {
  try {
    if (!chainValid(chain)) throw fail('signing_unavailable');
    const transport = await moduleLoader();
    assertCurrent();
    const request = transport.signingRequest(intent, chain);
    const cms = await (callImpl || transport.ncalayerCall)(request);
    assertCurrent();
    decode(cms, 131072);
    return cms;
  } catch (error) {
    if (error.code === 'session_ended' || error.code === 'intent_expired') throw error;
    throw fail(error.message === 'signing_cancelled_or_rejected' ? 'signing_cancelled_or_rejected' : 'signing_unavailable');
  }
}
