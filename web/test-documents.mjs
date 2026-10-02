// Local TEST text attachments only. These bytes establish no author, identity,
// signature, authenticity, business authority or payment status.
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { TextDecoder, types } from 'node:util';
import { fingerprintDraftTerms } from './terms.mjs';

export const TEST_DOCUMENT_MAX_BYTES = 262_144;
export const TEST_DOCUMENT_MAX_PER_VERSION = 10;
export const TEST_DOCUMENT_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const TEST_DOCUMENT_MAX_TOTAL_DOCUMENTS = 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const CATEGORIES = new Set(['contract', 'delivery', 'quality', 'other']);
const FIELDS = ['dealId', 'expectedVersion', 'requestId', 'category', 'bytes'];
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const STATUS = {
  invalid_document: 400, not_found: 404, stale_draft: 409, idempotency_conflict: 409,
  document_corrupt: 409, document_limit: 413, storage_limit: 413,
};

export class TestDocumentError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TestDocumentError';
    this.code = code;
    this.status = STATUS[code];
  }
}

function fail(code) { throw new TestDocumentError(code); }
function isUuid(value) { return typeof value === 'string' && UUID.test(value); }
function isVersion(value) { return Number.isSafeInteger(value) && value >= 1; }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function plainText(bytes) {
  if (bytes.length < 1 || bytes.length > TEST_DOCUMENT_MAX_BYTES) return false;
  let text;
  try { text = decoder.decode(bytes); } catch { return false; }
  // Tabs and line endings belong to plain text; other Unicode control bytes do
  // not. Content is always served as text/plain by the caller, never as HTML.
  if (/[\p{Cc}]/u.test(text.replace(/[\t\r\n]/g, ''))) return false;
  // A PDF can contain entirely valid ASCII. Do not accept its format header as
  // a text document just because it happened to pass UTF-8 decoding.
  return !text.replace(/^\ufeff/, '').startsWith('%PDF-');
}

function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) {
    fail('invalid_document');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('invalid_document');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== FIELDS.length || !FIELDS.every((field) => keys.includes(field))) {
    fail('invalid_document');
  }
  const values = FIELDS.map((field) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('invalid_document');
    return descriptor.value;
  });
  const [dealId, expectedVersion, requestId, category, suppliedBytes] = values;
  if (!isUuid(dealId) || !isUuid(requestId) || !isVersion(expectedVersion) ||
      typeof category !== 'string' || !CATEGORIES.has(category) || !Buffer.isBuffer(suppliedBytes) ||
      types.isProxy(suppliedBytes)) {
    fail('invalid_document');
  }
  if (suppliedBytes.length > TEST_DOCUMENT_MAX_BYTES) fail('document_limit');
  let bytes;
  try { bytes = Buffer.from(suppliedBytes); } catch { fail('invalid_document'); }
  if (!plainText(bytes)) fail('invalid_document');
  return { dealId, expectedVersion, requestId, category, bytes, sha256: digest(bytes) };
}

// The host owns and closes the database, creates its private directory/file and
// establishes the drafts/draft_versions schema before constructing this store.
export class TestDocuments {
  #db;
  #now;
  #maxTotalBytes;
  #maxTotalDocuments;

