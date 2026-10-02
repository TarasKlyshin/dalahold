import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { TestDocumentError, TestDocuments } from './test-documents.mjs';

const dealId = 'e85a7c90-cc44-4a9a-a5c5-e1f65c736227';
const otherDealId = 'cccb1fa8-caa0-43cd-bc42-4e3a6085bcf1';
const terms = { scenario: 'livestock', quantity: 12, amount: 8_400_000, date: '2026-10-10' };

function open(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY, version INTEGER NOT NULL, scenario TEXT NOT NULL,
      quantity INTEGER NOT NULL, amount INTEGER NOT NULL, date TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS draft_versions (
      deal_id TEXT NOT NULL REFERENCES drafts(id), version INTEGER NOT NULL,
      scenario TEXT NOT NULL, quantity INTEGER NOT NULL, amount INTEGER NOT NULL, date TEXT NOT NULL,
      PRIMARY KEY (deal_id, version)
    ) STRICT;
  `);
  return db;
}

function seed(db, id = dealId) {
  db.prepare('INSERT INTO drafts VALUES (?, 1, ?, ?, ?, ?)').run(
    id, terms.scenario, terms.quantity, terms.amount, terms.date,
  );
  db.prepare('INSERT INTO draft_versions VALUES (?, 1, ?, ?, ?, ?)').run(
    id, terms.scenario, terms.quantity, terms.amount, terms.date,
  );
}

function revise(db, id = dealId) {
  db.exec('BEGIN IMMEDIATE');
  db.prepare('UPDATE drafts SET version = 2, quantity = 13 WHERE id = ?').run(id);
  db.prepare('INSERT INTO draft_versions VALUES (?, 2, ?, 13, ?, ?)').run(
    id, terms.scenario, terms.amount, terms.date,
  );
  db.exec('COMMIT');
}

function fixture(t, options = {}) {
  const db = open();
  t.after(() => db.close());
  seed(db);
  return { db, store: new TestDocuments({ db, now: () => 1234, ...options }) };
}

function input(overrides = {}) {
  return {
    dealId, expectedVersion: 1, requestId: randomUUID(), category: 'contract',
    bytes: Buffer.from('Локальный TEST-документ\nOnly plain text.\n'), ...overrides,
  };
}

function code(expected) {
  return (error) => error instanceof TestDocumentError && error.code === expected;
}

test('stores only stable TEST metadata and copied UTF-8 bytes', (t) => {
  const { store } = fixture(t);
  const value = input();
  const original = Buffer.from(value.bytes);
  const document = store.add(value);
  assert.deepEqual(Object.keys(document), [
    'id', 'dealId', 'termsVersion', 'category', 'byteLength', 'sha256', 'createdAt', 'scope', 'fileKind',
  ]);
  assert.match(document.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(document.dealId, dealId);
  assert.equal(document.termsVersion, 1);
  assert.equal(document.category, 'contract');
  assert.equal(document.byteLength, original.length);
  assert.equal(document.sha256, createHash('sha256').update(original).digest('hex'));
  assert.equal(document.createdAt, 1234);
  assert.equal(document.scope, 'local_test_document_only');
  assert.equal(document.fileKind, 'text');
  value.bytes.fill(0);
  const read = store.read(dealId, document.id);
  assert.deepEqual(read.document, document);
  assert.equal(Buffer.isBuffer(read.bytes), true);
  assert.deepEqual(read.bytes, original);
  read.bytes.fill(0);
  assert.deepEqual(store.read(dealId, document.id).bytes, original);
  assert.deepEqual(store.list(dealId, 1), [document]);
});

test('BLOBs, metadata and exact idempotency survive database restart', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-test-documents-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'documents.sqlite');
  let db = open(path);
  seed(db);
  let store = new TestDocuments({ db, now: () => 1234 });
  const value = input();
  const document = store.add(value);
  db.close();
  db = open(path);
  t.after(() => db.close());
  store = new TestDocuments({ db, now: () => 5678 });
  assert.deepEqual(store.add(value), document);
  assert.deepEqual(store.list(dealId, 1), [document]);
  assert.deepEqual(store.read(dealId, document.id), { document, bytes: value.bytes });
  assert.equal(db.prepare('SELECT typeof(bytes) AS kind FROM test_documents').get().kind, 'blob');
});

test('old versions remain separate and stale new additions fail', (t) => {
  const { db, store } = fixture(t);
  const value = input();
  const first = store.add(value);
  revise(db);
  assert.deepEqual(store.add(value), first);
  assert.throws(() => store.add(input()), code('stale_draft'));
  const second = store.add(input({ expectedVersion: 2, category: 'delivery' }));
  assert.deepEqual(store.list(dealId, 1), [first]);
  assert.deepEqual(store.list(dealId, 2), [second]);
  assert.deepEqual(store.read(dealId, first.id).document, first);
  assert.throws(() => store.list(dealId, 3), code('not_found'));
});

test('an exact request has one entry and altered payload or deal conflicts', (t) => {
  const { db, store } = fixture(t);
  seed(db, otherDealId);
  const value = input();
  const first = store.add(value);
  assert.deepEqual(store.add({ ...value, bytes: Buffer.from(value.bytes) }), first);
  for (const overrides of [
    { category: 'other' }, { bytes: Buffer.from('changed') }, { expectedVersion: 2 },
    { dealId: otherDealId },
  ]) assert.throws(() => store.add({ ...value, ...overrides }), code('idempotency_conflict'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM test_documents').get().count, 1);
});

test('strict input rejects coercion, extra authority fields, accessors and prototypes', (t) => {
  const { store } = fixture(t);
  let touched = false;
  const coercion = { toString() { touched = true; return dealId; } };
  const value = input();
  const accessor = { ...value };
  Object.defineProperty(accessor, 'bytes', { enumerable: true, get() { touched = true; return value.bytes; } });
  for (const candidate of [
    { ...value, dealId: coercion }, { ...value, requestId: coercion },
    { ...value, dealId: dealId.toUpperCase() }, { ...value, expectedVersion: '1' },
    { ...value, expectedVersion: 0 }, { ...value, expectedVersion: NaN },
    { ...value, bytes: new Uint8Array([65]) }, { ...value, bytes: 'text' },
    { ...value, bytes: { type: 'Buffer', data: [65] } }, { ...value, category: coercion },
    { ...value, bytes: new Proxy(value.bytes, { get() { touched = true; throw new Error('proxy'); } }) },
    { ...value, category: 'identity' }, { ...value, filename: 'private.txt' },
    { ...value, author: 'verified' }, { ...value, [Symbol('hidden')]: true },
    Object.assign(Object.create({ inherited: true }), value), accessor, null, [],
    new Proxy(value, { ownKeys() { touched = true; throw new Error('proxy'); } }),
  ]) assert.throws(() => store.add(candidate), code('invalid_document'));
  assert.equal(touched, false);
  const noPrototype = Object.assign(Object.create(null), input());
  assert.equal(store.add(noPrototype).fileKind, 'text');
});

test('plain text rejects NUL, control bytes, invalid UTF-8 and recognizable binary formats', (t) => {
  const { store } = fixture(t);
  for (const bytes of [
    Buffer.alloc(0), Buffer.from('text\0tail'), Buffer.from([0xc3, 0x28]),
    Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]),
    Buffer.from('text\u0001'), Buffer.from('text\u007f'), Buffer.from('text\u0085'),
    Buffer.from('%PDF-1.7\n'), Buffer.from('PK\u0003\u0004'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  ]) assert.throws(() => store.add(input({ bytes })), code('invalid_document'));
  const bytes = Buffer.from('\ufeffPlain UTF-8\t\r\nҚазақша\n<script>literal text</script>');
  const document = store.add(input({ bytes }));
  assert.deepEqual(store.read(dealId, document.id).bytes, bytes);
});

test('file and per-version limits include the boundary and preserve exact retries', (t) => {
  const { db, store } = fixture(t);
  assert.throws(() => store.add(input({ bytes: Buffer.alloc(262145, 65) })), code('document_limit'));
  const value = input({ bytes: Buffer.alloc(262144, 65) });
  const first = store.add(value);
  for (let i = 1; i < 10; i += 1) store.add(input());
  assert.throws(() => store.add(input()), code('document_limit'));
  assert.deepEqual(store.add(value), first);
  assert.equal(store.list(dealId, 1).length, 10);
  revise(db);
  assert.equal(store.add(input({ expectedVersion: 2 })).termsVersion, 2);
});

test('global byte and row quotas are checked atomically across versions and deals', (t) => {
  const { db, store } = fixture(t, { maxTotalBytes: 5 });
  seed(db, otherDealId);
  const value = input({ bytes: Buffer.from('abc') });
  const first = store.add(value);
  assert.throws(() => store.add(input({ dealId: otherDealId, bytes: Buffer.from('xyz') })), code('storage_limit'));
  assert.deepEqual(store.add(value), first);
  store.add(input({ dealId: otherDealId, bytes: Buffer.from('xy') }));
  assert.throws(() => store.add(input({ bytes: Buffer.from('a') })), code('storage_limit'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM test_documents').get().count, 2);
  const rowLimited = new TestDocuments({ db, maxTotalDocuments: 2 });
  assert.throws(() => rowLimited.add(input({ bytes: Buffer.from('a') })), code('storage_limit'));
});

test('manifest is minimal, deterministic, sorted and limited to the requested version', (t) => {
  const { db, store } = fixture(t);
  const first = store.add(input({ category: 'quality' }));
  const second = store.add(input({ category: 'other' }));
  const expected = [first, second].sort((a, b) => a.id.localeCompare(b.id)).map(
    ({ id, category, byteLength, sha256 }) => ({ id, category, byteLength, sha256 }),
  );
  assert.deepEqual(store.manifest(dealId, 1), expected);
  revise(db);
  assert.deepEqual(store.manifest(dealId, 2), []);
  assert.deepEqual(store.manifest(dealId, 1), expected);
});

test('read cannot cross deals and unknown or injected identifiers fail', (t) => {
  const { db, store } = fixture(t);
  seed(db, otherDealId);
  const document = store.add(input());
  assert.throws(() => store.read(otherDealId, document.id), code('not_found'));
  assert.throws(() => store.read(dealId, randomUUID()), code('not_found'));
  assert.throws(() => store.list(randomUUID(), 1), code('not_found'));
  assert.throws(() => store.add(input({ dealId: randomUUID() })), code('not_found'));
  for (const candidate of [undefined, {}, '../document', `${dealId}' OR 1=1`, dealId.toUpperCase()]) {
    assert.throws(() => store.list(candidate, 1), code('invalid_document'));
    assert.throws(() => store.read(dealId, candidate), code('invalid_document'));
  }
});

