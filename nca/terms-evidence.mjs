// One-sided personal TEST CMS evidence only. This grants no business decision,
// login, role, access, corporate powers, wallet or payment authorization.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fingerprintDraftTerms } from '../web/terms.mjs';

const DOMAIN = 'dalahold:test-terms-evidence:v1';
const SOURCE = 'test_ocsp';
const ACTION = 'record_test_terms_signature';
const SCOPE = 'test_terms_evidence_only';
const PURPOSE = 'TEST only: record one personal TEST CMS signature over these exact terms and document digests. No transaction approval, role, access, corporate powers, wallet or payment is authorized.';
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CATEGORIES = new Set(['contract', 'delivery', 'quality', 'other']);
export const TERMS_EVIDENCE_MAX_HISTORY = 500;
export const TERMS_EVIDENCE_MAX_CMS_BYTES = 16 * 1024 * 1024;
const sharedSlots = new WeakMap();
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new Error(code); };
const isHash = value => typeof value === 'string' && HASH.test(value);
const isUuid = value => typeof value === 'string' && UUID.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const boundedLimit = (value, maximum) => Number.isSafeInteger(value) && value >= 1 && value <= maximum;

function metadata(row, legacy = false) {
  const names = ['singleton', 'domain', 'receipt_key'];
  if (!legacy) names.push('history_limit', 'cms_byte_limit');
  const value = fields(row, names, 'terms_state_changed');
  if (value.singleton !== 1 || value.domain !== DOMAIN ||
      !(value.receipt_key instanceof Uint8Array) || value.receipt_key.length !== 32 ||
      (!legacy && (!boundedLimit(value.history_limit, TERMS_EVIDENCE_MAX_HISTORY) ||
        !boundedLimit(value.cms_byte_limit, TERMS_EVIDENCE_MAX_CMS_BYTES)))) fail('terms_state_changed');
  return value;
}

// Only own data fields are accepted, so injected getters/prototypes cannot swap
// validated values or add fields to the signed representation.
function fields(value, names, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || !names.every(name => keys.includes(name))) fail(code);
  const result = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(code);
    result[name] = descriptor.value;
  }
  return result;
}

function snapshot(value, code = 'terms_snapshot_invalid') {
  const input = fields(value, ['terms', 'termsFingerprint', 'documents'], code);
  const terms = fields(input.terms, ['dealId', 'version', 'scenario', 'quantity', 'amount', 'date'], code);
  let fingerprint;
  try { fingerprint = fingerprintDraftTerms(terms); } catch { fail(code); }
  if (!isHash(input.termsFingerprint) || input.termsFingerprint !== fingerprint ||
      !Array.isArray(input.documents) || input.documents.length > 10) fail(code);
  const documents = [];
  for (let index = 0; index < input.documents.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input.documents, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(code);
    const document = fields(descriptor.value, ['id', 'category', 'byteLength', 'sha256'], code);
    if (!isUuid(document.id) || !CATEGORIES.has(document.category) ||
        !Number.isSafeInteger(document.byteLength) || document.byteLength < 1 || document.byteLength > 262_144 ||
        !isHash(document.sha256)) fail(code);
    documents.push(document);
  }
  // Reject non-index properties, holes and symbol fields on a manifest array.
  if (Reflect.ownKeys(input.documents).length !== input.documents.length + 1) fail(code);
  documents.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (documents.some((document, index) => index && document.id === documents[index - 1].id)) fail(code);
  return { terms, termsFingerprint: fingerprint, documents };
}

const encode = intent => Buffer.from(JSON.stringify(intent, null, 2) + '\n', 'utf8');
function decode(row) {
  const code = 'terms_intent_changed';
  if (!isUuid(row.id) || !isHash(row.session_hash) || !isHash(row.bytes_hash) ||
      !integer(row.expires_at) || !(row.bytes instanceof Uint8Array)) fail(code);
  const bytes = Buffer.from(row.bytes);
  if (sha(bytes) !== row.bytes_hash) fail(code);
  let input;
  try { input = JSON.parse(bytes.toString('utf8')); } catch { fail(code); }
  input = fields(input, ['domain', 'purpose', 'action', 'nonce', 'sessionHash', 'issuedAt', 'expiresAt', 'statusSource', 'snapshot'], code);
  if (input.domain !== DOMAIN || input.purpose !== PURPOSE || input.action !== ACTION ||
      input.statusSource !== SOURCE || input.nonce !== row.id || input.sessionHash !== row.session_hash ||
      !integer(input.issuedAt) || !integer(input.expiresAt) ||
      input.expiresAt !== input.issuedAt + 300_000 || input.expiresAt !== row.expires_at) fail(code);
  input.snapshot = snapshot(input.snapshot, code);
  if (!encode(input).equals(bytes)) fail(code);
  return { intent: input, bytes };
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const mac = (key, row) => createHmac('sha256', key).update(`${DOMAIN}:receipt\0`)
  .update(JSON.stringify([row.id, row.session_hash, row.bytes_hash, row.expires_at,
    row.signature_hash, row.receipt_json])).digest('hex');

function guard(options) {
  if (options === undefined) return () => {};
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
      Reflect.ownKeys(options).some(key => key !== 'assertCurrent')) fail('terms_guard_invalid');
  if (!Object.hasOwn(options, 'assertCurrent')) return () => {};
  const descriptor = Object.getOwnPropertyDescriptor(options, 'assertCurrent');
  if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') fail('terms_guard_invalid');
  return descriptor.value;
}

