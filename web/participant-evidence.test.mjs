import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, openSync, closeSync, ftruncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ParticipantStore } from './participant-store.mjs';
import { canonicalDraftTerms, fingerprintDraftTerms } from './terms.mjs';
import { TEST_DOCUMENT_MAX_BYTES, TEST_DOCUMENT_MAX_PER_VERSION, TEST_DOCUMENT_MAX_TOTAL_BYTES,
  TEST_DOCUMENT_MAX_TOTAL_DOCUMENTS } from './test-documents.mjs';
import { ParticipantEvidenceError, buildParticipantEvidence, verifyParticipantEvidence,
  PARTICIPANT_EVIDENCE_SCHEMA, PARTICIPANT_EVIDENCE_MODE, PARTICIPANT_EVIDENCE_MAX_BYTES,
  PARTICIPANT_EVIDENCE_MAX_VERSIONS, PARTICIPANT_EVIDENCE_MAX_DOCUMENT_BYTES,
  PARTICIPANT_EVIDENCE_MAX_DOCUMENTS, PARTICIPANT_EVIDENCE_MAX_TOTAL_DOCUMENT_BYTES } from './participant-evidence.mjs';

const TERMS = { scenario: 'grain', quantity: 12, amount: 8400000, date: '2026-10-10' };
const UNSIGNED_SCOPE = 'local_test_participant_statements_only';
const SIGNED_SCOPE = 'local_personal_test_signed_deal_only';
const SESSION = 'a'.repeat(64);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => structuredClone(value);
// Independent test encoder: package object key ordering is immaterial.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function rehash(value) {
  const { packageSha256, ...payload } = value;
  return { ...payload, packageSha256: sha(canonical(payload)) };
}
function invalid(value, code) {
  const report = verifyParticipantEvidence(value);
  assert.equal(report.valid, false);
  if (code) assert.deepEqual(report.errors, [code]);
  assert.equal(report.authenticityVerified, false);
  assert.equal(report.sdkVerificationPerformed, false);
  return report;
}
function error(code) { return value => value instanceof ParticipantEvidenceError && value.code === code; }

