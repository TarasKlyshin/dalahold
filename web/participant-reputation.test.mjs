// Local unsigned feedback; no identity, signature, commercial or payment claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ParticipantStore } from './participant-store.mjs';

const terms = { scenario: 'grain', quantity: 20, amount: 200000, date: '2026-10-03' };
const rejected = code => error => error.code === code;
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-role-feedback-'));
  const dbPath = join(directory, 'participants.sqlite');
  let nowHook = () => {};
  const now = () => { nowHook(); return 1000000; };
  let store = new ParticipantStore({ dbPath, now });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const seller = store.register().participant, buyer = store.register().participant, outsider = store.register().participant;
  const pair = (a = seller, b = buyer) => {
    const deal = store.createDeal(a.id, { requestId: randomUUID(), creatorRole: 'seller', ...terms });
    const invite = store.createInvitation(a.id, deal.id, { expectedVersion: 1, participantId: b.id });
    store.claimInvitation(b.id, { code: invite.code });
    return store.getDeal(a.id, deal.id);
  };
  const action = (actor, dealId, verb) => {
    const deal = store.getDeal(actor.id, dealId);
    return store.action(actor.id, dealId, { requestId: randomUUID(), action: verb,
      expectedVersion: deal.version, expectedStateRevision: deal.stateRevision, snapshotHash: deal.snapshotHash }).deal;
  };
  const accepted = (a = seller, b = buyer) => {
    const deal = pair(a, b);
    action(a, deal.id, 'offer'); action(b, deal.id, 'agree'); action(a, deal.id, 'handover');
    return action(b, deal.id, 'accept');
  };
  return { dbPath, seller, buyer, outsider, pair, action, accepted, get store() { return store; },
    setHook(fn) { nowHook = fn; },
    restart() { store.close(); store = new ParticipantStore({ dbPath, now }); },
    sql(fn) { const db = new DatabaseSync(dbPath); try { return fn(db); } finally { db.close(); } } };
}
function input(deal, score = 5, changes = {}) {
  return { requestId: randomUUID(), expectedVersion: deal.version,
    expectedStateRevision: deal.stateRevision, snapshotHash: deal.snapshotHash, score, ...changes };
}

test('accepted deal permits one unsigned local review per side with server-derived target and role', t => {
  const f = fixture(t), deal = f.accepted();
  const a = f.store.review(f.buyer.id, deal.id, input(deal, 5));
  const b = f.store.review(f.seller.id, deal.id, input(deal, 3));
  assert.equal(a.historical, false); assert.equal(a.review.authorId, f.buyer.id);
  assert.equal(a.review.targetId, f.seller.id); assert.equal(a.review.targetRole, 'seller');
  assert.equal(b.review.targetRole, 'buyer'); assert.equal(b.review.authorRole, 'seller');
  assert.equal(a.review.acceptedEventId, deal.events.at(-1).id);
  assert.equal(a.review.source, 'unsigned_test_participant_review');
  assert.equal(a.review.scope, 'local_test_role_reputation_only');
  assert.equal(a.review.dealScope, 'local_test_participant_statements_only');
  assert.equal(f.store.listReviews(f.buyer.id, deal.id).length, 2);
  assert.deepEqual(f.store.getDeal(f.seller.id, deal.id), { ...deal, role: 'seller' });
  const seller = f.store.getReputation(f.seller.id), buyer = f.store.getReputation(f.buyer.id);
  assert.deepEqual(seller.roles.seller, { count: 1, scoreTotal: 5, average: 5 });
  assert.deepEqual(seller.roles.buyer, { count: 0, scoreTotal: 0, average: null });
  assert.deepEqual(buyer.roles.buyer, { count: 1, scoreTotal: 3, average: 3 });
  assert.equal(seller.signatureVerified, false);
  assert.equal(f.store.getDealReputation(f.buyer.id, deal.id).length, 2);
  assert.throws(() => f.store.review(f.buyer.id, deal.id, input(deal)), rejected('review_already_exists'));
});

test('draft, offered, agreed, handed-over and disputed states never generate role ratings', t => {
  const f = fixture(t), deal = f.pair();
  for (const [actor, verb] of [[null, null], [f.seller, 'offer'], [f.buyer, 'agree'], [f.seller, 'handover'], [f.buyer, 'dispute']]) {
    if (actor) f.action(actor, deal.id, verb);
    const current = f.store.getDeal(f.buyer.id, deal.id);
    assert.throws(() => f.store.review(f.buyer.id, deal.id, input(current)), rejected('review_not_allowed'));
    assert.deepEqual(f.store.listReviews(f.seller.id, deal.id), []);
  }
  assert.equal(f.store.getReputation(f.seller.id).roles.seller.count, 0);
});

test('feedback authorization precedes data lookup and rejects actor/target/role injection and coercion', t => {
  const f = fixture(t), deal = f.accepted();
  for (const actor of [f.outsider.id, randomUUID()]) {
    const code = actor === f.outsider.id ? 'not_found' : 'unauthorized';
    assert.throws(() => f.store.review(actor, deal.id, {}), rejected(code));
    assert.throws(() => f.store.listReviews(actor, deal.id), rejected(code));
    assert.throws(() => f.store.getDealReputation(actor, deal.id), rejected(code));
  }
  for (const changes of [{ score: '5' }, { score: 0 }, { score: 6 }, { score: 1.5 },
    { authorId: f.seller.id }, { targetId: f.buyer.id }, { targetRole: 'seller' }, { comment: 'private data' }]) {
    assert.throws(() => f.store.review(f.buyer.id, deal.id, input(deal, 5, changes)), rejected('invalid_request'));
  }
  let calls = 0;
  const withGetter = input(deal);
  Object.defineProperty(withGetter, 'score', { enumerable: true, get() { calls++; return 5; } });
  assert.throws(() => f.store.review(f.buyer.id, deal.id, withGetter), rejected('invalid_request'));
  assert.equal(calls, 0);
  assert.throws(() => f.store.review(f.buyer.id, deal.id, new Proxy(input(deal), {})), rejected('invalid_request'));
  assert.deepEqual(f.store.listReviews(f.buyer.id, deal.id), []);
});

