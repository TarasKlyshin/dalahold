import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ParticipantStore, ParticipantStoreError, PARTICIPANT_INVITATION_LIFETIME_MS } from './participant-store.mjs';
import { TestDocumentError, TEST_DOCUMENT_MAX_BYTES } from './test-documents.mjs';
import { preparePrivateTestDatabase } from './private-test-store.mjs';

const base = { scenario: 'grain', quantity: 12, amount: 8400000, date: '2026-10-10' };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const error = (code, status) => (value) => value instanceof ParticipantStoreError && value.code === code && (status === undefined || value.status === status);
const documentError = (code) => (value) => value instanceof TestDocumentError && value.code === code;
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-participants-'));
  const dbPath = join(directory, 'private', 'participants.sqlite');
  let time = 1_000_000;
  let onNow = () => {};
  const now = () => { onNow(); return time; };
  let store = new ParticipantStore({ dbPath, now });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { dbPath, get store() { return store; }, now: () => time,
    advance: (amount) => { time += amount; },
    duringNow: (callback) => { onNow = callback; },
    restart: () => { store.close(); store = new ParticipantStore({ dbPath, now }); return store; } };
}
function create(store, actor, role = 'seller', changes = {}) {
  return store.createDeal(actor.id, { requestId: randomUUID(), creatorRole: role, ...base, ...changes });
}
function pair(store, creatorRole = 'seller') {
  const seller = store.register().participant, buyer = store.register().participant, outsider = store.register().participant;
  const creator = creatorRole === 'seller' ? seller : buyer;
  const target = creatorRole === 'seller' ? buyer : seller;
  const deal = create(store, creator, creatorRole);
  const invitation = store.createInvitation(creator.id, deal.id, { expectedVersion: 1, participantId: target.id });
  store.claimInvitation(target.id, { code: invitation.code });
  return { seller, buyer, outsider, deal: store.getDeal(seller.id, deal.id), invitation };
}
function input(deal, action, overrides = {}) {
  return { requestId: randomUUID(), action, expectedVersion: deal.version,
    expectedStateRevision: deal.stateRevision, snapshotHash: deal.snapshotHash, ...overrides };
}
function advance(store, actor, dealId, action) {
  return store.action(actor.id, dealId, input(store.getDeal(actor.id, dealId), action)).deal;
}
function document(store, actor, deal, changes = {}) {
  return store.addDocument(actor.id, deal.id, { requestId: randomUUID(), expectedVersion: deal.version,
    category: 'contract', bytes: Buffer.from('Unsigned local TEST text.\n'), ...changes });
}

test('private dedicated database stores only hashed high entropy access codes and authenticates after restart', (t) => {
  const f = fixture(t), registration = f.store.register();
  assert.match(registration.accessCode, /^[0-9a-f]{64}$/);
  assert.equal(f.store.authenticate(registration.accessCode).id, registration.participant.id);
  assert.deepEqual(f.store.participant(registration.participant.id), registration.participant);
  assert.equal(statSync(f.dbPath).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.dbPath, '..')).mode & 0o777, 0o700);
  assert.equal(readFileSync(f.dbPath).includes(Buffer.from(registration.accessCode)), false);
  const db = new DatabaseSync(f.dbPath);
  assert.equal(db.prepare('SELECT access_hash FROM participants').get().access_hash, sha256(registration.accessCode));
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
  db.close();
  f.restart();
  assert.deepEqual(f.store.authenticate(registration.accessCode), registration.participant);
  for (const code of [null, '', registration.accessCode.toUpperCase(), '0'.repeat(64), { toString: () => registration.accessCode }]) {
    assert.throws(() => f.store.authenticate(code), error('unauthorized', 401));
  }
});

test('refuses a prior demo or personal database without adding participant schema', (t) => {
  const f = fixture(t); f.store.close();
  const oldPath = join(f.dbPath, '..', 'personal.sqlite');
  const db = new DatabaseSync(preparePrivateTestDatabase(oldPath)); db.exec('CREATE TABLE private_identity(id TEXT)'); db.close();
  assert.throws(() => new ParticipantStore({ dbPath: oldPath }), error('incompatible_store', 409));
  const check = new DatabaseSync(oldPath);
  assert.deepEqual(check.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(({ name }) => name), ['private_identity']);
  check.close();
});