function fixture(t, { signed = false, invite = true, sdkValidity = 300000 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-evidence-'));
  const dbPath = join(directory, 'private', 'participants.sqlite');
  let time = 1_000_000, sdkCalls = 0, clockRead = 0, clockHook = null;
  const now = () => clockHook ? clockHook(time, ++clockRead) : time;
  // Pure policy double. No NCA SDK, genuine certificate, CMS or OCSP is used.
  const sdk = { statusSource: 'test_ocsp',
    async inspect() { return { ready: true, statusSource: 'test_ocsp', validUntil: time + 600000,
      chain: ['-----BEGIN CERTIFICATE-----\nMODEL ROOT\n-----END CERTIFICATE-----',
        '-----BEGIN CERTIFICATE-----\nMODEL CA\n-----END CERTIFICATE-----'] }; },
    async verifyIdentity(bytes, cms, key) {
      sdkCalls++;
      const model = JSON.parse(cms.toString('utf8'));
      if (model.hash !== sha(bytes)) return { verified: false };
      return { verified: true, statusSource: 'test_ocsp', validUntil: time + sdkValidity,
        certificateDigest: sha(`MODEL certificate ${model.person}`),
        identity: { schema: 'nca_test_subject_v1',
          personId: `person:${createHmac('sha256', key).update(model.person).digest('hex')}`, organizationId: null } };
    },
  };
  const store = new ParticipantStore({ dbPath, now, ...(signed ? { signatureSdk: sdk } : {}) });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const seller = store.register().participant, buyer = store.register().participant;
  const made = store.createDeal(seller.id, { requestId: randomUUID(), creatorRole: 'seller', ...TERMS });
  if (invite) {
    const invitation = store.createInvitation(seller.id, made.id, { expectedVersion: 1, participantId: buyer.id });
    store.claimInvitation(buyer.id, { code: invitation.code });
  }
  const receipts = [], enrollmentReceipts = [];
  const current = () => store.getDeal(seller.id, made.id);
  const add = (text, category = 'contract') => store.addDocument(seller.id, made.id, {
    requestId: randomUUID(), expectedVersion: current().version, category, bytes: Buffer.from(text),
  });
  const revise = changes => {
    const before = current();
    store.reviseDeal(seller.id, made.id, { requestId: randomUUID(), expectedVersion: before.version,
      scenario: before.scenario, quantity: before.quantity, amount: before.amount, date: before.date, ...changes });
  };
  const modelCms = (intent, person) => Buffer.from(JSON.stringify({ hash: intent.hash, person }));
  const enroll = async () => {
    for (const [actor, person] of [[seller, 'MODEL seller'], [buyer, 'MODEL buyer']]) {
      const intent = store.createEnrollmentIntent(actor.id, SESSION, {});
      const result = await store.submitSignature(actor.id, SESSION, { intentId: intent.id, cms: modelCms(intent, person) });
      enrollmentReceipts.push(result.receipt);
    }
  };
  const action = async (name, disputeRole = 'seller') => {
    const actor = ['agree', 'accept'].includes(name) || (name === 'dispute' && disputeRole === 'buyer') ? buyer : seller;
    const before = store.getDeal(actor.id, made.id);
    const request = { requestId: randomUUID(), action: name, expectedVersion: before.version,
      expectedStateRevision: before.stateRevision, snapshotHash: before.snapshotHash };
    if (signed) {
      const intent = store.createSignatureIntent(actor.id, made.id, SESSION, request);
      const result = await store.submitSignature(actor.id, SESSION, {
        intentId: intent.id, cms: modelCms(intent, actor === seller ? 'MODEL seller' : 'MODEL buyer') });
      receipts.push(result.receipt);
    } else store.action(actor.id, made.id, request);
    return current();
  };
  const collect = () => {
    const deal = current();
    // Test-only read of the immutable six fields; normal integration owns its
    // transactional collector. Receipts came from successful model submission.
    const db = new DatabaseSync(dbPath, { readOnly: true });
    let versions;
    try {
      versions = db.prepare('SELECT version,scenario,quantity,amount,date FROM draft_versions WHERE deal_id=? ORDER BY version')
        .all(deal.id).map(row => ({ ...row, termsFingerprint: fingerprintDraftTerms({ dealId: deal.id, ...row }) }));
    } finally { db.close(); }
    const documents = deal.documentHistory.map(metadata => {
      const { document, bytes } = store.readDocument(seller.id, made.id, metadata.id);
      assert.deepEqual(document, metadata);
      return { ...document, contentBase64: bytes.toString('base64') };
    });
    return { exportedAt: time, deal, versions, documents, receipts: clone(receipts) };
  };
  return { directory, store, seller, buyer, current, add, revise, action, enroll, collect, enrollmentReceipts,
    advance: amount => { time += amount; },
    duringClock: hook => { clockRead = 0; clockHook = hook; }, get sdkCalls() { return sdkCalls; } };
}

test('offline limits stay aligned with existing local text document limits', () => {
  assert.equal(PARTICIPANT_EVIDENCE_MAX_DOCUMENT_BYTES, TEST_DOCUMENT_MAX_BYTES);
  assert.equal(PARTICIPANT_EVIDENCE_MAX_DOCUMENTS, TEST_DOCUMENT_MAX_TOTAL_DOCUMENTS);
  assert.equal(PARTICIPANT_EVIDENCE_MAX_TOTAL_DOCUMENT_BYTES, TEST_DOCUMENT_MAX_TOTAL_BYTES);
  assert.equal(TEST_DOCUMENT_MAX_PER_VERSION, 10);
});

test('actual unsigned accepted store exports all immutable terms and old/current text bytes', async t => {
  const f = fixture(t);
  const old = f.add('Anonymous local TEST contract v1.\n');
  f.advance(1); f.revise({ quantity: 14 });
  f.add('Anonymous local TEST contract v2.\n');
  f.add('Anonymous local TEST quality note.\n', 'quality');
  for (const action of ['offer', 'agree', 'handover', 'accept']) await f.action(action);
  const input = f.collect(), evidence = buildParticipantEvidence(input);
  const report = verifyParticipantEvidence(JSON.parse(JSON.stringify(evidence)));
  assert.equal(report.valid, true); assert.equal(report.state, 'accepted');
  assert.deepEqual(report.counts, { versions: 2, documents: 3,
    documentBytes: input.documents.reduce((total, row) => total + row.byteLength, 0), events: 4, receipts: 0 });
  assert.equal(evidence.versions[0].documentManifest[0].id, old.id);
  for (const version of evidence.versions) {
    assert.equal(version.sha256, version.termsFingerprint);
    assert.equal(version.byteLength, Buffer.byteLength(version.canonicalTerms));
    assert.equal(version.documentManifestHash, sha(JSON.stringify(version.documentManifest)));
  }
  assert.equal(evidence.schema, PARTICIPANT_EVIDENCE_SCHEMA);
  assert.equal(evidence.verification, PARTICIPANT_EVIDENCE_MODE);
  assert.equal(report.authenticityVerified, false);
  assert.match(evidence.limitations.join(' '), /recomputable.*not signatures/);
  assert.equal(Object.hasOwn(input.versions[0], 'canonicalTerms'), false, 'builder does not mutate collector input');
});

test('actual draft can have one party and old-version documents without current attachments', t => {
  const f = fixture(t, { invite: false });
  f.add('Anonymous old text.\n'); f.revise({ amount: 9500000 });
  const evidence = buildParticipantEvidence(f.collect());
  assert.equal(evidence.deal.participants.length, 1);
  assert.equal(evidence.deal.documents.length, 0); assert.equal(evidence.documents.length, 1);
  assert.equal(verifyParticipantEvidence(evidence).valid, true);
  assert.equal(verifyParticipantEvidence(evidence).state, 'draft');
});

test('disputed snapshots verify after agreement or handover and either participant dispute', async t => {
  for (const afterHandover of [false, true]) {
    const f = fixture(t); f.add('Anonymous delivery TEST text.\n', 'delivery');
    await f.action('offer'); await f.action('agree');
    if (afterHandover) await f.action('handover');
    await f.action('dispute', afterHandover ? 'buyer' : 'seller');
    const report = verifyParticipantEvidence(buildParticipantEvidence(f.collect()));
    assert.equal(report.valid, true); assert.equal(report.state, 'disputed');
  }
});

test('actual model signed accepted store exports linked receipts but never calls them genuine SDK evidence', async t => {
  const f = fixture(t, { signed: true });
  await f.enroll(); f.add('Anonymous MODEL personal TEST document.\n');
  for (const action of ['offer', 'agree', 'handover', 'accept']) await f.action(action);
  const evidence = buildParticipantEvidence(f.collect());
  f.advance(400000); // Historical OCSP assertion is allowed; no fresh status claim.
  const calls = f.sdkCalls, report = verifyParticipantEvidence(evidence);
  assert.equal(report.valid, true); assert.equal(report.scope, SIGNED_SCOPE);
  assert.equal(report.counts.receipts, 4); assert.equal(f.sdkCalls, calls);
  assert.equal(report.authenticityVerified, false); assert.equal(report.sdkVerificationPerformed, false);
  assert.equal(report.freshStatusChecked, false);
  assert.doesNotMatch(JSON.stringify(evidence), /"(?:personId|organizationId|cms|sessionHash|mappingKey|accessCode|cookie|grant|walletAddress|originalFilename|path)"/);
  assert.ok(evidence.receipts.every(row => !['enroll_test_participant', 'anchor_test_memo'].includes(row.action)));
});

test('personal TEST draft with no event needs no enrollment or anchor receipts', async t => {
  const f = fixture(t, { signed: true }); await f.enroll();
  const input = f.collect(), evidence = buildParticipantEvidence(input);
  assert.equal(verifyParticipantEvidence(evidence).valid, true);
  assert.equal(evidence.receipts.length, 0);
  assert.throws(() => buildParticipantEvidence({ ...input, receipts: [f.enrollmentReceipts[0]] }), error('invalid_receipt'));
  const anchor = { ...f.enrollmentReceipts[0], action: 'anchor_test_memo', dealId: input.deal.id,
    eventId: randomUUID(), snapshotHash: input.deal.snapshotHash };
  assert.throws(() => buildParticipantEvidence({ ...input, receipts: [anchor] }), error('invalid_receipt'));
});

test('service permits backward wall clocks across document/offer and journal timestamps; report claims no chronology', async t => {
  const f = fixture(t, { signed: true }); await f.enroll();
  f.advance(10); const document = f.add('Anonymous TEST clock sample.\n');
  f.advance(-5); await f.action('offer');
  f.advance(-2); await f.action('agree');
  f.advance(20);
  const evidence = buildParticipantEvidence(f.collect());
  assert.ok(document.createdAt > evidence.deal.events[0].createdAt);
  assert.ok(evidence.deal.events[1].createdAt < evidence.deal.events[0].createdAt);
  const report = verifyParticipantEvidence(evidence);
  assert.equal(report.valid, true); assert.equal(report.chronologyVerified, false);
  assert.match(report.limitations.join(' '), /wall-clock chronology/);
});

test('accepted MODEL service receipt/event times can invert within one operation when wall clock regresses', async t => {
  let observed = null;
  // Vary bounded clock samples rather than relying on implementation-specific
  // counts of nested guard calls. Every sample stays within the same valid
  // issued intent interval; protected service acceptance is the source of truth.
  for (let period = 2; period <= 10 && !observed; period++) {
    const f = fixture(t, { signed: true }); await f.enroll();
    const before = f.current();
    const intent = f.store.createSignatureIntent(f.seller.id, before.id, SESSION, {
      requestId: randomUUID(), action: 'offer', expectedVersion: before.version,
      expectedStateRevision: before.stateRevision, snapshotHash: before.snapshotHash,
    });
    f.duringClock((time, read) => time + (read % period));
    const result = await f.store.submitSignature(f.seller.id, SESSION, { intentId: intent.id,
      cms: Buffer.from(JSON.stringify({ hash: intent.hash, person: 'MODEL seller' })) });
    f.duringClock(null); f.advance(20);
    if (result.event.createdAt < result.receipt.verifiedAt) {
      observed = { result, evidence: buildParticipantEvidence({ ...f.collect(), receipts: [result.receipt] }) };
    }
  }
  assert.ok(observed, 'accepted existing service demonstrates no verifiedAt <= event.createdAt guarantee');
  assert.equal(verifyParticipantEvidence(observed.evidence).valid, true);
  assert.equal(verifyParticipantEvidence(observed.evidence).chronologyVerified, false);
});

test('accepted MODEL service records do not guarantee event.createdAt < receipt.validUntil across clock samples', async t => {
  const submit = async (f, clock) => {
    await f.enroll();
    const before = f.current(), intent = f.store.createSignatureIntent(f.seller.id, before.id, SESSION, {
      requestId: randomUUID(), action: 'offer', expectedVersion: before.version,
      expectedStateRevision: before.stateRevision, snapshotHash: before.snapshotHash,
    });
    f.duringClock(clock);
    const result = await f.store.submitSignature(f.seller.id, SESSION, { intentId: intent.id,
      cms: Buffer.from(JSON.stringify({ hash: intent.hash, person: 'MODEL seller' })) });
    f.duringClock(null);
    return result;
  };
  // Discover the event's clock sample using the same live accepted path rather
  // than a hardcoded count. Then demonstrate a forward sample at that point
  // followed by valid lower commit samples. The intent itself stays unexpired.
  const calibration = fixture(t, { signed: true, sdkValidity: 60000 });
  const calibrated = await submit(calibration, (time, read) => time + read);
  const eventSample = calibrated.event.createdAt - 1_000_000;
  assert.ok(eventSample > 0);
  const f = fixture(t, { signed: true, sdkValidity: 60000 });
  const result = await submit(f, (time, read) => time + (read === eventSample ? 60001 : 0));
  assert.ok(result.event.createdAt >= result.receipt.validUntil);
  f.advance(70000);
  const evidence = buildParticipantEvidence({ ...f.collect(), receipts: [result.receipt] });
  const report = verifyParticipantEvidence(evidence);
  assert.equal(report.valid, true); assert.equal(report.chronologyVerified, false);
});

test('builder canonicalizes manifests and verifier rejects unsorted arrays while accepting reordered object keys', t => {
  const f = fixture(t); f.add('Anonymous B.'); f.add('Anonymous A.');
  f.revise({ quantity: 14 }); f.add('Anonymous C.');
  const input = f.collect(), expected = buildParticipantEvidence(input);
  const shuffled = clone(input);
  shuffled.versions.reverse(); shuffled.documents.reverse(); shuffled.deal.documentHistory.reverse();
  shuffled.deal.documents.reverse(); shuffled.deal.participants.reverse();
  assert.deepEqual(buildParticipantEvidence(shuffled), expected);
  const reordered = JSON.parse(JSON.stringify(expected, (key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).reverse());
    return value;
  }));
  assert.equal(verifyParticipantEvidence(reordered).valid, true);
  for (const field of ['versions', 'documents']) {
    const changed = clone(expected); changed[field].reverse();
    invalid(rehash(changed), 'noncanonical_evidence_order');
  }
});

