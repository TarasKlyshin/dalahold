import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import test from 'node:test';
import {
  canonicalTestMemoGrant, checkTestMemoAuthorization, createTestMemoEnvelope, openTestMemoEnvelope,
  TEST_MEMO_GRANT_FIELDS, TEST_MEMO_PROGRAM_ID, TEST_MEMO_SIGNING_PREFIX, testMemoHash,
} from './test-memo-grant.mjs';
import { encodeTestMemoBase58 } from './solana/memo-builder.mjs';

const NOW = 1_800_000_000_000;
function model() {
  const policy = generateKeyPairSync('ed25519'), wallet = generateKeyPairSync('ed25519');
  const snapshotHash = 'a'.repeat(64), eventId = randomUUID();
  const grant = { v: 1, kind: 'test_memo', grantId: randomUUID(), actorId: randomUUID(), bindingId: randomUUID(),
    authEpoch: 1, cluster: 'devnet', expiresAt: NOW + 60_000, intentHash: 'b'.repeat(64), dealId: randomUUID(),
    eventId, snapshotHash, walletAddress: encodeTestMemoBase58(Buffer.from(wallet.publicKey.export({ format: 'jwk' }).x, 'base64url')),
    programId: TEST_MEMO_PROGRAM_ID, memo: `DalaHold TEST v1 ${snapshotHash} ${eventId}`, maxFeeLamports: '10000' };
  const policyPublicKey = policy.publicKey.export({ format: 'jwk' }).x;
  const seal = value => createTestMemoEnvelope(value, policy.privateKey, { now: NOW });
  const raw = (text, prefix = TEST_MEMO_SIGNING_PREFIX) => JSON.stringify({ payload: Buffer.from(text).toString('base64url'),
    sig: sign(null, Buffer.concat([prefix, Buffer.from(text)]), policy.privateKey).toString('base64url') });
  return { grant, policy, policyPublicKey, seal, raw, open: envelope => openTestMemoEnvelope(envelope, policyPublicKey, { now: NOW }) };
}

test('TEST policy model uses the exact ordered canonical fields and independent signed prefix', () => {
  const f = model(), envelope = f.seal(f.grant), opened = f.open(envelope);
  assert.deepEqual(opened.grant, f.grant);
  assert.deepEqual(Object.keys(opened.grant), TEST_MEMO_GRANT_FIELDS);
  assert.equal(opened.grantHash, testMemoHash(canonicalTestMemoGrant(f.grant, { now: NOW })));
  assert.equal(Object.isFrozen(opened.grant), true);
  assert.throws(() => f.open(f.raw(JSON.stringify(f.grant), Buffer.from('DALAHOLD-SIGNER-V1\n'))), /memo_policy_signature_rejected/);
  assert.throws(() => openTestMemoEnvelope(envelope, generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x,
    { now: NOW }), /memo_policy_signature_rejected/);
});

test('TEST policy model rejects tampering of every signed field before parsing authority', () => {
  const f = model(), envelope = JSON.parse(f.seal(f.grant));
  for (const field of TEST_MEMO_GRANT_FIELDS) {
    const changed = { ...f.grant, [field]: typeof f.grant[field] === 'number' ? f.grant[field] + 1 : `${f.grant[field]}x` };
    assert.throws(() => f.open(JSON.stringify({ ...envelope, payload: Buffer.from(JSON.stringify(changed)).toString('base64url') })),
      /memo_policy_signature_rejected/, field);
  }
  assert.throws(() => f.open(JSON.stringify({ ...envelope, policyPublicKey: f.policyPublicKey })), /invalid_memo_envelope/);
  assert.throws(() => f.open(JSON.stringify({ ...envelope, sig: `${envelope.sig}=` })), /invalid_base64url/);
  assert.throws(() => f.open('x'.repeat(4097)), /invalid_memo_envelope/);
});

test('TEST policy model refuses arbitrary memo/payment/program, fee/TTL/identity coercions and extra fields', () => {
  const f = model();
  for (const patch of [
    { v: 2 }, { kind: 'test_transfer' }, { cluster: 'mainnet-beta' }, { programId: '11111111111111111111111111111111' },
    { memo: 'pay now' }, { walletAddress: '111' }, { bindingId: 'not-an-id' }, { actorId: f.grant.actorId.toUpperCase() },
    { authEpoch: true }, { authEpoch: -1 }, { authEpoch: -0 }, { snapshotHash: 'A'.repeat(64) },
    { maxFeeLamports: '0' }, { maxFeeLamports: '01' }, { maxFeeLamports: '10001' }, { maxFeeLamports: 5000 },
    { recipient: f.grant.walletAddress }, { amountLamports: '1' },
  ]) assert.throws(() => f.seal({ ...f.grant, ...patch }), /outside_test_memo_policy|invalid_memo_grant_fields/);
  assert.throws(() => f.seal({ ...f.grant, expiresAt: NOW }), /memo_grant_expired/);
  assert.throws(() => f.seal({ ...f.grant, expiresAt: NOW + 300_001 }), /memo_grant_ttl_too_long/);
  assert.equal(f.open(f.seal({ ...f.grant, maxFeeLamports: '1' })).grant.maxFeeLamports, '1');
  assert.throws(() => f.seal({ ...f.grant, expiresAt: '1800000000000' }), /outside_test_memo_policy/);
  assert.throws(() => createTestMemoEnvelope(f.grant, f.policy.publicKey, { now: NOW }), /invalid_policy_private_key/);
});

test('TEST policy model refuses signed noncanonical encodings and preserves expired history only explicitly', () => {
  const f = model(), canonical = JSON.stringify(f.grant);
  const reordered = JSON.stringify(Object.fromEntries(Object.entries(f.grant).reverse()));
  for (const text of [` ${canonical}`, reordered, canonical.replace('"v":1', '"v":1.0'),
    canonical.replace('"v":1', '"v":1,"v":1'), canonical.replace('"DalaHold', '"\\u0044alaHold')])
    assert.throws(() => f.open(f.raw(text)), /noncanonical_memo_grant/);
  const envelope = f.seal(f.grant);
  assert.throws(() => openTestMemoEnvelope(envelope, f.policyPublicKey, { now: NOW + 70_000 }), /memo_grant_expired/);
  assert.equal(openTestMemoEnvelope(envelope, f.policyPublicKey, { now: NOW + 70_000, allowExpired: true }).grant.grantId, f.grant.grantId);
});

test('TEST assertion model permits only synchronous void assertions; no boolean or thenable bypass', () => {
  const f = model();
  checkTestMemoAuthorization(() => {}, f.grant, 'c'.repeat(64));
  for (const authorize of [undefined, () => true, () => false, () => ({ then() {} }), () => Promise.resolve()])
    assert.throws(() => checkTestMemoAuthorization(authorize, f.grant, 'c'.repeat(64)), /memo_authorization_contract_invalid/);
  let calls = 0;
  assert.throws(() => checkTestMemoAuthorization(async () => { calls++; }, f.grant, 'c'.repeat(64)), /memo_authorization_contract_invalid/);
  assert.equal(calls, 0);
  assert.throws(() => checkTestMemoAuthorization(() => { throw new Error('PRIVATE TEST receipt'); }, f.grant, 'c'.repeat(64)),
    error => error.message === 'memo_authorization_rejected' && !JSON.stringify(error).includes('PRIVATE'));
});