test('recipient-bound invitations reject self, stolen codes, rotation and expiry; claims are single use with own historical retry', (t) => {
  const f = fixture(t), creator = f.store.register().participant, target = f.store.register().participant, thief = f.store.register().participant;
  const deal = create(f.store, creator);
  assert.throws(() => f.store.createInvitation(creator.id, deal.id, { expectedVersion: 1, participantId: creator.id }), error('forbidden', 403));
  assert.throws(() => f.store.createInvitation(creator.id, deal.id, { expectedVersion: 1, participantId: target.id, role: 'seller' }), error('invalid_request', 400));
  const old = f.store.createInvitation(creator.id, deal.id, { expectedVersion: 1, participantId: target.id });
  assert.throws(() => f.store.claimInvitation(thief.id, { code: old.code }), error('not_found', 404));
  assert.throws(() => f.store.claimInvitation(creator.id, { code: old.code }), error('not_found', 404));
  const expired = f.store.createInvitation(creator.id, deal.id, { expectedVersion: 1, participantId: target.id });
  assert.throws(() => f.store.claimInvitation(target.id, { code: old.code }), error('not_found'));
  f.advance(PARTICIPANT_INVITATION_LIFETIME_MS);
  assert.throws(() => f.store.claimInvitation(target.id, { code: expired.code }), error('not_found'));
  const invitation = f.store.createInvitation(creator.id, deal.id, { expectedVersion: 1, participantId: target.id });
  assert.equal(invitation.expiresAt, f.now() + PARTICIPANT_INVITATION_LIFETIME_MS);
  assert.equal(readFileSync(f.dbPath).includes(Buffer.from(invitation.code)), false);
  assert.deepEqual(f.store.claimInvitation(target.id, { code: invitation.code }), { dealId: deal.id, historical: false });
  f.advance(PARTICIPANT_INVITATION_LIFETIME_MS);
  assert.deepEqual(f.store.claimInvitation(target.id, { code: invitation.code }), { dealId: deal.id, historical: true });
  assert.throws(() => f.store.claimInvitation(thief.id, { code: invitation.code }), error('not_found'));
  assert.throws(() => f.store.createInvitation(creator.id, deal.id, { expectedVersion: 1, participantId: thief.id }), error('state_conflict'));
  const joined = f.store.getDeal(target.id, deal.id);
  assert.equal(joined.role, 'buyer'); assert.equal(joined.participants.length, 2);
  assert.notEqual(joined.snapshotHash, deal.snapshotHash);
  f.restart();
  assert.deepEqual(f.store.claimInvitation(target.id, { code: invitation.code }), { dealId: deal.id, historical: true });
});

test('every deal/document operation authenticates and hides another participant deal', (t) => {
  const { store } = fixture(t), { seller, outsider, deal } = pair(store);
  const doc = document(store, seller, deal);
  assert.deepEqual(store.listDeals(outsider.id), []);
  const revise = { requestId: randomUUID(), expectedVersion: 1, ...base };
  const upload = { requestId: randomUUID(), expectedVersion: 1, category: 'other', bytes: Buffer.from('TEST') };
  const calls = (actorId) => [
    () => store.getDeal(actorId, deal.id), () => store.listDocuments(actorId, deal.id),
    () => store.readDocument(actorId, deal.id, doc.id), () => store.addDocument(actorId, deal.id, upload),
    () => store.reviseDeal(actorId, deal.id, revise), () => store.action(actorId, deal.id, input(deal, 'offer')),
    () => store.createInvitation(actorId, deal.id, { expectedVersion: 1, participantId: seller.id }),
  ];
  for (const call of calls(outsider.id)) assert.throws(call, error('not_found', 404));
  for (const call of calls(randomUUID())) assert.throws(call, error('unauthorized', 401));
  assert.throws(() => store.listDeals(randomUUID()), error('unauthorized'));
  assert.throws(() => store.createDeal(randomUUID(), {}), error('unauthorized'));
  assert.throws(() => store.claimInvitation(randomUUID(), {}), error('unauthorized'));
  assert.equal(store.listDeals(seller.id).length, 1);
  assert.throws(() => store.readDocument(outsider.id, deal.id, randomUUID()), error('not_found'));
});