test('tampered document bytes, size, digest or noncanonical base64 reject even with recomputed outer digest', t => {
  const f = fixture(t); f.add('Anonymous original.\n');
  const evidence = buildParticipantEvidence(f.collect());
  for (const [change, code] of [
    [row => { row.contentBase64 = Buffer.from('Anonymous changed!.\n').toString('base64'); }, 'document_hash_mismatch'],
    [row => { row.byteLength++; }, 'document_size_mismatch'],
    [row => { row.sha256 = '0'.repeat(64); }, 'document_hash_mismatch'],
    [row => { row.contentBase64 += '\n'; }, 'invalid_document_content'],
  ]) {
    const changed = clone(evidence); change(changed.documents[0]);
    invalid(rehash(changed), code);
  }
});

test('text bytes are never executed and forbidden UTF-8, control or PDF data reject', t => {
  const f = fixture(t); f.add('Anonymous original.\n');
  const input = f.collect();
  for (const bytes of [Buffer.from([0xff]), Buffer.from('hidden\0text'), Buffer.from('%PDF-1.7\n')]) {
    const changed = clone(input), row = changed.documents[0];
    row.contentBase64 = bytes.toString('base64'); row.sha256 = sha(bytes); row.byteLength = bytes.length;
    assert.throws(() => buildParticipantEvidence(changed), error('invalid_document_content'));
  }
  // HTML-looking text is data, matching TestDocuments' plain-text policy.
  const safe = fixture(t); safe.add('<script>throw new Error("data only")</script>\n');
  assert.equal(verifyParticipantEvidence(buildParticipantEvidence(safe.collect())).valid, true);
});

