// Policy/storage doubles: two distinct model identities, no claim of NCA crypto.
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { canonicalDraftTerms, fingerprintDraftTerms } from '../web/terms.mjs';
import { ParticipantSignatures, ParticipantSignatureError, PARTICIPANT_SIGNATURE_DOMAIN,
  PARTICIPANT_SIGNATURE_SCOPE, PARTICIPANT_SIGNATURE_STATEMENT } from './participant-signatures.mjs';

const SCOPE = PARTICIPANT_SIGNATURE_SCOPE;
const SESSION = 'a'.repeat(64), OTHER_SESSION = 'b'.repeat(64);
const C1 = '1'.repeat(64), C2 = '2'.repeat(64), C3 = '3'.repeat(64);
const WALLET = '9xQeWvG816bUx9EPjHmaT23yvVMUTjJSLaqaXDh49o1Q';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sign = (bytes, person = 'seller', certificateDigest = C1, organizationId = null) =>
  Buffer.from(JSON.stringify({ bytes: bytes.toString('base64'), person, certificateDigest, organizationId }));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const RECEIPT_FIELDS = ['id', 'intentId', 'intentHash', 'actorId', 'action', 'dealId', 'eventId', 'snapshotHash',
  'bindingId', 'authEpoch', 'certificateDigest', 'verifiedAt', 'validUntil', 'statusSource', 'scope'];
const POLICIES = { offer: ['seller', 'draft', 'offered'], agree: ['buyer', 'offered', 'agreed'],
  handover: ['seller', 'agreed', 'handed_over'], accept: ['buyer', 'handed_over', 'accepted'], dispute: [null, null, 'disputed'] };
const PEM = '-----BEGIN CERTIFICATE-----\nVEVTVA==\n-----END CERTIFICATE-----\n';

