// Separate TEST Memo policy domain. No HTTP, wallet keys or NCA verification.
import { createHash, createPublicKey, sign, verify } from 'node:crypto';

export const TEST_MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const TEST_MEMO_SIGNING_PREFIX = Buffer.from('DALAHOLD-TEST-MEMO-V1\n');
export const MAX_TEST_MEMO_TTL_MS = 300_000;
export const MAX_TEST_MEMO_ENVELOPE_BYTES = 4_096;
export const TEST_MEMO_GRANT_FIELDS = Object.freeze([
  'v', 'kind', 'grantId', 'actorId', 'bindingId', 'authEpoch', 'cluster',
  'expiresAt', 'intentHash', 'dealId', 'eventId', 'snapshotHash', 'walletAddress',
  'programId', 'memo', 'maxFeeLamports',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export class TestMemoRejection extends Error {
  constructor(code) { super(code); this.name = 'TestMemoRejection'; this.code = code; }
}
export function rejectTestMemo(code) { throw new TestMemoRejection(code); }
export const testMemoHash = bytes => createHash('sha256').update(bytes).digest('hex');
export const isTestMemoUint = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
export function exactTestMemoKeys(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

export function decodeTestMemoBase64url(value, maxBytes = MAX_TEST_MEMO_ENVELOPE_BYTES) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes * 4 / 3) || !BASE64URL.test(value))
    rejectTestMemo('invalid_base64url');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length > maxBytes || bytes.toString('base64url') !== value) rejectTestMemo('invalid_base64url');
  return bytes;
}

export function isTestMemoBase58(value, expectedBytes) {
  if (typeof value !== 'string' || value.length < expectedBytes || value.length > Math.ceil(expectedBytes * 1.38))
    return false;
  let number = 0n;
  for (const char of value) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return false;
    number = number * 58n + BigInt(digit);
  }
  let size = 0;
  for (; number > 0n; number >>= 8n) size++;
  for (let i = 0; value[i] === '1'; i++) size++;
  return size === expectedBytes;
}

export function testMemoPolicyPublicKey(policyPublicKey) {
  if (decodeTestMemoBase64url(policyPublicKey, 32).length !== 32) rejectTestMemo('invalid_policy_public_key');
  try { return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: policyPublicKey }, format: 'jwk' }); }
  catch { rejectTestMemo('invalid_policy_public_key'); }
}

export function validateTestMemoGrant(grant, { now = Date.now(), allowExpired = false } = {}) {
  if (!isTestMemoUint(now) || typeof allowExpired !== 'boolean') rejectTestMemo('invalid_clock');
  if (!exactTestMemoKeys(grant, TEST_MEMO_GRANT_FIELDS)) rejectTestMemo('invalid_memo_grant_fields');
  if (grant.v !== 1 || grant.kind !== 'test_memo' ||
      ![grant.grantId, grant.actorId, grant.bindingId, grant.dealId, grant.eventId].every(value => typeof value === 'string' && UUID.test(value)) ||
      !isTestMemoUint(grant.authEpoch) || !isTestMemoUint(grant.expiresAt) ||
      grant.cluster !== 'devnet' || ![grant.intentHash, grant.snapshotHash].every(value => typeof value === 'string' && HASH.test(value)) ||
      !isTestMemoBase58(grant.walletAddress, 32) || grant.programId !== TEST_MEMO_PROGRAM_ID ||
      grant.memo !== `DalaHold TEST v1 ${grant.snapshotHash} ${grant.eventId}` ||
      typeof grant.maxFeeLamports !== 'string' || !/^[1-9][0-9]{0,4}$/.test(grant.maxFeeLamports) ||
      BigInt(grant.maxFeeLamports) > 10_000n) rejectTestMemo('outside_test_memo_policy');
  if (grant.expiresAt > now + MAX_TEST_MEMO_TTL_MS) rejectTestMemo('memo_grant_ttl_too_long');
  if (!allowExpired && grant.expiresAt <= now) rejectTestMemo('memo_grant_expired');
  return Object.freeze(Object.fromEntries(TEST_MEMO_GRANT_FIELDS.map(field => [field, grant[field]])));
}

export function canonicalTestMemoGrant(grant, options) {
  return Buffer.from(JSON.stringify(validateTestMemoGrant(grant, options), TEST_MEMO_GRANT_FIELDS));
}

/** Only a trusted server issuer may call this with its Ed25519 policy key. */
export function createTestMemoEnvelope(grant, policyPrivateKey, options) {
  const payload = canonicalTestMemoGrant(grant, options);
  let signature;
  try {
    if (policyPrivateKey?.asymmetricKeyType !== 'ed25519' || policyPrivateKey.type !== 'private')
      rejectTestMemo('invalid_policy_private_key');
    signature = sign(null, Buffer.concat([TEST_MEMO_SIGNING_PREFIX, payload]), policyPrivateKey);
  } catch { rejectTestMemo('invalid_policy_private_key'); }
  return JSON.stringify({ payload: payload.toString('base64url'), sig: signature.toString('base64url') });
}

/** The public key is trusted configuration, never a field in the envelope. */
export function openTestMemoEnvelope(envelope, policyPublicKey, options) {
  if (typeof envelope !== 'string' || Buffer.byteLength(envelope) > MAX_TEST_MEMO_ENVELOPE_BYTES)
    rejectTestMemo('invalid_memo_envelope');
  let parsed;
  try { parsed = JSON.parse(envelope); } catch { rejectTestMemo('invalid_memo_envelope'); }
  if (!exactTestMemoKeys(parsed, ['payload', 'sig'])) rejectTestMemo('invalid_memo_envelope');
  const payload = decodeTestMemoBase64url(parsed.payload);
  const signature = decodeTestMemoBase64url(parsed.sig, 64);
  if (signature.length !== 64 || !verify(null, Buffer.concat([TEST_MEMO_SIGNING_PREFIX, payload]),
    testMemoPolicyPublicKey(policyPublicKey), signature)) rejectTestMemo('memo_policy_signature_rejected');
  let value;
  const text = payload.toString('utf8');
  try { value = JSON.parse(text); } catch { rejectTestMemo('invalid_memo_grant_json'); }
  const grant = validateTestMemoGrant(value, options);
  if (JSON.stringify(grant, TEST_MEMO_GRANT_FIELDS) !== text || !Buffer.from(text).equals(payload))
    rejectTestMemo('noncanonical_memo_grant');
  return Object.freeze({ grant, grantHash: testMemoHash(payload), payload: parsed.payload, sig: parsed.sig });
}

/** A trusted synchronous assertion must throw to refuse; there is no boolean approval API. */
export function checkTestMemoAuthorization(authorize, grant, grantHash) {
  if (typeof authorize !== 'function' || authorize.constructor?.name === 'AsyncFunction')
    rejectTestMemo('memo_authorization_contract_invalid');
  let result;
  try { result = authorize(grant, grantHash); }
  catch { rejectTestMemo('memo_authorization_rejected'); }
  if (result !== undefined) {
    // Avoid an unhandled rejection from an accidentally async trusted adapter.
    if (result instanceof Promise) result.catch(() => {});
    rejectTestMemo('memo_authorization_contract_invalid');
  }
}
