// End-to-end MODEL SDK -> exact anchor -> private policy -> fake RPC readback.
// No genuine two-person UAT, real funding, network sends or production custody.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ParticipantStore } from '../web/participant-store.mjs';
import { createParticipantMemoIssuer } from './participant-memo-issuer.mjs';
import { openTestMemoEnvelope, DEVNET_GENESIS_HASH } from '../signer/test-memo-grant.mjs';
import { deriveOfflineSignerAddress } from '../signer/solana/transaction-builder.mjs';
import { encodeTestMemoBase58, inspectTestMemoTransaction } from '../signer/solana/memo-builder.mjs';
import { DevnetMemoSender } from '../signer/devnet-memo-sender.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const SESSION = 'b'.repeat(64);
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-memo-bridge-'));
  let clock = Date.now();
  const key = randomBytes(32), walletAddress = await deriveOfflineSignerAddress(key);
  const policy = generateKeyPairSync('ed25519');
  const sdk = { statusSource: 'test_ocsp', inspect: async () => ({}),
    async verifyIdentity(bytes, cms, mappingKey) {
      const model = JSON.parse(cms.toString('utf8'));
      if (model.hash !== hash(bytes)) return { verified: false };
      return { verified: true, statusSource: 'test_ocsp', validUntil: clock + 300000,
        certificateDigest: hash(`MODEL certificate ${model.person}`),
        identity: { schema: 'nca_test_subject_v1', personId: `person:${createHmac('sha256', mappingKey).update(model.person).digest('hex')}`,
          organizationId: null } };
    } };
  const store = new ParticipantStore({ dbPath: join(directory, 'cabinet.sqlite'), signatureSdk: sdk, now: () => clock,
    memoConfiguration: { walletAddress, maxFeeLamports: '10000' } });
  const seller = store.register().participant.id, buyer = store.register().participant.id;
  const submit = (actorId, intent, person) => store.submitSignature(actorId, SESSION, {
    intentId: intent.id, cms: Buffer.from(JSON.stringify({ person, hash: intent.hash })) });
  await submit(seller, store.createEnrollmentIntent(seller, SESSION, {}), 'MODEL seller');
  await submit(buyer, store.createEnrollmentIntent(buyer, SESSION, {}), 'MODEL buyer');
  const deal = store.createDeal(seller, { requestId: randomUUID(), creatorRole: 'seller',
    scenario: 'grain', quantity: 20, amount: 200000, date: '2026-10-03' });
  const invitation = store.createInvitation(seller, deal.id, { expectedVersion: 1, participantId: buyer });
  store.claimInvitation(buyer, { code: invitation.code });
  const currentRequest = (actorId, action) => {
    const current = store.getDeal(actorId, deal.id);
    return { requestId: randomUUID(), action, expectedVersion: current.version,
      expectedStateRevision: current.stateRevision, snapshotHash: current.snapshotHash };
  };
  for (const action of ['offer', 'agree', 'handover', 'accept']) {
    const actorId = ['agree', 'accept'].includes(action) ? buyer : seller;
    await submit(actorId, store.createSignatureIntent(actorId, deal.id, SESSION, currentRequest(actorId, action)),
      actorId === seller ? 'MODEL seller' : 'MODEL buyer');
  }
  const plainReceipt = store.getDeal(buyer, deal.id).events.at(-1).authorization;
  const anchor = store.createAnchorIntent(buyer, deal.id, SESSION, currentRequest(buyer, 'anchor_test_memo'));
  await submit(buyer, anchor, 'MODEL buyer');
  const issuers = flag => createParticipantMemoIssuer({ store, policyPrivateKey: policy.privateKey,
    walletAddress, executionAccepted: flag, now: () => clock });
  let sender;
  t.after(() => { sender?.close(); store.close(); key.fill(0); rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, seller, buyer, anchor, plainReceipt, key, walletAddress, issuers,
    now: () => clock, tick(ms) { clock += ms; }, setSender(value) { sender = value; } };
}