test('each deal has its own assigned roles, including a buyer-created deal', (t) => {
  const { store } = fixture(t), { seller, buyer, deal: first } = pair(store);
  const second = create(store, seller, 'buyer');
  const invitation = store.createInvitation(seller.id, second.id, { expectedVersion: 1, participantId: buyer.id });
  store.claimInvitation(buyer.id, { code: invitation.code });
  assert.equal(store.getDeal(seller.id, first.id).role, 'seller');
  assert.equal(store.getDeal(seller.id, second.id).role, 'buyer');
  assert.equal(store.getDeal(buyer.id, second.id).role, 'seller');
  assert.throws(() => store.reviseDeal(seller.id, second.id, { requestId: randomUUID(), expectedVersion: 1, ...base }), error('forbidden'));
  assert.throws(() => store.action(seller.id, second.id, input(store.getDeal(seller.id, second.id), 'offer')), error('forbidden'));
  assert.equal(advance(store, buyer, second.id, 'offer').state, 'offered');
  assert.equal(advance(store, seller, second.id, 'agree').state, 'agreed');
});

test('strict input rejects client actor/role injection, coercion, accessors and invalid dates with no partial writes', (t) => {
  const { store } = fixture(t), { seller, deal } = pair(store);
  for (const changes of [{ role: 'buyer' }, { actorId: randomUUID() }, { quantity: '12' }, { amount: 0 },
    { date: '2026-02-30' }, { scenario: 'money' }, { requestId: randomUUID().toUpperCase() }, { creatorRole: 'admin' }]) {
    assert.throws(() => store.createDeal(seller.id, { requestId: randomUUID(), creatorRole: 'seller', ...base, ...changes }), error('invalid_request'));
  }
  for (const changes of [{ role: 'seller' }, { actorId: seller.id }, { action: 'release' }, { expectedVersion: '1' },
    { expectedStateRevision: -1 }, { snapshotHash: 'bad' }]) {
    assert.throws(() => store.action(seller.id, deal.id, input(deal, 'offer', changes)), error('invalid_request'));
  }
  let getterCalls = 0;
  const malformed = input(deal, 'offer');
  Object.defineProperty(malformed, 'action', { enumerable: true, get() { getterCalls++; return 'offer'; } });
  assert.throws(() => store.action(seller.id, deal.id, malformed), error('invalid_request'));
  assert.equal(getterCalls, 0);
  assert.throws(() => store.action(seller.id, deal.id, new Proxy(input(deal, 'offer'), {})), error('invalid_request'));
  assert.equal(store.getDeal(seller.id, deal.id).state, 'draft');
  assert.equal(store.listDeals(seller.id).length, 1);
});

test('snapshot detects party/manifest changes and stale terms, and offer freezes terms, documents and parties', (t) => {
  const { store } = fixture(t), { seller, buyer, outsider, deal } = pair(store);
  const staleManifest = input(deal, 'offer');
  const doc = document(store, buyer, deal);
  const withDoc = store.getDeal(seller.id, deal.id);
  assert.notEqual(withDoc.snapshotHash, deal.snapshotHash);
  assert.throws(() => store.action(seller.id, deal.id, staleManifest), error('snapshot_mismatch'));
  assert.throws(() => store.action(seller.id, deal.id, input(withDoc, 'offer', { snapshotHash: '0'.repeat(64) })), error('snapshot_mismatch'));
  const reviseInput = { requestId: randomUUID(), expectedVersion: 1, ...base, quantity: 13 };
  const revised = store.reviseDeal(seller.id, deal.id, reviseInput);
  assert.equal(revised.version, 2); assert.equal(revised.documents.length, 0);
  assert.deepEqual(revised.documentHistory, [doc]);
  assert.deepEqual(store.readDocument(buyer.id, deal.id, doc.id).document, doc);
  assert.throws(() => store.action(seller.id, deal.id, input(withDoc, 'offer')), error('stale_deal'));
  assert.throws(() => document(store, seller, revised, { expectedVersion: 1 }), error('stale_deal'));
  const offered = advance(store, seller, deal.id, 'offer');
  assert.equal(offered.version, 2); assert.equal(offered.state, 'offered');
  assert.throws(() => store.reviseDeal(seller.id, deal.id, { requestId: randomUUID(), expectedVersion: 2, ...base }), error('state_conflict'));
  assert.throws(() => document(store, buyer, offered), error('state_conflict'));
  assert.throws(() => store.createInvitation(seller.id, deal.id, { expectedVersion: 2, participantId: outsider.id }), error('state_conflict'));
  assert.deepEqual(store.reviseDeal(seller.id, deal.id, reviseInput), { ...revised, historical: true });
  assert.equal(store.getDeal(buyer.id, deal.id).snapshotHash, offered.snapshotHash);
});

