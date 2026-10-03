// Independent local TEST participants and unsigned participant statements.
// Access codes identify only an account in this local fixture, never a person,
// organization, signing authority, legal agreement or payment.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { types } from 'node:util';
import { preparePrivateTestDatabase } from './private-test-store.mjs';
import { canonicalDraftTerms, fingerprintDraftTerms } from './terms.mjs';
import { TestDocumentError, TestDocuments, TEST_DOCUMENT_MAX_BYTES } from './test-documents.mjs';
import { ParticipantSignatures } from '../nca/participant-signatures.mjs';
import { buildParticipantEvidence } from './participant-evidence.mjs';

export const PARTICIPANT_LIMIT = 100;
export const PARTICIPANT_DEAL_LIMIT = 100;
export const PARTICIPANT_REQUEST_LIMIT = 2000;
export const PARTICIPANT_INVITATION_LIFETIME_MS = 15 * 60 * 1000;
export const PARTICIPANT_REPUTATION_SCOPE = 'local_test_role_reputation_only';
export const PARTICIPANT_REVIEW_SOURCE = 'unsigned_test_participant_review';
const SCOPE = 'local_test_participant_statements_only';
const SOURCE = 'unsigned_test_participant_statement';
const STORE_KIND = 'dalahold.local-test-participants.v1';
const SIGNED_SCOPE = 'local_personal_test_signed_deal_only';
const SIGNED_SOURCE = 'personal_test_nca_statement';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const ROLES = new Set(['seller', 'buyer']);
const STATES = new Set(['draft', 'offered', 'agreed', 'handed_over', 'accepted', 'disputed']);
const ACTIONS = {
  offer: { role: 'seller', from: ['draft'], to: 'offered' },
  agree: { role: 'buyer', from: ['offered'], to: 'agreed' },
  handover: { role: 'seller', from: ['agreed'], to: 'handed_over' },
  accept: { role: 'buyer', from: ['handed_over'], to: 'accepted' },
  dispute: { role: null, from: ['agreed', 'handed_over'], to: 'disputed' },
};
const EVENT_FIELDS = ['id', 'dealId', 'action', 'actorId', 'role', 'termsVersion', 'stateRevision',
  'snapshotHash', 'termsFingerprint', 'documentManifestHash', 'createdAt', 'stateFrom', 'stateTo', 'source', 'scope'];
const STATUS = {
  invalid_request: 400, unauthorized: 401, forbidden: 403, not_found: 404,
  stale_deal: 409, snapshot_mismatch: 409, state_conflict: 409,
  idempotency_conflict: 409, store_corrupt: 409, incompatible_store: 409,
  participant_limit: 413, deal_limit: 413, request_limit: 413,
  signature_required: 403,
  review_not_allowed: 409, review_already_exists: 409,
};

export class ParticipantStoreError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ParticipantStoreError';
    this.code = Object.hasOwn(STATUS, code) ? code : 'store_corrupt';
    this.status = STATUS[this.code];
  }
}
function fail(code) { throw new ParticipantStoreError(code); }
function uuid(value) { return typeof value === 'string' && UUID.test(value); }
function integer(value, min = 1) { return Number.isSafeInteger(value) && value >= min; }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function encodedHash(value) { return hash(JSON.stringify(value)); }

// Reject getters, proxies, extra fields and coercions before using any values.
function exact(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('invalid_request');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || !fields.every((field) => keys.includes(field))) fail('invalid_request');
  const output = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('invalid_request');
    output[field] = descriptor.value;
  }
  return output;
}
function terms(value) {
  const { scenario, quantity, amount, date } = value;
  if (!['grain', 'livestock'].includes(scenario) || !integer(quantity) || quantity > 100_000 ||
      !integer(amount) || amount > 999_999_999_999 || typeof date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('invalid_request');
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) fail('invalid_request');
  return { scenario, quantity, amount, date };
}
function request(value) { if (!uuid(value)) fail('invalid_request'); }
function version(value) { if (!integer(value)) fail('invalid_request'); }
function parse(value) {
  try { return JSON.parse(value); } catch { fail('store_corrupt'); }
}

export class ParticipantStore {
  #db;
  #documents;
  #now;
  #commitGuard = () => {};
  #finalChecks = [];
  #checkingFinal = false;
  #signatures = null;
  #signed = false;
  #memoEnabled = false;