test('terms canonical bytes, size, fingerprints and current snapshot must all agree', t => {
  const f = fixture(t); f.add('Anonymous original.\n'); f.revise({ quantity: 14 });
  const evidence = buildParticipantEvidence(f.collect());
  for (const change of [
    value => { value.versions[0].quantity++; },
    value => { value.versions[0].canonicalTerms += 'extra\n'; },
    value => { value.versions[0].byteLength++; },
    value => { value.versions[0].sha256 = '0'.repeat(64); },
    value => { value.versions[0].termsFingerprint = '0'.repeat(64); },
    value => { value.deal.amount++; },
    value => { value.deal.termsFingerprint = '0'.repeat(64); },
  ]) {
    const changed = clone(evidence); change(changed); invalid(rehash(changed), 'terms_hash_mismatch');
  }
  const snapshot = clone(evidence); snapshot.deal.snapshotHash = '0'.repeat(64);
  invalid(rehash(snapshot), 'snapshot_hash_mismatch');
});

test('every version and document is present exactly once and all full manifests match', t => {
  const f = fixture(t); f.add('Anonymous old.\n'); f.revise({ quantity: 14 }); f.add('Anonymous current.\n');
  const evidence = buildParticipantEvidence(f.collect());
  for (const [change, code] of [
    [value => { value.documents.pop(); }, 'document_manifest_mismatch'],
    [value => { value.documents.splice(0, 0, clone(value.documents[0])); }, 'duplicate_evidence_record'],
    [value => { value.deal.documentHistory.pop(); }, 'document_manifest_mismatch'],
    [value => { value.versions.shift(); }, 'version_manifest_mismatch'],
    [value => { value.versions.splice(0, 0, clone(value.versions[0])); }, 'version_manifest_mismatch'],
    [value => { value.versions[0].documentManifest = []; }, 'document_manifest_mismatch'],
    [value => { value.versions[0].documentManifestHash = '0'.repeat(64); }, 'document_manifest_mismatch'],
    [value => { value.deal.documents = []; }, 'document_manifest_mismatch'],
  ]) {
    const changed = clone(evidence); change(changed); invalid(rehash(changed), code);
  }
});