  constructor({ db, now = Date.now, maxTotalBytes = TEST_DOCUMENT_MAX_TOTAL_BYTES,
    maxTotalDocuments = TEST_DOCUMENT_MAX_TOTAL_DOCUMENTS } = {}) {
    if (!(db instanceof DatabaseSync) || typeof now !== 'function' ||
        !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1 ||
        maxTotalBytes > TEST_DOCUMENT_MAX_TOTAL_BYTES ||
        !Number.isSafeInteger(maxTotalDocuments) || maxTotalDocuments < 1 ||
        maxTotalDocuments > TEST_DOCUMENT_MAX_TOTAL_DOCUMENTS) {
      fail('invalid_document');
    }
    this.#db = db;
    this.#now = now;
    this.#maxTotalBytes = maxTotalBytes;
    this.#maxTotalDocuments = maxTotalDocuments;
    db.exec(`
      CREATE TABLE IF NOT EXISTS test_documents (
        id TEXT PRIMARY KEY,
        deal_id TEXT NOT NULL,
        terms_version INTEGER NOT NULL CHECK (terms_version >= 1),
        request_id TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL CHECK (category IN ('contract', 'delivery', 'quality', 'other')),
        bytes BLOB NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 262144),
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        terms_fingerprint TEXT NOT NULL CHECK (length(terms_fingerprint) = 64),
        CHECK (length(bytes) = byte_length),
        FOREIGN KEY (deal_id, terms_version) REFERENCES draft_versions(deal_id, version)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS test_documents_version
        ON test_documents (deal_id, terms_version, created_at, id);
    `);
  }