test('all read paths fail closed after byte, hash, size, text or metadata tampering', (t) => {
  const mutations = [
    ['bytes = ?', Buffer.from('other bytes')],
    ['sha256 = ?', 'a'.repeat(64)],
    ['byte_length = ?', 1],
    ['category = ?', 'forged'],
    ['created_at = ?', -1],
    ['terms_fingerprint = ?', 'a'.repeat(64)],
  ];
  for (const [assignment, value] of mutations) {
    const { db, store } = fixture(t);
    const request = input();
    const document = store.add(request);
    db.exec('PRAGMA ignore_check_constraints = ON');
    db.prepare(`UPDATE test_documents SET ${assignment} WHERE id = ?`).run(value, document.id);
    for (const read of [
      () => store.read(dealId, document.id), () => store.list(dealId, 1),
      () => store.manifest(dealId, 1), () => store.add(request),
    ]) assert.throws(read, code('document_corrupt'));
  }
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from('x\0')]) {
    const { db, store } = fixture(t);
    const document = store.add(input());
    db.prepare('UPDATE test_documents SET bytes = ?, byte_length = ?, sha256 = ? WHERE id = ?').run(
      bytes, bytes.length, createHash('sha256').update(bytes).digest('hex'), document.id,
    );
    assert.throws(() => store.read(dealId, document.id), code('document_corrupt'));
    assert.throws(() => store.list(dealId, 1), code('document_corrupt'));
  }
});