test('role and order policy requires two distinct participants and has accepted/disputed terminal states', (t) => {
  const { store } = fixture(t), alone = store.register().participant, solitary = create(store, alone);
  assert.throws(() => store.action(alone.id, solitary.id, input(solitary, 'offer')), error('state_conflict'));
  const { seller, buyer, deal } = pair(store);
  assert.throws(() => store.action(buyer.id, deal.id, input(deal, 'offer')), error('forbidden'));
  assert.throws(() => store.action(seller.id, deal.id, input(deal, 'handover')), error('state_conflict'));
  assert.throws(() => store.action(buyer.id, deal.id, input(deal, 'dispute')), error('state_conflict'));
  const offered = advance(store, seller, deal.id, 'offer');
  assert.throws(() => store.action(seller.id, deal.id, input(offered, 'agree')), error('forbidden'));
  assert.throws(() => store.action(buyer.id, deal.id, input(offered, 'accept')), error('state_conflict'));
  advance(store, buyer, deal.id, 'agree');
  const handed = advance(store, seller, deal.id, 'handover');
  const accepted = advance(store, buyer, deal.id, 'accept');
  assert.equal(accepted.state, 'accepted'); assert.equal(accepted.stateRevision, 4);
  assert.throws(() => store.action(seller.id, deal.id, input(accepted, 'dispute')), error('state_conflict'));
  assert.equal(handed.snapshotHash, accepted.snapshotHash);
  const second = pair(store); advance(store, second.seller, second.deal.id, 'offer');
  advance(store, second.buyer, second.deal.id, 'agree');
  const disputed = advance(store, second.buyer, second.deal.id, 'dispute');
  assert.equal(disputed.state, 'disputed');
  assert.throws(() => store.action(second.seller.id, second.deal.id, input(disputed, 'handover')), error('state_conflict'));
  const third = pair(store); advance(store, third.seller, third.deal.id, 'offer');
  advance(store, third.buyer, third.deal.id, 'agree'); advance(store, third.seller, third.deal.id, 'handover');
  assert.equal(advance(store, third.seller, third.deal.id, 'dispute').state, 'disputed');
});

test('exact actor-bound retries survive later states and restart, while changed or cross-actor payloads conflict', (t) => {
  const f = fixture(t), { seller, buyer, deal } = pair(f.store);
  const actionInput = input(deal, 'offer');
  const original = f.store.action(seller.id, deal.id, actionInput);
  assert.equal(original.historical, false);
  assert.equal(original.event.source, 'unsigned_test_participant_statement');
  assert.equal(original.event.role, 'seller');
  assert.equal(original.event.termsFingerprint, deal.termsFingerprint);
  assert.equal(original.event.documentManifestHash, sha256('[]'));
  advance(f.store, buyer, deal.id, 'agree');
  assert.throws(() => f.store.action(buyer.id, deal.id, actionInput), error('idempotency_conflict'));
  assert.throws(() => f.store.action(seller.id, deal.id, { ...actionInput, snapshotHash: 'f'.repeat(64) }), error('idempotency_conflict'));
  assert.throws(() => f.store.action(seller.id, deal.id, { ...actionInput, action: 'handover' }), error('idempotency_conflict'));
  assert.throws(() => f.store.action(seller.id, deal.id, input(deal, 'handover')), error('state_conflict'));
  f.restart();
  const historical = f.store.action(seller.id, deal.id, actionInput);
  assert.equal(historical.historical, true); assert.deepEqual(historical.event, original.event);
  assert.equal(historical.deal.state, 'agreed'); assert.equal(historical.deal.events.length, 2);
  const representation = JSON.stringify(historical.deal);
  assert.equal(/accessCode|access_hash|token_hash|claimed_by/.test(representation), false);
});