test('ordinary deal acceptance never mints a Memo grant; exact anchor is deterministic and deadline-bound', async t => {
  const f = await fixture(t), issuer = f.issuers(false);
  assert.throws(() => issuer.issue(f.buyer, f.plainReceipt.receiptId));
  const envelope = issuer.issue(f.buyer, f.anchor.id);
  assert.equal(issuer.issue(f.buyer, f.anchor.id), envelope);
  const opened = openTestMemoEnvelope(envelope, issuer.policyPublicKey, { now: f.now() });
  assert.equal(opened.grant.grantId, f.anchor.id); assert.equal(opened.grant.intentHash, f.anchor.hash);
  assert.equal(opened.grant.expiresAt, f.anchor.expiresAt);
  assert.throws(() => issuer.authorize(opened.grant, opened.grantHash), /execution_not_accepted/);
  assert.throws(() => issuer.issue(f.seller, f.anchor.id));
  f.tick(300001); assert.throws(() => issuer.issue(f.buyer, f.anchor.id));
});

test('trusted issuer rejects changed grant/hash/wallet and cannot derive authority from browser evidence', async t => {
  const f = await fixture(t), issuer = f.issuers(true);
  const opened = openTestMemoEnvelope(issuer.issue(f.buyer, f.anchor.id), issuer.policyPublicKey, { now: f.now() });
  assert.equal(issuer.authorize(opened.grant, opened.grantHash), undefined);
  assert.throws(() => issuer.authorize({ ...opened.grant, maxFeeLamports: '1' }, opened.grantHash));
  assert.throws(() => issuer.authorize(opened.grant, '0'.repeat(64)));
  const wrong = createParticipantMemoIssuer({ store: f.store,
    policyPrivateKey: generateKeyPairSync('ed25519').privateKey, walletAddress: '1'.repeat(32), now: f.now });
  assert.throws(() => wrong.issue(f.buyer, f.anchor.id));
  assert.throws(() => createParticipantMemoIssuer({ store: { signedTest: false }, walletAddress: f.walletAddress }));
});

test('MODEL signed cabinet anchor executes once through private sender and exact fake network readback', async t => {
  const f = await fixture(t), issuer = f.issuers(true);
  const envelope = issuer.issue(f.buyer, f.anchor.id);
  const opened = openTestMemoEnvelope(envelope, issuer.policyPublicKey, { now: f.now() });
  const blockhash = '1'.repeat(32);
  let calls = 0, wire, signature;
  const rpc = {
    getGenesisHash: async () => DEVNET_GENESIS_HASH,
    getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 1000 }),
    getBlockHeight: async () => 999, getFeeForMessage: async () => 5000, getBalance: async () => 10000,
    async sendTransaction(bytes) {
      calls++; wire = Buffer.from(bytes);
      assert.equal(wire[0], 1); // Exactly one compact signature before the v0 message.
      signature = encodeTestMemoBase58(wire.subarray(1, 65));
      assert.equal(inspectTestMemoTransaction({ wireBytes: wire, grant: opened.grant,
        recentBlockhash: blockhash, signature }).signature, signature);
      return signature;
    },
    getSignatureStatus: async () => ({ slot: 1000, confirmations: null, err: null, confirmationStatus: 'finalized' }),
    getTransaction: async () => ({ slot: 1000, blockTime: null, version: 0,
      transaction: [wire.toString('base64'), 'base64'], meta: { err: null, fee: 5000,
        innerInstructions: [], loadedAddresses: { readonly: [], writable: [] } } }),
  };
  const sender = new DevnetMemoSender({ dbPath: join(f.directory, 'sender.sqlite'),
    policyPublicKey: issuer.policyPublicKey, walletAddress: f.walletAddress,
    keyProvider: async () => f.key, rpc, authorize: issuer.authorize, executeEnabled: true, now: f.now });
  f.setSender(sender);
  const first = await sender.execute(envelope);
  assert.equal(first.status, 'confirmed'); assert.equal(calls, 1);
  const retry = await sender.execute(envelope);
  assert.equal(retry.signature, first.signature); assert.equal(retry.historical, true); assert.equal(calls, 1);
  assert.deepEqual(Object.keys(first).sort(), ['grantId', 'historical', 'sendAttempts', 'signature', 'status']);
});