test('event journal checks transitions, exact current terms, actor role, revision, state and document hash', async t => {
  const f = fixture(t); f.add('Anonymous TEST.\n');
  for (const name of ['offer', 'agree', 'handover', 'accept']) await f.action(name);
  const evidence = buildParticipantEvidence(f.collect());
  for (const change of [
    value => { value.deal.state = 'disputed'; },
    value => { value.deal.stateRevision--; },
    value => { value.deal.events.pop(); },
    value => { value.deal.events[0].stateTo = 'accepted'; },
    value => { value.deal.events[0].actorId = f.buyer.id; },
    value => { value.deal.events[0].role = 'buyer'; },
    value => { value.deal.events[0].termsVersion = 2; },
    value => { value.deal.events[0].termsFingerprint = '0'.repeat(64); },
    value => { value.deal.events[0].snapshotHash = '0'.repeat(64); },
    value => { value.deal.events[0].documentManifestHash = '0'.repeat(64); },
    value => { value.deal.events[0].action = 'accept'; },
  ]) {
    const changed = clone(evidence); change(changed); invalid(rehash(changed), 'event_state_mismatch');
  }
});

test('signed receipt links cannot change action, actor, event, snapshot, authorization or per-actor binding', async t => {
  const f = fixture(t, { signed: true }); await f.enroll();
  for (const name of ['offer', 'agree', 'handover', 'accept']) await f.action(name);
  const evidence = buildParticipantEvidence(f.collect());
  for (const change of [
    value => { value.receipts.pop(); },
    value => { value.receipts[0].actorId = f.buyer.id; },
    value => { value.receipts[0].action = 'agree'; },
    value => { value.receipts[0].eventId = randomUUID(); },
    value => { value.receipts[0].snapshotHash = '0'.repeat(64); },
    value => { value.receipts[0].intentHash = '0'.repeat(64); },
    value => { value.deal.events[0].authorization.receiptId = randomUUID(); },
  ]) {
    const changed = clone(evidence); change(changed); invalid(rehash(changed), 'receipt_link_mismatch');
  }
  for (const field of ['id', 'intentId', 'eventId']) {
    const changed = clone(evidence); changed.receipts[1][field] = changed.receipts[0][field];
    assert.equal(verifyParticipantEvidence(rehash(changed)).valid, false);
  }
  const changed = clone(evidence), receipt = changed.receipts[2], linked = changed.deal.events[2];
  receipt.certificateDigest = 'f'.repeat(64); linked.authorization.certificateDigest = receipt.certificateDigest;
  invalid(rehash(changed), 'receipt_binding_mismatch');
});

