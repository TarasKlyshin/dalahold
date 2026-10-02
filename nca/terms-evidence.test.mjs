// SQLite policy/storage tests with a verifier double, not real NCA cryptography.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fingerprintDraftTerms } from '../web/terms.mjs';
import { TermsEvidence } from './terms-evidence.mjs';

const SESSION = '9'.repeat(64), FOREIGN = '8'.repeat(64), CERTIFICATE = '1'.repeat(64);
const DEAL = 'fbe1e870-687c-4cf6-841c-37937c7e6716';
const OTHER = '01928c6e-7b3a-7d4e-8f5a-1b2c3d4e5f60';
const DOC1 = 'a0000000-0000-4000-8000-000000000001', DOC2 = 'a0000000-0000-4000-8000-000000000002';
const BASE = { dealId: DEAL, version: 1, scenario: 'grain', quantity: 12, amount: 8_400_000, date: '2026-10-10' };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sign = (bytes, suffix = '') => Buffer.from(JSON.stringify({ signed: bytes.toString('base64'), suffix }));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(t, path = ':memory:', options = {}) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS drafts (deal_id TEXT PRIMARY KEY, version INTEGER,
    scenario TEXT, quantity INTEGER, amount INTEGER, date TEXT) STRICT;
    CREATE TABLE IF NOT EXISTS draft_versions (deal_id TEXT, version INTEGER,
      scenario TEXT, quantity INTEGER, amount INTEGER, date TEXT, PRIMARY KEY(deal_id,version)) STRICT;
    CREATE TABLE IF NOT EXISTS test_documents (id TEXT PRIMARY KEY, deal_id TEXT,
      version INTEGER, category TEXT, bytes BLOB, sha256 TEXT) STRICT;`);
  const setTerms = (terms = BASE) => {
    const { dealId, version, scenario, quantity, amount, date } = terms;
    db.prepare('INSERT OR REPLACE INTO drafts VALUES (?,?,?,?,?,?)').run(dealId, version, scenario, quantity, amount, date);
    db.prepare('INSERT OR REPLACE INTO draft_versions VALUES (?,?,?,?,?,?)').run(dealId, version, scenario, quantity, amount, date);
  };
  if (!db.prepare('SELECT 1 FROM drafts WHERE deal_id=?').get(DEAL)) setTerms();
  const addDocument = ({ id = DOC1, category = 'contract', bytes = Buffer.from('exact TEST document'), version = 1 } = {}) => {
    db.prepare('INSERT OR REPLACE INTO test_documents VALUES (?,?,?,?,?,?)').run(id, DEAL, version, category, bytes, sha(bytes));
  };
  const readSnapshot = dealId => {
    const row = db.prepare('SELECT * FROM drafts WHERE deal_id=?').get(dealId);
    if (!row) return undefined;
    const terms = { dealId, version: row.version, scenario: row.scenario, quantity: row.quantity, amount: row.amount, date: row.date };
    const archive = db.prepare('SELECT * FROM draft_versions WHERE deal_id=? AND version=?').get(dealId, row.version);
    if (!archive || ['scenario', 'quantity', 'amount', 'date'].some(name => archive[name] !== row[name])) throw new Error('archive_changed');
    const documents = db.prepare('SELECT * FROM test_documents WHERE deal_id=? AND version=?').all(dealId, row.version).map(document => {
      if (!document.bytes || sha(document.bytes) !== document.sha256) throw new Error('document_digest_changed');
      return { id: document.id, category: document.category, byteLength: document.bytes.length, sha256: document.sha256 };
    });
    return { terms, termsFingerprint: fingerprintDraftTerms(terms), documents };
  };
  let time = 1_000_000, calls = 0;
  const outcome = () => ({ verified: true, statusSource: 'test_ocsp', certificateDigest: CERTIFICATE,
    validUntil: time + 60_000, personal: true, iin: 'private-never-returned', organizationId: null });
  const verify = async (bytes, cms) => {
    calls++;
    let input;
    try { input = JSON.parse(cms.toString('utf8')); } catch { return { verified: false }; }
    return input.signed === bytes.toString('base64') ? outcome() : { verified: false };
  };
  const stores = new Set();
  const open = (custom = {}) => {
    const store = new TermsEvidence({ db, readSnapshot, verify, now: () => time, ...options, ...custom });
    stores.add(store); return store;
  };
  const store = open();
  t.after(() => { for (const current of stores) current.close(); db.close(); });
  return { db, store, open, readSnapshot, setTerms, addDocument, verify, outcome,
    get time() { return time; }, set time(value) { time = value; }, get calls() { return calls; } };
}
const create = (f, options) => f.store.createIntent(SESSION, { dealId: DEAL, expectedVersion: 1 }, options);
const submit = (f, intent, cms = sign(intent.bytes), options) => f.store.submit(SESSION, { intentId: intent.id, cms }, options);
const accepted = f => f.db.prepare('SELECT count(*) AS n FROM terms_evidence_intents WHERE receipt_json IS NOT NULL').get().n;

test('constructor and strict request types reject injection and coercion', async t => {
  const f = fixture(t);
  for (const custom of [{ db: {} }, { readSnapshot: null }, { verify: {} }, { now: 1 }]) {
    assert.throws(() => new TermsEvidence({ db: f.db, readSnapshot: f.readSnapshot, verify: f.verify, ...custom }), /terms_dependencies_invalid/);
  }
  const request = { dealId: DEAL, expectedVersion: 1 };
  for (const input of [undefined, null, [], new Map(), { ...request, approved: true },
    { dealId: DEAL }, { ...request, expectedVersion: '1' }, { ...request, dealId: { toString: () => DEAL } },
    { ...request, [Symbol('role')]: 'buyer' }, Object.assign(Object.create(request), {}),
    Object.defineProperty({ ...request }, 'dealId', { get() { throw new Error('getter called'); } })]) {
    assert.throws(() => f.store.createIntent(SESSION, input), /terms_request_invalid/);
  }
  assert.throws(() => f.store.createIntent({ toString: () => SESSION }, request), /terms_request_invalid/);
  assert.throws(() => create(f, { assertCurrent: false }), /terms_guard_invalid/);
  assert.throws(() => create(f, { assertCurrent() {}, role: 'buyer' }), /terms_guard_invalid/);
  const intent = create(f);
  for (const input of [undefined, null, [], { intentId: intent.id, cms: 'cms' },
    { intentId: intent.id, cms: new Uint8Array(1) }, { intentId: intent.id, cms: Buffer.alloc(0) },
    { intentId: intent.id, cms: Buffer.alloc(98_305) }, { intentId: intent.id, cms: sign(intent.bytes), statusSource: 'test_ocsp' },
    { intentId: intent.id, cms: sign(intent.bytes), [Symbol('certificate')]: CERTIFICATE }]) {
    await assert.rejects(f.store.submit(SESSION, input), /terms_submission_invalid/);
  }
  assert.equal(f.calls, 0); assert.equal(accepted(f), 0);
});

test('canonical exact bytes bind session, TEST purpose, version, fingerprint and sorted complete manifest', async t => {
  const f = fixture(t);
  f.addDocument({ id: DOC2, category: 'quality' }); f.addDocument();
  const intent = create(f), pinned = JSON.parse(intent.bytes);
  const expected = { domain: 'dalahold:test-terms-evidence:v1',
    purpose: 'TEST only: record one personal TEST CMS signature over these exact terms and document digests. No transaction approval, role, access, corporate powers, wallet or payment is authorized.',
    action: 'record_test_terms_signature', nonce: intent.id, sessionHash: SESSION,
    issuedAt: f.time, expiresAt: f.time + 300_000, statusSource: 'test_ocsp',
    snapshot: { terms: BASE, termsFingerprint: fingerprintDraftTerms(BASE),
      documents: [DOC1, DOC2].map((id, index) => ({ id, category: index ? 'quality' : 'contract',
        byteLength: Buffer.byteLength('exact TEST document'), sha256: sha('exact TEST document') })) } };
  assert.deepEqual(pinned, expected);
  assert.deepEqual(intent.bytes, Buffer.from(JSON.stringify(expected, null, 2) + '\n'));
  assert.equal(intent.hash, sha(intent.bytes)); assert.equal(intent.expiresAt, expected.expiresAt);
  await assert.rejects(submit(f, intent, sign(Buffer.from('personal enrollment receipt'))), /terms_signature_rejected/);
  const result = await submit(f, intent);
  assert.equal(result.historical, false);
  assert.deepEqual(Object.keys(result.receipt), ['id', 'intentHash', 'dealId', 'termsVersion', 'termsFingerprint',
    'certificateDigest', 'verifiedAt', 'validUntil', 'statusSource', 'scope', 'action']);
  assert.equal(result.receipt.scope, 'test_terms_evidence_only');
  assert.equal(result.receipt.action, 'record_test_terms_signature');
  assert.equal(result.receipt.intentHash, intent.hash); assert.equal(result.receipt.certificateDigest, CERTIFICATE);
  assert.equal(accepted(f), 1);
});

test('snapshot validation refuses malformed, extra, fingerprint-invalid and document-invalid values', t => {
  const f = fixture(t), valid = f.readSnapshot(DEAL);
  const bad = [null, Promise.resolve(valid), { ...valid, role: 'seller' },
    { ...valid, terms: { ...BASE, quantity: '12' } }, { ...valid, termsFingerprint: '0'.repeat(64) },
    { ...valid, terms: { ...BASE, dealId: OTHER }, termsFingerprint: fingerprintDraftTerms({ ...BASE, dealId: OTHER }) },
    { ...valid, documents: [undefined] }, { ...valid, documents: [{ id: DOC1, category: 'contract', byteLength: 1, sha256: 'a'.repeat(64), iin: 'private' }] },
    { ...valid, documents: [{ id: DOC1, category: 'power', byteLength: 1, sha256: 'a'.repeat(64) }] },
    { ...valid, documents: [{ id: DOC1, category: 'contract', byteLength: 262_145, sha256: 'a'.repeat(64) }] },
    { ...valid, documents: [{ id: DOC1, category: 'contract', byteLength: 0, sha256: 'a'.repeat(64) }] },
    { ...valid, documents: [{ id: DOC1, category: 'contract', byteLength: 1, sha256: 'A'.repeat(64) }] }];
  const doc = { id: DOC1, category: 'contract', byteLength: 1, sha256: 'a'.repeat(64) };
  bad.push({ ...valid, documents: [doc, doc] }, { ...valid, documents: Array.from({ length: 11 }, () => doc) });
  for (const value of bad) {
    const store = f.open({ readSnapshot: () => value });
    assert.throws(() => store.createIntent(SESSION, { dealId: DEAL, expectedVersion: 1 }), /terms_(snapshot_invalid|deal_not_found)/);
  }
  assert.throws(() => f.store.createIntent(SESSION, { dealId: DEAL, expectedVersion: 2 }), /terms_snapshot_stale/);
  assert.throws(() => f.store.createIntent(SESSION, { dealId: OTHER, expectedVersion: 1 }), /terms_deal_not_found/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM terms_evidence_intents').get().n, 0);
});

test('CMS and exact intent bytes are copied before verifier await and never returned in evidence', async t => {
  const f = fixture(t), gate = deferred();
  let capturedCms;
  const store = f.open({ verify: async (bytes, cms) => {
    capturedCms = Buffer.from(cms);
    bytes.fill(0); cms.fill(0); await gate.promise; return f.outcome();
  } });
  const intent = store.createIntent(SESSION, { dealId: DEAL, expectedVersion: 1 });
  const cms = sign(intent.bytes), original = Buffer.from(cms), promise = store.submit(SESSION, { intentId: intent.id, cms });
  cms.fill(0); intent.bytes.fill(0); gate.resolve();
  const result = await promise;
  assert.deepEqual(capturedCms, original);
  const row = f.db.prepare('SELECT * FROM terms_evidence_intents WHERE id=?').get(intent.id);
  assert.deepEqual(Buffer.from(row.cms), original); assert.equal(row.signature_hash, sha(original));
  const list = store.list(DEAL, 1);
  assert.deepEqual(list, [{ snapshot: f.readSnapshot(DEAL), receipt: result.receipt }]);
  assert.ok(!/cms|sessionHash|private-never-returned|iin|personId|organizationId/.test(JSON.stringify(list)));
  assert.ok(Object.isFrozen(list[0].receipt)); assert.ok(Object.isFrozen(list[0].snapshot.terms));
  assert.throws(() => { list[0].snapshot.terms.amount = 1; }, TypeError);
  assert.deepEqual(store.read(DEAL, 1, result.receipt.id), list[0]);
  assert.equal(store.read(DEAL, 1, OTHER), undefined);
});

test('changed current version and every term during await reject without a receipt', async t => {
  for (const changes of [{ version: 2 }, { quantity: 13 }, { amount: 1 }, { date: '2026-10-11' }, { scenario: 'livestock' }]) {
    const f = fixture(t), gate = deferred();
    const store = f.open({ verify: async () => { await gate.promise; return f.outcome(); } });
    const intent = store.createIntent(SESSION, { dealId: DEAL, expectedVersion: 1 });
    const promise = store.submit(SESSION, { intentId: intent.id, cms: sign(intent.bytes) });
    f.setTerms({ ...BASE, ...changes }); gate.resolve();
    await assert.rejects(promise, /terms_snapshot_stale/); assert.equal(accepted(f), 0);
  }
});

test('document addition, deletion, content, category and digest failure during await reject evidence', async t => {
  const mutations = [f => f.addDocument({ id: DOC2 }),
    f => f.db.prepare('DELETE FROM test_documents WHERE id=?').run(DOC1),
    f => f.addDocument({ bytes: Buffer.from('new content') }),
    f => f.addDocument({ category: 'quality' }),
    f => f.db.prepare('UPDATE test_documents SET sha256=? WHERE id=?').run('0'.repeat(64), DOC1)];
  for (const mutate of mutations) {
    const f = fixture(t), gate = deferred(); f.addDocument();
    const store = f.open({ verify: async () => { await gate.promise; return f.outcome(); } });
    const intent = store.createIntent(SESSION, { dealId: DEAL, expectedVersion: 1 });
    const promise = store.submit(SESSION, { intentId: intent.id, cms: sign(intent.bytes) });
    mutate(f); gate.resolve();
    await assert.rejects(promise, /terms_snapshot_stale|document_digest_changed/); assert.equal(accepted(f), 0);
  }
});

test('snapshot and session are rechecked after verifier and while SQLite rollback is possible', async t => {
  const f = fixture(t), intent = create(f); let guards = 0;
  await assert.rejects(submit(f, intent, sign(intent.bytes), { assertCurrent() {
    if (++guards === 6) f.setTerms({ ...BASE, version: 2 });
  } }), /terms_snapshot_stale/);
  assert.equal(accepted(f), 0); assert.equal(f.readSnapshot(DEAL).terms.version, 1, 'late shared-db mutation also rolls back');
  guards = 0;
  await assert.rejects(submit(f, intent, sign(intent.bytes), { assertCurrent() {
    if (++guards === 6) throw new Error('session_closed');
  } }), /session_closed/);
  assert.equal(accepted(f), 0);
  assert.equal(f.db.prepare('SELECT signature_hash,cms,receipt_json,receipt_mac FROM terms_evidence_intents WHERE id=?').get(intent.id).cms, null);
});

test('expired intent and expired TEST status cannot commit after await or after receipt update', async t => {
  const f = fixture(t), expired = create(f); f.time = expired.expiresAt;
  await assert.rejects(submit(f, expired), /terms_intent_expired/); assert.equal(f.calls, 0);
  f.time = 1_000_000;
  const gate = deferred(), store = f.open({ verify: async () => { await gate.promise; return f.outcome(); } });
  const intent = store.createIntent(SESSION, { dealId: DEAL, expectedVersion: 1 });
  const promise = store.submit(SESSION, { intentId: intent.id, cms: sign(intent.bytes) });
  f.time = intent.expiresAt; gate.resolve(); await assert.rejects(promise, /terms_intent_expired/);
  f.time = 1_000_000; const fresh = create(f); let guards = 0;
  await assert.rejects(submit(f, fresh, sign(fresh.bytes), { assertCurrent() { if (++guards === 6) f.time += 60_000; } }), /terms_status_expired/);
  assert.equal(accepted(f), 0);
});

test('closed and foreign sessions cannot submit or recover a historical receipt', async t => {
  const f = fixture(t), gate = deferred(); let live = true;
  const assertCurrent = () => { if (!live) throw new Error('session_closed'); };
  const store = f.open({ verify: async () => { await gate.promise; return f.outcome(); } });
  const intent = store.createIntent(SESSION, { dealId: DEAL, expectedVersion: 1 }, { assertCurrent });
  const promise = store.submit(SESSION, { intentId: intent.id, cms: sign(intent.bytes) }, { assertCurrent });
  live = false; gate.resolve(); await assert.rejects(promise, /session_closed/); assert.equal(accepted(f), 0);
  live = true; await store.submit(SESSION, { intentId: intent.id, cms: sign(intent.bytes) }, { assertCurrent }); live = false;
  await assert.rejects(store.submit(SESSION, { intentId: intent.id, cms: sign(intent.bytes) }, { assertCurrent }), /session_closed/);
  await assert.rejects(store.submit(FOREIGN, { intentId: intent.id, cms: sign(intent.bytes) }), /terms_intent_not_found/);
  assert.equal(accepted(f), 1);
});

test('revoked, fixture/model, expired, malformed and corporate verifier outcomes fail closed', async t => {
  const f = fixture(t);
  for (const changes of [{ verified: false }, { statusSource: 'test_crl_fixture' }, { statusSource: 'local_model' },
    { certificateDigest: 'A'.repeat(64) }, { certificateDigest: 'bad' }, { validUntil: f.time },
    { validUntil: `${f.time + 1}` }, { personal: false }, { personal: undefined }, { corporate: true }, { verified: 'true' }]) {
    const store = f.open({ verify: async () => ({ ...f.outcome(), ...changes }) });
    const intent = store.createIntent(SESSION, { dealId: DEAL, expectedVersion: 1 });
    await assert.rejects(store.submit(SESSION, { intentId: intent.id, cms: sign(intent.bytes) }), /terms_signature_rejected/);
  }
  assert.equal(accepted(f), 0);
});

test('historical exact CMS retry survives intent/status expiry and changed current version without new verification', async t => {
  const f = fixture(t); f.addDocument();
  const intent = create(f), cms = sign(intent.bytes), first = await submit(f, intent, cms);
  f.time = intent.expiresAt + 1; f.setTerms({ ...BASE, version: 2, quantity: 20 }); f.addDocument({ version: 2, bytes: Buffer.from('v2') });
  const second = await submit(f, intent, cms);
  assert.deepEqual(second, { receipt: first.receipt, historical: true }); assert.equal(f.calls, 1);
  await assert.rejects(submit(f, intent, sign(intent.bytes, 'different CMS')), /terms_replay_conflict/);
  assert.equal(accepted(f), 1);
  const old = f.store.list(DEAL, 1);
  assert.equal(old.length, 1); assert.deepEqual(old[0].snapshot.terms, BASE);
  assert.equal(old[0].snapshot.documents[0].sha256, sha('exact TEST document'));
  assert.deepEqual(f.store.list(DEAL, 2), []);
});

test('tampered canonical intent, receipt, signature, private CMS and partial accepted row fail closed', async t => {
  const changes = [
    f => f.db.prepare('UPDATE terms_evidence_intents SET bytes=?').run(Buffer.from('{}')),
    f => f.db.prepare('UPDATE terms_evidence_intents SET bytes_hash=?').run('0'.repeat(64)),
    f => f.db.prepare('UPDATE terms_evidence_intents SET expires_at=expires_at+1').run(),
    f => f.db.prepare('UPDATE terms_evidence_intents SET receipt_json=?').run('{}'),
    f => f.db.prepare('UPDATE terms_evidence_intents SET signature_hash=?').run('0'.repeat(64)),
    f => f.db.prepare('UPDATE terms_evidence_intents SET cms=?').run(Buffer.from('tampered')),
    f => f.db.prepare('UPDATE terms_evidence_intents SET receipt_mac=?').run('0'.repeat(64)),
    f => f.db.prepare('UPDATE terms_evidence_intents SET receipt_json=NULL').run(),
  ];
  for (const change of changes) {
    const f = fixture(t), intent = create(f), cms = sign(intent.bytes); await submit(f, intent, cms); change(f);
    await assert.rejects(submit(f, intent, cms), /terms_(intent|receipt)_changed/);
    if (f.db.prepare('SELECT receipt_json FROM terms_evidence_intents').get().receipt_json !== null) {
      assert.throws(() => f.store.list(DEAL), /terms_(intent|receipt)_changed/);
    }
  }
});

test('changed metadata key is rejected by an already open store', async t => {
  const f = fixture(t), intent = create(f);
  f.db.prepare('UPDATE terms_evidence_meta SET receipt_key=?').run(Buffer.alloc(32));
  await assert.rejects(submit(f, intent), /terms_state_changed/);
  assert.throws(() => f.store.list(DEAL), /terms_state_changed/);
});

test('parallel same CMS consumes nonce once; different CMS loses replay race', async t => {
  for (const different of [false, true]) {
    const f = fixture(t), gate = deferred(); let calls = 0;
    const store = f.open({ verify: async () => { calls++; await gate.promise; return f.outcome(); } });
    const intent = store.createIntent(SESSION, { dealId: DEAL, expectedVersion: 1 }), cms = sign(intent.bytes);
    const p1 = store.submit(SESSION, { intentId: intent.id, cms });
    const p2 = store.submit(SESSION, { intentId: intent.id, cms: different ? sign(intent.bytes, 'other') : cms });
    const settled = Promise.allSettled([p1, p2]); gate.resolve();
    const results = await settled; assert.equal(calls, 2); assert.equal(accepted(f), 1);
    assert.equal(results[0].status, 'fulfilled');
    if (different) { assert.equal(results[1].status, 'rejected'); assert.match(results[1].reason.message, /terms_replay_conflict/); }
    else { assert.equal(results[1].status, 'fulfilled'); assert.equal(results[1].value.historical, true); assert.deepEqual(results[1].value.receipt, results[0].value.receipt); }
  }
});

test('parallel exact retry preserves receipt even if its second verifier result is now expired or revoked', async t => {
  const f = fixture(t), g1 = deferred(), g2 = deferred(); let calls = 0;
  const store = f.open({ verify: async () => {
    const count = ++calls; await (count === 1 ? g1.promise : g2.promise);
    return count === 1 ? f.outcome() : { verified: false, personal: false };
  } });
  const intent = store.createIntent(SESSION, { dealId: DEAL, expectedVersion: 1 }), cms = sign(intent.bytes);
  const p1 = store.submit(SESSION, { intentId: intent.id, cms }), p2 = store.submit(SESSION, { intentId: intent.id, cms });
  g1.resolve(); const first = await p1; f.time = intent.expiresAt + 1; g2.resolve();
  assert.deepEqual(await p2, { receipt: first.receipt, historical: true }); assert.equal(accepted(f), 1);
});

test('ambiguous verifier failure leaves intent retryable and releases concurrency slots', async t => {
  const f = fixture(t); let failOnce = true;
  const store = f.open({ verify: async (bytes, cms) => { if (failOnce) { failOnce = false; throw new Error('sdk_unavailable'); } return f.verify(bytes, cms); } });
  const intent = store.createIntent(SESSION, { dealId: DEAL, expectedVersion: 1 }), cms = sign(intent.bytes);
  await assert.rejects(store.submit(SESSION, { intentId: intent.id, cms }), /sdk_unavailable/);
  assert.equal(accepted(f), 0); assert.equal((await store.submit(SESSION, { intentId: intent.id, cms })).historical, false);
});

test('shared-db verifier cap is two and closing does not close caller database', async t => {
  const f = fixture(t), gate = deferred();
  const verify = async () => { await gate.promise; return f.outcome(); };
  const s1 = f.open({ verify }), s2 = f.open({ verify }), intent = create(f), cms = sign(intent.bytes);
  const p1 = s1.submit(SESSION, { intentId: intent.id, cms }), p2 = s2.submit(SESSION, { intentId: intent.id, cms });
  await assert.rejects(f.store.submit(SESSION, { intentId: intent.id, cms }), /verifier_busy/);
  assert.throws(() => s1.close(), /verification_in_progress/);
  gate.resolve(); await Promise.all([p1, p2]); s1.close();
  await assert.rejects(s1.submit(SESSION, { intentId: intent.id, cms }), /terms_store_closed/);
  assert.equal(f.db.prepare('SELECT 1 AS ok').get().ok, 1);
});

test('persistent pending bound survives store restart and prunes only expired unsigned intents', async t => {
  const f = fixture(t), acceptedIntent = create(f); await submit(f, acceptedIntent);
  const first = create(f);
  for (let index = 1; index < 500; index++) create(f);
  assert.throws(() => create(f), /terms_pending_limit/);
  f.store.close(); const reopened = f.open();
  assert.throws(() => reopened.createIntent(SESSION, { dealId: DEAL, expectedVersion: 1 }), /terms_pending_limit/);
  f.time = first.expiresAt;
  reopened.createIntent(SESSION, { dealId: DEAL, expectedVersion: 1 });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM terms_evidence_intents').get().n, 2);
  assert.equal(reopened.list(DEAL).length, 1); assert.equal(accepted(f), 1);
});

test('historical receipt and canonical pinned snapshot survive real SQLite connection restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-terms-evidence-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'workspace.sqlite');
  const f = fixture(t, path), intent = create(f), cms = sign(intent.bytes), result = await submit(f, intent, cms);
  f.store.close();
  // A separate connection simulates process restart while keeping only persisted
  // canonical bytes, receipt, private CMS and local integrity key.
  const db = new DatabaseSync(path);
  const store = new TermsEvidence({ db, readSnapshot() { throw new Error('must not read current for historical recovery'); },
    verify() { throw new Error('must not reverify accepted CMS'); }, now: () => intent.expiresAt + 1 });
  try {
    assert.deepEqual(await store.submit(SESSION, { intentId: intent.id, cms }), { receipt: result.receipt, historical: true });
    assert.deepEqual(store.list(DEAL, 1), [{ snapshot: { terms: BASE, termsFingerprint: fingerprintDraftTerms(BASE), documents: [] }, receipt: result.receipt }]);
  } finally { store.close(); db.close(); }
});

test('retained intents and receipts refuse missing metadata without provisioning another key', async t => {
  for (const acceptedFirst of [false, true]) {
    for (const removedTable of [false, true]) {
      const f = fixture(t), intent = create(f);
      if (acceptedFirst) await submit(f, intent);
      f.store.close();
      f.db.exec(removedTable ? 'DROP TABLE terms_evidence_meta' : 'DELETE FROM terms_evidence_meta');
      assert.throws(() => f.open(), /terms_state_changed/);
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM terms_evidence_intents').get().n, 1);
      assert.equal(accepted(f), acceptedFirst ? 1 : 0);
      const tableCount = f.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='terms_evidence_meta'").get().n;
      assert.equal(tableCount, removedTable ? 0 : 1, 'failed open does not recreate missing metadata');
      if (!removedTable) assert.equal(f.db.prepare('SELECT count(*) AS n FROM terms_evidence_meta').get().n, 0);
    }
  }
});

test('retained state refuses malformed metadata without repairing or replacing its key', async t => {
  for (const acceptedFirst of [false, true]) {
    for (const malformedKey of [false, true]) {
      const f = fixture(t), intent = create(f);
      if (acceptedFirst) await submit(f, intent);
      f.store.close();
      if (malformedKey) f.db.prepare('UPDATE terms_evidence_meta SET receipt_key=?').run(Buffer.alloc(31));
      else f.db.prepare('UPDATE terms_evidence_meta SET domain=?').run('changed-test-domain');
      assert.throws(() => f.open(), /terms_state_changed/);
      const meta = f.db.prepare('SELECT * FROM terms_evidence_meta').get();
      assert.equal(malformedKey ? meta.receipt_key.length : meta.domain, malformedKey ? 31 : 'changed-test-domain');
      assert.equal(accepted(f), acceptedFirst ? 1 : 0);
    }
  }
});

test('persistent accepted-history count cap rejects new receipts while exact replay remains available', async t => {
  const f = fixture(t, ':memory:', { maxHistory: 1 });
  const first = create(f), cms = sign(first.bytes), receipt = (await submit(f, first, cms)).receipt;
  const next = create(f);
  await assert.rejects(submit(f, next), /terms_history_limit/);
  assert.equal(accepted(f), 1);
  f.store.close();
  const reopened = f.open({ maxHistory: undefined });
  await assert.rejects(reopened.submit(SESSION, { intentId: next.id, cms: sign(next.bytes) }), /terms_history_limit/);
  assert.deepEqual(await reopened.submit(SESSION, { intentId: first.id, cms }), { receipt, historical: true });
  assert.equal(reopened.list(DEAL).length, 1);
  assert.equal(f.db.prepare('SELECT cms FROM terms_evidence_intents WHERE id=?').get(next.id).cms, null);
});

test('persistent accepted CMS byte cap counts actual stored bytes and allows exact history at quota', async t => {
  const f = fixture(t, ':memory:', { maxCmsBytes: 6, verify: async () => ({
    verified: true, statusSource: 'test_ocsp', certificateDigest: CERTIFICATE, validUntil: 1_060_000, personal: true,
  }) });
  const first = create(f), second = create(f), next = create(f), cms = Buffer.from('abc');
  const receipt = (await submit(f, first, cms)).receipt;
  await submit(f, second, Buffer.from('def'));
  await assert.rejects(submit(f, next, Buffer.from('g')), /terms_history_limit/);
  assert.equal(accepted(f), 2);
  assert.equal(f.db.prepare('SELECT sum(length(cms)) AS n FROM terms_evidence_intents').get().n, 6);
  f.store.close(); const reopened = f.open({ maxCmsBytes: undefined });
  await assert.rejects(reopened.submit(SESSION, { intentId: next.id, cms: Buffer.from('g') }), /terms_history_limit/);
  assert.deepEqual(await reopened.submit(SESSION, { intentId: first.id, cms }), { receipt, historical: true });
  assert.equal(reopened.list(DEAL).length, 2);
});

test('parallel distinct intents enforce the persistent history cap inside the acceptance transaction', async t => {
  const f = fixture(t, ':memory:', { maxHistory: 1 }), gate = deferred();
  const store = f.open({ verify: async () => { await gate.promise; return f.outcome(); } });
  const first = store.createIntent(SESSION, { dealId: DEAL, expectedVersion: 1 });
  const second = store.createIntent(SESSION, { dealId: DEAL, expectedVersion: 1 });
  const firstCms = sign(first.bytes), secondCms = sign(second.bytes);
  const p1 = store.submit(SESSION, { intentId: first.id, cms: firstCms });
  const p2 = store.submit(SESSION, { intentId: second.id, cms: secondCms });
  const settled = Promise.allSettled([p1, p2]); gate.resolve();
  const results = await settled;
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
  assert.match(results[1].reason.message, /terms_history_limit/); assert.equal(accepted(f), 1);
  assert.deepEqual(await store.submit(SESSION, { intentId: first.id, cms: firstCms }), {
    receipt: results[0].value.receipt, historical: true,
  });
});

test('tightening persisted limits preserves overquota history and blocks all new receipts after restart', async t => {
  const f = fixture(t, ':memory:', { verify: async () => ({
    verified: true, statusSource: 'test_ocsp', certificateDigest: CERTIFICATE, validUntil: 1_060_000, personal: true,
  }) });
  const first = create(f), second = create(f), cms = Buffer.from('abc');
  const r1 = (await submit(f, first, cms)).receipt, r2 = (await submit(f, second, cms)).receipt;
  const next = create(f), tightened = f.open({ maxHistory: 1, maxCmsBytes: 5 });
  assert.equal(tightened.list(DEAL).length, 2);
  await assert.rejects(submit(f, next, cms), /terms_history_limit/, 'already-open stores also honor the stored tighter limit');
  tightened.close(); f.store.close();
  const reopened = f.open();
  await assert.rejects(reopened.submit(SESSION, { intentId: next.id, cms }), /terms_history_limit/);
  assert.deepEqual(await reopened.submit(SESSION, { intentId: first.id, cms }), { receipt: r1, historical: true });
  assert.deepEqual(await reopened.submit(SESSION, { intentId: second.id, cms }), { receipt: r2, historical: true });
  assert.equal(reopened.list(DEAL).length, 2);
  assert.equal(accepted(f), 2);
  assert.equal(f.db.prepare('SELECT sum(length(cms)) AS n FROM terms_evidence_intents').get().n, 6);
});

test('history limits reject malformed and unbounded constructor values without changing metadata', t => {
  const f = fixture(t);
  for (const [name, maximum] of [['maxHistory', 500], ['maxCmsBytes', 16 * 1024 * 1024]]) {
    for (const value of [0, -1, 1.5, '1', Infinity, NaN, maximum + 1]) {
      assert.throws(() => f.open({ [name]: value }), /terms_dependencies_invalid/);
    }
  }
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM terms_evidence_meta').get().n, 1);
});

test('valid legacy metadata gains persistent limits without replacing the receipt key or historical evidence', async t => {
  const f = fixture(t), intent = create(f), cms = sign(intent.bytes), receipt = (await submit(f, intent, cms)).receipt;
  f.store.close();
  const key = Buffer.from(f.db.prepare('SELECT receipt_key FROM terms_evidence_meta').get().receipt_key);
  try {
    f.db.exec(`ALTER TABLE terms_evidence_meta RENAME TO previous_terms_meta;
      CREATE TABLE terms_evidence_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        domain TEXT NOT NULL,receipt_key BLOB NOT NULL) STRICT;`);
    f.db.prepare('INSERT INTO terms_evidence_meta VALUES (1,?,?)').run('dalahold:test-terms-evidence:v1', key);
    f.db.exec('DROP TABLE previous_terms_meta');
    const reopened = f.open();
    const meta = f.db.prepare('SELECT * FROM terms_evidence_meta').get();
    assert.ok(Buffer.from(meta.receipt_key).equals(key), 'legacy migration retains the original private receipt key');
    assert.equal(meta.history_limit, 500); assert.equal(meta.cms_byte_limit, 16 * 1024 * 1024);
    assert.deepEqual(await reopened.submit(SESSION, { intentId: intent.id, cms }), { receipt, historical: true });
    assert.equal(reopened.list(DEAL).length, 1);
  } finally { key.fill(0); }
});

test('stored history ceiling survives a new SQLite connection and cannot be increased on reopen', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-terms-quota-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'workspace.sqlite'), f = fixture(t, path, { maxHistory: 1 });
  const first = create(f), cms = sign(first.bytes), receipt = (await submit(f, first, cms)).receipt;
  const next = create(f); f.store.close();
  const db = new DatabaseSync(path);
  const store = new TermsEvidence({ db, maxHistory: 500, verify: async () => f.outcome(), now: () => f.time,
    readSnapshot(dealId) {
      const row = db.prepare('SELECT * FROM drafts WHERE deal_id=?').get(dealId);
      const terms = { dealId, version: row.version, scenario: row.scenario, quantity: row.quantity, amount: row.amount, date: row.date };
      return { terms, termsFingerprint: fingerprintDraftTerms(terms), documents: [] };
    },
  });
  try {
    assert.equal(db.prepare('SELECT history_limit FROM terms_evidence_meta').get().history_limit, 1);
    await assert.rejects(store.submit(SESSION, { intentId: next.id, cms: sign(next.bytes) }), /terms_history_limit/);
    assert.deepEqual(await store.submit(SESSION, { intentId: first.id, cms }), { receipt, historical: true });
    assert.equal(store.list(DEAL).length, 1);
  } finally { store.close(); db.close(); }
});

test('malformed retained quota metadata fails closed without repairing persisted ceilings', async t => {
  const f = fixture(t), intent = create(f); await submit(f, intent); f.store.close();
  f.db.exec('PRAGMA ignore_check_constraints=ON');
  f.db.prepare('UPDATE terms_evidence_meta SET history_limit=0').run();
  assert.throws(() => f.open(), /terms_state_changed/);
  assert.equal(f.db.prepare('SELECT history_limit FROM terms_evidence_meta').get().history_limit, 0);
  assert.equal(accepted(f), 1);
});