test('stale version, revision and snapshot refuse with no feedback or request receipt', t => {
  const f = fixture(t), deal = f.accepted();
  for (const [changes, code] of [[{ expectedVersion: 2 }, 'stale_deal'],
    [{ expectedStateRevision: 3 }, 'state_conflict'], [{ snapshotHash: 'f'.repeat(64) }, 'snapshot_mismatch']]) {
    assert.throws(() => f.store.review(f.buyer.id, deal.id, input(deal, 5, changes)), rejected(code));
  }
  assert.equal(f.sql(db => db.prepare('SELECT count(*) AS n FROM participant_reviews').get().n), 0);
  assert.equal(f.sql(db => db.prepare("SELECT count(*) AS n FROM participant_requests WHERE kind='review'").get().n), 0);
});

test('exact feedback retry persists across restart; changed, cross-actor and other-kind request IDs conflict', t => {
  const f = fixture(t), deal = f.accepted(), originalInput = input(deal, 4);
  const original = f.store.review(f.buyer.id, deal.id, originalInput);
  f.restart();
  const replay = f.store.review(f.buyer.id, deal.id, originalInput);
  assert.equal(replay.historical, true); assert.deepEqual(replay.review, original.review);
  assert.throws(() => f.store.review(f.buyer.id, deal.id, { ...originalInput, score: 5 }), rejected('idempotency_conflict'));
  assert.throws(() => f.store.review(f.seller.id, deal.id, originalInput), rejected('idempotency_conflict'));
  const other = f.pair();
  assert.throws(() => f.store.review(f.buyer.id, other.id, originalInput), rejected('idempotency_conflict'));
  const otherActor = f.seller.id;
  const dbRequestId = f.sql(db => db.prepare("SELECT request_id FROM participant_requests WHERE kind='create' AND deal_id=?").get(deal.id).request_id);
  assert.throws(() => f.store.review(otherActor, deal.id, input(deal, 5, { requestId: dbRequestId })), rejected('idempotency_conflict'));
  assert.equal(f.store.listReviews(f.seller.id, deal.id).length, 1);
});

test('one account can earn independent buyer and seller ratings without counting unrelated counterparties', t => {
  const f = fixture(t), first = f.accepted(), second = f.accepted(f.buyer, f.seller);
  f.store.review(f.buyer.id, first.id, input(first, 5));
  f.store.review(f.buyer.id, second.id, input(second, 2));
  const result = f.store.getReputation(f.seller.id);
  assert.deepEqual(result.roles, { seller: { count: 1, scoreTotal: 5, average: 5 }, buyer: { count: 1, scoreTotal: 2, average: 2 } });
  const privateSummary = f.store.getDealReputation(f.buyer.id, first.id);
  assert.doesNotMatch(JSON.stringify(privateSummary), new RegExp(second.id));
  assert.equal(f.store.getReputation(f.outsider.id).roles.buyer.count, 0);
});

test('expired/closed commit guard rolls back the review and its exact retry receipt together', t => {
  const f = fixture(t), deal = f.accepted(), value = input(deal);
  let open = true;
  f.setHook(() => { open = false; });
  assert.throws(() => f.store.withCommitGuard(() => {
    if (!open) throw new Error('MODEL session unavailable');
  }, () => f.store.review(f.buyer.id, deal.id, value)), /MODEL session unavailable/);
  f.setHook(() => {});
  assert.equal(f.sql(db => db.prepare('SELECT count(*) AS n FROM participant_reviews').get().n), 0);
  assert.equal(f.sql(db => db.prepare("SELECT count(*) AS n FROM participant_requests WHERE kind='review'").get().n), 0);
  assert.equal(f.store.review(f.buyer.id, deal.id, value).historical, false);
});

test('damaged feedback row or removed review refuses read/retry instead of silently manufacturing a score', t => {
  const f = fixture(t), deal = f.accepted(), value = input(deal, 3);
  const result = f.store.review(f.buyer.id, deal.id, value);
  f.sql(db => db.prepare('UPDATE participant_reviews SET score=5 WHERE id=?').run(result.review.id));
  assert.throws(() => f.store.listReviews(f.seller.id, deal.id), rejected('store_corrupt'));
  assert.throws(() => f.store.getReputation(f.seller.id), rejected('store_corrupt'));
  assert.throws(() => f.store.review(f.buyer.id, deal.id, value), rejected('store_corrupt'));
  f.sql(db => db.prepare('DELETE FROM participant_reviews WHERE id=?').run(result.review.id));
  assert.throws(() => f.store.listReviews(f.seller.id, deal.id), rejected('store_corrupt'));
  assert.throws(() => f.store.review(f.buyer.id, deal.id, value), rejected('store_corrupt'));
});

test('existing participant database gets empty feedback schema, never synthetic historical reviews', t => {
  const f = fixture(t), deal = f.accepted();
  f.store.close();
  f.sql(db => db.exec('DROP TABLE participant_reviews'));
  f.restart();
  assert.deepEqual(f.store.listReviews(f.seller.id, deal.id), []);
  assert.equal(f.store.getReputation(f.seller.id).roles.seller.average, null);
});