test('scope and action downgrade attempts or extra private grant material reject', async t => {
  const f = fixture(t, { signed: true }); await f.enroll(); await f.action('offer');
  const evidence = buildParticipantEvidence(f.collect());
  for (const change of [
    value => { value.scope = UNSIGNED_SCOPE; },
    value => { value.deal.scope = UNSIGNED_SCOPE; },
    value => { value.deal.events[0].source = 'unsigned_test_participant_statement'; },
    value => { value.deal.events[0].scope = UNSIGNED_SCOPE; },
    value => { delete value.deal.events[0].authorization; },
    value => { value.receipts = []; },
    value => { value.receipts[0].scope = UNSIGNED_SCOPE; },
    value => { value.receipts[0].action = 'enroll_test_participant'; },
    value => { value.receipts[0].action = 'anchor_test_memo'; },
    value => { value.verification = 'verified_genuine_sdk'; },
    value => { value.limitations = []; },
    value => { value.receipts[0].personId = 'DO NOT ECHO PRIVATE PERSON'; },
    value => { value.receipts[0].grant = { execute: true }; },
  ]) {
    const changed = clone(evidence); change(changed);
    assert.doesNotMatch(JSON.stringify(invalid(rehash(changed))), /PRIVATE PERSON|execute|verified_genuine_sdk/);
  }
});

