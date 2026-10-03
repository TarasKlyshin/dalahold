// Pure Node protocol regressions. No DOM, browser or headless acceptance.
// Signed store paths below use explicit MODEL SDK fixtures, not genuine NCA.
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID, webcrypto } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ParticipantStore } from './participant-store.mjs';
import { verifyParticipantEvidence, PARTICIPANT_EVIDENCE_MAX_BYTES } from './participant-evidence.mjs';
import { validateReputationEnvelope, validateDealFeedbackEnvelope, validateReviewEnvelope,
  buildReviewPayload, readEvidenceResponse } from './participant-delivery-client.mjs';

const SCOPE = 'local_test_participant_statements_only';
const SIGNED_SCOPE = 'local_personal_test_signed_deal_only';
const FEEDBACK_SCOPE = 'local_test_role_reputation_only';
const TERMS = { scenario: 'grain', quantity: 12, amount: 8400000, date: '2026-10-10' };
const SESSION = 'a'.repeat(64);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => structuredClone(value);
const rejected = (code = 'invalid_response') => error => error.code === code && error.message === code;
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function rehash(evidence) {
  const { packageSha256, ...payload } = evidence;
  return { ...payload, packageSha256: sha(canonical(payload)) };
}
function response(value, { chunkSize = 4096, headers = {}, status = 200 } = {}) {
  const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
  return new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.subarray(offset, offset + chunkSize));
    controller.close();
  } }), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}
