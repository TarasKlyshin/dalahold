import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OwnerStore } from './owner-store.mjs';
import { OfflineIssuer } from './offline-issuer.mjs';
import { SYSTEM_PROGRAM_ID, Signer } from '../signer/signer.mjs';

const NOW = 1_799_999_940_000;
const OWNER_ID = 'f1d05a12-5849-4a6b-9f47-a7a11dfa0132';
const WALLET = '6MHGUvei2atca6cz6yHPDqi6WKwYkNWRVLLCrwvoazsp';
const RECIPIENT = 'DNJtnMP3CbEN5Wvio7zFDEUcBAEfdzrxdQVj2i4sYXwY';
const hash = (value) => createHash('sha256').update(value).digest('hex');

function order(overrides = {}) {
  return {
    version: 1, action: 'test_transfer', cluster: 'devnet', program_id: SYSTEM_PROGRAM_ID,
    owner_id: OWNER_ID, deal_id: 'test-deal-1', wallet_address: WALLET,
    recipient: RECIPIENT, amount_lamports: '1200', terms_hash: hash('test terms'),
    auth_epoch: 0, nonce: 'nonce-1', expires_at: NOW + 120_000, ...overrides,
  };
}

const bytes = (value) => Buffer.from(JSON.stringify(value));
test('offline issuer and signer agree on exact order, replay, rotation and fail-closed cases', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-integration-'));
  const store = new OwnerStore(join(directory, 'owners.sqlite'));
  const policy = generateKeyPairSync('ed25519');
  const cert1 = generateKeyPairSync('ed25519');
  const cert2 = generateKeyPairSync('ed25519');
  const cert3 = generateKeyPairSync('ed25519');
  const certs = new Map([['cert-1', cert1], ['cert-2', cert2], ['cert-3', cert3]]);
  let revoked = false;
  let verificationUnavailable = false;
  let powers = true;
  const sent = [];
  const signer = new Signer({
    dbPath: join(directory, 'signer.sqlite'),
    policyPublicKey: policy.publicKey.export({ format: 'jwk' }).x,
    wallets: { [OWNER_ID]: WALLET }, now: () => NOW,
    send: (transaction) => { sent.push(transaction); },
  });
  t.after(() => {
    signer.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.registerVerifiedOwner({
    ownerId: OWNER_ID, subjectId: 'person-1', certificateId: 'cert-1', walletAddress: WALLET,
  });
  const issuer = new OfflineIssuer({
    store, policyPrivateKey: policy.privateKey, now: () => NOW,
    verifySigned: async (raw, signature, certificateId) => {
      if (verificationUnavailable) throw new Error('certificate status unavailable');
      const cert = certs.get(certificateId);
      if (!cert || !verify(null, raw, cert.publicKey, signature)) return null;
      return { status: revoked && certificateId === 'cert-2' ? 'revoked' : 'valid',
        certificateId, subjectId: certificateId === 'cert-3' ? 'person-2' : 'person-1' };
    },
    verifyPowers: async () => powers,
  });
  const signed = (value, cert) => ({
    orderBytes: bytes(value), signature: sign(null, bytes(value), cert.privateKey),
    certificateId: cert === cert1 ? 'cert-1' : 'cert-2',
  });

  const first = signed(order(), cert1);
  const issued = await issuer.issue(first);
  assert.equal(issued.replayed, false);
  assert.equal((await signer.transfer(issued.envelope)).status, 'submitted');
  assert.equal(sent.length, 1);
  assert.deepEqual(await issuer.issue(first), { envelope: issued.envelope, replayed: true });
  assert.equal((await signer.transfer(issued.envelope)).replayed, true);
  assert.equal(sent.length, 1);
  await assert.rejects(issuer.issue(signed(order({ nonce: 'second-nonce-same-deal' }), cert1)),
    /deal already authorized/);
  await assert.rejects(issuer.issue({ ...first, orderBytes: bytes(order({ amount_lamports: '1300' })) }),
    /identity rejected/);
  await assert.rejects(issuer.issue(signed(order({
    deal_id: 'test-deal-other', amount_lamports: '1300',
  }), cert1)), /replay/);

  const pending = await issuer.issue(signed(order({ deal_id: 'test-deal-2', nonce: 'nonce-2' }), cert1));
  const rebindBytes = bytes({
    version: 1, action: 'rebind_certificate', owner_id: OWNER_ID,
    new_certificate_id: 'cert-2', nonce: 'rotate-1', expires_at: NOW + 120_000,
  });
  const rebind = {
    rebindBytes, signature: sign(null, rebindBytes, cert2.privateKey), certificateId: 'cert-2',
  };
  const foreignBytes = bytes({
    version: 1, action: 'rebind_certificate', owner_id: OWNER_ID,
    new_certificate_id: 'cert-3', nonce: 'rotate-foreign', expires_at: NOW + 120_000,
  });
  await assert.rejects(issuer.rebind({
    rebindBytes: foreignBytes, signature: sign(null, foreignBytes, cert3.privateKey),
    certificateId: 'cert-3', notifySigner: (value) => signer.epoch(value),
  }), /stale authority/);
  powers = false;
  await assert.rejects(issuer.rebind({ ...rebind, notifySigner: (value) => signer.epoch(value) }),
    /powers rejected/);
  powers = true;
  await assert.rejects(issuer.rebind({ ...rebind, notifySigner: async () => {
    throw new Error('signer unavailable');
  } }), /signer unavailable/);
  assert.equal(store.owner(OWNER_ID).authEpoch, 0);
  revoked = true;
  await assert.rejects(issuer.rebind({ ...rebind, notifySigner: (value) => signer.epoch(value) }),
    /identity rejected/);
  revoked = false;
  const rotated = await issuer.rebind({ ...rebind, notifySigner: (value) => signer.epoch(value) });
  assert.equal(rotated.walletAddress, WALLET);
  assert.equal(rotated.authEpoch, 1);
  await assert.rejects(signer.transfer(pending.envelope), /stale_epoch/);
  await assert.rejects(issuer.issue(signed(order({ deal_id: 'test-deal-3', nonce: 'nonce-3', auth_epoch: 1 }), cert1)),
    /stale authority/);

  const next = await issuer.issue(signed(order({ deal_id: 'test-deal-3', nonce: 'nonce-4', auth_epoch: 1 }), cert2));
  assert.equal((await signer.transfer(next.envelope)).status, 'submitted');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].wallet_address, WALLET);

  verificationUnavailable = true;
  await assert.rejects(issuer.issue(signed(order({ deal_id: 'test-deal-4', nonce: 'nonce-5', auth_epoch: 1 }), cert2)),
    /certificate status unavailable/);
  verificationUnavailable = false;
  revoked = true;
  await assert.rejects(issuer.issue(signed(order({ deal_id: 'test-deal-4', nonce: 'nonce-5', auth_epoch: 1 }), cert2)),
    /identity rejected/);
  revoked = false;
  powers = false;
  await assert.rejects(issuer.issue(signed(order({ deal_id: 'test-deal-5', nonce: 'nonce-6', auth_epoch: 1 }), cert2)),
    /powers rejected/);
  await assert.rejects(signer.transfer(JSON.stringify({ payload: 'e30', sig: 'AA' })), /bad_signature/);
  assert.equal(sent.length, 2);
});