test('all nested schemas reject unknown fields, missing fields, getters, proxies and sparse arrays without evaluation', t => {
  const f = fixture(t); f.add('Anonymous TEST.\n');
  const evidence = buildParticipantEvidence(f.collect());
  for (const change of [
    value => { value.extra = 'secret'; },
    value => { value.deal.accessCode = 'secret'; },
    value => { value.deal.participants[0].name = 'secret'; },
    value => { value.deal.documents[0].originalFilename = '/private/secret.txt'; },
    value => { value.deal.documentHistory[0].path = '/private/secret.txt'; },
    value => { value.documents[0].filename = 'secret.txt'; },
    value => { value.versions[0].privateIdentity = 'secret'; },
    value => { value.versions[0].documentManifest[0].secret = 'secret'; },
    value => { delete value.documents[0].scope; },
    value => { value.documents[0][Symbol('hidden')] = 'secret'; },
    value => { delete value.documents[0]; },
    value => { value.documents.private = 'secret'; },
    value => { value.documents[0] = new Proxy(value.documents[0], {}); },
    value => { Object.defineProperty(value.documents[0], 'contentBase64', { get() { throw new Error('getter evaluated'); }, enumerable: true }); },
  ]) {
    const changed = clone(evidence); change(changed);
    const report = invalid(changed, 'invalid_evidence');
    assert.doesNotMatch(JSON.stringify(report), /secret|getter evaluated/);
  }
  const input = f.collect(); input.deal.extra = 'DO NOT COPY';
  assert.throws(() => buildParticipantEvidence(input), error('invalid_evidence'));
});

test('fixed structural and byte limits reject before unbounded traversal or file extraction', t => {
  const f = fixture(t); f.add('Anonymous TEST.\n');
  const input = f.collect();
  const tooManyVersions = { ...input, versions: Array(PARTICIPANT_EVIDENCE_MAX_VERSIONS + 1).fill(null) };
  assert.throws(() => buildParticipantEvidence(tooManyVersions), error('evidence_limit'));
  const tooManyDocuments = { ...input, documents: Array(PARTICIPANT_EVIDENCE_MAX_DOCUMENTS + 1).fill(null) };
  assert.throws(() => buildParticipantEvidence(tooManyDocuments), error('evidence_limit'));
  const metadataSize = clone(input); metadataSize.deal.documents[0].byteLength = TEST_DOCUMENT_MAX_BYTES + 1;
  assert.throws(() => buildParticipantEvidence(metadataSize), error('evidence_limit'));
  const encodedSize = clone(input); encodedSize.documents[0].contentBase64 = 'A'.repeat(4 * Math.ceil(TEST_DOCUMENT_MAX_BYTES / 3) + 4);
  assert.throws(() => buildParticipantEvidence(encodedSize), error('evidence_limit'));
  const bytes = Buffer.alloc(TEST_DOCUMENT_MAX_BYTES, 65), oversized = clone(input);
  oversized.documents = Array.from({ length: 33 }, () => ({ ...input.documents[0], id: randomUUID(),
    contentBase64: bytes.toString('base64'), byteLength: bytes.length, sha256: sha(bytes) }));
  oversized.deal.documents = []; oversized.deal.documentHistory = oversized.documents.map(({ contentBase64, ...row }) => row);
  assert.throws(() => buildParticipantEvidence(oversized), error('evidence_limit'));
});