function selection(f, deal = f.current(), actor = f.seller) {
  return { scope: deal.scope, actorId: actor.id, dealId: deal.id, role: deal.participants.find(row => row.id === actor.id)?.role ?? 'seller' };
}
function fixture(t, { signed = false, invite = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-delivery-client-'));
  let time = 1000000, calls = 0;
  const sdk = { statusSource: 'test_ocsp',
    async inspect() { return { ready: true, statusSource: 'test_ocsp', validUntil: time + 600000 }; },
    async verifyIdentity(bytes, cms, key) {
      calls++;
      const model = JSON.parse(cms.toString('utf8'));
      if (model.hash !== sha(bytes)) return { verified: false };
      return { verified: true, statusSource: 'test_ocsp', validUntil: time + 300000,
        certificateDigest: sha(`MODEL certificate ${model.person}`), identity: { schema: 'nca_test_subject_v1',
          personId: `person:${createHmac('sha256', key).update(model.person).digest('hex')}`, organizationId: null } };
    } };
  const store = new ParticipantStore({ dbPath: join(directory, 'participants.sqlite'), now: () => time,
    ...(signed ? { signatureSdk: sdk } : {}) });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const seller = store.register().participant, buyer = store.register().participant, outsider = store.register().participant;
  const made = store.createDeal(seller.id, { requestId: randomUUID(), creatorRole: 'seller', ...TERMS });
  const id = made.id;
  if (invite) {
    const invite = store.createInvitation(seller.id, id, { expectedVersion: 1, participantId: buyer.id });
    store.claimInvitation(buyer.id, { code: invite.code });
  }
  const current = (actor = seller, dealId = id) => store.getDeal(actor.id, dealId);
  const modelCms = (intent, actor) => Buffer.from(JSON.stringify({ hash: intent.hash,
    person: actor.id === seller.id ? 'MODEL seller' : 'MODEL buyer' }));
  const enroll = async () => {
    for (const actor of [seller, buyer]) {
      const intent = store.createEnrollmentIntent(actor.id, SESSION, {});
      await store.submitSignature(actor.id, SESSION, { intentId: intent.id, cms: modelCms(intent, actor) });
    }
  };
  const action = async (name, dealId = id) => {
    const actor = ['agree', 'accept'].includes(name) ? buyer : seller, before = current(actor, dealId);
    const payload = { requestId: randomUUID(), action: name, expectedVersion: before.version,
      expectedStateRevision: before.stateRevision, snapshotHash: before.snapshotHash };
    if (signed) {
      const intent = store.createSignatureIntent(actor.id, dealId, SESSION, payload);
      await store.submitSignature(actor.id, SESSION, { intentId: intent.id, cms: modelCms(intent, actor) });
    } else store.action(actor.id, dealId, payload);
    return current(seller, dealId);
  };
  const complete = async (dealId = id) => {
    for (const name of ['offer', 'agree', 'handover', 'accept']) await action(name, dealId);
    return current(seller, dealId);
  };
  const other = () => {
    const deal = store.createDeal(seller.id, { requestId: randomUUID(), creatorRole: 'seller', ...TERMS });
    const invitation = store.createInvitation(seller.id, deal.id, { expectedVersion: 1, participantId: buyer.id });
    store.claimInvitation(buyer.id, { code: invitation.code });
    return deal.id;
  };
  const add = (text, category = 'contract') => store.addDocument(seller.id, id, { requestId: randomUUID(),
    expectedVersion: current().version, category, bytes: Buffer.from(text) });
  const revise = changes => {
    const deal = current();
    store.reviseDeal(seller.id, id, { requestId: randomUUID(), expectedVersion: deal.version,
      scenario: deal.scenario, quantity: deal.quantity, amount: deal.amount, date: deal.date, ...changes });
  };
  const score = (actor = buyer, value = 4, dealId = id) => {
    const deal = current(actor, dealId);
    return store.review(actor.id, dealId, { requestId: randomUUID(), expectedVersion: deal.version,
      expectedStateRevision: deal.stateRevision, snapshotHash: deal.snapshotHash, score: value });
  };
  const own = (actor = seller) => ({ reputation: store.getReputation(actor.id), scope: FEEDBACK_SCOPE, dealScope: store.scope });
  const feedback = () => ({ reviewValue: { reviews: store.listReviews(seller.id, id), scope: FEEDBACK_SCOPE, dealScope: store.scope },
    reputationValue: { reputation: store.getDealReputation(seller.id, id), scope: FEEDBACK_SCOPE, dealScope: store.scope } });
  const savedEnvelope = saved => ({ ...saved, scope: FEEDBACK_SCOPE, dealScope: store.scope });
  return { store, seller, buyer, outsider, current, enroll, action, complete, other, add, revise, score, own, feedback, savedEnvelope,
    evidence: (actor = seller) => store.getEvidencePackage(actor.id, id), advance: amount => { time += amount; }, get sdkCalls() { return calls; } };
}

test('own reputation uses exact role totals/rounding/null and copies every record', async t => {
  const f = fixture(t); await f.complete(); f.score(f.buyer, 5);
  for (const value of [3, 3]) { const id = f.other(); await f.complete(id); f.score(f.buyer, value, id); }
  const envelope = f.own(), checked = validateReputationEnvelope(envelope, { scope: SCOPE, actorId: f.seller.id });
  assert.deepEqual(checked.roles.seller, { count: 3, scoreTotal: 11, average: 3.67 });
  assert.deepEqual(checked.roles.buyer, { count: 0, scoreTotal: 0, average: null });
  assert.equal(checked.signatureVerified, false);
  checked.participant.label = 'changed'; checked.roles.seller.count = 99;
  assert.equal(envelope.reputation.participant.label, f.seller.label);
  assert.equal(envelope.reputation.roles.seller.count, 3);
});

test('own summary refuses scope, identity, source, signature claims, malformed totals/averages and private extras', t => {
  const f = fixture(t), envelope = f.own(), options = { scope: SCOPE, actorId: f.seller.id };
  for (const change of [
    value => { value.scope = SCOPE; }, value => { value.dealScope = SIGNED_SCOPE; },
    value => { value.reputation.participant.id = f.buyer.id; }, value => { value.reputation.source = 'personal_test_nca_statement'; },
    value => { value.reputation.signatureVerified = true; }, value => { value.reputation.signatureVerified = 'false'; },
    value => { value.reputation.eligibility = 'any_deal'; }, value => { value.reputation.participant.name = 'PRIVATE'; },
    value => { value.reputation.roles.seller = { count: 0, scoreTotal: 0, average: 0 }; },
    value => { value.reputation.roles.seller = { count: 0, scoreTotal: 1, average: null }; },
    value => { value.reputation.roles.seller = { count: 1, scoreTotal: 6, average: 6 }; },
    value => { value.reputation.roles.seller = { count: '1', scoreTotal: 1, average: 1 }; },
    value => { value.reputation.roles.seller = { count: 3, scoreTotal: 11, average: 3.666 }; },
    value => { value.reputation.roles.seller = { count: 101, scoreTotal: 101, average: 1 }; },
    value => { value.reputation.roles = { seller: { count: 60, scoreTotal: 60, average: 1 }, buyer: { count: 60, scoreTotal: 60, average: 1 } }; },
    value => { value.reputation.roles.seller.average = NaN; }, value => { value.reputation.roles.third = {}; },
    value => { value.reputation.cms = 'PRIVATE CMS'; }, value => { value.csrfToken = 'PRIVATE TOKEN'; },
  ]) {
    const changed = clone(envelope); change(changed);
    assert.throws(() => validateReputationEnvelope(changed, options), rejected());
  }
});

test('draft feedback may have one party/zero current reviews and accepted feedback matches two identities/roles', async t => {
  const single = fixture(t, { invite: false }), first = single.feedback();
  assert.equal(validateDealFeedbackEnvelope(first.reviewValue, first.reputationValue, single.current()).parties.length, 1);
  const f = fixture(t); await f.complete(); f.score(f.buyer, 5); f.score(f.seller, 3);
  const { reviewValue, reputationValue } = f.feedback(), originalScore = reviewValue.reviews[0].score;
  reputationValue.reputation.reverse();
  const checked = validateDealFeedbackEnvelope(reviewValue, reputationValue, f.current());
  assert.equal(checked.dealId, f.current().id); assert.equal(checked.snapshotHash, f.current().snapshotHash);
  assert.equal(checked.stateRevision, 4); assert.equal(checked.parties.length, 2); assert.equal(checked.reviews.length, 2);
  for (const party of checked.parties) assert.equal(party.id, party.reputation.participant.id);
  checked.reviews[0].score = 1; checked.parties[0].reputation.roles.seller.count = 77;
  assert.equal(reviewValue.reviews[0].score, originalScore);
  assert.ok(reputationValue.reputation.every(row => row.roles.seller.count < 77));
});

test('deal summaries may include unrelated volume without leaking unrelated identifiers, while containing current review', async t => {
  const f = fixture(t); await f.complete(); f.score(f.buyer, 5);
  const otherId = f.other(); await f.complete(otherId); f.score(f.buyer, 2, otherId);
  const data = f.feedback(), checked = validateDealFeedbackEnvelope(data.reviewValue, data.reputationValue, f.current());
  const seller = checked.parties.find(row => row.id === f.seller.id);
  assert.deepEqual(seller.reputation.roles.seller, { count: 2, scoreTotal: 7, average: 3.5 });
  assert.doesNotMatch(JSON.stringify(checked), new RegExp(otherId));
  for (const summary of [{ count: 0, scoreTotal: 0, average: null }, { count: 2, scoreTotal: 5, average: 2.5 }]) {
    const changed = clone(data.reputationValue);
    changed.reputation.find(row => row.participant.id === f.seller.id).roles.seller = summary;
    assert.throws(() => validateDealFeedbackEnvelope(data.reviewValue, changed, f.current()), rejected());
  }
});

test('GET feedback refuses stale terminal links, author/target/role changes, duplicates and unknown/private fields', async t => {
  const f = fixture(t); await f.complete(); f.score(f.buyer, 4);
  const data = f.feedback(), deal = f.current();
  for (const change of [
    value => { value.reviews[0].authorId = f.outsider.id; }, value => { value.reviews[0].targetId = f.buyer.id; },
    value => { value.reviews[0].authorRole = 'seller'; }, value => { value.reviews[0].targetRole = 'buyer'; },
    value => { value.reviews[0].termsVersion++; }, value => { value.reviews[0].stateRevision--; },
    value => { value.reviews[0].snapshotHash = '0'.repeat(64); }, value => { value.reviews[0].acceptedEventId = deal.events[0].id; },
    value => { value.reviews[0].createdAt = deal.events.at(-1).createdAt - 1; },
    value => { value.reviews[0].source = 'personal_test_nca_statement'; }, value => { value.reviews[0].scope = SCOPE; },
    value => { value.reviews[0].comment = 'PRIVATE COMMENT'; }, value => { value.reviews[0].cms = 'PRIVATE CMS'; },
    value => { value.reviews[0].score = 0; }, value => { value.reviews[0].score = '4'; },
    value => { value.reviews.push(clone(value.reviews[0])); },
    value => { value.reviews.push({ ...value.reviews[0], id: randomUUID() }); },
    value => { value.reviews = [value.reviews[0], value.reviews[0], value.reviews[0]]; },
    value => { value.dealScope = SIGNED_SCOPE; },
  ]) {
    const changed = clone(data.reviewValue); change(changed);
    assert.throws(() => validateDealFeedbackEnvelope(changed, data.reputationValue, deal), rejected());
  }
  for (const change of [
    value => { value.reputation.pop(); }, value => { value.reputation[0].participant.id = f.outsider.id; },
    value => { value.reputation[0].participant.label = 'TEST participant 099'; },
    value => { value.reputation.push(clone(value.reputation[0])); },
    value => { value.reputation[0].dealIds = [randomUUID()]; }, value => { value.dealScope = SIGNED_SCOPE; },
  ]) {
    const changed = clone(data.reputationValue); change(changed);
    assert.throws(() => validateDealFeedbackEnvelope(data.reviewValue, changed, deal), rejected());
  }
  const wrong = clone(deal); wrong.events.at(-1).action = 'dispute';
  assert.throws(() => validateDealFeedbackEnvelope(data.reviewValue, data.reputationValue, wrong), rejected());
});

test('POST review envelope pins author, opposite target role, score and current accepted snapshot for fresh/history', async t => {
  const f = fixture(t); await f.complete(); const saved = f.score(f.buyer, 4);
  const deal = f.current(f.buyer), options = { deal, actorId: f.buyer.id, score: 4 };
  for (const historical of [false, true]) {
    const envelope = { ...f.savedEnvelope(saved), historical };
    const checked = validateReviewEnvelope(envelope, options);
    assert.deepEqual(checked, { review: saved.review, historical });
    assert.notEqual(checked.review, envelope.review);
  }
  for (const change of [
    value => { value.historical = 'true'; }, value => { value.review.score = 5; },
    value => { value.review.authorId = f.seller.id; }, value => { value.review.targetId = f.buyer.id; },
    value => { value.review.snapshotHash = '0'.repeat(64); }, value => { value.review.acceptedEventId = randomUUID(); },
    value => { value.review.author = 'PRIVATE'; }, value => { value.review.role = 'seller'; },
    value => { value.comment = 'PRIVATE'; }, value => { value.dealScope = SIGNED_SCOPE; },
  ]) {
    const changed = clone(f.savedEnvelope(saved)); change(changed);
    assert.throws(() => validateReviewEnvelope(changed, options), rejected());
  }
  assert.throws(() => validateReviewEnvelope(f.savedEnvelope(saved), { ...options, actorId: f.outsider.id }), rejected());
});

test('review payload has only pinned request/version/revision/snapshot/score and requires exact consent and eligibility', async t => {
  const f = fixture(t), before = f.current();
  const args = { deal: before, actorId: f.seller.id, score: 5, requestId: randomUUID(), consent: true };
  assert.throws(() => buildReviewPayload(args), rejected('review_not_allowed'));
  for (const consent of [false, undefined, 1, 'true']) assert.throws(() => buildReviewPayload({ ...args, consent }), rejected('review_consent_required'));
  await f.complete(); const deal = f.current(f.buyer);
  const accepted = { ...args, deal, actorId: f.buyer.id };
  assert.deepEqual(buildReviewPayload(accepted), { requestId: accepted.requestId, expectedVersion: deal.version,
    expectedStateRevision: deal.stateRevision, snapshotHash: deal.snapshotHash, score: 5 });
  for (const score of [0, 6, 2.5, '4', NaN, null]) assert.throws(() => buildReviewPayload({ ...accepted, score }), rejected('invalid_request'));
  assert.throws(() => buildReviewPayload({ ...accepted, requestId: accepted.requestId.toUpperCase() }), rejected('invalid_request'));
  assert.throws(() => buildReviewPayload({ ...accepted, authorId: f.buyer.id }), rejected('invalid_request'));
  assert.throws(() => buildReviewPayload({ ...accepted, actorId: f.outsider.id }), rejected('review_not_allowed'));
  assert.throws(() => buildReviewPayload({ ...accepted, deal: f.current(f.seller) }), rejected('review_not_allowed'));
  const stale = clone(deal); stale.events.at(-1).snapshotHash = '0'.repeat(64);
  assert.throws(() => buildReviewPayload({ ...accepted, deal: stale }), rejected('review_not_allowed'));
  const disputed = fixture(t); await disputed.action('offer'); await disputed.action('agree'); await disputed.action('dispute');
  assert.throws(() => buildReviewPayload({ ...args, deal: disputed.current(), actorId: disputed.seller.id }), rejected('review_not_allowed'));
});

test('metadata getters/symbols/sparse arrays/coercions reject without evaluating them or exposing errors', async t => {
  const f = fixture(t); await f.complete(); f.score(f.buyer, 4);
  let reads = 0;
  const data = f.feedback();
  for (const change of [
    value => { Object.defineProperty(value.reviews[0], 'score', { get() { reads++; return 4; }, enumerable: true }); },
    value => { value.reviews[0][Symbol('PRIVATE')] = 'PRIVATE'; },
    value => { delete value.reviews[0]; },
    value => { value.reviews.extra = 'PRIVATE'; },
    value => { value.reviews[0].score = { valueOf() { reads++; return 4; } }; },
  ]) {
    const changed = clone(data.reviewValue); change(changed);
    assert.throws(() => validateDealFeedbackEnvelope(changed, data.reputationValue, f.current()), rejected());
  }
  const own = f.own(); Object.defineProperty(own.reputation.roles.seller, 'average', { get() { reads++; return 4; }, enumerable: true });
  assert.throws(() => validateReputationEnvelope(own, { scope: SCOPE, actorId: f.seller.id }), rejected());
  const args = { deal: f.current(), actorId: f.seller.id, score: 5, requestId: randomUUID(), consent: true };
  Object.defineProperty(args, 'score', { get() { reads++; return 5; }, enumerable: true });
  assert.throws(() => buildReviewPayload(args), rejected('invalid_request'));
  const thrown = { get code() { reads++; throw new Error('PRIVATE'); } };
  const proxy = new Proxy({}, { ownKeys() { throw thrown; } });
  assert.throws(() => buildReviewPayload(proxy), rejected('invalid_request'));
  assert.equal(reads, 0);
});

test('streamed actual store evidence retains all old/current document bytes and passes WebCrypto package checksum', async t => {
  const f = fixture(t); f.add('Anonymous old TEST text.\n'); f.revise({ quantity: 14 });
  f.add('<script>data only</script>\n', 'quality'); await f.complete();
  const evidence = f.evidence(), original = clone(evidence);
  const checked = await readEvidenceResponse(response(evidence, { chunkSize: 37 }), selection(f), webcrypto);
  assert.deepEqual(checked.evidence, original);
  assert.deepEqual(JSON.parse(checked.text), original);
  assert.equal(verifyParticipantEvidence(checked.evidence).valid, true);
  assert.deepEqual(checked.evidence.documents.map(row => row.contentBase64), original.documents.map(row => row.contentBase64));
  checked.evidence.documents[0].category = 'other';
  assert.notEqual(checked.evidence.documents[0].category, original.documents[0].category);
});

test('MODEL personal TEST package/reputation remain historical local data, without fresh SDK or feedback signature claim', async t => {
  const f = fixture(t, { signed: true }); await f.enroll(); f.add('Anonymous MODEL TEST text.\n'); await f.complete();
  f.score(f.buyer, 4); f.advance(400000);
  const calls = f.sdkCalls, checked = await readEvidenceResponse(response(f.evidence()), selection(f), webcrypto);
  assert.equal(checked.evidence.scope, SIGNED_SCOPE); assert.equal(checked.evidence.receipts.length, 4);
  const feedback = f.feedback(), parsed = validateDealFeedbackEnvelope(feedback.reviewValue, feedback.reputationValue, f.current());
  assert.ok(parsed.parties.every(row => row.reputation.signatureVerified === false));
  assert.equal(validateReputationEnvelope(f.own(), { scope: SIGNED_SCOPE, actorId: f.seller.id }).signatureVerified, false);
  const saved = f.score(f.seller, 3);
  assert.equal(validateReviewEnvelope(f.savedEnvelope(saved), { deal: f.current(), actorId: f.seller.id, score: 3 }).review.source, 'unsigned_test_participant_review');
  assert.equal(f.sdkCalls, calls);
});

test('evidence selection pins account, deal, role and both scope labels', async t => {
  const f = fixture(t), evidence = f.evidence(), context = selection(f);
  for (const changes of [{ actorId: f.outsider.id }, { dealId: randomUUID() }, { role: 'buyer' }, { scope: SIGNED_SCOPE }, { token: 'PRIVATE' }]) {
    await assert.rejects(readEvidenceResponse(response(evidence), { ...context, ...changes }, webcrypto), rejected());
  }
  for (const change of [value => { value.scope = SIGNED_SCOPE; }, value => { value.deal.scope = SIGNED_SCOPE; }, value => { value.deal.role = 'buyer'; }]) {
    const changed = clone(evidence); change(changed);
    await assert.rejects(readEvidenceResponse(response(rehash(changed)), context, webcrypto), rejected());
  }
});

test('every evidence metadata layer rejects extra private fields before hashing or returning text', async t => {
  const f = fixture(t, { signed: true }); await f.enroll(); f.add('Anonymous MODEL TEST text.\n'); await f.complete();
  const evidence = f.evidence(); let hashes = 0;
  const crypto = { subtle: { digest() { hashes++; throw new Error('should not hash malformed schema'); } } };
  for (const change of [
    value => { value.cms = 'PRIVATE'; }, value => { value.deal.personId = 'PRIVATE'; },
    value => { value.deal.participants[0].subject = 'PRIVATE'; }, value => { value.deal.documents[0].originalFilename = 'PRIVATE'; },
    value => { value.deal.documentHistory[0].path = 'PRIVATE'; }, value => { value.deal.events[0].cms = 'PRIVATE'; },
    value => { value.deal.events[0].authorization.mappingKey = 'PRIVATE'; }, value => { value.versions[0].grant = 'PRIVATE'; },
    value => { value.versions[0].documentManifest[0].subject = 'PRIVATE'; }, value => { value.documents[0].accessCode = 'PRIVATE'; },
    value => { value.receipts[0].key = 'PRIVATE'; }, value => { value.receipts[0].action = 'enroll_test_participant'; },
    value => { value.receipts[0].action = 'anchor_test_memo'; }, value => { value.deal.events[0].action = 'anchor_test_memo'; },
    value => { value.limitations = []; }, value => { value.verification = 'verified_genuine_sdk'; },
  ]) {
    const changed = clone(evidence); change(changed);
    await assert.rejects(readEvidenceResponse(response(rehash(changed)), selection(f), crypto), rejected());
  }
  assert.equal(hashes, 0);
});

test('typed nested schemas enforce version/document/manifests, base64 and count/byte bounds before hashing', async t => {
  const f = fixture(t); f.add('Anonymous TEST text.\n'); const evidence = f.evidence(); let hashes = 0;
  const crypto = { subtle: { digest() { hashes++; throw new Error('PRIVATE'); } } };
  for (const change of [
    value => { value.versions = Array(2001).fill(value.versions[0]); },
    value => { value.documents = Array(1025).fill(value.documents[0]); },
    value => { value.versions[0].canonicalTerms = 'x'.repeat(513); },
    value => { value.versions[0].canonicalTerms = 'PRIVATE CMS OR ACCESS CODE'; },
    value => { value.versions[0].documentManifest = Array(11).fill(value.versions[0].documentManifest[0]); },
    value => { value.documents[0].byteLength = 262145; }, value => { value.documents[0].contentBase64 += '\n'; },
    value => { value.documents[0].contentBase64 = 'Zh=='; value.documents[0].byteLength = 1; },
    value => { value.documents[0].termsVersion = 2; }, value => { value.versions[0].quantity = '12'; },
    value => { value.versions[0].scenario = 'unknown'; }, value => { value.versions[0].date = '2026-02-30'; },
    value => { value.deal.documentHistory[0].fileKind = 'html'; }, value => { value.deal.participants[0].label = 'PRIVATE'; },
    value => { value.schema = 'dalahold.unknown.v1'; },
    value => { value.exportedAt = '1000000'; }, value => { value.documents.push(clone(value.documents[0])); },
  ]) {
    const changed = clone(evidence); change(changed);
    await assert.rejects(readEvidenceResponse(response(rehash(changed)), selection(f), crypto), rejected());
  }
  await assert.rejects(readEvidenceResponse(response({ ...evidence, packageSha256: evidence.packageSha256.toUpperCase() }), selection(f), crypto), rejected());
  assert.equal(hashes, 0);
});

test('per-version, cumulative decoded-byte and total-manifest limits reject before WebCrypto', async t => {
  const f = fixture(t); f.add('Anonymous TEST text.\n'); const evidence = f.evidence(); let hashes = 0;
  const crypto = { subtle: { digest() { hashes++; throw new Error('PRIVATE'); } } };
  const perVersion = clone(evidence);
  perVersion.documents = Array.from({ length: 11 }, () => ({ ...evidence.documents[0], id: randomUUID() }));
  await assert.rejects(readEvidenceResponse(response(perVersion), selection(f), crypto), rejected());
  const totalBytes = clone(evidence), bytes = Buffer.alloc(262144, 65);
  totalBytes.deal.version = 4; totalBytes.deal.documents = []; totalBytes.deal.documentHistory = [];
  const version = (number, documentManifest) => {
    const row = { ...evidence.versions[0], version: number, documentManifest };
    row.canonicalTerms = row.canonicalTerms.replace('\nversion=1\n', `\nversion=${number}\n`);
    row.byteLength = row.canonicalTerms.length;
    return row;
  };
  totalBytes.versions = Array.from({ length: 4 }, (_, index) => version(index + 1, []));
  totalBytes.documents = Array.from({ length: 33 }, (_, index) => ({ ...evidence.documents[0], id: randomUUID(),
    termsVersion: Math.floor(index / 10) + 1, byteLength: bytes.length, contentBase64: bytes.toString('base64') }));
  assert.ok(Buffer.byteLength(JSON.stringify(totalBytes)) < PARTICIPANT_EVIDENCE_MAX_BYTES);
  await assert.rejects(readEvidenceResponse(response(totalBytes), selection(f), crypto), rejected());
  const manifests = clone(evidence);
  manifests.deal.version = 103; manifests.deal.documents = []; manifests.deal.documentHistory = []; manifests.documents = [];
  manifests.versions = Array.from({ length: 103 }, (_, index) => version(index + 1,
    Array.from({ length: 10 }, () => ({ ...evidence.versions[0].documentManifest[0], id: randomUUID(), termsVersion: index + 1 }))));
  await assert.rejects(readEvidenceResponse(response(manifests), selection(f), crypto), rejected());
  assert.equal(hashes, 0);
});

test('bounded transport rejects actual oversize despite a lying small Content-Length and cancels the stream', async t => {
  const f = fixture(t); let cancelled = 0, hashes = 0;
  const bytes = new Uint8Array(PARTICIPANT_EVIDENCE_MAX_BYTES + 1);
  const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes); }, cancel() { cancelled++; } });
  const oversized = new Response(stream, { headers: { 'Content-Type': 'application/json', 'Content-Length': '1' } });
  await assert.rejects(readEvidenceResponse(oversized, selection(f), { subtle: { digest() { hashes++; } } }), rejected());
  assert.equal(cancelled, 1); assert.equal(hashes, 0);
  let zeroChunks = 0, emptyCancelled = 0;
  const endlessEmpty = new ReadableStream({ pull(controller) {
    zeroChunks++; controller.enqueue(new Uint8Array(0));
  }, cancel() { emptyCancelled++; } });
  await assert.rejects(readEvidenceResponse(new Response(endlessEmpty, { headers: { 'Content-Type': 'application/json' } }), selection(f), webcrypto), rejected());
  assert.equal(emptyCancelled, 1); assert.ok(zeroChunks <= 65538, 'empty chunks cannot bypass the bounded reader loop');
  const value = f.evidence();
  for (const headers of [{ 'Content-Length': String(PARTICIPANT_EVIDENCE_MAX_BYTES + 1) },
    { 'Content-Length': '-1' }, { 'Content-Type': 'text/html' }, { 'Content-Type': 'application/json; charset=iso-8859-1' }]) {
    await assert.rejects(readEvidenceResponse(response(value, { headers }), selection(f), webcrypto), rejected());
  }
  for (const status of [201, 401, 500]) await assert.rejects(readEvidenceResponse(response(value, { status }), selection(f), webcrypto), rejected());
  await assert.rejects(readEvidenceResponse({ ok: true, status: 200, body: null }, selection(f), webcrypto), rejected());
});