test('create, revision and document request IDs are global and actor-bound with exact historical receipts', (t) => {
  const f = fixture(t), seller = f.store.register().participant, buyer = f.store.register().participant;
  const createInput = { requestId: randomUUID(), creatorRole: 'seller', ...base };
  const deal = f.store.createDeal(seller.id, createInput);
  assert.equal(f.store.createDeal(seller.id, createInput).id, deal.id);
  assert.throws(() => f.store.createDeal(buyer.id, createInput), error('idempotency_conflict'));
  assert.throws(() => f.store.createDeal(seller.id, { ...createInput, quantity: 13 }), error('idempotency_conflict'));
  const invite = f.store.createInvitation(seller.id, deal.id, { expectedVersion: 1, participantId: buyer.id });
  f.store.claimInvitation(buyer.id, { code: invite.code });
  const upload = { requestId: randomUUID(), expectedVersion: 1, category: 'quality', bytes: Buffer.from('TEST quality sample') };
  const doc = f.store.addDocument(buyer.id, deal.id, upload);
  assert.throws(() => f.store.addDocument(seller.id, deal.id, upload), error('idempotency_conflict'));
  assert.throws(() => f.store.addDocument(buyer.id, deal.id, { ...upload, bytes: Buffer.from('TEST quality change') }), error('idempotency_conflict'));
  const revision = { requestId: randomUUID(), expectedVersion: 1, ...base, quantity: 14 };
  const revised = f.store.reviseDeal(seller.id, deal.id, revision);
  assert.throws(() => f.store.reviseDeal(buyer.id, deal.id, revision), error('idempotency_conflict'));
  assert.throws(() => f.store.reviseDeal(seller.id, deal.id, { ...revision, quantity: 15 }), error('idempotency_conflict'));
  advance(f.store, seller, deal.id, 'offer'); f.restart();
  assert.deepEqual(f.store.addDocument(buyer.id, deal.id, upload), doc);
  assert.deepEqual(f.store.reviseDeal(seller.id, deal.id, revision), { ...revised, historical: true });
  assert.equal(f.store.createDeal(seller.id, createInput).state, 'offered');
  assert.equal(f.store.getDeal(seller.id, deal.id).documentHistory.length, 1);
});

test('unchanged draft terms keep the version and manifest while retaining an actor-bound retry receipt', (t) => {
  const f = fixture(t), { seller, buyer, deal } = pair(f.store);
  document(f.store, buyer, deal);
  const current = f.store.getDeal(seller.id, deal.id), revise = { requestId: randomUUID(), expectedVersion: 1, ...base };
  const unchanged = f.store.reviseDeal(seller.id, deal.id, revise);
  assert.equal(unchanged.unchanged, true); assert.equal(unchanged.version, 1);
  assert.equal(unchanged.snapshotHash, current.snapshotHash); assert.deepEqual(unchanged.documents, current.documents);
  assert.throws(() => f.store.reviseDeal(buyer.id, deal.id, revise), error('idempotency_conflict'));
  assert.throws(() => f.store.reviseDeal(seller.id, deal.id, { ...revise, quantity: 13 }), error('idempotency_conflict'));
  f.restart();
  assert.deepEqual(f.store.reviseDeal(seller.id, deal.id, revise), { ...unchanged, historical: true });
  advance(f.store, seller, deal.id, 'offer');
  assert.throws(() => f.store.reviseDeal(seller.id, deal.id, { ...revise, requestId: randomUUID() }), error('state_conflict'));
});

test('downloaded document is a copied buffer whose byte length and digest match metadata; corruption fails closed', (t) => {
  const f = fixture(t), { seller, buyer, deal } = pair(f.store), original = Buffer.from('TEST документ\n');
  const doc = document(f.store, seller, deal, { bytes: original });
  original.fill(0);
  const read = f.store.readDocument(buyer.id, deal.id, doc.id);
  assert.equal(read.bytes.length, doc.byteLength); assert.equal(sha256(read.bytes), doc.sha256);
  const expected = Buffer.from(read.bytes); read.bytes.fill(0);
  assert.deepEqual(f.store.readDocument(buyer.id, deal.id, doc.id).bytes, expected);
  const db = new DatabaseSync(f.dbPath);
  db.prepare('UPDATE test_documents SET bytes = ? WHERE id = ?').run(Buffer.alloc(doc.byteLength, 120), doc.id); db.close();
  assert.throws(() => f.store.readDocument(seller.id, deal.id, doc.id), documentError('document_corrupt'));
  assert.throws(() => f.store.listDocuments(buyer.id, deal.id), documentError('document_corrupt'));
  assert.throws(() => f.store.getDeal(seller.id, deal.id), documentError('document_corrupt'));
  assert.throws(() => f.store.action(seller.id, deal.id, input(deal, 'offer')), documentError('document_corrupt'));
});

