import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OwnerStore } from '../authority/owner-store.mjs';
import { OfflineIssuer } from '../authority/offline-issuer.mjs';
import { Signer } from '../signer/signer.mjs';
import { deriveOfflineSignerAddress } from '../signer/solana/transaction-builder.mjs';
import { DealFlow } from './deal-flow.mjs';

const OWNER_ID = 'f1d05a12-5849-4a6b-9f47-a7a11dfa0132';
const WALLET = '6MHGUvei2atca6cz6yHPDqi6WKwYkNWRVLLCrwvoazsp';
const RECIPIENT = 'DNJtnMP3CbEN5Wvio7zFDEUcBAEfdzrxdQVj2i4sYXwY';
const NOW = 1_799_999_940_000;
const TERMS = {
  version: 1, commodity: 'Пшеница', quantity_kg: 20_000,
  total_price_kzt: '5000000', delivery_date: '2026-10-01',
  quality_spec: 'Влажность до 14%',
};

function setup(t, { walletAddress = WALLET, offlineContext } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-workflow-'));
  const path = (name) => join(directory, name);
  const owners = new OwnerStore(path('owners.sqlite'));
  const policy = generateKeyPairSync('ed25519');
  const certificate = generateKeyPairSync('ed25519');
  let now = NOW;
  let powers = true;
  let revoked = false;
  const sent = [];
  owners.registerVerifiedOwner({
    ownerId: OWNER_ID, subjectId: 'person-1', certificateId: 'cert-1', walletAddress,
  });
  const issuer = new OfflineIssuer({
    store: owners, policyPrivateKey: policy.privateKey, now: () => now,
    verifySigned: async (raw, signature, certificateId) => {
      if (certificateId !== 'cert-1' ||
          !verify(null, raw, certificate.publicKey, signature)) return null;
      return { certificateId, subjectId: 'person-1', status: revoked ? 'revoked' : 'valid' };
    },
    verifyPowers: async () => powers,
  });
  const signer = new Signer({
    dbPath: path('signer.sqlite'), policyPublicKey: policy.publicKey.export({ format: 'jwk' }).x,
    wallets: { [OWNER_ID]: walletAddress }, send: (transaction) => { sent.push(transaction); },
    now: () => now,
  });
  let flow = new DealFlow({ dbPath: path('deals.sqlite'), owners, issuer, signer,
    offlineContext, now: () => now });
  t.after(() => {
    flow.close();
    signer.close();
    owners.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get flow() { return flow; }, sent,
    setNow: (value) => { now = value; },
    setPowers: (value) => { powers = value; },
    setRevoked: (value) => { revoked = value; },
    restartFlow: () => {
      flow.close();
      flow = new DealFlow({ dbPath: path('deals.sqlite'), owners, issuer, signer,
        offlineContext, now: () => now });
    },
    signChallenge: (challenge) => sign(null,
      Buffer.from(challenge.bytesBase64url, 'base64url'), certificate.privateKey),
  };
}

function seed(flow, dealId = 'grain-1') {
  return flow.seedFixtureDeal({
    dealId, ownerId: OWNER_ID, recipient: RECIPIENT,
    testAmountLamports: '1200', terms: TERMS,
  });
}

test('challenge binds persisted terms, owner, recipient and capped test amount', (t) => {
  const fx = setup(t);
  const deal = seed(fx.flow);
  const challenge = fx.flow.createTransferChallenge('grain-1');
  const order = JSON.parse(Buffer.from(challenge.bytesBase64url, 'base64url'));
  const canonicalTerms = JSON.stringify(TERMS);
  assert.equal(deal.termsHash, createHash('sha256').update(canonicalTerms).digest('hex'));
  assert.equal(order.terms_hash, deal.termsHash);
  assert.equal(order.wallet_address, WALLET);
  assert.equal(order.recipient, RECIPIENT);
  assert.equal(order.amount_lamports, '1200');
  assert.equal(order.cluster, 'devnet');
  assert.equal(challenge.display.totalPriceKzt, '5000000');
  assert.equal(challenge.display.testAmountLamports, '1200');
  assert.deepEqual(fx.flow.deal('grain-1').terms, TERMS);
  assert.throws(() => seed(fx.flow), /UNIQUE constraint failed/);
  assert.throws(() => fx.flow.seedFixtureDeal({
    dealId: 'bad', ownerId: OWNER_ID, recipient: RECIPIENT,
    testAmountLamports: '1000001', terms: TERMS,
  }), /invalid fixture deal/);
  assert.throws(() => fx.flow.seedFixtureDeal({
    dealId: 'bad-address', ownerId: OWNER_ID, recipient: '0'.repeat(44),
    testAmountLamports: '1200', terms: TERMS,
  }), /invalid fixture deal: recipient/);
  assert.throws(() => fx.flow.seedFixtureDeal({
    dealId: 'bad-date', ownerId: OWNER_ID, recipient: RECIPIENT,
    testAmountLamports: '1200', terms: { ...TERMS, delivery_date: '2026-02-30' },
  }), /invalid deal terms/);
});

test('persisted challenge succeeds once; replay cannot make a second send', async (t) => {
  const fx = setup(t);
  seed(fx.flow);
  const challenge = fx.flow.createTransferChallenge('grain-1');
  const signature = fx.signChallenge(challenge);
  fx.restartFlow();
  const first = await fx.flow.submitTransfer({
    challengeId: challenge.challengeId, signature, certificateId: 'cert-1',
  });
  assert.equal(first.status, 'submitted');
  assert.equal(first.simulated, true);
  assert.match(first.txId, /^sim_/);
  assert.equal(fx.sent.length, 1);
  const replay = await fx.flow.submitTransfer({
    challengeId: challenge.challengeId, signature, certificateId: 'cert-1',
  });
  assert.equal(replay.txId, first.txId);
  assert.equal(replay.replayed, true);
  assert.equal(fx.sent.length, 1);
  const second = fx.flow.createTransferChallenge('grain-1');
  await assert.rejects(fx.flow.submitTransfer({
    challengeId: second.challengeId, signature: fx.signChallenge(second), certificateId: 'cert-1',
  }), /deal already authorized/);
  assert.equal(fx.sent.length, 1);
});

test('tampered, revoked, powerless and expired challenges fail before send', async (t) => {
  const fx = setup(t);
  seed(fx.flow);
  const challenge = fx.flow.createTransferChallenge('grain-1');
  const signature = fx.signChallenge(challenge);
  const attempt = (value = {}) => fx.flow.submitTransfer({
    challengeId: challenge.challengeId, signature, certificateId: 'cert-1', ...value,
  });
  await assert.rejects(attempt({ recipient: WALLET }), /invalid challenge response/);
  await assert.rejects(attempt({ amount_lamports: '9999' }), /invalid challenge response/);
  await assert.rejects(attempt({ signature: Buffer.from('invalid') }), /identity rejected/);
  await assert.rejects(attempt({ certificateId: 'wrong-cert' }), /identity rejected/);
  fx.setRevoked(true);
  await assert.rejects(attempt(), /identity rejected/);
  fx.setRevoked(false);
  fx.setPowers(false);
  await assert.rejects(attempt(), /powers rejected/);
  fx.setPowers(true);
  fx.setNow(NOW + 120_000);
  await assert.rejects(attempt(), /challenge expired/);
  assert.equal(fx.sent.length, 0);
});

test('deal response reaches one offline assembly without exposing signed bytes', async (t) => {
  const wallet = generateKeyPairSync('ed25519');
  const signerPrivateKey = Buffer.from(wallet.privateKey.export({ format: 'jwk' }).d, 'base64url');
  const walletAddress = await deriveOfflineSignerAddress(signerPrivateKey);
  const fx = setup(t, { walletAddress, offlineContext: async () => ({
    signerPrivateKey, recentBlockhash: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi',
    lastValidBlockHeight: 100n,
  }) });
  seed(fx.flow);
  const challenge = fx.flow.createTransferChallenge('grain-1');
  const response = {
    challengeId: challenge.challengeId, signature: fx.signChallenge(challenge),
    certificateId: 'cert-1',
  };
  await assert.rejects(fx.flow.submitOfflineAssembly({
    ...response, amount_lamports: '9999',
  }), /invalid challenge response/);
  fx.setRevoked(true);
  await assert.rejects(fx.flow.submitOfflineAssembly(response), /identity rejected/);
  fx.setRevoked(false);
  const first = await fx.flow.submitOfflineAssembly(response);
  assert.equal(first.status, 'assembled_offline');
  assert.equal(first.broadcast, false);
  assert.match(first.transactionSignature, /^[1-9A-HJ-NP-Za-km-z]+$/);
  assert.equal(Object.hasOwn(first, 'wireBytes'), false);
  assert.equal(fx.sent.length, 0);
  const replay = await fx.flow.submitOfflineAssembly(response);
  assert.equal(replay.transactionSignature, first.transactionSignature);
  assert.equal(replay.replayed, true);
  await assert.rejects(fx.flow.submitTransfer(response), /order_already_assembled/);
  const second = fx.flow.createTransferChallenge('grain-1');
  await assert.rejects(fx.flow.submitOfflineAssembly({
    challengeId: second.challengeId, signature: fx.signChallenge(second), certificateId: 'cert-1',
  }), /deal already authorized/);
  assert.equal(fx.sent.length, 0);
});