  constructor({ dbPath, now = Date.now, signatureSdk, memoConfiguration } = {}) {
    if (typeof dbPath !== 'string' || !dbPath || typeof now !== 'function') fail('invalid_request');
    if (signatureSdk !== undefined && (signatureSdk?.statusSource !== 'test_ocsp' ||
        typeof signatureSdk.verifyIdentity !== 'function' || typeof signatureSdk.inspect !== 'function')) fail('invalid_request');
    if (memoConfiguration !== undefined && signatureSdk === undefined) fail('invalid_request');
    this.#signed = signatureSdk !== undefined;
    this.#memoEnabled = memoConfiguration !== undefined;
    const kind = this.#signed ? `${STORE_KIND}.personal-test-signed` : STORE_KIND;
    const db = new DatabaseSync(preparePrivateTestDatabase(dbPath));
    try {
      // Refuse personal/demo databases before changing their pragmas or schema.
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
      if (tables.length && !tables.some(({ name }) => name === 'participant_store_meta')) fail('incompatible_store');
      if (tables.length) {
        let row;
        try { row = db.prepare('SELECT kind FROM participant_store_meta WHERE singleton = 1').get(); }
        catch { fail('incompatible_store'); }
        if (row?.kind !== kind) fail('incompatible_store');
      }
      db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA mmap_size = 0; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS participant_store_meta (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1), kind TEXT NOT NULL
          ) STRICT;
          CREATE TABLE IF NOT EXISTS participants (
            id TEXT PRIMARY KEY, label TEXT NOT NULL UNIQUE,
            access_hash TEXT NOT NULL UNIQUE CHECK (length(access_hash) = 64),
            created_at INTEGER NOT NULL CHECK (created_at >= 0)
          ) STRICT;
          CREATE TABLE IF NOT EXISTS drafts (
            id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK (version >= 1),
            scenario TEXT NOT NULL CHECK (scenario IN ('grain', 'livestock')),
            quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 100000),
            amount INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 999999999999),
            date TEXT NOT NULL, created_at INTEGER NOT NULL CHECK (created_at >= 0)
          ) STRICT;
          CREATE TABLE IF NOT EXISTS draft_versions (
            deal_id TEXT NOT NULL REFERENCES drafts(id), version INTEGER NOT NULL CHECK (version >= 1),
            scenario TEXT NOT NULL CHECK (scenario IN ('grain', 'livestock')),
            quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 100000),
            amount INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 999999999999),
            date TEXT NOT NULL, changed_at INTEGER NOT NULL CHECK (changed_at >= 0),
            PRIMARY KEY (deal_id, version)
          ) STRICT;
          CREATE TABLE IF NOT EXISTS participant_deals (
            id TEXT PRIMARY KEY REFERENCES drafts(id), creator_id TEXT NOT NULL REFERENCES participants(id),
            state TEXT NOT NULL CHECK (state IN ('draft', 'offered', 'agreed', 'handed_over', 'accepted', 'disputed')),
            state_revision INTEGER NOT NULL CHECK (state_revision >= 0),
            offered_snapshot_hash TEXT CHECK (offered_snapshot_hash IS NULL OR length(offered_snapshot_hash) = 64)
          ) STRICT;
          CREATE TABLE IF NOT EXISTS participant_memberships (
            deal_id TEXT NOT NULL REFERENCES participant_deals(id), participant_id TEXT NOT NULL REFERENCES participants(id),
            role TEXT NOT NULL CHECK (role IN ('seller', 'buyer')),
            PRIMARY KEY (deal_id, participant_id), UNIQUE (deal_id, role)
          ) STRICT;
          CREATE INDEX IF NOT EXISTS participant_memberships_actor ON participant_memberships(participant_id, deal_id);
          CREATE TABLE IF NOT EXISTS participant_invitations (
            deal_id TEXT PRIMARY KEY REFERENCES participant_deals(id),
            token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
            participant_id TEXT NOT NULL REFERENCES participants(id),
            role TEXT NOT NULL CHECK (role IN ('seller', 'buyer')),
            expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
            claimed_by TEXT REFERENCES participants(id), claimed_at INTEGER
          ) STRICT;
          CREATE TABLE IF NOT EXISTS participant_events (
            id TEXT PRIMARY KEY, deal_id TEXT NOT NULL REFERENCES participant_deals(id),
            state_revision INTEGER NOT NULL CHECK (state_revision >= 1), event_json TEXT NOT NULL,
            UNIQUE (deal_id, state_revision)
          ) STRICT;
          CREATE TABLE IF NOT EXISTS participant_requests (
            request_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES participants(id),
            kind TEXT NOT NULL, deal_id TEXT NOT NULL REFERENCES participant_deals(id),
            payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64), receipt_json TEXT NOT NULL,
            created_at INTEGER NOT NULL CHECK (created_at >= 0)
          ) STRICT;
          CREATE TABLE IF NOT EXISTS participant_reviews (
            id TEXT PRIMARY KEY, deal_id TEXT NOT NULL REFERENCES participant_deals(id),
            author_id TEXT NOT NULL REFERENCES participants(id), target_id TEXT NOT NULL REFERENCES participants(id),
            target_role TEXT NOT NULL CHECK (target_role IN ('seller', 'buyer')),
            score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
            accepted_event_id TEXT NOT NULL REFERENCES participant_events(id),
            terms_version INTEGER NOT NULL CHECK (terms_version >= 1),
            state_revision INTEGER NOT NULL CHECK (state_revision >= 1),
            snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash) = 64),
            created_at INTEGER NOT NULL CHECK (created_at >= 0),
            UNIQUE (deal_id, author_id), CHECK (author_id <> target_id)
          ) STRICT;
        `);
        db.prepare('INSERT OR IGNORE INTO participant_store_meta VALUES (1, ?)').run(kind);
        this.#documents = new TestDocuments({ db, now });
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      this.#db = db;
      this.#now = now;
      if (this.#signed) this.#signatures = new ParticipantSignatures({ db, sdk: signatureSdk, now,
        readParticipant: actorId => this.#participant(actorId),
        readDeal: (actorId, dealId) => this.#deal(actorId, dealId),
        commitSignedAction: (actorId, dealId, input, authorization) => this.#action(actorId, dealId, input, authorization),
        atomic: (assertCurrent, action, finalCheck) => this.withCommitGuard(assertCurrent, action, finalCheck),
        memoConfiguration });
    } catch (error) { db.close(); throw error; }
  }

  close() { if (this.#db) { this.#signatures?.close(); this.#db.close(); this.#db = undefined; } }
  get scope() { return this.#signed ? SIGNED_SCOPE : SCOPE; }
  get signedTest() { return this.#signed; }
  get memoEnabled() { return this.#memoEnabled; }
  #signing() { if (!this.#signatures) fail('signature_required'); return this.#signatures; }
  signatureStatus() { return this.#signing().inspect(); }
  getCertificateBinding(actorId) { return this.#signing().getBinding(actorId); }
  createEnrollmentIntent(actorId, sessionHash, input, options) {
    return this.#signing().createEnrollmentIntent(actorId, sessionHash, input, options);
  }
  createSignatureIntent(actorId, dealId, sessionHash, input, options) {
    return this.#signing().createActionIntent(actorId, dealId, sessionHash, input, options);
  }
  createAnchorIntent(actorId, dealId, sessionHash, input, options) {
    return this.#signing().createAnchorIntent(actorId, dealId, sessionHash, input, options);
  }
  submitSignature(actorId, sessionHash, input, options) {
    return this.#signing().submit(actorId, sessionHash, input, options);
  }
  // Internal operator library boundary. No HTTP endpoint exposes an executable grant.
  readMemoAuthorization(actorId, intentId) { return this.#signing().readMemoAuthorization(actorId, intentId); }

  // A synchronous HTTP session check is repeated while the final SQLite
  // transaction is still open, so expiry during a lock wait rolls back writes.
  withCommitGuard(assertCurrent, action, finalCheck = null) {
    if (typeof assertCurrent !== 'function' || typeof action !== 'function' ||
        types.isProxy(assertCurrent) || types.isProxy(action) ||
        types.isAsyncFunction(assertCurrent) || types.isAsyncFunction(action) ||
        (finalCheck !== null && (typeof finalCheck !== 'function' || types.isProxy(finalCheck) ||
          types.isAsyncFunction(finalCheck)))) fail('invalid_request');
    const previous = this.#commitGuard;
    this.#commitGuard = () => {
      previous();
      const result = assertCurrent();
      if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result) fail('invalid_request');
    };
    try {
      return this.#transaction(() => {
        const result = action();
        if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result) fail('invalid_request');
        return result;
      }, true, finalCheck && (() => {
        const result = finalCheck();
        if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result) fail('invalid_request');
      }));
    } finally { this.#commitGuard = previous; }
  }

  #transaction(action, write = false, finalCheck = null) {
    if (!this.#db) fail('store_corrupt');
    this.#commitGuard();
    const nested = this.#db.isTransaction;
    const savepoint = nested ? `participant_store_${randomUUID().replaceAll('-', '')}` : null;
    this.#db.exec(nested ? `SAVEPOINT ${savepoint}` : write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    if (!nested) this.#finalChecks = [];
    const checkCount = this.#finalChecks.length;
    if (finalCheck) this.#finalChecks.push(finalCheck);
    try {
      const result = action();
      this.#commitGuard();
      // Domain expiry checks survive nested savepoints and run after the HTTP
      // session guard, immediately before the outermost commit too.
      // A final check can use public read methods. Those nested savepoints must
      // not recursively re-run the same final checks; the outer pass still
      // checks all registered guards before its own COMMIT.
      if (!this.#checkingFinal) {
        this.#checkingFinal = true;
        try { for (const check of this.#finalChecks) check(); }
        finally { this.#checkingFinal = false; }
      }
      this.#db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      if (nested) {
        this.#db.exec(`ROLLBACK TO ${savepoint}`);
        this.#db.exec(`RELEASE ${savepoint}`);
      } else this.#db.exec('ROLLBACK');
      this.#finalChecks.splice(checkCount);
      throw error;
    } finally { if (!nested) this.#finalChecks = []; }
  }
  #time() {
    const value = this.#now();
    if (!integer(value, 0) || value > Number.MAX_SAFE_INTEGER - PARTICIPANT_INVITATION_LIFETIME_MS) fail('invalid_request');
    return value;
  }
  #participant(id) {
    if (!uuid(id)) fail('unauthorized');
    const row = this.#db.prepare('SELECT id, label FROM participants WHERE id = ?').get(id);
    if (!row) fail('unauthorized');
    if (typeof row.label !== 'string' || !/^TEST participant \d{3}$/.test(row.label)) fail('store_corrupt');
    return { id: row.id, label: row.label };
  }
  #member(actorId, dealId) {
    this.#participant(actorId);
    if (!uuid(dealId)) fail('invalid_request');
    const member = this.#db.prepare('SELECT role FROM participant_memberships WHERE deal_id = ? AND participant_id = ?').get(dealId, actorId);
    if (!member) fail('not_found');
    if (!ROLES.has(member.role)) fail('store_corrupt');
    return member;
  }
  #membershipLimit(actorId) {
    if (this.#db.prepare('SELECT COUNT(*) AS count FROM participant_memberships WHERE participant_id = ?').get(actorId).count >= PARTICIPANT_DEAL_LIMIT) fail('deal_limit');
  }
  #receipt(actorId, requestId, kind, dealId, payload) {
    const row = this.#db.prepare('SELECT * FROM participant_requests WHERE request_id = ?').get(requestId);
    if (!row) return null;
    if (row.actor_id !== actorId || row.kind !== kind || row.deal_id !== dealId || row.payload_hash !== encodedHash(payload)) fail('idempotency_conflict');
    return parse(row.receipt_json);
  }
  #requestLimit() {
    if (this.#db.prepare('SELECT COUNT(*) AS count FROM participant_requests').get().count >= PARTICIPANT_REQUEST_LIMIT) fail('request_limit');
  }
  #remember(actorId, requestId, kind, dealId, payload, receipt) {
    this.#db.prepare('INSERT INTO participant_requests VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      requestId, actorId, kind, dealId, encodedHash(payload), JSON.stringify(receipt), this.#time());
  }
  #row(dealId) {
    const row = this.#db.prepare(`SELECT d.*, p.creator_id, p.state, p.state_revision, p.offered_snapshot_hash
      FROM drafts d JOIN participant_deals p ON p.id = d.id WHERE d.id = ?`).get(dealId);
    if (!row) fail('store_corrupt');
    if (!uuid(row.id) || !uuid(row.creator_id) || !integer(row.version) || !integer(row.state_revision, 0) ||
        !STATES.has(row.state) || (row.state === 'draft' ? row.offered_snapshot_hash !== null :
          typeof row.offered_snapshot_hash !== 'string' || !HASH.test(row.offered_snapshot_hash))) fail('store_corrupt');
    const archived = this.#db.prepare('SELECT * FROM draft_versions WHERE deal_id = ? AND version = ?').get(dealId, row.version);
    let currentHash;
    try {
      const current = { dealId, version: row.version, ...terms(row) };
      currentHash = fingerprintDraftTerms(current);
      if (!archived || fingerprintDraftTerms({ dealId, version: row.version, ...terms(archived) }) !== currentHash) fail('store_corrupt');
    } catch { fail('store_corrupt'); }
    return { ...row, termsFingerprint: currentHash };
  }
  #parties(dealId, creatorId) {
    const parties = this.#db.prepare(`SELECT p.id, p.label, m.role FROM participant_memberships m
      JOIN participants p ON p.id = m.participant_id WHERE m.deal_id = ? ORDER BY m.role, p.id`).all(dealId)
      .map(({ id, label, role }) => ({ id, label, role }));
    if (parties.length < 1 || parties.length > 2 || !parties.some(({ id }) => id === creatorId) ||
        parties.some(({ id, label, role }) => !uuid(id) || !ROLES.has(role) || typeof label !== 'string' ||
          !/^TEST participant \d{3}$/.test(label))) fail('store_corrupt');
    return parties;
  }
  #eventRows(dealId) {
    return this.#db.prepare('SELECT * FROM participant_events WHERE deal_id = ? ORDER BY state_revision').all(dealId).map((row) => {
      let event;
      try { event = exact(parse(row.event_json), this.#signed ? [...EVENT_FIELDS, 'authorization'] : EVENT_FIELDS); } catch { fail('store_corrupt'); }
      if (!event || !uuid(event.id) || event.id !== row.id || event.dealId !== dealId ||
          !uuid(event.actorId) || !ROLES.has(event.role) || !Object.hasOwn(ACTIONS, event.action) ||
          !integer(event.termsVersion) || !integer(event.stateRevision) || event.stateRevision !== row.state_revision ||
          !integer(event.createdAt, 0) || !STATES.has(event.stateFrom) || !STATES.has(event.stateTo) ||
          !HASH.test(event.snapshotHash) || !HASH.test(event.termsFingerprint) || !HASH.test(event.documentManifestHash) ||
          event.source !== (this.#signed ? SIGNED_SOURCE : SOURCE) || event.scope !== this.scope) fail('store_corrupt');
      if (this.#signed) {
        let authorization;
        try { authorization = exact(event.authorization, ['receiptId', 'intentHash', 'certificateDigest', 'bindingId', 'authEpoch', 'statusSource']); }
        catch { fail('store_corrupt'); }
        if (!uuid(authorization.receiptId) || !uuid(authorization.bindingId) ||
            !HASH.test(authorization.intentHash) || !HASH.test(authorization.certificateDigest) ||
            !integer(authorization.authEpoch, 0) || authorization.statusSource !== 'test_ocsp') fail('store_corrupt');
        this.#signing().validateEvent(event);
      }
      return event;
    });
  }
  #deal(actorId, dealId) {
    const { role } = this.#member(actorId, dealId);
    const row = this.#row(dealId);
    const participants = this.#parties(dealId, row.creator_id);
    const documents = this.#documents.list(dealId, row.version);
    const manifest = [...documents].sort((a, b) => a.id.localeCompare(b.id));
    const canonicalTerms = canonicalDraftTerms({ dealId, version: row.version, ...terms(row) }).toString('utf8');
    const snapshotHash = encodedHash({ schema: 'dalahold.local-test-participant-snapshot.v1', canonicalTerms, documents: manifest, participants });
    if (row.state !== 'draft' && snapshotHash !== row.offered_snapshot_hash) fail('store_corrupt');
    const events = this.#eventRows(dealId), documentManifestHash = encodedHash(manifest);
    let derivedState = 'draft';
    for (const [index, event] of events.entries()) {
      const policy = ACTIONS[event.action];
      if (event.stateRevision !== index + 1 || event.stateFrom !== derivedState ||
          !policy.from.includes(event.stateFrom) || policy.to !== event.stateTo ||
          (policy.role && policy.role !== event.role) ||
          !participants.some(({ id, role: participantRole }) => id === event.actorId && participantRole === event.role) ||
          event.termsVersion !== row.version || event.termsFingerprint !== row.termsFingerprint ||
          event.snapshotHash !== snapshotHash || event.documentManifestHash !== documentManifestHash) fail('store_corrupt');
      derivedState = event.stateTo;
    }
    if (derivedState !== row.state || events.length !== row.state_revision ||
        (row.state !== 'draft' && participants.length !== 2)) fail('store_corrupt');
    const versions = this.#db.prepare('SELECT version FROM draft_versions WHERE deal_id = ? ORDER BY version').all(dealId);
    const documentHistory = versions.flatMap(({ version: archivedVersion }) => this.#documents.list(dealId, archivedVersion));
    return { id: row.id, creatorId: row.creator_id, version: row.version, ...terms(row),
      state: row.state, stateRevision: row.state_revision, termsFingerprint: row.termsFingerprint, role,
      participants, documents, documentHistory, events, scope: this.scope, snapshotHash };
  }

  register() {
    return this.#transaction(() => {
      const count = this.#db.prepare('SELECT COUNT(*) AS count FROM participants').get().count;
      if (count >= PARTICIPANT_LIMIT) fail('participant_limit');
      const participant = { id: randomUUID(), label: `TEST participant ${String(count + 1).padStart(3, '0')}` };
      const accessCode = randomBytes(32).toString('hex');
      this.#db.prepare('INSERT INTO participants VALUES (?, ?, ?, ?)').run(participant.id, participant.label, hash(accessCode), this.#time());
      return { participant, accessCode };
    }, true);
  }
  authenticate(accessCode) {
    return this.#transaction(() => {
      if (typeof accessCode !== 'string' || !HASH.test(accessCode)) fail('unauthorized');
      const row = this.#db.prepare('SELECT id FROM participants WHERE access_hash = ?').get(hash(accessCode));
      if (!row) fail('unauthorized');
      return this.#participant(row.id);
    });
  }
  participant(id) { return this.#transaction(() => this.#participant(id)); }
  listDeals(actorId) {
    return this.#transaction(() => {
      this.#participant(actorId);
      const rows = this.#db.prepare(`SELECT m.deal_id FROM participant_memberships m JOIN drafts d ON d.id = m.deal_id
        WHERE m.participant_id = ? ORDER BY d.created_at DESC, d.id DESC LIMIT 101`).all(actorId);
      if (rows.length > PARTICIPANT_DEAL_LIMIT) fail('store_corrupt');
      return rows.map(({ deal_id }) => this.#deal(actorId, deal_id));
    });
  }
  createDeal(actorId, value) {
    return this.#transaction(() => {
      this.#participant(actorId);
      const input = exact(value, ['requestId', 'creatorRole', 'scenario', 'quantity', 'amount', 'date']);
      request(input.requestId);
      if (!ROLES.has(input.creatorRole)) fail('invalid_request');
      const normalized = { creatorRole: input.creatorRole, ...terms(input) };
      const previous = this.#db.prepare('SELECT deal_id FROM participant_requests WHERE request_id = ?').get(input.requestId);
      if (previous) {
        const receipt = this.#receipt(actorId, input.requestId, 'create', previous.deal_id, normalized);
        return this.#deal(actorId, receipt.dealId);
      }
      this.#requestLimit(); this.#membershipLimit(actorId);
      const id = randomUUID(), createdAt = this.#time();
      this.#db.prepare('INSERT INTO drafts VALUES (?, 1, ?, ?, ?, ?, ?)').run(id, normalized.scenario, normalized.quantity, normalized.amount, normalized.date, createdAt);
      this.#db.prepare('INSERT INTO draft_versions VALUES (?, 1, ?, ?, ?, ?, ?)').run(id, normalized.scenario, normalized.quantity, normalized.amount, normalized.date, createdAt);
      this.#db.prepare('INSERT INTO participant_deals VALUES (?, ?, ?, 0, NULL)').run(id, actorId, 'draft');
      this.#db.prepare('INSERT INTO participant_memberships VALUES (?, ?, ?)').run(id, actorId, input.creatorRole);
      this.#remember(actorId, input.requestId, 'create', id, normalized, { dealId: id });
      return this.#deal(actorId, id);
    }, true);
  }
  createInvitation(actorId, dealId, value) {
    return this.#transaction(() => {
      const member = this.#member(actorId, dealId);
      const input = exact(value, ['expectedVersion', 'participantId']);
      version(input.expectedVersion);
      if (!uuid(input.participantId)) fail('invalid_request');
      const row = this.#row(dealId);
      if (row.creator_id !== actorId) fail('forbidden');
      if (row.version !== input.expectedVersion) fail('stale_deal');
      if (row.state !== 'draft' || this.#parties(dealId, row.creator_id).length !== 1) fail('state_conflict');
      if (input.participantId === actorId) fail('forbidden');
      if (!this.#db.prepare('SELECT id FROM participants WHERE id = ?').get(input.participantId)) fail('not_found');
      this.#membershipLimit(input.participantId);
      const code = randomBytes(32).toString('hex'), expiresAt = this.#time() + PARTICIPANT_INVITATION_LIFETIME_MS;
      const role = member.role === 'seller' ? 'buyer' : 'seller';
      this.#db.prepare(`INSERT INTO participant_invitations VALUES (?, ?, ?, ?, ?, NULL, NULL)
        ON CONFLICT(deal_id) DO UPDATE SET token_hash = excluded.token_hash, participant_id = excluded.participant_id,
          role = excluded.role, expires_at = excluded.expires_at, claimed_by = NULL, claimed_at = NULL`)
        .run(dealId, hash(code), input.participantId, role, expiresAt);
      return { code, expiresAt };
    }, true);
  }
  claimInvitation(actorId, value) {
    let expiresAt;
    return this.#transaction(() => {
      this.#participant(actorId);
      const input = exact(value, ['code']);
      if (typeof input.code !== 'string' || !HASH.test(input.code)) fail('not_found');
      const invitation = this.#db.prepare('SELECT * FROM participant_invitations WHERE token_hash = ?').get(hash(input.code));
      if (!invitation || invitation.participant_id !== actorId) fail('not_found');
      if (invitation.claimed_by !== null) {
        if (invitation.claimed_by !== actorId) fail('not_found');
        this.#member(actorId, invitation.deal_id);
        return { dealId: invitation.deal_id, historical: true };
      }
      expiresAt = invitation.expires_at;
      const row = this.#row(invitation.deal_id);
      if (row.creator_id === actorId) fail('forbidden');
      if (this.#time() >= invitation.expires_at) fail('not_found');
      if (row.state !== 'draft' || this.#parties(row.id, row.creator_id).length !== 1) fail('state_conflict');
      this.#membershipLimit(actorId);
      this.#db.prepare('INSERT INTO participant_memberships VALUES (?, ?, ?)').run(row.id, actorId, invitation.role);
      this.#db.prepare('UPDATE participant_invitations SET claimed_by = ?, claimed_at = ? WHERE deal_id = ?').run(actorId, this.#time(), row.id);
      return { dealId: row.id, historical: false };
    }, true, () => { if (expiresAt !== undefined && this.#time() >= expiresAt) fail('not_found'); });
  }
  getDeal(actorId, dealId) { return this.#transaction(() => this.#deal(actorId, dealId)); }
  getEvidencePackage(actorId, dealId) {
    return this.#transaction(() => {
      // All versions, private file bytes and protected receipt links are read
      // in the same SQLite snapshot, only after the membership check.
      const deal = this.#deal(actorId, dealId);
      const archived = this.#db.prepare('SELECT * FROM draft_versions WHERE deal_id=? ORDER BY version LIMIT 2001').all(dealId);
      if (archived.length > 2000 || archived.length !== deal.version) fail('store_corrupt');
      const versions = archived.map(row => {
        let normalized;
        try { normalized = terms(row); } catch { fail('store_corrupt'); }
        return { version: row.version, ...normalized,
          termsFingerprint: fingerprintDraftTerms({ dealId, version: row.version, ...normalized }) };
      });
      const documents = deal.documentHistory.map(document => {
        const file = this.#documents.read(dealId, document.id);
        return { ...file.document, contentBase64: file.bytes.toString('base64') };
      });
      const receipts = this.#signed ? deal.events.map(event => this.#signing().receiptForEvent(event)) : [];
      return buildParticipantEvidence({ exportedAt: this.#time(), deal, versions, documents, receipts });
    });
  }
  #reviewPayload(value) {
    return { expectedVersion: value.termsVersion, expectedStateRevision: value.stateRevision,
      snapshotHash: value.snapshotHash, score: value.score };
  }
  #reviews(deal) {
    const rows = this.#db.prepare('SELECT * FROM participant_reviews WHERE deal_id=? ORDER BY created_at,id').all(deal.id);
    const requests = this.#db.prepare("SELECT * FROM participant_requests WHERE deal_id=? AND kind='review'").all(deal.id);
    if (rows.length > 2 || requests.length !== rows.length || new Set(rows.map(row => row.author_id)).size !== rows.length) fail('store_corrupt');
    const terminal = deal.events.at(-1);
    if (rows.length && (deal.state !== 'accepted' || terminal?.action !== 'accept' || terminal.stateTo !== 'accepted')) fail('store_corrupt');
    const seenRequests = new Set();
    return rows.map(row => {
      const author = deal.participants.find(party => party.id === row.author_id);
      const target = deal.participants.find(party => party.id === row.target_id);
      if (!uuid(row.id) || !author || !target || author.id === target.id || target.role !== row.target_role ||
          !integer(row.score) || row.score > 5 || row.accepted_event_id !== terminal.id ||
          row.terms_version !== deal.version || row.state_revision !== deal.stateRevision ||
          row.snapshot_hash !== deal.snapshotHash || !integer(row.created_at, 0) || row.created_at < terminal.createdAt) fail('store_corrupt');
      const review = { id: row.id, dealId: deal.id, authorId: author.id, authorRole: author.role,
        targetId: target.id, targetRole: target.role, score: row.score, termsVersion: row.terms_version,
        stateRevision: row.state_revision, snapshotHash: row.snapshot_hash, acceptedEventId: row.accepted_event_id,
        createdAt: row.created_at, source: PARTICIPANT_REVIEW_SOURCE, scope: PARTICIPANT_REPUTATION_SCOPE, dealScope: this.scope };
      // A review and its durable actor/payload-bound receipt must survive together.
      // This detects bounded damage, not a hostile owner rewriting the entire DB.
      const matching = requests.filter(requestRow => {
        let receipt;
        try { receipt = exact(parse(requestRow.receipt_json), ['reviewId']); } catch { fail('store_corrupt'); }
        return receipt.reviewId === review.id;
      });
      const saved = matching[0];
      if (matching.length !== 1 || seenRequests.has(saved.request_id) || !uuid(saved.request_id) ||
          saved.actor_id !== review.authorId || saved.payload_hash !== encodedHash(this.#reviewPayload(review)) ||
          saved.created_at < review.createdAt || !integer(saved.created_at, 0)) fail('store_corrupt');
      seenRequests.add(saved.request_id);
      return review;
    });
  }
  listReviews(actorId, dealId) {
    return this.#transaction(() => this.#reviews(this.#deal(actorId, dealId)));
  }
  review(actorId, dealId, value) {
    return this.#transaction(() => {
      // Membership comes before request detail or historical receipt lookup.
      const deal = this.#deal(actorId, dealId);
      const input = exact(value, ['requestId', 'expectedVersion', 'expectedStateRevision', 'snapshotHash', 'score']);
      request(input.requestId); version(input.expectedVersion);
      if (!integer(input.expectedStateRevision, 0) || typeof input.snapshotHash !== 'string' ||
          !HASH.test(input.snapshotHash) || !integer(input.score) || input.score > 5) fail('invalid_request');
      const payload = { expectedVersion: input.expectedVersion, expectedStateRevision: input.expectedStateRevision,
        snapshotHash: input.snapshotHash, score: input.score };
      const receipt = this.#receipt(actorId, input.requestId, 'review', dealId, payload);
      const existing = this.#reviews(deal);
      if (receipt) {
        let saved;
        try { saved = exact(receipt, ['reviewId']); } catch { fail('store_corrupt'); }
        const review = existing.find(review => review.id === saved.reviewId && review.authorId === actorId);
        if (!review) fail('store_corrupt');
        return { review, historical: true };
      }
      if (deal.version !== input.expectedVersion) fail('stale_deal');
      if (deal.stateRevision !== input.expectedStateRevision) fail('state_conflict');
      if (deal.snapshotHash !== input.snapshotHash) fail('snapshot_mismatch');
      if (deal.state !== 'accepted' || deal.participants.length !== 2) fail('review_not_allowed');
      if (existing.some(review => review.authorId === actorId)) fail('review_already_exists');
      const target = deal.participants.find(party => party.id !== actorId);
      const terminal = deal.events.at(-1);
      if (!target || terminal?.action !== 'accept') fail('store_corrupt');
      this.#requestLimit();
      const id = randomUUID(), createdAt = this.#time();
      if (createdAt < terminal.createdAt) fail('store_corrupt');
      this.#db.prepare('INSERT INTO participant_reviews VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, dealId, actorId,
        target.id, target.role, input.score, terminal.id, deal.version, deal.stateRevision, deal.snapshotHash, createdAt);
      this.#remember(actorId, input.requestId, 'review', dealId, payload, { reviewId: id });
      const review = this.#reviews(deal).find(review => review.id === id);
      if (!review) fail('store_corrupt');
      return { review, historical: false };
    }, true);
  }
  #reputation(participantId) {
    const participant = this.#participant(participantId);
    const roles = { seller: { count: 0, scoreTotal: 0, average: null }, buyer: { count: 0, scoreTotal: 0, average: null } };
    // Read memberships, not only review rows: a deleted review cannot disappear
    // from an aggregate while its accepted request receipt still exists.
    const memberships = this.#db.prepare('SELECT deal_id FROM participant_memberships WHERE participant_id=? ORDER BY deal_id LIMIT 101').all(participantId);
    if (memberships.length > PARTICIPANT_DEAL_LIMIT) fail('store_corrupt');
    for (const { deal_id: dealId } of memberships) {
      for (const review of this.#reviews(this.#deal(participantId, dealId))) {
        if (review.targetId !== participantId) continue;
        const role = roles[review.targetRole]; role.count++; role.scoreTotal += review.score;
      }
    }
    for (const role of Object.values(roles)) if (role.count) role.average = Number((role.scoreTotal / role.count).toFixed(2));
    return { participant, roles, scope: PARTICIPANT_REPUTATION_SCOPE, source: PARTICIPANT_REVIEW_SOURCE,
      dealScope: this.scope, signatureVerified: false, eligibility: 'accepted_local_test_deals_only' };
  }
  getReputation(actorId) { return this.#transaction(() => this.#reputation(actorId)); }
  getDealReputation(actorId, dealId) {
    return this.#transaction(() => this.#deal(actorId, dealId).participants.map(party => this.#reputation(party.id)));
  }
  listDocuments(actorId, dealId) {
    return this.#transaction(() => {
      return this.#deal(actorId, dealId).documents;
    });
  }
  readDocument(actorId, dealId, documentId) {
    return this.#transaction(() => {
      this.#deal(actorId, dealId);
      if (!uuid(documentId)) fail('invalid_request');
      return this.#documents.read(dealId, documentId);
    });
  }
  addDocument(actorId, dealId, value) {
    return this.#transaction(() => {
      this.#member(actorId, dealId);
      const input = exact(value, ['requestId', 'expectedVersion', 'category', 'bytes']);
      request(input.requestId); version(input.expectedVersion);
      if (!Buffer.isBuffer(input.bytes) || types.isProxy(input.bytes) ||
          typeof input.category !== 'string' || !['contract', 'delivery', 'quality', 'other'].includes(input.category)) fail('invalid_request');
      // TestDocuments performs the byte and format limits, including UTF-8 integrity.
      if (input.bytes.length > TEST_DOCUMENT_MAX_BYTES) throw new TestDocumentError('document_limit');
      const bytes = Buffer.from(input.bytes);
      const payload = { expectedVersion: input.expectedVersion, category: input.category, byteLength: bytes.length, sha256: hash(bytes) };
      const receipt = this.#receipt(actorId, input.requestId, 'document', dealId, payload);
      if (receipt) return this.#documents.read(dealId, receipt.documentId).document;
      const row = this.#row(dealId);
      if (row.version !== input.expectedVersion) fail('stale_deal');
      if (row.state !== 'draft') fail('state_conflict');
      this.#requestLimit();
      const document = this.#documents.add({ dealId, ...input, bytes });
      this.#remember(actorId, input.requestId, 'document', dealId, payload, { documentId: document.id });
      return document;
    }, true);
  }
  reviseDeal(actorId, dealId, value) {
    return this.#transaction(() => {
      const { role } = this.#member(actorId, dealId);
      const input = exact(value, ['requestId', 'expectedVersion', 'scenario', 'quantity', 'amount', 'date']);
      request(input.requestId); version(input.expectedVersion);
      const normalized = { expectedVersion: input.expectedVersion, ...terms(input) };
      const receipt = this.#receipt(actorId, input.requestId, 'revise', dealId, normalized);
      if (receipt) return { ...receipt, historical: true };
      if (role !== 'seller') fail('forbidden');
      const row = this.#row(dealId);
      if (row.version !== input.expectedVersion) fail('stale_deal');
      if (row.state !== 'draft') fail('state_conflict');
      this.#requestLimit();
      if (['scenario', 'quantity', 'amount', 'date'].every((field) => normalized[field] === row[field])) {
        const deal = { ...this.#deal(actorId, dealId), unchanged: true };
        this.#remember(actorId, input.requestId, 'revise', dealId, normalized, deal);
        return { ...deal, historical: false };
      }
      if (row.version === Number.MAX_SAFE_INTEGER) fail('store_corrupt');
      const nextVersion = row.version + 1;
      this.#db.prepare('UPDATE drafts SET version = ?, scenario = ?, quantity = ?, amount = ?, date = ? WHERE id = ?')
        .run(nextVersion, normalized.scenario, normalized.quantity, normalized.amount, normalized.date, dealId);
      this.#db.prepare('INSERT INTO draft_versions VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(dealId, nextVersion, normalized.scenario, normalized.quantity, normalized.amount, normalized.date, this.#time());
      const deal = this.#deal(actorId, dealId);
      this.#remember(actorId, input.requestId, 'revise', dealId, normalized, deal);
      return { ...deal, historical: false };
    }, true);
  }
  action(actorId, dealId, value) {
    if (this.#signed) fail('signature_required');
    return this.#action(actorId, dealId, value);
  }
  #action(actorId, dealId, value, authorization) {
    return this.#transaction(() => {
      const { role } = this.#member(actorId, dealId);
      const input = exact(value, ['requestId', 'action', 'expectedVersion', 'expectedStateRevision', 'snapshotHash']);
      request(input.requestId); version(input.expectedVersion);
      if (typeof input.action !== 'string' || !Object.hasOwn(ACTIONS, input.action) ||
          !integer(input.expectedStateRevision, 0) || typeof input.snapshotHash !== 'string' || !HASH.test(input.snapshotHash)) fail('invalid_request');
      const payload = { action: input.action, expectedVersion: input.expectedVersion,
        expectedStateRevision: input.expectedStateRevision, snapshotHash: input.snapshotHash };
      const receipt = this.#receipt(actorId, input.requestId, 'action', dealId, payload);
      if (receipt) {
        const event = this.#eventRows(dealId).find(({ id }) => id === receipt.eventId);
        if (!event) fail('store_corrupt');
        return { event, historical: true, deal: this.#deal(actorId, dealId) };
      }
      const policy = ACTIONS[input.action];
      if (policy.role && role !== policy.role) fail('forbidden');
      const deal = this.#deal(actorId, dealId);
      if (deal.version !== input.expectedVersion) fail('stale_deal');
      if (deal.stateRevision !== input.expectedStateRevision) fail('state_conflict');
      if (deal.snapshotHash !== input.snapshotHash) fail('snapshot_mismatch');
      if (!policy.from.includes(deal.state) || deal.participants.length !== 2) fail('state_conflict');
      if (deal.stateRevision === Number.MAX_SAFE_INTEGER) fail('store_corrupt');
      this.#requestLimit();
      const event = { id: randomUUID(), dealId, action: input.action, actorId, role,
        termsVersion: deal.version, stateRevision: deal.stateRevision + 1,
        snapshotHash: deal.snapshotHash, termsFingerprint: deal.termsFingerprint,
        documentManifestHash: encodedHash([...deal.documents].sort((a, b) => a.id.localeCompare(b.id))),
        createdAt: this.#time(), stateFrom: deal.state, stateTo: policy.to,
        source: this.#signed ? SIGNED_SOURCE : SOURCE, scope: this.scope,
        ...(this.#signed ? { authorization } : {}) };
      this.#db.prepare(`UPDATE participant_deals SET state = ?, state_revision = ?,
        offered_snapshot_hash = COALESCE(offered_snapshot_hash, ?) WHERE id = ?`)
        .run(policy.to, event.stateRevision, deal.snapshotHash, dealId);
      this.#db.prepare('INSERT INTO participant_events VALUES (?, ?, ?, ?)').run(event.id, dealId, event.stateRevision, JSON.stringify(event));
      this.#remember(actorId, input.requestId, 'action', dealId, payload, { eventId: event.id });
      // The signature service saves its receipt in this same transaction before
      // detail can validate the event's receipt link. Do not read it early.
      return { event, historical: false, deal: this.#signed ? null : this.#deal(actorId, dealId) };
    }, true);
  }
}