  #transaction(action, write = false) {
    // Reading a manifest within its caller's transaction keeps an attestation
    // bound to the same SQLite snapshot. Nested writes use a local savepoint.
    if (this.#db.isTransaction && !write) return action();
    const nested = this.#db.isTransaction;
    const savepoint = nested ? `test_documents_${randomUUID().replaceAll('-', '')}` : undefined;
    this.#db.exec(nested ? `SAVEPOINT ${savepoint}` : write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      const result = action();
      this.#db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      if (nested) {
        this.#db.exec(`ROLLBACK TO ${savepoint}`);
        this.#db.exec(`RELEASE ${savepoint}`);
      } else this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #termsFingerprint(dealId, version, row) {
    if (!row || !isVersion(version) || !['livestock', 'grain'].includes(row.scenario) ||
        !Number.isSafeInteger(row.quantity) || row.quantity < 1 || row.quantity > 100_000 ||
        !Number.isSafeInteger(row.amount) || row.amount < 1 || row.amount > 999_999_999_999) {
      fail('document_corrupt');
    }
    try {
      return fingerprintDraftTerms({ dealId, version, scenario: row.scenario,
        quantity: row.quantity, amount: row.amount, date: row.date });
    } catch { fail('document_corrupt'); }
  }

  #version(dealId, version, corruptMissing = false) {
    const current = this.#db.prepare(
      'SELECT version, scenario, quantity, amount, date FROM drafts WHERE id = ?',
    ).get(dealId);
    if (!current) fail(corruptMissing ? 'document_corrupt' : 'not_found');
    const archived = this.#db.prepare(`SELECT scenario, quantity, amount, date
      FROM draft_versions WHERE deal_id = ? AND version = ?`);
    const currentFingerprint = this.#termsFingerprint(dealId, current.version, current);
    const archivedCurrent = archived.get(dealId, current.version);
    if (this.#termsFingerprint(dealId, current.version, archivedCurrent) !== currentFingerprint) {
      fail('document_corrupt');
    }
    const requested = version === current.version ? archivedCurrent : archived.get(dealId, version);
    if (!requested) fail(corruptMissing ? 'document_corrupt' : 'not_found');
    return { currentVersion: current.version,
      fingerprint: this.#termsFingerprint(dealId, version, requested) };
  }

  #validated(row) {
    if (!row || !isUuid(row.id) || !isUuid(row.deal_id) || !isUuid(row.request_id) ||
        !isVersion(row.terms_version) || typeof row.category !== 'string' || !CATEGORIES.has(row.category) ||
        !Number.isSafeInteger(row.byte_length) || row.byte_length < 1 ||
        row.byte_length > TEST_DOCUMENT_MAX_BYTES ||
        typeof row.sha256 !== 'string' || !HASH.test(row.sha256) ||
        typeof row.terms_fingerprint !== 'string' || !HASH.test(row.terms_fingerprint) ||
        !Number.isSafeInteger(row.created_at) || row.created_at < 0 ||
        !(row.bytes instanceof Uint8Array)) fail('document_corrupt');
    const bytes = Buffer.from(row.bytes);
    if (bytes.length !== row.byte_length || !plainText(bytes) || digest(bytes) !== row.sha256 ||
        this.#version(row.deal_id, row.terms_version, true).fingerprint !== row.terms_fingerprint) {
      fail('document_corrupt');
    }
    return { document: {
      id: row.id, dealId: row.deal_id, termsVersion: row.terms_version, category: row.category,
      byteLength: row.byte_length, sha256: row.sha256, createdAt: row.created_at,
      scope: 'local_test_document_only', fileKind: 'text',
    }, bytes };
  }

  add(value) {
    const input = normalize(value);
    return this.#transaction(() => {
      const existing = this.#db.prepare('SELECT * FROM test_documents WHERE request_id = ?')
        .get(input.requestId);
      if (existing) {
        const { document, bytes } = this.#validated(existing);
        if (document.dealId !== input.dealId || document.termsVersion !== input.expectedVersion ||
            document.category !== input.category || document.sha256 !== input.sha256 ||
            !bytes.equals(input.bytes)) fail('idempotency_conflict');
        return document;
      }
      const current = this.#db.prepare('SELECT version FROM drafts WHERE id = ?').get(input.dealId);
      if (!current) fail('not_found');
      // Check the live/archive agreement before any mutation, including before
      // returning a normal stale-version conflict.
      const version = this.#version(input.dealId, current.version);
      if (version.currentVersion !== input.expectedVersion) fail('stale_draft');
      const count = this.#db.prepare(`SELECT COUNT(*) AS count FROM test_documents
        WHERE deal_id = ? AND terms_version = ?`).get(input.dealId, input.expectedVersion).count;
      if (count >= TEST_DOCUMENT_MAX_PER_VERSION) fail('document_limit');
      const total = this.#db.prepare(`SELECT COUNT(*) AS count,
        COALESCE(SUM(length(bytes)), 0) AS byteLength FROM test_documents`).get();
      if (total.count >= this.#maxTotalDocuments ||
          total.byteLength + input.bytes.length > this.#maxTotalBytes) fail('storage_limit');
      const createdAt = this.#now();
      if (!Number.isSafeInteger(createdAt) || createdAt < 0) fail('invalid_document');
      const id = randomUUID();
      this.#db.prepare(`INSERT INTO test_documents
        (id, deal_id, terms_version, request_id, category, bytes, byte_length, sha256, created_at, terms_fingerprint)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.dealId, input.expectedVersion,
        input.requestId, input.category, input.bytes, input.bytes.length, input.sha256, createdAt, version.fingerprint);
      return this.#validated(this.#db.prepare('SELECT * FROM test_documents WHERE id = ?').get(id)).document;
    }, true);
  }

  list(dealId, version) {
    if (!isUuid(dealId) || !isVersion(version)) fail('invalid_document');
    return this.#transaction(() => {
      const rows = this.#db.prepare(`SELECT * FROM test_documents WHERE deal_id = ? AND terms_version = ?
        ORDER BY created_at ASC, id ASC`).all(dealId, version);
      this.#version(dealId, version, rows.length > 0);
      if (rows.length > TEST_DOCUMENT_MAX_PER_VERSION) fail('document_corrupt');
      return rows.map((row) => this.#validated(row).document);
    });
  }

  read(dealId, documentId) {
    if (!isUuid(dealId) || !isUuid(documentId)) fail('invalid_document');
    return this.#transaction(() => {
      const row = this.#db.prepare('SELECT * FROM test_documents WHERE deal_id = ? AND id = ?')
        .get(dealId, documentId);
      if (!row) fail('not_found');
      return this.#validated(row);
    });
  }

  manifest(dealId, version) {
    return this.list(dealId, version).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      .map(({ id, category, byteLength, sha256 }) => ({ id, category, byteLength, sha256 }));
  }
}