export class TermsEvidence {
  #db; #readSnapshot; #verify; #now; #key; #slots; #inflight = 0;
  #closed = false; #transaction = false;

  // db is caller-owned DatabaseSync and MUST also hold current draft/archive and
  // document data. readSnapshot(dealId) is synchronous and reads that same db;
  // it must refuse missing documents or digest-invalid document bytes. verify
  // is a trusted TEST SDK adapter, never a browser-supplied evidence object.
  // The key in this protected DB detects individual row edits, not a full DB
  // rewrite, database rollback or replacement. This is not production authority.
  // Optional limits can only tighten stored ceilings. Reopen without options
  // honors those ceilings; retained overquota evidence remains readable/replayable.
  constructor({ db, readSnapshot, verify, now = Date.now, maxHistory, maxCmsBytes }) {
    if (!(db instanceof DatabaseSync) || typeof readSnapshot !== 'function' ||
        typeof verify !== 'function' || typeof now !== 'function' ||
        (maxHistory !== undefined && !boundedLimit(maxHistory, TERMS_EVIDENCE_MAX_HISTORY)) ||
        (maxCmsBytes !== undefined && !boundedLimit(maxCmsBytes, TERMS_EVIDENCE_MAX_CMS_BYTES))) fail('terms_dependencies_invalid');
    this.#db = db; this.#readSnapshot = readSnapshot; this.#verify = verify; this.#now = now;
    this.#slots = sharedSlots.get(db) || { active: 0 };
    sharedSlots.set(db, this.#slots);
    // Bootstrap and valid legacy migration are atomic. Missing metadata with any
    // retained intent is corruption, never permission to provision another key.
    db.exec('BEGIN IMMEDIATE');
    let key;
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS terms_evidence_meta (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), domain TEXT NOT NULL, receipt_key BLOB NOT NULL,
        history_limit INTEGER NOT NULL CHECK(history_limit BETWEEN 1 AND 500),
        cms_byte_limit INTEGER NOT NULL CHECK(cms_byte_limit BETWEEN 1 AND 16777216)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS terms_evidence_intents (
        id TEXT PRIMARY KEY, session_hash TEXT NOT NULL,
        bytes BLOB NOT NULL, bytes_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
        signature_hash TEXT, cms BLOB, receipt_json TEXT, receipt_mac TEXT
      ) STRICT;`);
      const columns = db.prepare('PRAGMA table_info(terms_evidence_meta)').all().map(column => column.name).sort().join(',');
      const legacy = columns === 'domain,receipt_key,singleton';
      if (!legacy && columns !== 'cms_byte_limit,domain,history_limit,receipt_key,singleton') fail('terms_state_changed');
      const rows = db.prepare('SELECT * FROM terms_evidence_meta').all();
      if (rows.length > 1) fail('terms_state_changed');
      let meta = rows.length ? metadata(rows[0], legacy) : null;
      if (!meta && db.prepare('SELECT count(*) AS n FROM terms_evidence_intents').get().n) fail('terms_state_changed');
      if (legacy) db.exec(`ALTER TABLE terms_evidence_meta ADD COLUMN history_limit INTEGER NOT NULL
        DEFAULT 500 CHECK(history_limit BETWEEN 1 AND 500);
        ALTER TABLE terms_evidence_meta ADD COLUMN cms_byte_limit INTEGER NOT NULL
        DEFAULT 16777216 CHECK(cms_byte_limit BETWEEN 1 AND 16777216);`);
      if (!meta) {
        const initialKey = randomBytes(32);
        try {
          db.prepare(`INSERT INTO terms_evidence_meta
            (singleton,domain,receipt_key,history_limit,cms_byte_limit) VALUES (1,?,?,?,?)`)
            .run(DOMAIN, initialKey, maxHistory ?? TERMS_EVIDENCE_MAX_HISTORY, maxCmsBytes ?? TERMS_EVIDENCE_MAX_CMS_BYTES);
        } finally { initialKey.fill(0); }
      } else {
        meta = metadata(db.prepare('SELECT * FROM terms_evidence_meta WHERE singleton=1').get());
        db.prepare('UPDATE terms_evidence_meta SET history_limit=?,cms_byte_limit=? WHERE singleton=1')
          .run(Math.min(meta.history_limit, maxHistory ?? meta.history_limit),
            Math.min(meta.cms_byte_limit, maxCmsBytes ?? meta.cms_byte_limit));
      }
      meta = metadata(db.prepare('SELECT * FROM terms_evidence_meta WHERE singleton=1').get());
      key = Buffer.from(meta.receipt_key);
      db.exec('COMMIT'); this.#key = key;
    } catch {
      key?.fill(0);
      try { db.exec('ROLLBACK'); } catch { /* Preserve the fail-closed classification. */ }
      fail('terms_state_changed');
    }
  }

  #time() {
    const time = this.#now();
    if (!integer(time)) fail('terms_clock_invalid');
    return time;
  }

  #available() {
    if (this.#closed) fail('terms_store_closed');
    const rows = this.#db.prepare('SELECT * FROM terms_evidence_meta').all();
    if (rows.length !== 1) fail('terms_state_changed');
    const meta = metadata(rows[0]);
    if (!timingSafeEqual(this.#key, Buffer.from(meta.receipt_key))) fail('terms_state_changed');
    return meta;
  }

  #assertHistoryBudget(cmsLength) {
    const meta = this.#available();
    const usage = this.#db.prepare(`SELECT count(*) AS count,COALESCE(sum(length(cms)),0) AS bytes
      FROM terms_evidence_intents WHERE receipt_json IS NOT NULL`).get();
    if (!integer(usage.count) || !integer(usage.bytes)) fail('terms_state_changed');
    if (usage.count >= meta.history_limit || cmsLength > meta.cms_byte_limit - usage.bytes) fail('terms_history_limit');
  }

  #withTransaction(fn, immediate = false) {
    this.#available();
    if (this.#transaction) fail('terms_transaction_in_progress');
    this.#db.exec(immediate ? 'BEGIN IMMEDIATE' : 'BEGIN'); this.#transaction = true;
    try {
      this.#available();
      const result = fn();
      this.#db.exec('COMMIT'); return result;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      throw error;
    } finally { this.#transaction = false; }
  }

  #current(dealId) {
    const result = this.#readSnapshot(dealId);
    if (result === undefined || result === null) fail('terms_deal_not_found');
    const current = snapshot(result);
    if (current.terms.dealId !== dealId) fail('terms_snapshot_invalid');
    return current;
  }

  #row(sessionHash, id) {
    return this.#db.prepare('SELECT * FROM terms_evidence_intents WHERE id=? AND session_hash=?').get(id, sessionHash);
  }

  #pending(row) {
    if ([row.signature_hash, row.cms, row.receipt_json, row.receipt_mac].some(value => value !== null)) fail('terms_receipt_changed');
  }

  #evidence(row) {
    const { intent } = decode(row);
    if (!isHash(row.signature_hash) || !(row.cms instanceof Uint8Array) || !row.cms.length ||
        row.cms.length > 98_304 || sha(row.cms) !== row.signature_hash ||
        typeof row.receipt_json !== 'string' || !isHash(row.receipt_mac) ||
        !timingSafeEqual(Buffer.from(row.receipt_mac, 'hex'), Buffer.from(mac(this.#key, row), 'hex'))) fail('terms_receipt_changed');
    let receipt;
    try { receipt = JSON.parse(row.receipt_json); } catch { fail('terms_receipt_changed'); }
    receipt = fields(receipt, ['id', 'intentHash', 'dealId', 'termsVersion', 'termsFingerprint',
      'certificateDigest', 'verifiedAt', 'validUntil', 'statusSource', 'scope', 'action'], 'terms_receipt_changed');
    if (!isUuid(receipt.id) || receipt.intentHash !== row.bytes_hash ||
        receipt.dealId !== intent.snapshot.terms.dealId || receipt.termsVersion !== intent.snapshot.terms.version ||
        receipt.termsFingerprint !== intent.snapshot.termsFingerprint || !isHash(receipt.certificateDigest) ||
        !integer(receipt.verifiedAt) || receipt.verifiedAt < intent.issuedAt || receipt.verifiedAt >= intent.expiresAt ||
        !integer(receipt.validUntil) || receipt.validUntil <= receipt.verifiedAt ||
        receipt.statusSource !== SOURCE || receipt.scope !== SCOPE || receipt.action !== ACTION ||
        JSON.stringify(receipt) !== row.receipt_json) fail('terms_receipt_changed');
    return freeze({ snapshot: intent.snapshot, receipt });
  }

  #history(row, signatureHash) {
    const evidence = this.#evidence(row);
    if (row.signature_hash !== signatureHash) fail('terms_replay_conflict');
    return { receipt: evidence.receipt, historical: true };
  }

  // Pins current exact terms/version and sorted document manifest for five minutes.
  // assertCurrent synchronously asserts the caller's live session while rollback
  // is possible. It must throw on closure/expiry; returning false is not a guard.
  createIntent(sessionHash, request, options) {
    const assertCurrent = guard(options);
    request = fields(request, ['dealId', 'expectedVersion'], 'terms_request_invalid');
    if (!isHash(sessionHash) || !isUuid(request.dealId) ||
        !Number.isSafeInteger(request.expectedVersion) || request.expectedVersion < 1) fail('terms_request_invalid');
    return this.#withTransaction(() => {
      assertCurrent();
      const current = this.#current(request.dealId);
      if (current.terms.version !== request.expectedVersion) fail('terms_snapshot_stale');
      const issuedAt = this.#time(), expiresAt = issuedAt + 300_000;
      if (!integer(expiresAt)) fail('terms_clock_invalid');
      // Expired unsigned intents contain no accepted evidence and can be pruned.
      // Accepted rows are retained for historical exact-CMS recovery.
      this.#db.prepare('DELETE FROM terms_evidence_intents WHERE receipt_json IS NULL AND expires_at<=?').run(issuedAt);
      if (this.#db.prepare('SELECT count(*) AS n FROM terms_evidence_intents WHERE receipt_json IS NULL').get().n >= 500) fail('terms_pending_limit');
      const intent = { domain: DOMAIN, purpose: PURPOSE, action: ACTION, nonce: randomUUID(),
        sessionHash, issuedAt, expiresAt, statusSource: SOURCE, snapshot: current };
      const bytes = encode(intent), hash = sha(bytes);
      this.#db.prepare('INSERT INTO terms_evidence_intents (id,session_hash,bytes,bytes_hash,expires_at) VALUES (?,?,?,?,?)')
        .run(intent.nonce, sessionHash, bytes, hash, expiresAt);
      assertCurrent();
      return { id: intent.nonce, bytes, hash, expiresAt };
    }, true);
  }

  // Copies CMS before await, verifies exact bytes, then atomically rechecks live
  // session/current snapshot and consumes nonce with one receipt. Same CMS retry
  // returns the original receipt without new verification, even after its TEST
  // status/intent expiry; closed/foreign sessions still cannot recover it here.
  async submit(sessionHash, request, options) {
    const assertCurrent = guard(options);
    assertCurrent();
    request = fields(request, ['intentId', 'cms'], 'terms_submission_invalid');
    if (!isHash(sessionHash) || !isUuid(request.intentId) || !Buffer.isBuffer(request.cms) ||
        !request.cms.length || request.cms.length > 98_304) fail('terms_submission_invalid');
    const cms = Buffer.from(request.cms), signatureHash = sha(cms);
    const initial = this.#withTransaction(() => {
      assertCurrent();
      const row = this.#row(sessionHash, request.intentId);
      if (!row) fail('terms_intent_not_found');
      if (row.receipt_json !== null) return { history: this.#history(row, signatureHash) };
      this.#pending(row);
      const decoded = decode(row), now = this.#time();
      if (row.expires_at <= now || decoded.intent.issuedAt > now) fail('terms_intent_expired');
      return { row, ...decoded };
    });
    assertCurrent();
    if (initial.history) return initial.history;
    if (this.#slots.active >= 2) fail('verifier_busy');
    this.#slots.active++; this.#inflight++;
    let outcome;
    try {
      outcome = await this.#verify(Buffer.from(initial.bytes), Buffer.from(cms));
      assertCurrent();
      // Snapshot trusted verifier values once; no identity or subject is retained.
      const verified = outcome?.verified, statusSource = outcome?.statusSource;
      const certificateDigest = outcome?.certificateDigest, validUntil = outcome?.validUntil;
      const personal = outcome?.personal, corporate = outcome?.corporate;
      return this.#withTransaction(() => {
        assertCurrent();
        const row = this.#row(sessionHash, initial.row.id);
        if (!row) fail('terms_intent_changed');
        if (row.receipt_json !== null) {
          const result = this.#history(row, signatureHash);
          assertCurrent(); return result;
        }
        this.#pending(row);
        if (verified !== true || statusSource !== SOURCE || !isHash(certificateDigest) ||
            !integer(validUntil) || validUntil <= this.#time() || personal !== true || corporate === true) fail('terms_signature_rejected');
        const decoded = decode(row);
        if (row.bytes_hash !== initial.row.bytes_hash || row.expires_at !== initial.row.expires_at ||
            !decoded.bytes.equals(initial.bytes)) fail('terms_intent_changed');
        const current = this.#current(initial.intent.snapshot.terms.dealId);
        if (JSON.stringify(current) !== JSON.stringify(initial.intent.snapshot)) fail('terms_snapshot_stale');
        const verifiedAt = this.#time();
        if (row.expires_at <= verifiedAt || initial.intent.issuedAt > verifiedAt) fail('terms_intent_expired');
        if (validUntil <= verifiedAt) fail('terms_status_expired');
        // Persistent SQL usage is checked within BEGIN IMMEDIATE after await,
        // so parallel verification/restart cannot bypass count or CMS byte caps.
        // Historical exact retry takes its earlier branch and needs no quota.
        this.#assertHistoryBudget(cms.length);
        const receipt = { id: randomUUID(), intentHash: row.bytes_hash,
          dealId: initial.intent.snapshot.terms.dealId, termsVersion: initial.intent.snapshot.terms.version,
          termsFingerprint: initial.intent.snapshot.termsFingerprint, certificateDigest,
          verifiedAt, validUntil, statusSource: SOURCE, scope: SCOPE, action: ACTION };
        const receiptJson = JSON.stringify(receipt);
        const accepted = { ...row, signature_hash: signatureHash, receipt_json: receiptJson };
        const update = this.#db.prepare(`UPDATE terms_evidence_intents
          SET signature_hash=?,cms=?,receipt_json=?,receipt_mac=? WHERE id=? AND receipt_json IS NULL`)
          .run(signatureHash, cms, receiptJson, mac(this.#key, accepted), row.id);
        if (update.changes !== 1) fail('terms_replay_conflict');
        assertCurrent();
        // Guard callbacks are trusted but may advance time or write that shared
        // DB; check both again immediately before the atomic COMMIT.
        if (JSON.stringify(this.#current(receipt.dealId)) !== JSON.stringify(initial.intent.snapshot)) fail('terms_snapshot_stale');
        const atCommit = this.#time();
        if (row.expires_at <= atCommit) fail('terms_intent_expired');
        if (validUntil <= atCommit) fail('terms_status_expired');
        return { receipt: freeze(receipt), historical: false };
      }, true);
    } finally { this.#slots.active--; this.#inflight--; }
  }

  // Public historical evidence, from signed immutable snapshot rather than the
  // current draft. All fields are whitelisted; CMS/session/subject stay private.
  list(dealId, termsVersion) {
    if (!isUuid(dealId) || (termsVersion !== undefined &&
        (!Number.isSafeInteger(termsVersion) || termsVersion < 1))) fail('terms_read_invalid');
    return this.#withTransaction(() => this.#db.prepare(`SELECT * FROM terms_evidence_intents
      WHERE receipt_json IS NOT NULL ORDER BY id`).all()
      .map(row => this.#evidence(row))
      .filter(value => value.receipt.dealId === dealId &&
        (termsVersion === undefined || value.receipt.termsVersion === termsVersion))
      .sort((a, b) => b.receipt.verifiedAt - a.receipt.verifiedAt || a.receipt.id.localeCompare(b.receipt.id)));
  }

  // Reads one immutable accepted snapshot/receipt, or undefined if not present.
  read(dealId, termsVersion, receiptId) {
    if (!isUuid(receiptId)) fail('terms_read_invalid');
    return this.list(dealId, termsVersion).find(value => value.receipt.id === receiptId);
  }

  // Caller owns db lifetime. Refuse closing this store during verification so
  // a server shutdown cannot close the shared database beneath an active commit.
  close() {
    if (this.#inflight || this.#transaction) fail('verification_in_progress');
    if (!this.#closed) { this.#closed = true; this.#key.fill(0); }
  }
}