test('valid-byte replacement after offer still fails against the immutable offered snapshot', (t) => {
  const f = fixture(t), { seller, buyer, deal } = pair(f.store), doc = document(f.store, seller, deal);
  advance(f.store, seller, deal.id, 'offer');
  const altered = Buffer.alloc(doc.byteLength, 120), db = new DatabaseSync(f.dbPath);
  db.prepare('UPDATE test_documents SET bytes = ?, sha256 = ? WHERE id = ?').run(altered, sha256(altered), doc.id); db.close();
  assert.throws(() => f.store.getDeal(seller.id, deal.id), error('store_corrupt'));
  assert.throws(() => f.store.readDocument(buyer.id, deal.id, doc.id), error('store_corrupt'));
});

test('participant and per-participant deal quotas are bounded and preserve retries', (t) => {
  const { store } = fixture(t), first = store.register().participant;
  for (let i = 1; i < 100; i++) store.register();
  assert.throws(() => store.register(), error('participant_limit', 413));
  const firstInput = { requestId: randomUUID(), creatorRole: 'seller', ...base };
  const firstDeal = store.createDeal(first.id, firstInput);
  for (let i = 1; i < 100; i++) create(store, first);
  assert.equal(store.listDeals(first.id).length, 100);
  assert.throws(() => create(store, first), error('deal_limit', 413));
  assert.equal(store.createDeal(first.id, firstInput).id, firstDeal.id);
});