test('malformed JSON, duplicate escaped keys, excessive nesting, fatal UTF-8 and read failures have fixed safe errors', async t => {
  const f = fixture(t);
  for (const value of ['', '{"private":"DO NOT ECHO"', '{"schema":1,"schema":2}',
    '{"schema":1,"sch\\u0065ma":2}', '['.repeat(34) + '0' + ']'.repeat(34), new Uint8Array([0xff, 0x80])]) {
    await assert.rejects(readEvidenceResponse(response(value), selection(f), webcrypto), rejected());
  }
  const stream = new ReadableStream({ pull(controller) { controller.error(new Error('PRIVATE STREAM ERROR')); } });
  await assert.rejects(readEvidenceResponse(new Response(stream, { headers: { 'Content-Type': 'application/json' } }), selection(f), webcrypto), rejected());
});

test('package checksum verifies independently of object key order and rejects tampering/unavailable or failing crypto', async t => {
  const f = fixture(t); f.add('Anonymous TEST text.\n'); const evidence = f.evidence();
  const reordered = JSON.parse(JSON.stringify(evidence, (key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).reverse()) : value));
  assert.equal((await readEvidenceResponse(response(reordered), selection(f), webcrypto)).evidence.packageSha256, evidence.packageSha256);
  const changed = clone(evidence); changed.exportedAt++;
  await assert.rejects(readEvidenceResponse(response(changed), selection(f), webcrypto), rejected());
  for (const crypto of [null, {}, { subtle: { async digest() { throw new Error('PRIVATE CRYPTO ERROR'); } } },
    { subtle: { async digest() { return new ArrayBuffer(31); } } }]) {
    await assert.rejects(readEvidenceResponse(response(evidence), selection(f), crypto), rejected());
  }
});

