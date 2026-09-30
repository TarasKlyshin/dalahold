import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createDraftServer } from '../web/server.mjs';
import { DecisionLedger } from './decision-ledger.mjs';
import { SignedDecisionFixture } from './signed-decision-fixture.mjs';

const SELLER = '20000000-0000-4000-8000-000000000001';
const BUYER = '20000000-0000-4000-8000-000000000002';
const DRAFT = { scenario: 'grain', quantity: 20_000, amount: 5_000_000, date: '2026-10-10' };

async function setup(t, { unstableVerifier = false, sharedDb = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-signed-decision-'));
  const draftDbPath = join(directory, 'drafts.sqlite');
  const decisionDbPath = sharedDb ? draftDbPath : join(directory, 'decisions.sqlite');
  const server = createDraftServer({ dbPath: draftDbPath });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const keys = {
    seller: generateKeyPairSync('ed25519'),
    buyer: generateKeyPairSync('ed25519'),
  };
  let now = 1_800_000_000_000;
  let revoked = false;
  let powers = true;
  let nowHook;
  let actorReads = 0;
  let verifyHook = async () => {};
  const checks = [];
  const powerActors = [];
  const dependencies = {
    draftDbPath, decisionDbPath, now: () => nowHook ? nowHook() : now,
    verifySigned: async (bytes, signature, certificateId) => {
      checks.push({ bytes: Buffer.from(bytes), certificateId });
      const key = keys[certificateId];
      if (!key || !verify(null, bytes, key.publicKey, signature)) return null;
      await verifyHook(bytes);
      const result = {
        actorId: certificateId === 'seller' ? SELLER : BUYER,
        status: revoked ? 'revoked' : 'valid',
      };
      return unstableVerifier ? new Proxy(result, {
        get(target, key, receiver) {
          if (key === 'actorId') return actorReads++ === 0 ? target.actorId : BUYER;
          return Reflect.get(target, key, receiver);
        },
      }) : result;
    },
    verifyPowers: async ({ actorId }) => { powerActors.push(actorId); return powers; },
  };
  let fixture = new SignedDecisionFixture(dependencies);
  t.after(async () => {
    fixture.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const write = (path, method, body) => fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify(body),
  });
  const created = await write('/api/deals', 'POST', DRAFT);
  assert.equal(created.status, 201);
  const deal = (await created.json()).deal;
  return {
    deal, base, checks, powerActors, write, draftDbPath, decisionDbPath,
    get actorReads() { return actorReads; },
    get fixture() { return fixture; },
    setNow: (value) => { now = value; },
    setNowHook: (value) => { nowHook = value; },
    setRevoked: (value) => { revoked = value; },
    setPowers: (value) => { powers = value; },
    setVerifyHook: (value) => { verifyHook = value; },
    restart: () => { fixture.close(); fixture = new SignedDecisionFixture(dependencies); },
    signature: (challenge, role) => sign(null,
      Buffer.from(challenge.bytesBase64url, 'base64url'), keys[role].privateKey),
    alteredSignature: (challenge, role) => sign(null,
      Buffer.from(`${challenge.bytesBase64url}altered`), keys[role].privateKey),
  };
}

function bind(fx) {
  return fx.fixture.bindDeal({ dealId: fx.deal.id, sellerId: SELLER, buyerId: BUYER });
}

function submit(fx, challenge, role, fields = {}) {
  return fx.fixture.submitChallenge({
    challengeId: challenge.challengeId, signature: fx.signature(challenge, role),
    certificateId: role, ...fields,
  });
}

test('saved web terms bind exact signed bytes to an offline decision after restart', async (t) => {
  const fx = await setup(t);
  const bound = bind(fx);
  assert.equal(bound.termsFingerprint, fx.deal.termsFingerprint);
  const originalTerms = { dealId: fx.deal.id, version: 1, ...DRAFT };
  assert.deepEqual(fx.fixture.termsSnapshot(fx.deal.id), originalTerms);
  const challenge = fx.fixture.issueChallenge({
    dealId: fx.deal.id, actorId: SELLER, action: 'offer',
  });
  assert.deepEqual(challenge.display.terms, originalTerms);
  const payload = JSON.parse(Buffer.from(challenge.bytesBase64url, 'base64url'));
  assert.equal(payload.schema, 'dalahold.offline-decision.v1');
  assert.equal(payload.dealId, fx.deal.id);
  assert.equal(payload.termsVersion, fx.deal.version);
  assert.equal(payload.termsFingerprint, fx.deal.termsFingerprint);
  fx.restart();
  assert.deepEqual(fx.fixture.termsSnapshot(fx.deal.id), originalTerms);
  const first = await submit(fx, challenge, 'seller');
  assert.equal(first.status, 'offered');
  assert.equal(first.replayed, false);
  assert.equal((await submit(fx, challenge, 'seller')).replayed, true);
  assert.equal(fx.fixture.deal(fx.deal.id).events.length, 1);
  assert.deepEqual(fx.checks[0].bytes, Buffer.from(challenge.bytesBase64url, 'base64url'));
  const revised = await fx.write(`/api/deals/${fx.deal.id}`, 'PUT', {
    ...DRAFT, amount: DRAFT.amount + 1, expectedVersion: 1,
  });
  assert.equal(revised.status, 200);
  assert.deepEqual(fx.fixture.termsSnapshot(fx.deal.id), originalTerms);
  fx.setNow(challenge.display.expiresAt);
  fx.setRevoked(true);
  const checksBeforeReplay = fx.checks.length;
  assert.equal((await submit(fx, challenge, 'seller')).replayed, true);
  assert.equal(fx.checks.length, checksBeforeReplay);
  await assert.rejects(fx.fixture.submitChallenge({
    challengeId: challenge.challengeId,
    signature: fx.alteredSignature(challenge, 'seller'), certificateId: 'seller',
  }), /replay credential mismatch/);
  await assert.rejects(fx.fixture.submitChallenge({
    challengeId: challenge.challengeId,
    signature: fx.signature(challenge, 'seller'), certificateId: 'buyer',
  }), /replay credential mismatch/);
  fx.setRevoked(false);
  assert.throws(() => fx.fixture.issueChallenge({
    dealId: fx.deal.id, actorId: SELLER, action: 'offer',
  }), /decision not allowed/);
  const accept = fx.fixture.issueChallenge({
    dealId: fx.deal.id, actorId: BUYER, action: 'accept_terms',
  });
  assert.equal((await submit(fx, accept, 'buyer')).status, 'agreed');
  assert.equal(fx.fixture.deal(fx.deal.id).events.length, 2);
  const historical = await submit(fx, challenge, 'seller');
  assert.equal(historical.status, 'offered');
  assert.equal(historical.replayed, true);
});

test('tampering, wrong actor, revocation, missing powers and extra fields do not advance', async (t) => {
  const fx = await setup(t);
  bind(fx);
  const challenge = fx.fixture.issueChallenge({
    dealId: fx.deal.id, actorId: SELLER, action: 'offer',
  });
  await assert.rejects(submit(fx, challenge, 'seller', { amount: 1 }), /invalid challenge response/);
  await assert.rejects(submit(fx, challenge, 'buyer'), /identity rejected/);
  await assert.rejects(fx.fixture.submitChallenge({
    challengeId: challenge.challengeId,
    signature: fx.alteredSignature(challenge, 'seller'),
    certificateId: 'seller',
  }), /identity rejected/);
  fx.setRevoked(true);
  await assert.rejects(submit(fx, challenge, 'seller'), /identity rejected/);
  fx.setRevoked(false);
  fx.setPowers(false);
  await assert.rejects(submit(fx, challenge, 'seller'), /powers rejected/);
  fx.setPowers(true);
  assert.equal(fx.fixture.deal(fx.deal.id).events.length, 0);
  assert.equal((await submit(fx, challenge, 'seller')).status, 'offered');
  assert.equal((await fetch(`${fx.base}/api/deals/${fx.deal.id}/decisions`)).status, 404);
});

test('draft revision invalidates both pending and new challenges', async (t) => {
  const fx = await setup(t);
  bind(fx);
  const challenge = fx.fixture.issueChallenge({
    dealId: fx.deal.id, actorId: SELLER, action: 'offer',
  });
  const revised = await fx.write(`/api/deals/${fx.deal.id}`, 'PUT', {
    ...DRAFT, amount: DRAFT.amount + 1, expectedVersion: 1,
  });
  assert.equal(revised.status, 200);
  await assert.rejects(submit(fx, challenge, 'seller'), /draft changed after binding/);
  assert.throws(() => fx.fixture.issueChallenge({
    dealId: fx.deal.id, actorId: SELLER, action: 'offer',
  }), /draft changed after binding/);
  assert.equal(fx.fixture.deal(fx.deal.id).events.length, 0);
  const refreshed = fx.fixture.refreshUnsignedTerms(fx.deal.id);
  assert.equal(refreshed.termsVersion, 2);
  assert.notEqual(refreshed.termsFingerprint, fx.deal.termsFingerprint);
  assert.deepEqual(fx.fixture.termsSnapshot(fx.deal.id), {
    dealId: fx.deal.id, version: 2, ...DRAFT, amount: DRAFT.amount + 1,
  });
  await assert.rejects(submit(fx, challenge, 'seller'), /stale or altered terms/);
  const current = fx.fixture.issueChallenge({
    dealId: fx.deal.id, actorId: SELLER, action: 'offer',
  });
  assert.equal((await submit(fx, current, 'seller')).status, 'offered');
  assert.throws(() => fx.fixture.refreshUnsignedTerms(fx.deal.id), /already offered/);
});

test('corrupt bound terms fail closed before a new challenge', async (t) => {
  const fx = await setup(t);
  bind(fx);
  const db = new DatabaseSync(fx.decisionDbPath);
  t.after(() => db.close());
  db.prepare('UPDATE decision_deals SET terms_json = ? WHERE deal_id = ?')
    .run(JSON.stringify({ dealId: fx.deal.id, version: 1, ...DRAFT, amount: 1 }), fx.deal.id);
  assert.throws(() => fx.fixture.termsSnapshot(fx.deal.id), /terms snapshot mismatch/);
  assert.throws(() => fx.fixture.issueChallenge({
    dealId: fx.deal.id, actorId: SELLER, action: 'offer',
  }), /terms snapshot mismatch/);
  db.prepare('UPDATE decision_deals SET terms_json = NULL WHERE deal_id = ?').run(fx.deal.id);
  assert.throws(() => fx.fixture.issueChallenge({
    dealId: fx.deal.id, actorId: SELLER, action: 'offer',
  }), /missing terms snapshot/);
  assert.equal(fx.fixture.deal(fx.deal.id).events.length, 0);
});

test('one-file ledger checks draft freshness inside the decision transaction', async (t) => {
  const fx = await setup(t, { sharedDb: true });
  bind(fx);
  const stale = fx.fixture.issueChallenge({
    dealId: fx.deal.id, actorId: SELLER, action: 'offer',
  });
  const revised = await fx.write(`/api/deals/${fx.deal.id}`, 'PUT', {
    ...DRAFT, amount: DRAFT.amount + 1, expectedVersion: 1,
  });
  assert.equal(revised.status, 200);
  const signedBytes = Buffer.from(stale.bytesBase64url, 'base64url');
  const { schema, expiresAt, ...decision } = JSON.parse(signedBytes);
  assert.equal(schema, 'dalahold.offline-decision.v1');
  assert.equal(expiresAt, stale.display.expiresAt);
  const ledger = new DecisionLedger({ dbPath: fx.decisionDbPath, requireCurrentDraft: true });
  t.after(() => ledger.close());
  assert.throws(() => ledger.apply(fx.deal.id, decision, {
    signatureHash: createHash('sha256').update(fx.signature(stale, 'seller')).digest('hex'),
    certificateId: 'seller',
    challengeHash: createHash('sha256').update(signedBytes).digest('hex'),
    expiresAt, now: () => expiresAt - 1,
  }), /unsigned draft changed after binding/);
  assert.equal(fx.fixture.deal(fx.deal.id).events.length, 0);
  fx.fixture.refreshUnsignedTerms(fx.deal.id);
  const current = fx.fixture.issueChallenge({
    dealId: fx.deal.id, actorId: SELLER, action: 'offer',
  });
  assert.equal((await submit(fx, current, 'seller')).status, 'offered');
  const laterDraft = await fx.write(`/api/deals/${fx.deal.id}`, 'PUT', {
    ...DRAFT, amount: DRAFT.amount + 2, expectedVersion: 2,
  });
  assert.equal(laterDraft.status, 200);
  const accept = fx.fixture.issueChallenge({
    dealId: fx.deal.id, actorId: BUYER, action: 'accept_terms',
  });
  assert.equal((await submit(fx, accept, 'buyer')).status, 'agreed');
  assert.equal(fx.fixture.termsSnapshot(fx.deal.id).amount, DRAFT.amount + 1);
});

test('expiry and competing challenges fail closed after one accepted decision', async (t) => {
  const fx = await setup(t);
  bind(fx);
  const expired = fx.fixture.issueChallenge({
    dealId: fx.deal.id, actorId: SELLER, action: 'offer',
  });
  fx.setNow(expired.display.expiresAt);
  await assert.rejects(submit(fx, expired, 'seller'), /challenge expired/);
  assert.equal(fx.fixture.deal(fx.deal.id).events.length, 0);
  const first = fx.fixture.issueChallenge({
    dealId: fx.deal.id, actorId: SELLER, action: 'offer',
  });
  const competing = fx.fixture.issueChallenge({
    dealId: fx.deal.id, actorId: SELLER, action: 'offer',
  });
  assert.equal((await submit(fx, first, 'seller')).status, 'offered');
  await assert.rejects(submit(fx, competing, 'seller'), /decision not allowed/);
  assert.equal(fx.fixture.deal(fx.deal.id).events.length, 1);
});

test('verified actor is read once before policy and powers use it', async (t) => {
  const fx = await setup(t, { unstableVerifier: true });
  bind(fx);
  const challenge = fx.fixture.issueChallenge({
    dealId: fx.deal.id, actorId: SELLER, action: 'offer',
  });
  assert.equal((await submit(fx, challenge, 'seller')).status, 'offered');
  assert.equal(fx.actorReads, 1);
  assert.deepEqual(fx.powerActors, [SELLER]);
});

test('signed offline dispute route never reaches demo release', async (t) => {
  const fx = await setup(t);
  bind(fx);
  for (const [action, actorId, role] of [
    ['offer', SELLER, 'seller'],
    ['accept_terms', BUYER, 'buyer'],
    ['reserve_demo', BUYER, 'buyer'],
    ['claim_handover', SELLER, 'seller'],
    ['open_dispute', BUYER, 'buyer'],
  ]) {
    if (action === 'open_dispute') {
      const revised = await fx.write(`/api/deals/${fx.deal.id}`, 'PUT', {
        ...DRAFT, amount: DRAFT.amount + 1, expectedVersion: 1,
      });
      assert.equal(revised.status, 200);
    }
    const challenge = fx.fixture.issueChallenge({ dealId: fx.deal.id, actorId, action });
    await submit(fx, challenge, role);
  }
  assert.equal(fx.fixture.deal(fx.deal.id).status, 'disputed');
  assert.equal(fx.fixture.deal(fx.deal.id).events.length, 5);
  assert.throws(() => fx.fixture.issueChallenge({
    dealId: fx.deal.id, actorId: BUYER, action: 'release_demo',
  }), /decision not allowed/);
});

test('expiry during verification and draft change during verification both fail closed', async (t) => {
  const fx = await setup(t);
  bind(fx);
  const challenge = fx.fixture.issueChallenge({
    dealId: fx.deal.id, actorId: SELLER, action: 'offer',
  });
  fx.setVerifyHook(async (bytes) => {
    fx.setNow(JSON.parse(bytes.toString('utf8')).expiresAt);
  });
  await assert.rejects(submit(fx, challenge, 'seller'), /challenge expired/);
  assert.equal(fx.fixture.deal(fx.deal.id).events.length, 0);
  fx.setVerifyHook(async () => {
    const revised = await fx.write(`/api/deals/${fx.deal.id}`, 'PUT', {
      ...DRAFT, amount: DRAFT.amount + 1, expectedVersion: 1,
    });
    assert.equal(revised.status, 200);
  });
  const fresh = fx.fixture.issueChallenge({
    dealId: fx.deal.id, actorId: SELLER, action: 'offer',
  });
  await assert.rejects(submit(fx, fresh, 'seller'), /draft changed after binding/);
  assert.equal(fx.fixture.deal(fx.deal.id).events.length, 0);
});

test('failed ledger write leaves no signed receipt and can be retried', async (t) => {
  const fx = await setup(t);
  bind(fx);
  const challenge = fx.fixture.issueChallenge({
    dealId: fx.deal.id, actorId: SELLER, action: 'offer',
  });
  const db = new DatabaseSync(fx.decisionDbPath);
  t.after(() => db.close());
  for (const [table, abortMode] of [
    ['decision_deals', 'ABORT'],
    ['decision_challenges', 'ABORT'],
    ['decision_challenges', 'ROLLBACK'],
  ]) {
    db.exec(`CREATE TRIGGER fail_decision_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(${abortMode}, 'injected ledger failure'); END;`);
    await assert.rejects(submit(fx, challenge, 'seller'), /injected ledger failure/);
    const row = db.prepare(`SELECT signature_hash, certificate_id, result_status
      FROM decision_challenges WHERE challenge_id = ?`).get(challenge.challengeId);
    assert.deepEqual({ ...row }, {
      signature_hash: null, certificate_id: null, result_status: null,
    });
    assert.equal(fx.fixture.deal(fx.deal.id).events.length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM decision_ids').get().count, 0);
    db.exec('DROP TRIGGER fail_decision_update');
  }
  assert.deepEqual(await submit(fx, challenge, 'seller'), {
    dealId: fx.deal.id, challengeId: challenge.challengeId,
    status: 'offered', replayed: false,
  });
});

test('concurrent identical submissions commit once and return one historical replay', async (t) => {
  const fx = await setup(t);
  bind(fx);
  const challenge = fx.fixture.issueChallenge({
    dealId: fx.deal.id, actorId: SELLER, action: 'offer',
  });
  let arrivals = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  fx.setVerifyHook(async () => {
    if (++arrivals === 2) release();
    await barrier;
  });
  const outcomes = await Promise.all([
    submit(fx, challenge, 'seller'), submit(fx, challenge, 'seller'),
  ]);
  assert.deepEqual(outcomes.map((result) => result.replayed).sort(), [false, true]);
  assert.deepEqual(outcomes.map((result) => result.status), ['offered', 'offered']);
  assert.equal(fx.fixture.deal(fx.deal.id).events.length, 1);
});

test('caller mutation cannot change the verified signature or historical receipt', async (t) => {
  const fx = await setup(t);
  bind(fx);
  const challenge = fx.fixture.issueChallenge({
    dealId: fx.deal.id, actorId: SELLER, action: 'offer',
  });
  let release;
  const pause = new Promise((resolve) => { release = resolve; });
  fx.setVerifyHook(async () => { await pause; });
  const original = fx.signature(challenge, 'seller');
  const supplied = Buffer.from(original);
  const pending = fx.fixture.submitChallenge({
    challengeId: challenge.challengeId, signature: supplied, certificateId: 'seller',
  });
  supplied.fill(0);
  release();
  assert.equal((await pending).status, 'offered');
  assert.equal((await fx.fixture.submitChallenge({
    challengeId: challenge.challengeId, signature: original, certificateId: 'seller',
  })).replayed, true);
  await assert.rejects(fx.fixture.submitChallenge({
    challengeId: challenge.challengeId, signature: supplied, certificateId: 'seller',
  }), /replay credential mismatch/);

  const fakeShort = new Uint8Array(20_000);
  Object.setPrototypeOf(fakeShort, Buffer.prototype);
  Object.defineProperty(fakeShort, 'length', { get: () => 1 });
  await assert.rejects(fx.fixture.submitChallenge({
    challengeId: challenge.challengeId, signature: fakeShort, certificateId: 'seller',
  }), /invalid challenge response/);
});

test('late concurrent retry returns the committed receipt after expiry and revocation', async (t) => {
  const fx = await setup(t);
  bind(fx);
  const challenge = fx.fixture.issueChallenge({
    dealId: fx.deal.id, actorId: SELLER, action: 'offer',
  });
  let release;
  const pause = new Promise((resolve) => { release = resolve; });
  fx.setVerifyHook(async () => { await pause; });
  const delayed = submit(fx, challenge, 'seller');
  fx.setVerifyHook(async () => {});
  assert.equal((await submit(fx, challenge, 'seller')).status, 'offered');
  const revised = await fx.write(`/api/deals/${fx.deal.id}`, 'PUT', {
    ...DRAFT, amount: DRAFT.amount + 1, expectedVersion: 1,
  });
  assert.equal(revised.status, 200);
  fx.setNow(challenge.display.expiresAt);
  fx.setRevoked(true);
  fx.setPowers(false);
  release();
  assert.deepEqual(await delayed, {
    dealId: fx.deal.id, challengeId: challenge.challengeId,
    status: 'offered', replayed: true,
  });
  assert.equal(fx.fixture.deal(fx.deal.id).events.length, 1);
});

test('offline evidence keeps only matching-version metadata and honest provenance', async (t) => {
  const fx = await setup(t);
  const marker = {
    expectedVersion: 1, requestId: '3901aa3d-56ef-49cd-a732-20ed92d33c11',
    category: 'quality', context: 'Тестовая партия', note: 'Файла нет',
    claimedRole: 'seller', fileKind: 'pdf',
  };
  const markerPath = `/api/deals/${fx.deal.id}/markers`;
  const first = await fx.write(markerPath, 'POST', marker);
  assert.equal(first.status, 201);
  const firstMarker = (await first.json()).marker;
  bind(fx);
  const offer = fx.fixture.issueChallenge({
    dealId: fx.deal.id, actorId: SELLER, action: 'offer',
  });
  await submit(fx, offer, 'seller');
  const revised = await fx.write(`/api/deals/${fx.deal.id}`, 'PUT', {
    ...DRAFT, amount: DRAFT.amount + 1, expectedVersion: 1,
  });
  assert.equal(revised.status, 200);
  const later = await fx.write(markerPath, 'POST', {
    ...marker, expectedVersion: 2,
    requestId: 'a2437ed0-9df6-4169-9e64-3462b86add33',
  });
  assert.equal(later.status, 201);
  const accept = fx.fixture.issueChallenge({
    dealId: fx.deal.id, actorId: BUYER, action: 'accept_terms',
  });
  await submit(fx, accept, 'buyer');
  const report = fx.fixture.demoEvidence(fx.deal.id);
  assert.equal(report.schema, 'dalahold.offline-evidence.v1');
  assert.equal(report.trustLevel, 'local_test_fixture_only');
  assert.deepEqual(report.terms, { dealId: fx.deal.id, version: 1, ...DRAFT });
  assert.equal(report.termsFingerprint, fx.deal.termsFingerprint);
  assert.deepEqual(report.decisions.map((event) => event.action), ['offer', 'accept_terms']);
  assert(report.decisions.every((event) => event.source === 'test_key_receipt'));
  assert(report.decisions.every((event) => !Object.hasOwn(event, 'certificateId')));
  assert.deepEqual(report.documentMarkers.map((item) => item.id), [firstMarker.id]);
  assert.equal(report.documentMarkers[0].source, 'unsigned_metadata_only');
  assert.equal(Object.hasOwn(report.documentMarkers[0], 'contents'), false);
  const db = new DatabaseSync(fx.draftDbPath);
  t.after(() => db.close());
  db.prepare('UPDATE draft_versions SET amount = 1 WHERE deal_id = ? AND version = 1')
    .run(fx.deal.id);
  assert.throws(() => fx.fixture.demoEvidence(fx.deal.id), /archived terms mismatch/);
});

test('offline evidence refuses a decision that bypassed the test-key receipt', async (t) => {
  const fx = await setup(t);
  bind(fx);
  const ledger = new DecisionLedger({ dbPath: fx.decisionDbPath });
  t.after(() => ledger.close());
  ledger.apply(fx.deal.id, {
    decisionId: 'bbf2147a-7fcb-46b7-afb3-3108a00e951d',
    dealId: fx.deal.id, actorId: SELLER, action: 'offer',
    termsVersion: 1, termsFingerprint: fx.deal.termsFingerprint,
  });
  assert.throws(() => fx.fixture.demoEvidence(fx.deal.id), /missing test decision receipt/);
});

test('expiry at transactional commit leaves the verified challenge unapplied', async (t) => {
  const fx = await setup(t);
  bind(fx);
  const challenge = fx.fixture.issueChallenge({
    dealId: fx.deal.id, actorId: SELLER, action: 'offer',
  });
  let reads = 0;
  fx.setNowHook(() => ++reads >= 3
    ? challenge.display.expiresAt : challenge.display.expiresAt - 1);
  await assert.rejects(submit(fx, challenge, 'seller'), /challenge expired/);
  assert.equal(fx.fixture.deal(fx.deal.id).events.length, 0);
  const db = new DatabaseSync(fx.decisionDbPath);
  t.after(() => db.close());
  assert.equal(db.prepare('SELECT signature_hash FROM decision_challenges WHERE challenge_id = ?')
    .get(challenge.challengeId).signature_hash, null);
});

test('challenge bytes changed during verification cannot be committed', async (t) => {
  const fx = await setup(t);
  bind(fx);
  const challenge = fx.fixture.issueChallenge({
    dealId: fx.deal.id, actorId: SELLER, action: 'offer',
  });
  const db = new DatabaseSync(fx.decisionDbPath);
  t.after(() => db.close());
  fx.setVerifyHook(async () => {
    db.prepare('UPDATE decision_challenges SET signed_bytes = ? WHERE challenge_id = ?')
      .run(Buffer.from('corrupt'), challenge.challengeId);
  });
  await assert.rejects(submit(fx, challenge, 'seller'), /challenge changed during verification/);
  assert.equal(fx.fixture.deal(fx.deal.id).events.length, 0);
  assert.equal(db.prepare('SELECT signature_hash FROM decision_challenges WHERE challenge_id = ?')
    .get(challenge.challengeId).signature_hash, null);
});