test('unsupported schema, corrupt digest and invalid report do not expose supplied content', t => {
  const f = fixture(t); f.add('DO NOT PRINT ATTACHMENT CONTENT.\n');
  const evidence = buildParticipantEvidence(f.collect());
  invalid({ ...evidence, schema: 'SECRET UNSUPPORTED SCHEMA' }, 'unsupported_evidence_schema');
  invalid({ ...evidence, packageSha256: '0'.repeat(64) }, 'package_hash_mismatch');
  const report = invalid({ ...evidence, exportedAt: -1 });
  assert.doesNotMatch(JSON.stringify(report), /DO NOT PRINT|SECRET|contentBase64|scenario|participants/);
});

test('a fully rewritten internally consistent file can verify, proving hashes do not authenticate origin', t => {
  const f = fixture(t, { invite: false });
  const original = buildParticipantEvidence(f.collect()), changed = clone(f.collect());
  changed.deal.amount = 1; changed.versions[0].amount = 1;
  const terms = { dealId: changed.deal.id, version: 1, ...TERMS, amount: 1 };
  changed.deal.termsFingerprint = fingerprintDraftTerms(terms);
  changed.versions[0].termsFingerprint = changed.deal.termsFingerprint;
  changed.deal.snapshotHash = sha(JSON.stringify({ schema: 'dalahold.local-test-participant-snapshot.v1',
    canonicalTerms: canonicalDraftTerms(terms).toString('utf8'), documents: [], participants: changed.deal.participants }));
  const rewritten = buildParticipantEvidence(changed), report = verifyParticipantEvidence(rewritten);
  assert.notEqual(rewritten.packageSha256, original.packageSha256);
  assert.equal(report.valid, true); assert.equal(report.authenticityVerified, false);
  assert.match(report.limitations.join(' '), /Anyone can change all contents and recompute all hashes/);
});

test('CLI reads only one bounded regular JSON file and prints a sanitized report with meaningful exit code', t => {
  const f = fixture(t); f.add('DO NOT PRINT ATTACHMENT CONTENT.\n');
  const filename = join(f.directory, 'evidence.json');
  const cli = fileURLToPath(new URL('./verify-participant-evidence.mjs', import.meta.url));
  const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10000 });
  writeFileSync(filename, JSON.stringify(buildParticipantEvidence(f.collect())));
  const valid = run([filename]); assert.equal(valid.status, 0); assert.equal(JSON.parse(valid.stdout).valid, true);
  assert.doesNotMatch(valid.stdout, /DO NOT PRINT|contentBase64|scenario|participants/);
  for (const [args, code] of [
    [[], 'expected_one_json_file'], [[filename, filename], 'expected_one_json_file'],
    [[join(f.directory, 'PRIVATE-MISSING-PATH')], 'evidence_file_unavailable'],
    [[f.directory], 'expected_regular_json_file'],
  ]) {
    const result = run(args); assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout).errors, [code]); assert.doesNotMatch(result.stdout, /PRIVATE-MISSING-PATH|DO NOT PRINT/);
  }
  writeFileSync(filename, '{"content":"DO NOT PRINT INVALID JSON"');
  const malformed = run([filename]); assert.equal(malformed.status, 1);
  assert.deepEqual(JSON.parse(malformed.stdout).errors, ['invalid_evidence_json']); assert.doesNotMatch(malformed.stdout, /DO NOT PRINT/);
  writeFileSync(filename, Buffer.from([0xff]));
  assert.deepEqual(JSON.parse(run([filename]).stdout).errors, ['invalid_evidence_json']);
  for (const json of ['{"schema":1,"schema":2}', '{"schema":1,"sch\\u0065ma":2}', '{"deal":{"scope":1,"scope":2}}']) {
    writeFileSync(filename, json);
    assert.deepEqual(JSON.parse(run([filename]).stdout).errors, ['duplicate_evidence_key']);
  }
  writeFileSync(filename, '['.repeat(34) + '0' + ']'.repeat(34));
  assert.deepEqual(JSON.parse(run([filename]).stdout).errors, ['evidence_limit']);
  const fd = openSync(filename, 'w');
  try { ftruncateSync(fd, PARTICIPANT_EVIDENCE_MAX_BYTES + 1); } finally { closeSync(fd); }
  assert.deepEqual(JSON.parse(run([filename]).stdout).errors, ['evidence_limit']);
});