test('request quota blocks fresh mutations but allows exact old receipts without another transition', (t) => {
  const f = fixture(t), actor = f.store.register().participant;
  const original = { requestId: randomUUID(), creatorRole: 'seller', ...base };
  const deal = f.store.createDeal(actor.id, original), db = new DatabaseSync(f.dbPath);
  const insert = db.prepare('INSERT INTO participant_requests VALUES (?, ?, ?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  for (let i = 1; i < 2000; i++) insert.run(randomUUID(), actor.id, 'fixture', deal.id, '0'.repeat(64), '{}', 0);
  db.exec('COMMIT'); db.close();
  assert.throws(() => create(f.store, actor), error('request_limit', 413));
  assert.throws(() => f.store.reviseDeal(actor.id, deal.id, { requestId: randomUUID(), expectedVersion: 1, ...base }), error('request_limit'));
  assert.throws(() => document(f.store, actor, deal), error('request_limit'));
  assert.equal(f.store.createDeal(actor.id, original).id, deal.id);
  assert.equal(f.store.getDeal(actor.id, deal.id).version, 1);
});

test('document per-version and global byte quotas include historical versions and rollback failed uploads', (t) => {
  const { store } = fixture(t), actor = store.register().participant;
  let deal = create(store, actor), count = 0;
  const bytes = Buffer.alloc(TEST_DOCUMENT_MAX_BYTES, 120);
  for (let cycle = 0; cycle < 4; cycle++) {
    const versionCount = cycle < 3 ? 10 : 2;
    for (let i = 0; i < versionCount; i++) { document(store, actor, deal, { bytes }); count++; }
    if (cycle === 0) assert.throws(() => document(store, actor, deal, { bytes }), documentError('document_limit'));
    if (cycle < 3) deal = store.reviseDeal(actor.id, deal.id, { requestId: randomUUID(), expectedVersion: deal.version, ...base, quantity: 13 + cycle });
  }
  assert.equal(count, 32);
  assert.throws(() => document(store, actor, deal, { bytes: Buffer.from('x') }), documentError('storage_limit'));
  assert.throws(() => document(store, actor, deal, { bytes: Buffer.alloc(TEST_DOCUMENT_MAX_BYTES + 1, 120) }), documentError('document_limit'));
  assert.equal(store.getDeal(actor.id, deal.id).documentHistory.length, 32);
});

test('commit guards roll back expiry during mutation and do not leak into subsequent requests', (t) => {
  const f = fixture(t), { seller, deal } = pair(f.store);
  const expiresAt = f.now() + 1, actionInput = input(deal, 'offer');
  const assertCurrent = () => { if (f.now() >= expiresAt) throw new Error('test_session_expired'); };
  f.duringNow(() => f.advance(1));
  assert.throws(() => f.store.withCommitGuard(assertCurrent, () => f.store.action(seller.id, deal.id, actionInput)), /test_session_expired/);
  f.duringNow(() => {});
  const unchanged = f.store.getDeal(seller.id, deal.id);
  assert.equal(unchanged.state, 'draft'); assert.equal(unchanged.events.length, 0);
  const db = new DatabaseSync(f.dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM participant_requests WHERE request_id = ?').get(actionInput.requestId).count, 0);
  db.close();
  assert.equal(f.store.action(seller.id, deal.id, actionInput).historical, false);
  let checks = 0;
  assert.throws(() => f.store.withCommitGuard(() => { if (++checks === 3) throw new Error('read_session_expired'); },
    () => f.store.getDeal(seller.id, deal.id)), /read_session_expired/);
  assert.equal(f.store.getDeal(seller.id, deal.id).state, 'offered');
});

test('commit guard callbacks must stay synchronous and returning a thenable rolls back preceding writes', (t) => {
  const { store } = fixture(t);
  let ran = false;
  assert.throws(() => store.withCommitGuard(() => {}, async () => { ran = true; store.register(); }), error('invalid_request'));
  assert.equal(ran, false);
  assert.throws(() => store.withCommitGuard(async () => {}, () => store.register()), error('invalid_request'));
  assert.throws(() => store.withCommitGuard(() => {}, () => { store.register(); return Promise.resolve(); }), error('invalid_request'));
  assert.equal(store.register().participant.label, 'TEST participant 001');
  assert.throws(() => store.withCommitGuard(() => Promise.resolve(), () => store.register()), error('invalid_request'));
  assert.equal(store.register().participant.label, 'TEST participant 002');
});

test('new invitation claims recheck expiry after mutation and after the outer commit guard', (t) => {
  const f = fixture(t), creator = f.store.register().participant, target = f.store.register().participant;
  const deal = create(f.store, creator);
  let invitation = f.store.createInvitation(creator.id, deal.id, { expectedVersion: 1, participantId: target.id });
  f.advance(PARTICIPANT_INVITATION_LIFETIME_MS - 1);
  let timeReads = 0;
  f.duringNow(() => { if (++timeReads >= 2) f.advance(1); });
  assert.throws(() => f.store.claimInvitation(target.id, { code: invitation.code }), error('not_found', 404));
  f.duringNow(() => {});
  assert.deepEqual(f.store.listDeals(target.id), []);
  assert.equal(f.store.getDeal(creator.id, deal.id).participants.length, 1);
  let db = new DatabaseSync(f.dbPath);
  assert.equal(db.prepare('SELECT claimed_by FROM participant_invitations WHERE deal_id = ?').get(deal.id).claimed_by, null); db.close();
  invitation = f.store.createInvitation(creator.id, deal.id, { expectedVersion: 1, participantId: target.id });
  let guards = 0;
  assert.throws(() => f.store.withCommitGuard(() => { if (++guards === 4) f.advance(PARTICIPANT_INVITATION_LIFETIME_MS); },
    () => f.store.claimInvitation(target.id, { code: invitation.code })), error('not_found', 404));
  assert.deepEqual(f.store.listDeals(target.id), []);
  db = new DatabaseSync(f.dbPath);
  assert.equal(db.prepare('SELECT claimed_by FROM participant_invitations WHERE deal_id = ?').get(deal.id).claimed_by, null); db.close();
  invitation = f.store.createInvitation(creator.id, deal.id, { expectedVersion: 1, participantId: target.id });
  assert.equal(f.store.claimInvitation(target.id, { code: invitation.code }).historical, false);
  f.advance(PARTICIPANT_INVITATION_LIFETIME_MS);
  assert.equal(f.store.withCommitGuard(() => {}, () => f.store.claimInvitation(target.id, { code: invitation.code })).historical, true);
});