test('missing or inconsistent archived terms prevent adds and historical reads', (t) => {
  const { db, store } = fixture(t);
  db.prepare('UPDATE draft_versions SET quantity = 13 WHERE deal_id = ?').run(dealId);
  assert.throws(() => store.add(input()), code('document_corrupt'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM test_documents').get().count, 0);
  db.prepare('UPDATE draft_versions SET quantity = 12 WHERE deal_id = ?').run(dealId);
  const document = store.add(input());
  revise(db);
  db.prepare('UPDATE draft_versions SET quantity = 14 WHERE deal_id = ? AND version = 1').run(dealId);
  assert.throws(() => store.read(dealId, document.id), code('document_corrupt'));
  assert.throws(() => store.list(dealId, 1), code('document_corrupt'));
});

test('injected database association fails closed rather than trusting foreign-key state', (t) => {
  const { db, store } = fixture(t);
  const document = store.add(input());
  db.exec('PRAGMA foreign_keys = OFF');
  db.prepare('UPDATE test_documents SET terms_version = 2 WHERE id = ?').run(document.id);
  assert.throws(() => store.read(dealId, document.id), code('document_corrupt'));
  db.prepare('UPDATE test_documents SET terms_version = 1 WHERE id = ?').run(document.id);
  db.prepare('DELETE FROM draft_versions WHERE deal_id = ?').run(dealId);
  assert.throws(() => store.read(dealId, document.id), code('document_corrupt'));
});

test('a database failure rolls back the insert and releases the transaction for retry', (t) => {
  const { db, store } = fixture(t);
  db.exec(`CREATE TRIGGER fail_document AFTER INSERT ON test_documents
    BEGIN SELECT RAISE(ABORT, 'test failure'); END`);
  const value = input();
  assert.throws(() => store.add(value), /test failure/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM test_documents').get().count, 0);
  db.exec('DROP TRIGGER fail_document');
  assert.equal(store.add(value).termsVersion, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM test_documents').get().count, 1);
});

test('a clock failure rolls back and cannot persist partial metadata', (t) => {
  const { db } = fixture(t);
  const invalidClock = new TestDocuments({ db, now: () => NaN });
  assert.throws(() => invalidClock.add(input()), code('invalid_document'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM test_documents').get().count, 0);
  assert.equal(new TestDocuments({ db }).add(input()).termsVersion, 1);
});

test('nested add and manifest keep the caller transaction and rollback boundary', (t) => {
  const { db, store } = fixture(t);
  db.exec('BEGIN IMMEDIATE');
  const first = store.add(input());
  assert.equal(db.isTransaction, true);
  assert.equal(store.manifest(dealId, 1)[0].id, first.id);
  assert.equal(db.isTransaction, true);
  db.exec('ROLLBACK');
  assert.deepEqual(store.list(dealId, 1), []);

  db.exec('BEGIN IMMEDIATE');
  const second = store.add(input());
  db.exec(`CREATE TRIGGER fail_nested AFTER INSERT ON test_documents
    BEGIN SELECT RAISE(ABORT, 'nested failure'); END`);
  assert.throws(() => store.add(input()), /nested failure/);
  assert.equal(db.isTransaction, true);
  assert.deepEqual(store.list(dealId, 1), [second]);
  db.exec('DROP TRIGGER fail_nested');
  db.exec('COMMIT');
  assert.deepEqual(store.list(dealId, 1), [second]);
});

test('constructor rejects unbounded storage and invalid dependencies', () => {
  const db = open();
  try {
    for (const options of [
      {}, { db: {} }, { db, now: 123 }, { db, maxTotalBytes: 0 },
      { db, maxTotalBytes: 8 * 1024 * 1024 + 1 }, { db, maxTotalDocuments: 1025 },
    ]) assert.throws(() => new TestDocuments(options), code('invalid_document'));
  } finally { db.close(); }
});