function fixture(t, { memo = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE fixture_participants (id TEXT PRIMARY KEY,label TEXT) STRICT;
    CREATE TABLE fixture_deals (id TEXT PRIMARY KEY,value TEXT) STRICT;
    CREATE TABLE fixture_events (id TEXT PRIMARY KEY,deal_id TEXT,value TEXT) STRICT;`);
  const actors = [randomUUID(), randomUUID(), randomUUID()];
  actors.forEach((id, index) => db.prepare('INSERT INTO fixture_participants VALUES (?,?)').run(id, `TEST participant 00${index + 1}`));
  let time = 1_000_000, calls = 0, commitCalls = 0, verificationHook = null, finalChecks = [], checking = false, commitHook = null;
  const stores = [];
  const atomic = (assertCurrent, fn, finalCheck = () => {}) => {
    assertCurrent();
    const nested = db.isTransaction, savepoint = `fixture_${randomUUID().replaceAll('-', '')}`;
    if (!nested) finalChecks = [];
    const count = finalChecks.length;
    finalChecks.push(finalCheck);
    db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    try {
      const result = fn(); assertCurrent();
      if (!checking) {
        checking = true;
        try { for (const check of finalChecks) check(); } finally { checking = false; }
      }
      db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      if (nested) { db.exec(`ROLLBACK TO ${savepoint}`); db.exec(`RELEASE ${savepoint}`); }
      else db.exec('ROLLBACK');
      finalChecks.splice(count); throw error;
    } finally { if (!nested) finalChecks = []; }
  };
  const participant = actorId => {
    const row = db.prepare('SELECT * FROM fixture_participants WHERE id=?').get(actorId);
    if (!row) throw new Error('unauthorized'); return { ...row };
  };
  const rawDeal = dealId => JSON.parse(db.prepare('SELECT value FROM fixture_deals WHERE id=?').get(dealId).value);
  const readDeal = (actorId, dealId) => {
    const deal = rawDeal(dealId);
    const member = deal.participants.find(row => row.id === actorId);
    if (!member) throw new Error('not_found');
    return { ...deal, role: member.role,
      events: db.prepare('SELECT value FROM fixture_events WHERE deal_id=? ORDER BY rowid').all(dealId).map(row => JSON.parse(row.value)) };
  };
  const writeDeal = value => db.prepare('UPDATE fixture_deals SET value=? WHERE id=?').run(JSON.stringify(value), value.id);
  const calculate = value => {
    const terms = { dealId: value.id, version: value.version, scenario: value.scenario, quantity: value.quantity, amount: value.amount, date: value.date };
    value.termsFingerprint = fingerprintDraftTerms(terms);
    value.snapshotHash = hash(JSON.stringify({ schema: 'dalahold.local-test-participant-snapshot.v1',
      canonicalTerms: canonicalDraftTerms(terms).toString('utf8'),
      documents: [...value.documents].sort((a, b) => a.id.localeCompare(b.id)),
      participants: [...value.participants].sort((a, b) => a.role.localeCompare(b.role) || a.id.localeCompare(b.id)) }));
    return value;
  };
  const createDeal = () => {
    const id = randomUUID();
    const deal = calculate({ id, version: 1, scenario: 'grain', quantity: 12, amount: 12000, date: '2026-10-10',
      state: 'draft', stateRevision: 0,
      participants: [{ ...participant(actors[0]), role: 'seller' }, { ...participant(actors[1]), role: 'buyer' }],
      documents: [{ id: randomUUID(), dealId: id, termsVersion: 1, category: 'contract', byteLength: 12,
        sha256: hash('model text\n'), createdAt: time, scope: 'local_test_document_only', fileKind: 'text' }] });
    db.prepare('INSERT INTO fixture_deals VALUES (?,?)').run(id, JSON.stringify(deal)); return id;
  };
  const sdk = {
    statusSource: 'test_ocsp',
    async inspect() { return { ready: true, chain: [PEM, PEM], validUntil: time + 100_000, statusSource: 'test_ocsp', personId: 'discarded' }; },
    async verifyIdentity(bytes, cms, key) {
      calls++;
      assert.equal(db.isTransaction, false, 'no shared transaction spans verifier await');
      assert.equal(key.length, 32);
      if (verificationHook) return verificationHook(bytes, cms, key);
      const input = JSON.parse(cms.toString('utf8'));
      if (input.bytes !== bytes.toString('base64')) return { verified: false };
      return { verified: true, certificateDigest: input.certificateDigest, statusSource: 'test_ocsp', validUntil: time + 60_000,
        identity: { schema: 'nca_test_subject_v1', personId: 'person:' + createHmac('sha256', key).update(input.person).digest('hex'), organizationId: input.organizationId } };
    },
  };
  const commit = (actorId, dealId, request, authorization) => atomic(() => {}, () => {
    commitCalls++;
    const before = readDeal(actorId, dealId), policy = POLICIES[request.action];
    assert.equal(before.snapshotHash, request.snapshotHash);
    assert.equal(before.stateRevision, request.expectedStateRevision);
    assert.equal(before.version, request.expectedVersion);
    if (policy[0] && policy[0] !== before.role) throw new Error('forbidden');
    const event = { id: randomUUID(), dealId, action: request.action, actorId, role: before.role,
      termsVersion: before.version, stateRevision: before.stateRevision + 1, snapshotHash: before.snapshotHash,
      termsFingerprint: before.termsFingerprint, documentManifestHash: hash(JSON.stringify([...before.documents].sort((a, b) => a.id.localeCompare(b.id)))),
      createdAt: time, stateFrom: before.state, stateTo: policy[2], source: 'personal_test_nca_statement', scope: SCOPE, authorization };
    db.prepare('INSERT INTO fixture_events VALUES (?,?,?)').run(event.id, dealId, JSON.stringify(event));
    const changed = rawDeal(dealId); changed.state = policy[2]; changed.stateRevision++;
    writeDeal(changed);
    return commitHook ? commitHook({ event }, { actorId, dealId, request, authorization }) : { event };
  });
  const open = (override = {}) => {
    const store = new ParticipantSignatures({ db, sdk, now: () => time, readParticipant: participant,
      readDeal, commitSignedAction: commit, atomic,
      ...(memo ? { memoConfiguration: { walletAddress: WALLET, maxFeeLamports: '10000' } } : {}), ...override });
    stores.push(store); return store;
  };
  const store = open();
  t.after(() => { for (const current of stores) current.close(); db.close(); });
  const state = () => JSON.stringify(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
  const request = (actorId, dealId, action) => {
    const deal = readDeal(actorId, dealId);
    return { requestId: randomUUID(), action, expectedVersion: deal.version, expectedStateRevision: deal.stateRevision, snapshotHash: deal.snapshotHash };
  };
  const enrollment = async (actorId = actors[0], person = 'seller', cert = C1) => {
    const intent = store.createEnrollmentIntent(actorId, SESSION);
    return store.submit(actorId, SESSION, { intentId: intent.id, cms: sign(intent.bytes, person, cert) });
  };
  const bindBoth = async () => { await enrollment(); await enrollment(actors[1], 'buyer', C2); };
  const action = async (dealId, name) => {
    const actorId = ['agree', 'accept'].includes(name) ? actors[1] : actors[0];
    const intent = store.createActionIntent(actorId, dealId, SESSION, request(actorId, dealId, name));
    const cms = sign(intent.bytes, actorId === actors[0] ? 'seller' : 'buyer', actorId === actors[0] ? C1 : C2);
    return { intent, cms, result: await store.submit(actorId, SESSION, { intentId: intent.id, cms }) };
  };
  return { db, actors, sdk, store, open, state, atomic, createDeal, readDeal, rawDeal, writeDeal, calculate,
    request, enrollment, bindBoth, action, get calls() { return calls; }, get commitCalls() { return commitCalls; },
    get time() { return time; }, set time(value) { time = value; }, set verificationHook(value) { verificationHook = value; },
    set commitHook(value) { commitHook = value; } };
}
const rejection = code => error => error instanceof ParticipantSignatureError && error.code === code;

test('explicit enrollment pins account/session/TEST purpose and never exposes identity or authenticates login', async t => {
  const f = fixture(t), [seller, buyer] = f.actors;
  assert.equal(f.store.getBinding(seller), null);
  const intent = f.store.createEnrollmentIntent(seller, SESSION), parsed = JSON.parse(intent.bytes);
  assert.equal(parsed.domain, PARTICIPANT_SIGNATURE_DOMAIN);
  assert.equal(parsed.purpose, 'TEST'); assert.equal(parsed.statement, PARTICIPANT_SIGNATURE_STATEMENT);
  assert.equal(parsed.nonce, intent.id); assert.equal(parsed.actorId, seller); assert.equal(parsed.sessionHash, SESSION);
  assert.equal(parsed.expiresAt, parsed.issuedAt + 300_000); assert.equal(intent.hash, hash(intent.bytes));
  assert.deepEqual([parsed.binding, parsed.snapshot, parsed.request, parsed.operation], [null, null, null, null]);
  assert.ok(intent.bytes.equals(Buffer.from(JSON.stringify(parsed, null, 2) + '\n')));
  const baseline = f.state();
  await assert.rejects(f.store.submit(buyer, SESSION, { intentId: intent.id, cms: sign(intent.bytes) }), rejection('signature_intent_not_found'));
  await assert.rejects(f.store.submit(seller, OTHER_SESSION, { intentId: intent.id, cms: sign(intent.bytes) }), rejection('signature_intent_not_found'));
  await assert.rejects(f.store.submit(seller, SESSION, { intentId: intent.id, cms: sign(Buffer.from('different bytes')) }), rejection('signature_rejected'));
  assert.equal(f.state(), baseline);
  const accepted = await f.store.submit(seller, SESSION, { intentId: intent.id, cms: sign(intent.bytes) });
  assert.deepEqual(Object.keys(accepted.receipt), RECEIPT_FIELDS);
  assert.deepEqual(Object.keys(f.store.getBinding(seller)), ['bindingId', 'certificateDigest', 'authEpoch', 'scope']);
  assert.equal(accepted.receipt.dealId, null); assert.equal(accepted.receipt.scope, SCOPE);
  assert.doesNotMatch(JSON.stringify(accepted), /personId|organizationId|sessionHash|mapping_key|cms|walletAddress/);
  const row = f.db.prepare('SELECT * FROM participant_signature_bindings WHERE actor_id=?').get(seller);
  assert.match(row.person_id, /^person:[a-f0-9]{64}$/);
  assert.equal(f.db.prepare('SELECT mapping_key FROM participant_signature_meta').get().mapping_key.length, 32);
});

test('same person or certificate cannot bind another account; corporate/malformed/changed/foreign identity refuses without writes', async t => {
  const f = fixture(t), [seller, buyer] = f.actors;
  const enrolled = await f.enrollment();
  const attempts = [
    [buyer, 'seller', C2, null, 'signature_person_already_bound'],
    [buyer, 'buyer', C1, null, 'signature_certificate_already_bound'],
    [buyer, 'buyer', C2, 'organization:test', 'signature_organization_disabled'],
    [seller, 'seller', C3, null, 'signature_renewal_required'],
    [seller, 'other', C1, null, 'signature_identity_mismatch'],
  ];
  for (const [actorId, person, cert, organization, code] of attempts) {
    const intent = f.store.createEnrollmentIntent(actorId, SESSION), baseline = f.state();
    await assert.rejects(f.store.submit(actorId, SESSION, { intentId: intent.id, cms: sign(intent.bytes, person, cert, organization) }), rejection(code));
    assert.equal(f.state(), baseline);
  }
  const again = await f.enrollment();
  assert.equal(again.receipt.bindingId, enrolled.receipt.bindingId);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM participant_signature_bindings').get().n, 1);
  const intent = f.store.createEnrollmentIntent(buyer, SESSION), baseline = f.state();
  f.verificationHook = async () => ({ verified: true, certificateDigest: C2, validUntil: f.time + 1000, statusSource: 'test_ocsp',
    identity: { schema: 'nca_test_subject_v1', personId: 'raw-person-id', organizationId: null } });
  await assert.rejects(f.store.submit(buyer, SESSION, { intentId: intent.id, cms: sign(intent.bytes) }), rejection('signature_identity_rejected'));
  assert.equal(f.state(), baseline);
});

test('both distinct bindings and correct actor role/state required before issuing action', async t => {
  const f = fixture(t), dealId = f.createDeal(), [seller, buyer] = f.actors;
  const noBindings = f.state();
  assert.throws(() => f.store.createActionIntent(seller, dealId, SESSION, f.request(seller, dealId, 'offer')), rejection('signature_binding_required'));
  assert.equal(f.state(), noBindings);
  await f.enrollment();
  assert.throws(() => f.store.createActionIntent(seller, dealId, SESSION, f.request(seller, dealId, 'offer')), rejection('signature_binding_required'));
  await f.enrollment(buyer, 'buyer', C2);
  const baseline = f.state();
  assert.throws(() => f.store.createActionIntent(buyer, dealId, SESSION, f.request(buyer, dealId, 'offer')), rejection('signature_forbidden'));
  assert.throws(() => f.store.createActionIntent(seller, dealId, SESSION, f.request(seller, dealId, 'handover')), rejection('signature_state_conflict'));
  assert.equal(f.state(), baseline);
});

test('four signed TEST commands consume exact snapshot once and event authorization validates accepted CMS receipt+MAC', async t => {
  const f = fixture(t); await f.bindBoth(); const dealId = f.createDeal();
  for (const name of ['offer', 'agree', 'handover', 'accept']) {
    const { intent, cms, result } = await f.action(dealId, name), parsed = JSON.parse(intent.bytes);
    assert.equal(result.historical, false); assert.equal(result.receipt.action, name);
    assert.deepEqual(Object.keys(result.receipt), RECEIPT_FIELDS);
    assert.equal(parsed.snapshot.documents.length, 1);
    assert.deepEqual(Object.keys(parsed.snapshot.documents[0]), ['id', 'dealId', 'termsVersion', 'category', 'byteLength', 'sha256', 'createdAt', 'scope', 'fileKind']);
    assert.deepEqual(parsed.snapshot.participants.map(row => row.certificateDigest).sort(), [C1, C2]);
    assert.equal(parsed.request.expectedStateRevision + 1, result.event.stateRevision);
    assert.deepEqual(f.store.validateEvent(result.event), result.event);
    assert.deepEqual(result.event.authorization, { receiptId: result.receipt.id, intentHash: intent.hash,
      certificateDigest: result.receipt.certificateDigest, bindingId: result.receipt.bindingId, authEpoch: 0, statusSource: 'test_ocsp' });
    const calls = f.calls, writes = f.commitCalls;
    assert.deepEqual(await f.store.submit(result.receipt.actorId, SESSION, { intentId: intent.id, cms }), { receipt: result.receipt, historical: true, event: result.event });
    assert.equal(f.calls, calls); assert.equal(f.commitCalls, writes);
    const forged = structuredClone(result.event); forged.authorization.intentHash = 'f'.repeat(64);
    assert.throws(() => f.store.validateEvent(forged), rejection('signature_receipt_changed'));
  }
  assert.equal(f.readDeal(f.actors[0], dealId).state, 'accepted'); assert.equal(f.commitCalls, 4);
});

test('exact accepted CMS retry persists after restart/status/intent expiry; altered CMS/session/persisted bytes refuse', async t => {
  const f = fixture(t); await f.bindBoth(); const dealId = f.createDeal();
  const { intent, cms, result } = await f.action(dealId, 'offer');
  f.time += 400_000; f.store.close();
  const reopened = f.open({ sdk: { ...f.sdk, verifyIdentity() { throw new Error('must not reverify historical receipt'); } } });
  const before = f.state();
  assert.deepEqual(await reopened.submit(f.actors[0], SESSION, { intentId: intent.id, cms }), { receipt: result.receipt, historical: true, event: result.event });
  await assert.rejects(reopened.submit(f.actors[0], SESSION, { intentId: intent.id, cms: Buffer.concat([cms, Buffer.from('altered')]) }), rejection('signature_replay_conflict'));
  await assert.rejects(reopened.submit(f.actors[0], OTHER_SESSION, { intentId: intent.id, cms }), rejection('signature_intent_not_found'));
  assert.equal(f.state(), before);
  const original = f.db.prepare('SELECT bytes FROM participant_signature_intents WHERE id=?').get(intent.id).bytes;
  f.db.prepare('UPDATE participant_signature_intents SET bytes=? WHERE id=?').run(Buffer.concat([Buffer.from(original), Buffer.from(' ')]), intent.id);
  await assert.rejects(reopened.submit(f.actors[0], SESSION, { intentId: intent.id, cms }), rejection('signature_intent_changed'));
});

test('fresh foreign signer and stale full manifest during await refuse atomically', async t => {
  const f = fixture(t); await f.bindBoth(); const dealId = f.createDeal(), [seller] = f.actors;
  const intent = f.store.createActionIntent(seller, dealId, SESSION, f.request(seller, dealId, 'offer'));
  const baseline = f.state();
  await assert.rejects(f.store.submit(seller, SESSION, { intentId: intent.id, cms: sign(intent.bytes, 'buyer', C2) }), rejection('signature_identity_mismatch'));
  assert.equal(f.state(), baseline);
  const gate = deferred(), started = deferred();
  f.verificationHook = async (bytes, cms, key) => {
    started.resolve(); await gate.promise;
    return { verified: true, certificateDigest: C1, validUntil: f.time + 1000, statusSource: 'test_ocsp',
      identity: { schema: 'nca_test_subject_v1', personId: 'person:' + createHmac('sha256', key).update('seller').digest('hex'), organizationId: null } };
  };
  const pending = f.store.submit(seller, SESSION, { intentId: intent.id, cms: sign(intent.bytes) });
  await started.promise;
  assert.throws(() => f.store.close(), rejection('verification_in_progress'));
  const changed = f.rawDeal(dealId); changed.documents[0].category = 'quality'; f.writeDeal(f.calculate(changed));
  const staleState = f.state(); gate.resolve();
  await assert.rejects(pending, rejection('signature_snapshot_stale')); assert.equal(f.state(), staleState);
  assert.equal(f.commitCalls, 0);
});

test('both binding integrity, actor role and state revision are rechecked after verifier await', async t => {
  for (const mode of ['binding', 'role', 'state']) {
    const f = fixture(t); await f.bindBoth(); const dealId = f.createDeal(), [seller, buyer] = f.actors;
    const intent = f.store.createActionIntent(seller, dealId, SESSION, f.request(seller, dealId, 'offer'));
    const gate = deferred(), started = deferred();
    f.verificationHook = async (bytes, cms, key) => {
      started.resolve(); await gate.promise;
      return { verified: true, certificateDigest: C1, validUntil: f.time + 1000, statusSource: 'test_ocsp',
        identity: { schema: 'nca_test_subject_v1', personId: 'person:' + createHmac('sha256', key).update('seller').digest('hex'), organizationId: null } };
    };
    const pending = f.store.submit(seller, SESSION, { intentId: intent.id, cms: sign(intent.bytes) });
    await started.promise;
    if (mode === 'binding') f.db.prepare('UPDATE participant_signature_bindings SET certificate_digest=? WHERE actor_id=?').run(C3, buyer);
    else {
      const changed = f.rawDeal(dealId);
      if (mode === 'role') changed.participants.forEach(row => { row.role = row.role === 'seller' ? 'buyer' : 'seller'; });
      else changed.stateRevision++;
      f.writeDeal(f.calculate(changed));
    }
    const baseline = f.state(); gate.resolve();
    await assert.rejects(pending, rejection(mode === 'binding' ? 'signature_binding_changed' : mode === 'role' ? 'signature_snapshot_stale' : 'signature_state_changed'));
    assert.equal(f.state(), baseline); assert.equal(f.commitCalls, 0);
  }
});

test('live session expiry during await, expired OCSP and intent expiry are rejected without receipt or event', async t => {
  for (const mode of ['session', 'status', 'intent']) {
    const f = fixture(t); await f.bindBoth(); const dealId = f.createDeal(), [seller] = f.actors;
    const intent = f.store.createActionIntent(seller, dealId, SESSION, f.request(seller, dealId, 'offer'));
    const gate = deferred(), started = deferred(); let live = true;
    f.verificationHook = async (bytes, cms, key) => {
      started.resolve(); await gate.promise;
      return { verified: true, certificateDigest: C1, validUntil: mode === 'status' ? f.time : f.time + 1000,
        statusSource: 'test_ocsp', identity: { schema: 'nca_test_subject_v1',
          personId: 'person:' + createHmac('sha256', key).update('seller').digest('hex'), organizationId: null } };
    };
    const pending = f.store.submit(seller, SESSION, { intentId: intent.id, cms: sign(intent.bytes) },
      { assertCurrent() { if (!live) throw new Error('session_expired'); } });
    await started.promise;
    if (mode === 'session') live = false;
    if (mode === 'intent') f.time = intent.expiresAt;
    const baseline = f.state(); gate.resolve();
    await assert.rejects(pending, mode === 'session' ? /session_expired/ : rejection(`signature_${mode}_expired`));
    assert.equal(f.state(), baseline);
  }
});

test('final outer COMMIT repeats time/session/current manifest checks and rolls back action plus receipt together', async t => {
  for (const mode of ['session', 'status', 'intent', 'manifest']) {
    const f = fixture(t); await f.bindBoth(); const dealId = f.createDeal(), [seller] = f.actors;
    const intent = f.store.createActionIntent(seller, dealId, SESSION, f.request(seller, dealId, 'offer'));
    const baseline = f.state(); let triggered = false;
    const options = { assertCurrent() {
      const accepted = f.db.prepare('SELECT receipt_json FROM participant_signature_intents WHERE id=?').get(intent.id)?.receipt_json;
      if (accepted && !triggered) {
        triggered = true;
        if (mode === 'session') throw new Error('session_closed_before_commit');
        if (mode === 'intent') f.time = intent.expiresAt;
        if (mode === 'status') f.time = JSON.parse(accepted).validUntil;
        if (mode === 'manifest') { const changed = f.rawDeal(dealId); changed.documents[0].byteLength++; f.writeDeal(f.calculate(changed)); }
      }
    } };
    await assert.rejects(f.store.submit(seller, SESSION, { intentId: intent.id, cms: sign(intent.bytes) }, options),
      mode === 'session' ? /session_closed_before_commit/ : rejection(mode === 'manifest' ? 'signature_state_changed' : `signature_${mode}_expired`));
    assert.equal(triggered, true); assert.equal(f.state(), baseline);
    assert.equal(f.readDeal(seller, dealId).state, 'draft');
  }
});

test('pending/accepted/binding/meta row tamper fails closed, missing metadata never provisions another key', async t => {
  for (const kind of ['pending', 'receipt', 'event', 'binding', 'meta']) {
    const f = fixture(t); await f.bindBoth(); const dealId = f.createDeal();
    const { intent, cms, result } = await f.action(dealId, 'offer');
    if (kind === 'pending') {
      const next = f.store.createEnrollmentIntent(f.actors[2], SESSION);
      f.db.prepare('UPDATE participant_signature_intents SET expires_at=expires_at+1 WHERE id=?').run(next.id);
      await assert.rejects(f.store.submit(f.actors[2], SESSION, { intentId: next.id, cms: sign(next.bytes, 'third', C3) }), rejection('signature_intent_changed'));
    } else if (kind === 'receipt') {
      f.db.prepare('UPDATE participant_signature_intents SET receipt_json=? WHERE id=?').run(JSON.stringify({ ...result.receipt, certificateDigest: C3 }), intent.id);
      await assert.rejects(f.store.submit(f.actors[0], SESSION, { intentId: intent.id, cms }), rejection('signature_receipt_changed'));
    } else if (kind === 'event') {
      f.db.prepare('UPDATE participant_signature_intents SET event_json=? WHERE id=?').run(JSON.stringify({ ...result.event, actorId: f.actors[1] }), intent.id);
      assert.throws(() => f.store.validateEvent(result.event), rejection('signature_receipt_changed'));
    } else if (kind === 'binding') {
      f.db.prepare('UPDATE participant_signature_bindings SET certificate_digest=? WHERE actor_id=?').run(C3, f.actors[0]);
      assert.throws(() => f.store.getBinding(f.actors[0]), rejection('signature_binding_changed'));
    } else {
      f.db.exec('DELETE FROM participant_signature_meta');
      assert.throws(() => f.open(), rejection('signature_state_changed'));
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM participant_signature_meta').get().n, 0);
    }
  }
});

test('deleting a protected binding never frees its person/certificate slot for another participant', async t => {
  const f = fixture(t); await f.bindBoth(); const [seller, , third] = f.actors;
  const intent = f.store.createEnrollmentIntent(third, SESSION);
  f.db.prepare('DELETE FROM participant_signature_bindings WHERE actor_id=?').run(seller);
  const baseline = f.state();
  await assert.rejects(f.store.submit(third, SESSION, { intentId: intent.id, cms: sign(intent.bytes) }), rejection('signature_binding_changed'));
  assert.throws(() => f.store.createEnrollmentIntent(third, SESSION), rejection('signature_binding_changed'));
  assert.throws(() => f.open(), rejection('signature_binding_changed'));
  assert.equal(f.state(), baseline);
  assert.equal(f.db.prepare('SELECT actor_id FROM participant_signature_bindings WHERE actor_id=?').get(third), undefined);
});

test('fresh callback that returns old authorization or historical request never relabels an old signed event', async t => {
  for (const mode of ['authorization', 'historical']) {
    const f = fixture(t); await f.bindBoth(); const dealId = f.createDeal(), [seller] = f.actors;
    const intent = f.store.createActionIntent(seller, dealId, SESSION, f.request(seller, dealId, 'offer')), baseline = f.state();
    f.commitHook = result => mode === 'historical' ? { ...result, historical: true } :
      { event: { ...result.event, authorization: { ...result.event.authorization, receiptId: randomUUID() } } };
    await assert.rejects(f.store.submit(seller, SESSION, { intentId: intent.id, cms: sign(intent.bytes) }),
      rejection(mode === 'historical' ? 'signature_replay_conflict' : 'signature_receipt_changed'));
    assert.equal(f.state(), baseline);
  }
});

test('operator fixed devnet Memo intent needs terminal signed acceptance and fresh current exact operation', async t => {
  const f = fixture(t); await f.bindBoth(); const dealId = f.createDeal(), [seller] = f.actors;
  assert.throws(() => f.store.createAnchorIntent(seller, dealId, SESSION, f.request(seller, dealId, 'anchor_test_memo')), rejection('signature_anchor_unavailable'));
  for (const name of ['offer', 'agree', 'handover', 'accept']) await f.action(dealId, name);
  const intent = f.store.createAnchorIntent(seller, dealId, SESSION, f.request(seller, dealId, 'anchor_test_memo'));
  const parsed = JSON.parse(intent.bytes), before = f.commitCalls;
  assert.equal(parsed.operation.cluster, 'devnet'); assert.equal(parsed.operation.walletAddress, WALLET);
  assert.equal(parsed.operation.maxFeeLamports, '10000');
  assert.equal(parsed.operation.memo, `DalaHold TEST v1 ${parsed.snapshot.snapshotHash} ${parsed.snapshot.terminalEventId}`);
  const result = await f.store.submit(seller, SESSION, { intentId: intent.id, cms: sign(intent.bytes) });
  assert.equal(result.event, undefined); assert.equal(f.commitCalls, before);
  const authorization = f.store.readMemoAuthorization(seller, intent.id);
  assert.deepEqual(authorization.operation, parsed.operation); assert.deepEqual(authorization.receipt, result.receipt);
  assert.equal(authorization.expiresAt, parsed.expiresAt);
  assert.doesNotMatch(JSON.stringify(authorization), /personId|organizationId|sessionHash|mapping_key|cms|grant/);
  const changed = f.open({ memoConfiguration: { walletAddress: WALLET, maxFeeLamports: '9999' } });
  assert.throws(() => changed.readMemoAuthorization(seller, intent.id), rejection('signature_anchor_unavailable'));
  const pending = f.store.createAnchorIntent(seller, dealId, SESSION, f.request(seller, dealId, 'anchor_test_memo'));
  await assert.rejects(changed.submit(seller, SESSION, { intentId: pending.id, cms: sign(pending.bytes) }), rejection('signature_anchor_unavailable'));
  f.time = result.receipt.validUntil;
  assert.throws(() => f.store.readMemoAuthorization(seller, intent.id), rejection('signature_status_expired'));
});

test('limits persist across service instances and retries recover without new verifier slots or budget', async t => {
  const f = fixture(t), [seller, buyer, third] = f.actors;
  for (let i = 0; i < 100; i++) f.store.createEnrollmentIntent(seller, SESSION);
  const baseline = f.state(), another = f.open();
  assert.throws(() => another.createEnrollmentIntent(seller, SESSION), rejection('signature_pending_limit')); assert.equal(f.state(), baseline);
  f.time += 300_000;
  const intents = f.actors.map(actorId => f.store.createEnrollmentIntent(actorId, SESSION));
  const gate = deferred(), start = deferred(); let started = 0;
  f.verificationHook = async (bytes, cms, key) => {
    started++; if (started === 2) start.resolve(); await gate.promise;
    const value = JSON.parse(cms.toString());
    return { verified: true, certificateDigest: value.certificateDigest, validUntil: f.time + 1000, statusSource: 'test_ocsp',
      identity: { schema: 'nca_test_subject_v1', personId: 'person:' + createHmac('sha256', key).update(value.person).digest('hex'), organizationId: null } };
  };
  const first = f.store.submit(seller, SESSION, { intentId: intents[0].id, cms: sign(intents[0].bytes) });
  const second = another.submit(buyer, SESSION, { intentId: intents[1].id, cms: sign(intents[1].bytes, 'buyer', C2) });
  await start.promise;
  await assert.rejects(another.submit(third, SESSION, { intentId: intents[2].id, cms: sign(intents[2].bytes, 'third', C3) }), rejection('verifier_busy'));
  gate.resolve(); await Promise.all([first, second]);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM participant_signature_intents WHERE receipt_json IS NOT NULL').get().n, 2);
});

test('strict input rejects getters/proxies/extra wallet data and public inspection whitelists trusted readiness', async t => {
  const f = fixture(t), [seller] = f.actors;
  for (const request of [{ walletAddress: WALLET }, Object.defineProperty({}, 'certificateDigest', { enumerable: true, get() { throw new Error('getter executed'); } }), new Proxy({}, {})]) {
    assert.throws(() => f.store.createEnrollmentIntent(seller, SESSION, request), rejection('signature_request_invalid'));
  }
  const intent = f.store.createEnrollmentIntent(seller, SESSION), baseline = f.state();
  await assert.rejects(f.store.submit(seller, SESSION, { intentId: intent.id, cms: sign(intent.bytes), certificateDigest: C1 }), rejection('signature_request_invalid'));
  await assert.rejects(f.store.submit(seller, SESSION, { intentId: intent.id, cms: Buffer.alloc(98_305) }), rejection('signature_request_invalid'));
  await assert.rejects(f.store.submit(seller, SESSION, { intentId: intent.id, cms: sign(intent.bytes) }, { assertCurrent: () => false }), rejection('signature_guard_invalid'));
  assert.equal(f.state(), baseline);
  assert.deepEqual(Object.keys(await f.store.inspect()), ['ready', 'chain', 'validUntil', 'statusSource']);
  const bad = f.open({ sdk: { ...f.sdk, inspect: async () => ({ ready: true, chain: [PEM, PEM], validUntil: f.time, statusSource: 'test_ocsp' }) } });
  await assert.rejects(bad.inspect(), rejection('verifier_unavailable'));
});

test('500 accepted history ceiling persists across restart and exact recovery needs no new capacity', async t => {
  const f = fixture(t), [seller] = f.actors;
  const first = f.store.createEnrollmentIntent(seller, SESSION), cms = sign(first.bytes);
  const result = await f.store.submit(seller, SESSION, { intentId: first.id, cms });
  for (let index = 1; index < 500; index++) await f.enrollment();
  const reopened = f.open();
  const next = reopened.createEnrollmentIntent(seller, SESSION), baseline = f.state();
  await assert.rejects(reopened.submit(seller, SESSION, { intentId: next.id, cms: sign(next.bytes) }), rejection('signature_history_limit'));
  assert.equal(f.state(), baseline);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM participant_signature_intents WHERE receipt_json IS NOT NULL').get().n, 500);
  f.time += 400_000;
  const calls = f.calls;
  assert.deepEqual(await reopened.submit(seller, SESSION, { intentId: first.id, cms }), { receipt: result.receipt, historical: true });
  assert.equal(f.calls, calls);
});

test('16 MiB accepted private CMS ceiling is persistent and accepts exact boundary below next CMS', async t => {
  const f = fixture(t), [seller] = f.actors;
  let first;
  for (let index = 0; index < 170; index++) {
    const intent = f.store.createEnrollmentIntent(seller, SESSION), model = sign(intent.bytes);
    const cms = Buffer.concat([model, Buffer.alloc(98_304 - model.length, 0x20)]);
    const result = await f.store.submit(seller, SESSION, { intentId: intent.id, cms });
    if (!first) first = { intent, cms, result };
  }
  const reopened = f.open(), intent = reopened.createEnrollmentIntent(seller, SESSION), model = sign(intent.bytes);
  const cms = Buffer.concat([model, Buffer.alloc(98_304 - model.length, 0x20)]);
  const usage = () => f.db.prepare(`SELECT count(*) AS count,COALESCE(sum(length(cms)),0) AS bytes
    FROM participant_signature_intents WHERE receipt_json IS NOT NULL`).get();
  assert.deepEqual({ ...usage() }, { count: 170, bytes: 170 * 98_304 });
  await assert.rejects(reopened.submit(seller, SESSION, { intentId: intent.id, cms }), rejection('signature_history_limit'));
  assert.deepEqual({ ...usage() }, { count: 170, bytes: 170 * 98_304 });
  assert.equal(f.db.prepare('SELECT receipt_json FROM participant_signature_intents WHERE id=?').get(intent.id).receipt_json, null);
  const calls = f.calls;
  assert.deepEqual(await reopened.submit(seller, SESSION, { intentId: first.intent.id, cms: first.cms }),
    { receipt: first.result.receipt, historical: true });
  assert.equal(f.calls, calls);
  // The remaining exact byte capacity can still be accepted, and the next
  // nonempty CMS refuses even though the accepted row count is below 500.
  const remainder = 16 * 1024 * 1024 - usage().bytes;
  const smaller = Buffer.concat([model, Buffer.alloc(remainder - model.length, 0x20)]);
  await reopened.submit(seller, SESSION, { intentId: intent.id, cms: smaller });
  assert.equal(usage().bytes, 16 * 1024 * 1024);
  const last = reopened.createEnrollmentIntent(seller, SESSION);
  await assert.rejects(reopened.submit(seller, SESSION, { intentId: last.id, cms: sign(last.bytes) }), rejection('signature_history_limit'));
  assert.equal(usage().bytes, 16 * 1024 * 1024);
});