test('download validation deliberately does not duplicate document/terms business hashes or confer authenticity', async t => {
  const f = fixture(t); f.add('Anonymous old text.\n'); const original = f.evidence(), changed = clone(original);
  changed.documents[0].contentBase64 = Buffer.from('Anonymous new text.\n').toString('base64');
  const rebuilt = rehash(changed), checked = await readEvidenceResponse(response(rebuilt), selection(f), webcrypto);
  assert.equal(checked.evidence.documents[0].contentBase64, rebuilt.documents[0].contentBase64);
  assert.equal(verifyParticipantEvidence(checked.evidence).valid, false, 'offline consistency checker detects the unchanged document digest');
  assert.match(checked.evidence.limitations.join(' '), /Anyone can change all contents and recompute all hashes/);
});

test('selection is copied before awaiting stream/hash; caller still owns session/generation checks', async t => {
  const f = fixture(t), evidence = f.evidence(), options = selection(f);
  let deliver;
  const stream = new ReadableStream({ start(controller) { deliver = () => {
    controller.enqueue(new TextEncoder().encode(JSON.stringify(evidence))); controller.close();
  }; } });
  const pending = readEvidenceResponse(new Response(stream, { headers: { 'Content-Type': 'application/json' } }), options, webcrypto);
  options.actorId = f.outsider.id; options.dealId = randomUUID(); deliver();
  assert.equal((await pending).evidence.deal.id, evidence.deal.id);
});

test('browser helper has no Node imports, markup execution, network calls or logging', () => {
  const source = readFileSync(new URL('./participant-delivery-client.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /\b(?:fetch|eval|Function|console\.[a-z]+|document\.write|innerHTML)\s*\(/);
});
