// Capability-account binding and commands for the isolated personal TEST cabinet.
// TEST CMS does not establish login, corporate powers, legal agreement or payment.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { types } from 'node:util';
import { canonicalDraftTerms, fingerprintDraftTerms } from '../web/terms.mjs';

export const PARTICIPANT_SIGNATURE_DOMAIN = 'dalahold:participant-personal-test-signatures:v1';
export const PARTICIPANT_SIGNATURE_SCOPE = 'local_personal_test_signed_deal_only';
export const PARTICIPANT_SIGNATURE_STATEMENT = 'Personal TEST certificate statement for this local capability account and exact TEST deal only. Enrollment is not login or corporate authority. No real legal agreement, wallet transfer, payment or production action is authorized. A separate anchor statement can authorize only the fixed operator-configured devnet Memo.';
export const PARTICIPANT_SIGNATURE_PENDING_LIMIT = 100;
export const PARTICIPANT_SIGNATURE_HISTORY_LIMIT = 500;
export const PARTICIPANT_SIGNATURE_CMS_BYTE_LIMIT = 16 * 1024 * 1024;
const DOMAIN = PARTICIPANT_SIGNATURE_DOMAIN, SCOPE = PARTICIPANT_SIGNATURE_SCOPE;
const SOURCE = 'test_ocsp', EVENT_SOURCE = 'personal_test_nca_statement';
const ENROLL = 'enroll_test_participant', ANCHOR = 'anchor_test_memo';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const ROLES = new Set(['seller', 'buyer']);
const STATES = new Set(['draft', 'offered', 'agreed', 'handed_over', 'accepted', 'disputed']);
const ACTIONS = {
  offer: { role: 'seller', from: ['draft'], to: 'offered' },
  agree: { role: 'buyer', from: ['offered'], to: 'agreed' },
  handover: { role: 'seller', from: ['agreed'], to: 'handed_over' },
  accept: { role: 'buyer', from: ['handed_over'], to: 'accepted' },
  dispute: { role: null, from: ['agreed', 'handed_over'], to: 'disputed' },
};
const AUTH_FIELDS = ['receiptId', 'intentHash', 'certificateDigest', 'bindingId', 'authEpoch', 'statusSource'];
const EVENT_FIELDS = ['id', 'dealId', 'action', 'actorId', 'role', 'termsVersion', 'stateRevision',
  'snapshotHash', 'termsFingerprint', 'documentManifestHash', 'createdAt', 'stateFrom', 'stateTo', 'source', 'scope', 'authorization'];
const RECEIPT_FIELDS = ['id', 'intentId', 'intentHash', 'actorId', 'action', 'dealId', 'eventId', 'snapshotHash',
  'bindingId', 'authEpoch', 'certificateDigest', 'verifiedAt', 'validUntil', 'statusSource', 'scope'];
const INTENT_FIELDS = ['domain', 'purpose', 'scope', 'statement', 'action', 'nonce', 'actorId', 'sessionHash',
  'issuedAt', 'expiresAt', 'statusSource', 'binding', 'snapshot', 'request', 'operation'];
const SNAPSHOT_FIELDS = ['dealId', 'version', 'canonicalTerms', 'termsFingerprint', 'documents', 'participants',
  'role', 'state', 'stateRevision', 'snapshotHash', 'terminalEventId'];
const DOCUMENT_FIELDS = ['id', 'dealId', 'termsVersion', 'category', 'byteLength', 'sha256', 'createdAt', 'scope', 'fileKind'];
const BINDING_FIELDS = ['bindingId', 'certificateDigest', 'authEpoch', 'scope'];
const REQUEST_FIELDS = ['requestId', 'action', 'expectedVersion', 'expectedStateRevision', 'snapshotHash'];
const OPERATION_FIELDS = ['cluster', 'programId', 'walletAddress', 'maxFeeLamports', 'memo', 'snapshotHash', 'eventId'];
const STATUSES = {
  signature_request_invalid: 400, signature_guard_invalid: 400, unauthorized: 401, signature_forbidden: 403,
  signature_intent_not_found: 404, signature_state_changed: 409, signature_intent_changed: 409,
  signature_receipt_changed: 409, signature_binding_changed: 409, signature_snapshot_stale: 409,
  signature_intent_expired: 409, signature_status_expired: 409, signature_replay_conflict: 409,
  signature_binding_required: 409, signature_renewal_required: 409, signature_person_already_bound: 409,
  signature_certificate_already_bound: 409, signature_identity_mismatch: 409, signature_anchor_unavailable: 409,
  signature_state_conflict: 409, signature_pending_limit: 413, signature_history_limit: 413,
  signature_identity_rejected: 422, signature_organization_disabled: 422, signature_rejected: 422,
  verifier_busy: 429, verifier_unavailable: 503, status_unavailable: 503, verification_in_progress: 409,
  signature_store_closed: 409, signature_dependencies_invalid: 500, signature_clock_invalid: 500,
};
export class ParticipantSignatureError extends Error {
  constructor(code) {
    super(Object.hasOwn(STATUSES, code) ? code : 'signature_state_changed');
    this.name = 'ParticipantSignatureError'; this.code = this.message; this.status = STATUSES[this.code];
  }
}
const fail = code => { throw new ParticipantSignatureError(code); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = value => typeof value === 'string' && HASH.test(value);
const uuid = value => typeof value === 'string' && UUID.test(value);
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const slots = new WeakMap();

function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  return value;
}
function fields(value, names, code = 'signature_request_invalid') {
  object(value, code);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || !names.every(name => keys.includes(name))) fail(code);
  return select(value, names, code);
}
function select(value, names, code = 'signature_state_changed') {
  object(value, code);
  const output = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
    output[name] = descriptor.value;
  }
  return output;
}
function array(value, maximum, code, fn) {
  if (!Array.isArray(value) || types.isProxy(value) || value.length > maximum ||
      Reflect.ownKeys(value).length !== value.length + 1) fail(code);
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
    return fn(descriptor.value);
  });
}
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function sync(fn, code) {
  const result = fn();
  if (result === false || (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result)) fail(code);
  return result;
}
function guard(options) {
  if (options === undefined) return () => {};
  object(options, 'signature_guard_invalid');
  if (Reflect.ownKeys(options).some(key => key !== 'assertCurrent')) fail('signature_guard_invalid');
  if (!Object.hasOwn(options, 'assertCurrent')) return () => {};
  const value = fields(options, ['assertCurrent'], 'signature_guard_invalid').assertCurrent;
  if (typeof value !== 'function') fail('signature_guard_invalid');
  return () => { sync(value, 'signature_guard_invalid'); };
}
function publicBinding(value, code = 'signature_binding_changed') {
  const binding = fields(value, BINDING_FIELDS, code);
  if (!uuid(binding.bindingId) || !hash(binding.certificateDigest) || binding.authEpoch !== 0 || binding.scope !== SCOPE) fail(code);
  return binding;
}
function actionRequest(value, action = null, code = 'signature_request_invalid') {
  const request = fields(value, REQUEST_FIELDS, code);
  if (!uuid(request.requestId) || !integer(request.expectedVersion, 1) || !integer(request.expectedStateRevision) ||
      !hash(request.snapshotHash) || typeof request.action !== 'string' ||
      (action ? request.action !== action : !Object.hasOwn(ACTIONS, request.action))) fail(code);
  return request;
}
function documents(value, dealId, version, code) {
  const result = array(value, 10, code, value => {
    const document = fields(value, DOCUMENT_FIELDS, code);
    if (!uuid(document.id) || document.dealId !== dealId || document.termsVersion !== version ||
        !['contract', 'delivery', 'quality', 'other'].includes(document.category) ||
        !integer(document.byteLength, 1) || document.byteLength > 262_144 || !hash(document.sha256) ||
        !integer(document.createdAt) || document.scope !== 'local_test_document_only' || document.fileKind !== 'text') fail(code);
    return document;
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (result.some((row, i) => i && row.id === result[i - 1].id)) fail(code);
  return result;
}
function snapshot(value, code = 'signature_intent_changed') {
  const result = fields(value, SNAPSHOT_FIELDS, code);
  if (!uuid(result.dealId) || !integer(result.version, 1) || typeof result.canonicalTerms !== 'string' ||
      !hash(result.termsFingerprint) || !hash(result.snapshotHash) || !ROLES.has(result.role) ||
      !STATES.has(result.state) || !integer(result.stateRevision) ||
      (result.terminalEventId !== null && !uuid(result.terminalEventId))) fail(code);
  result.documents = documents(result.documents, result.dealId, result.version, code);
  result.participants = array(result.participants, 2, code, participant => {
    const row = fields(participant, ['id', 'role', 'bindingId', 'certificateDigest', 'authEpoch'], code);
    if (!uuid(row.id) || !ROLES.has(row.role) || !uuid(row.bindingId) || !hash(row.certificateDigest) || row.authEpoch !== 0) fail(code);
    return row;
  }).sort((a, b) => a.role.localeCompare(b.role) || a.id.localeCompare(b.id));
  if (result.participants.length !== 2 || result.participants[0].id === result.participants[1].id ||
      result.participants[0].role === result.participants[1].role ||
      result.participants[0].bindingId === result.participants[1].bindingId ||
      result.participants[0].certificateDigest === result.participants[1].certificateDigest ||
      (result.state === 'accepted') !== (result.terminalEventId !== null)) fail(code);
  return result;
}
function wallet(value) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let number = 0n;
  for (const character of value) number = number * 58n + BigInt(alphabet.indexOf(character));
  const leading = value.match(/^1*/)[0].length;
  const length = number ? Math.ceil(number.toString(16).length / 2) : 0;
  return leading + length === 32;
}
function operation(value, current, code = 'signature_intent_changed') {
  const result = fields(value, OPERATION_FIELDS, code);
  if (result.cluster !== 'devnet' || result.programId !== MEMO_PROGRAM || !wallet(result.walletAddress) ||
      typeof result.maxFeeLamports !== 'string' || !/^[1-9]\d{0,4}$/.test(result.maxFeeLamports) ||
      BigInt(result.maxFeeLamports) > 10000n || result.snapshotHash !== current.snapshotHash ||
      result.eventId !== current.terminalEventId || !uuid(result.eventId) ||
      result.memo !== `DalaHold TEST v1 ${result.snapshotHash} ${result.eventId}`) fail(code);
  return result;
}

export class ParticipantSignatures {
  #db; #sdk; #now; #readParticipant; #readDeal; #commit; #atomic; #memo; #key;
  #closed = false; #inflight = 0; #slots;

  // Caller owns this private isolated signed-mode DB and its transaction helper.
  // atomic must carry finalCheck through nested savepoints to the outer COMMIT.
  // No transaction stays open across SDK await. The protected key detects row
  // edits, not whole-database rollback/replacement or an operator with the key.
  constructor({ db, sdk, now = Date.now, readParticipant, readDeal, commitSignedAction, atomic, memoConfiguration } = {}) {
    if (!(db instanceof DatabaseSync) || !sdk || sdk.statusSource !== SOURCE ||
        typeof sdk.verifyIdentity !== 'function' || typeof sdk.inspect !== 'function' || typeof now !== 'function' ||
        typeof readParticipant !== 'function' || typeof readDeal !== 'function' ||
        typeof commitSignedAction !== 'function' || typeof atomic !== 'function') fail('signature_dependencies_invalid');
    this.#db = db; this.#sdk = sdk; this.#now = now; this.#readParticipant = readParticipant;
    this.#readDeal = readDeal; this.#commit = commitSignedAction; this.#atomic = atomic;
    if (memoConfiguration !== undefined) {
      object(memoConfiguration, 'signature_dependencies_invalid');
      const names = Object.hasOwn(memoConfiguration, 'maxFeeLamports') ? ['walletAddress', 'maxFeeLamports'] : ['walletAddress'];
      const config = fields(memoConfiguration, names, 'signature_dependencies_invalid');
      if (!Object.hasOwn(config, 'maxFeeLamports')) config.maxFeeLamports = '10000';
      if (!wallet(config.walletAddress) || typeof config.maxFeeLamports !== 'string' ||
          !/^[1-9]\d{0,4}$/.test(config.maxFeeLamports) || BigInt(config.maxFeeLamports) > 10000n) fail('signature_dependencies_invalid');
      this.#memo = freeze(config);
    }
    this.#slots = slots.get(db) || { active: 0 }; slots.set(db, this.#slots);
    try {
      sync(() => atomic(() => {}, () => {
        db.exec(`CREATE TABLE IF NOT EXISTS participant_signature_meta (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), domain TEXT NOT NULL,
          mapping_key BLOB NOT NULL, key_id TEXT NOT NULL,
          binding_count INTEGER NOT NULL CHECK(binding_count>=0), binding_set_mac TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS participant_signature_bindings (
          actor_id TEXT PRIMARY KEY, binding_id TEXT NOT NULL UNIQUE, person_id TEXT NOT NULL UNIQUE,
          certificate_digest TEXT NOT NULL UNIQUE, auth_epoch INTEGER NOT NULL CHECK(auth_epoch=0), binding_mac TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS participant_signature_intents (
          id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, session_hash TEXT NOT NULL,
          bytes BLOB NOT NULL, bytes_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, intent_mac TEXT NOT NULL,
          signature_hash TEXT, cms BLOB, receipt_id TEXT UNIQUE, receipt_json TEXT, event_json TEXT, receipt_mac TEXT
        ) STRICT;`);
        const rows = db.prepare('SELECT * FROM participant_signature_meta').all();
        if (rows.length > 1) fail('signature_state_changed');
        if (!rows.length) {
          if (db.prepare('SELECT count(*) AS n FROM participant_signature_bindings').get().n ||
              db.prepare('SELECT count(*) AS n FROM participant_signature_intents').get().n) fail('signature_state_changed');
          const key = randomBytes(32);
          try {
            const bindingSetMac = createHmac('sha256', key).update(`${DOMAIN}:binding-set\0`).update('[]').digest('hex');
            db.prepare('INSERT INTO participant_signature_meta VALUES (1,?,?,?,0,?)').run(DOMAIN, key, this.#keyId(key), bindingSetMac);
          }
          finally { key.fill(0); }
        }
        const meta = this.#metadata(); this.#key = Buffer.from(meta.mapping_key); this.#available();
        for (const row of db.prepare('SELECT * FROM participant_signature_bindings').all()) this.#binding(row.actor_id);
        for (const row of db.prepare('SELECT * FROM participant_signature_intents').all()) {
          this.#decode(row); row.receipt_json === null ? this.#pending(row) : this.#accepted(row);
        }
      }), 'signature_state_changed');
    } catch (error) { this.#key?.fill(0); throw error instanceof ParticipantSignatureError ? error : new ParticipantSignatureError('signature_state_changed'); }
  }
  #keyId(key) { return sha(Buffer.concat([Buffer.from(`${DOMAIN}:mapping-key\0`), key])); }
  #metadata() {
    const rows = this.#db.prepare('SELECT * FROM participant_signature_meta').all();
    if (rows.length !== 1) fail('signature_state_changed');
    const meta = fields(rows[0], ['singleton', 'domain', 'mapping_key', 'key_id', 'binding_count', 'binding_set_mac'], 'signature_state_changed');
    if (meta.singleton !== 1 || meta.domain !== DOMAIN || !(meta.mapping_key instanceof Uint8Array) ||
        meta.mapping_key.length !== 32 || meta.key_id !== this.#keyId(Buffer.from(meta.mapping_key)) ||
        !integer(meta.binding_count) || !hash(meta.binding_set_mac)) fail('signature_state_changed');
    return meta;
  }
  #available() {
    if (this.#closed) fail('signature_store_closed');
    const meta = this.#metadata();
    if (!timingSafeEqual(Buffer.from(meta.mapping_key), this.#key)) fail('signature_state_changed');
    // Individual row deletion must not free another account's person/cert slot.
    // This bounded keyed registry checksum covers additions, edits and removal.
    const bindings = this.#bindingSet();
    if (bindings.length !== meta.binding_count) fail('signature_binding_changed');
    this.#checkMac(meta.binding_set_mac, this.#mac('binding-set', bindings), 'signature_binding_changed');
  }
  #time() {
    const now = this.#now();
    if (!integer(now) || now > Number.MAX_SAFE_INTEGER - 300_000) fail('signature_clock_invalid');
    return now;
  }
  #mac(label, value) { return createHmac('sha256', this.#key).update(`${DOMAIN}:${label}\0`).update(JSON.stringify(value)).digest('hex'); }
  #bindingSet() {
    return this.#db.prepare('SELECT * FROM participant_signature_bindings ORDER BY actor_id').all()
      .map(row => [row.actor_id, row.binding_id, row.person_id, row.certificate_digest, row.auth_epoch, row.binding_mac]);
  }
  #sealBindingSet() {
    const bindings = this.#bindingSet();
    const result = this.#db.prepare('UPDATE participant_signature_meta SET binding_count=?,binding_set_mac=? WHERE singleton=1')
      .run(bindings.length, this.#mac('binding-set', bindings));
    if (result.changes !== 1) fail('signature_state_changed');
  }
  #checkMac(actual, expected, code) {
    if (!hash(actual) || !timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))) fail(code);
  }
  #transaction(assertCurrent, fn, finalCheck = () => {}) {
    this.#available();
    return sync(() => this.#atomic(assertCurrent, () => {
      this.#available(); assertCurrent(); return sync(fn, 'signature_state_changed');
    }, () => { this.#available(); assertCurrent(); sync(finalCheck, 'signature_state_changed'); }), 'signature_state_changed');
  }
  #actor(actorId) {
    if (!uuid(actorId)) fail('unauthorized');
    const actor = select(sync(() => this.#readParticipant(actorId), 'signature_state_changed'), ['id']);
    if (actor.id !== actorId) fail('unauthorized');
  }
  #binding(actorId) {
    const row = this.#db.prepare('SELECT * FROM participant_signature_bindings WHERE actor_id=?').get(actorId);
    if (!row) return null;
    const data = fields(row, ['actor_id', 'binding_id', 'person_id', 'certificate_digest', 'auth_epoch', 'binding_mac'], 'signature_binding_changed');
    if (!uuid(data.actor_id) || !uuid(data.binding_id) || !/^person:[a-f0-9]{64}$/.test(data.person_id) ||
        !hash(data.certificate_digest) || data.auth_epoch !== 0) fail('signature_binding_changed');
    this.#checkMac(data.binding_mac, this.#mac('binding', [data.actor_id, data.binding_id, data.person_id,
      data.certificate_digest, data.auth_epoch]), 'signature_binding_changed');
    return { ...data, public: { bindingId: data.binding_id, certificateDigest: data.certificate_digest, authEpoch: 0, scope: SCOPE } };
  }
  getBinding(actorId) {
    return this.#transaction(() => {}, () => { this.#actor(actorId); return freeze(this.#binding(actorId)?.public ?? null); });
  }
  #current(actorId, dealId) {
    this.#actor(actorId);
    const deal = sync(() => this.#readDeal(actorId, dealId), 'signature_state_changed');
    const source = select(deal, ['id', 'version', 'scenario', 'quantity', 'amount', 'date', 'state', 'stateRevision',
      'termsFingerprint', 'role', 'participants', 'documents', 'events', 'snapshotHash']);
    if (source.id !== dealId || !uuid(source.id) || !integer(source.version, 1) ||
        !STATES.has(source.state) || !integer(source.stateRevision) || !ROLES.has(source.role) || !hash(source.snapshotHash)) fail('signature_state_changed');
    const terms = { dealId, version: source.version, scenario: source.scenario, quantity: source.quantity, amount: source.amount, date: source.date };
    let canonicalTerms, termsFingerprint;
    try { canonicalTerms = canonicalDraftTerms(terms).toString('utf8'); termsFingerprint = fingerprintDraftTerms(terms); }
    catch { fail('signature_state_changed'); }
    if (termsFingerprint !== source.termsFingerprint) fail('signature_state_changed');
    const manifest = documents(source.documents, dealId, source.version, 'signature_state_changed');
    const parties = array(source.participants, 2, 'signature_state_changed', value => {
      const participant = fields(value, ['id', 'label', 'role'], 'signature_state_changed');
      if (!uuid(participant.id) || !ROLES.has(participant.role) || typeof participant.label !== 'string') fail('signature_state_changed');
      return participant;
    }).sort((a, b) => a.role.localeCompare(b.role) || a.id.localeCompare(b.id));
    if (parties.length !== 2 || parties[0].id === parties[1].id || parties[0].role === parties[1].role ||
        !parties.some(row => row.id === actorId && row.role === source.role)) fail('signature_binding_required');
    const bindings = parties.map(row => this.#binding(row.id));
    if (bindings.some(binding => !binding)) fail('signature_binding_required');
    if (bindings[0].person_id === bindings[1].person_id || bindings[0].certificate_digest === bindings[1].certificate_digest) fail('signature_identity_mismatch');
    const snapshotHash = sha(JSON.stringify({ schema: 'dalahold.local-test-participant-snapshot.v1', canonicalTerms, documents: manifest, participants: parties }));
    if (snapshotHash !== source.snapshotHash) fail('signature_state_changed');
    const events = array(source.events, 2000, 'signature_state_changed', value => this.validateEvent(value));
    if (events.length !== source.stateRevision) fail('signature_state_changed');
    let state = 'draft';
    for (const [index, event] of events.entries()) {
      const policy = ACTIONS[event.action];
      if (event.dealId !== dealId || event.termsVersion !== source.version || event.termsFingerprint !== termsFingerprint ||
          event.documentManifestHash !== sha(JSON.stringify(manifest)) || event.snapshotHash !== snapshotHash ||
          event.stateFrom !== state || event.stateRevision !== index + 1 || !policy.from.includes(state) ||
          !parties.some(row => row.id === event.actorId && row.role === event.role)) fail('signature_state_changed');
      state = event.stateTo;
    }
    if (state !== source.state) fail('signature_state_changed');
    return snapshot({ dealId, version: source.version, canonicalTerms, termsFingerprint, documents: manifest,
      participants: parties.map((row, index) => ({ id: row.id, role: row.role, bindingId: bindings[index].binding_id,
        certificateDigest: bindings[index].certificate_digest, authEpoch: 0 })), role: source.role,
      state: source.state, stateRevision: source.stateRevision, snapshotHash,
      terminalEventId: state === 'accepted' ? events.at(-1)?.id : null }, 'signature_state_changed');
  }
  #assertRequest(current, request) {
    if (current.version !== request.expectedVersion || current.stateRevision !== request.expectedStateRevision ||
        current.snapshotHash !== request.snapshotHash) fail('signature_snapshot_stale');
    if (request.action === ANCHOR) {
      if (current.state !== 'accepted' || !current.terminalEventId || !this.#memo) fail('signature_anchor_unavailable');
    } else {
      const policy = ACTIONS[request.action];
      if (policy.role && policy.role !== current.role) fail('signature_forbidden');
      if (!policy.from.includes(current.state)) fail('signature_state_conflict');
      if (current.stateRevision === Number.MAX_SAFE_INTEGER) fail('signature_state_changed');
    }
  }
  #memoUnchanged(intent) {
    if (intent.action !== ANCHOR) return;
    if (!this.#memo || !equal(intent.operation, operation(intent.operation, intent.snapshot)) ||
        intent.operation.walletAddress !== this.#memo.walletAddress ||
        intent.operation.maxFeeLamports !== this.#memo.maxFeeLamports) fail('signature_anchor_unavailable');
  }
  #bindingUnchanged(actorId, expected) {
    if (!equal(this.#binding(actorId)?.public ?? null, expected)) fail('signature_binding_changed');
  }
  #intentMac(row) { return this.#mac('intent', [row.id, row.actor_id, row.session_hash, row.bytes_hash, row.expires_at]); }
  #receiptMac(row) { return this.#mac('receipt', [row.id, row.actor_id, row.session_hash, row.bytes_hash, row.expires_at,
    row.signature_hash, row.receipt_id, row.receipt_json, row.event_json]); }
  #decode(row) {
    const code = 'signature_intent_changed';
    if (!row || !uuid(row.id) || !uuid(row.actor_id) || !hash(row.session_hash) || !hash(row.bytes_hash) ||
        !integer(row.expires_at) || !(row.bytes instanceof Uint8Array)) fail(code);
    this.#checkMac(row.intent_mac, this.#intentMac(row), code);
    const bytes = Buffer.from(row.bytes);
    if (bytes.length > 9000 || sha(bytes) !== row.bytes_hash) fail(code);
    let input;
    try { input = JSON.parse(bytes.toString('utf8')); } catch { fail(code); }
    const intent = fields(input, INTENT_FIELDS, code);
    if (intent.domain !== DOMAIN || intent.purpose !== 'TEST' || intent.scope !== SCOPE ||
        intent.statement !== PARTICIPANT_SIGNATURE_STATEMENT || intent.nonce !== row.id || intent.actorId !== row.actor_id ||
        intent.sessionHash !== row.session_hash || intent.statusSource !== SOURCE || !integer(intent.issuedAt) ||
        intent.expiresAt !== intent.issuedAt + 300_000 || intent.expiresAt !== row.expires_at) fail(code);
    if (intent.binding !== null) intent.binding = publicBinding(intent.binding, code);
    if (intent.action === ENROLL) {
      if (intent.snapshot !== null || intent.request !== null || intent.operation !== null) fail(code);
    } else {
      if (intent.action !== ANCHOR && !Object.hasOwn(ACTIONS, intent.action)) fail(code);
      if (!intent.binding) fail(code);
      intent.snapshot = snapshot(intent.snapshot, code);
      intent.request = actionRequest(intent.request, intent.action, code);
      if (intent.action === ANCHOR) intent.operation = operation(intent.operation, intent.snapshot, code);
      else if (intent.operation !== null) fail(code);
      const actor = intent.snapshot.participants.find(row => row.id === intent.actorId && row.role === intent.snapshot.role);
      if (!actor || actor.bindingId !== intent.binding.bindingId || actor.certificateDigest !== intent.binding.certificateDigest ||
          actor.authEpoch !== intent.binding.authEpoch || intent.request.expectedVersion !== intent.snapshot.version ||
          intent.request.expectedStateRevision !== intent.snapshot.stateRevision || intent.request.snapshotHash !== intent.snapshot.snapshotHash) fail(code);
    }
    if (!encode(intent).equals(bytes)) fail(code);
    return { intent, bytes };
  }
  #pending(row) {
    if ([row.signature_hash, row.cms, row.receipt_id, row.receipt_json, row.event_json, row.receipt_mac].some(value => value !== null)) fail('signature_receipt_changed');
  }
  #accepted(row) {
    const code = 'signature_receipt_changed';
    const { intent } = this.#decode(row);
    if (!hash(row.signature_hash) || !(row.cms instanceof Uint8Array) || !row.cms.length || row.cms.length > 98_304 ||
        sha(row.cms) !== row.signature_hash || !uuid(row.receipt_id) || typeof row.receipt_json !== 'string') fail(code);
    this.#checkMac(row.receipt_mac, this.#receiptMac(row), code);
    let receipt;
    try { receipt = JSON.parse(row.receipt_json); } catch { fail(code); }
    receipt = fields(receipt, RECEIPT_FIELDS, code);
    if (receipt.id !== row.receipt_id || receipt.intentId !== row.id || receipt.intentHash !== row.bytes_hash ||
        receipt.actorId !== row.actor_id || receipt.action !== intent.action || !uuid(receipt.bindingId) ||
        receipt.authEpoch !== 0 || !hash(receipt.certificateDigest) || !integer(receipt.verifiedAt) ||
        receipt.verifiedAt < intent.issuedAt || receipt.verifiedAt >= intent.expiresAt ||
        !integer(receipt.validUntil) || receipt.validUntil <= receipt.verifiedAt || receipt.statusSource !== SOURCE ||
        receipt.scope !== SCOPE || JSON.stringify(receipt) !== row.receipt_json) fail(code);
    if (intent.binding && (receipt.bindingId !== intent.binding.bindingId || receipt.authEpoch !== intent.binding.authEpoch ||
        receipt.certificateDigest !== intent.binding.certificateDigest)) fail(code);
    const binding = this.#binding(receipt.actorId);
    if (!binding || binding.binding_id !== receipt.bindingId || binding.certificate_digest !== receipt.certificateDigest ||
        binding.auth_epoch !== receipt.authEpoch) fail('signature_binding_changed');
    let event = null;
    if (intent.action === ENROLL) {
      if (receipt.dealId !== null || receipt.eventId !== null || receipt.snapshotHash !== null || row.event_json !== null) fail(code);
    } else {
      if (receipt.dealId !== intent.snapshot.dealId || receipt.snapshotHash !== intent.snapshot.snapshotHash) fail(code);
      if (intent.action === ANCHOR) {
        if (receipt.eventId !== intent.operation.eventId || row.event_json !== null) fail(code);
      } else {
        if (!uuid(receipt.eventId) || typeof row.event_json !== 'string') fail(code);
        try { event = JSON.parse(row.event_json); } catch { fail(code); }
        event = this.#event(event, receipt, intent, code);
        if (JSON.stringify(event) !== row.event_json) fail(code);
      }
    }
    return { receipt: freeze(receipt), event: event && freeze(event), intent };
  }
  #event(value, receipt, intent, code) {
    const event = fields(value, EVENT_FIELDS, code);
    event.authorization = fields(event.authorization, AUTH_FIELDS, code);
    const expectedAuthorization = this.#authorization(receipt);
    const policy = ACTIONS[intent.action];
    if (!policy || !uuid(event.id) || event.id !== receipt.eventId || event.dealId !== receipt.dealId ||
        event.action !== receipt.action || event.actorId !== receipt.actorId || event.role !== intent.snapshot.role ||
        event.termsVersion !== intent.snapshot.version || event.stateRevision !== intent.snapshot.stateRevision + 1 ||
        event.snapshotHash !== receipt.snapshotHash || event.termsFingerprint !== intent.snapshot.termsFingerprint ||
        event.documentManifestHash !== sha(JSON.stringify(intent.snapshot.documents)) || !integer(event.createdAt) ||
        event.createdAt < intent.issuedAt || event.createdAt >= intent.expiresAt || event.stateFrom !== intent.snapshot.state ||
        !policy.from.includes(event.stateFrom) || event.stateTo !== policy.to || event.source !== EVENT_SOURCE ||
        event.scope !== SCOPE || !equal(event.authorization, expectedAuthorization)) fail(code);
    return event;
  }
  #authorization(receipt) {
    return { receiptId: receipt.id, intentHash: receipt.intentHash, certificateDigest: receipt.certificateDigest,
      bindingId: receipt.bindingId, authEpoch: receipt.authEpoch, statusSource: SOURCE };
  }
  // Synchronous, no readDeal recursion: the accepted private CMS/receipt/event
  // record and its MAC must all agree with the exact public event authorization.
  validateEvent(value) {
    this.#available();
    const event = fields(value, EVENT_FIELDS, 'signature_receipt_changed');
    const authorization = fields(event.authorization, AUTH_FIELDS, 'signature_receipt_changed');
    if (!uuid(authorization.receiptId)) fail('signature_receipt_changed');
    const row = this.#db.prepare('SELECT * FROM participant_signature_intents WHERE receipt_id=?').get(authorization.receiptId);
    if (!row) fail('signature_receipt_changed');
    const accepted = this.#accepted(row);
    if (!accepted.event || !equal(event, accepted.event)) fail('signature_receipt_changed');
    return freeze(accepted.event);
  }
  // Export only an already accepted deal-action receipt after checking its
  // private record/MAC and exact event link. No CMS, subject or fresh authority.
  receiptForEvent(value) {
    const event = this.validateEvent(value);
    const row = this.#db.prepare('SELECT * FROM participant_signature_intents WHERE receipt_id=?').get(event.authorization.receiptId);
    return freeze(this.#accepted(row).receipt);
  }
  #row(actorId, sessionHash, id) {
    return this.#db.prepare('SELECT * FROM participant_signature_intents WHERE id=? AND actor_id=? AND session_hash=?').get(id, actorId, sessionHash);
  }
  #history(row, signatureHash) {
    const accepted = this.#accepted(row);
    if (row.signature_hash !== signatureHash) fail('signature_replay_conflict');
    return accepted.event ? { receipt: accepted.receipt, historical: true, event: accepted.event } : { receipt: accepted.receipt, historical: true };
  }
  #issue(actorId, sessionHash, action, request, assertCurrent, dealId = null) {
    if (!uuid(actorId) || !hash(sessionHash)) fail('signature_request_invalid');
    let issued;
    const check = () => {
      if (!issued) return;
      this.#actor(actorId); this.#bindingUnchanged(actorId, issued.intent.binding);
      const row = this.#row(actorId, sessionHash, issued.intent.nonce);
      if (!row || !this.#decode(row).bytes.equals(issued.bytes)) fail('signature_intent_changed');
      this.#pending(row);
      if (this.#time() >= issued.intent.expiresAt) fail('signature_intent_expired');
      if (dealId && !equal(this.#current(actorId, dealId), issued.intent.snapshot)) fail('signature_snapshot_stale');
    };
    return this.#transaction(assertCurrent, () => {
      this.#actor(actorId);
      const binding = this.#binding(actorId)?.public ?? null;
      const current = dealId ? this.#current(actorId, dealId) : null;
      if (dealId) this.#assertRequest(current, request);
      const issuedAt = this.#time(), expiresAt = issuedAt + 300_000;
      // Only expired, intact pending rows are pruned; accepted evidence persists.
      for (const row of this.#db.prepare('SELECT * FROM participant_signature_intents WHERE receipt_json IS NULL AND expires_at<=?').all(issuedAt)) {
        this.#decode(row); this.#pending(row);
        this.#db.prepare('DELETE FROM participant_signature_intents WHERE id=?').run(row.id);
      }
      if (this.#db.prepare('SELECT count(*) AS n FROM participant_signature_intents WHERE receipt_json IS NULL').get().n >= PARTICIPANT_SIGNATURE_PENDING_LIMIT) fail('signature_pending_limit');
      const intent = { domain: DOMAIN, purpose: 'TEST', scope: SCOPE, statement: PARTICIPANT_SIGNATURE_STATEMENT,
        action, nonce: randomUUID(), actorId, sessionHash, issuedAt, expiresAt, statusSource: SOURCE,
        binding, snapshot: current, request, operation: action === ANCHOR ? {
          cluster: 'devnet', programId: MEMO_PROGRAM, walletAddress: this.#memo.walletAddress,
          maxFeeLamports: this.#memo.maxFeeLamports, memo: `DalaHold TEST v1 ${current.snapshotHash} ${current.terminalEventId}`,
          snapshotHash: current.snapshotHash, eventId: current.terminalEventId,
        } : null };
      const bytes = encode(intent), bytesHash = sha(bytes);
      if (bytes.length > 9000) fail('signature_request_invalid');
      const row = { id: intent.nonce, actor_id: actorId, session_hash: sessionHash, bytes_hash: bytesHash, expires_at: expiresAt };
      this.#db.prepare(`INSERT INTO participant_signature_intents (id,actor_id,session_hash,bytes,bytes_hash,expires_at,intent_mac)
        VALUES (?,?,?,?,?,?,?)`).run(row.id, actorId, sessionHash, bytes, bytesHash, expiresAt, this.#intentMac(row));
      issued = { intent, bytes };
      return { id: intent.nonce, bytes: Buffer.from(bytes), hash: bytesHash, expiresAt };
    }, check);
  }
  createEnrollmentIntent(actorId, sessionHash, request = {}, options) {
    fields(request, []);
    return this.#issue(actorId, sessionHash, ENROLL, null, guard(options));
  }
  createActionIntent(actorId, dealId, sessionHash, request, options) {
    if (!uuid(dealId)) fail('signature_request_invalid');
    const copied = actionRequest(request);
    return this.#issue(actorId, sessionHash, copied.action, copied, guard(options), dealId);
  }
  createAnchorIntent(actorId, dealId, sessionHash, request, options) {
    if (!uuid(dealId)) fail('signature_request_invalid');
    return this.#issue(actorId, sessionHash, ANCHOR, actionRequest(request, ANCHOR), guard(options), dealId);
  }
  #fresh(row, initial, validUntil) {
    this.#pending(row);
    const decoded = this.#decode(row);
    if (!decoded.bytes.equals(initial.bytes) || row.bytes_hash !== initial.row.bytes_hash || row.expires_at !== initial.row.expires_at) fail('signature_intent_changed');
    const at = this.#time();
    if (at >= row.expires_at || at < decoded.intent.issuedAt) fail('signature_intent_expired');
    if (validUntil !== undefined && at >= validUntil) fail('signature_status_expired');
    this.#bindingUnchanged(row.actor_id, decoded.intent.binding);
    return decoded;
  }
  #identity(outcome) {
    const values = select(outcome, ['verified'], 'signature_identity_rejected');
    if (values.verified !== true) {
      const error = Object.getOwnPropertyDescriptor(outcome, 'error');
      fail(error && Object.hasOwn(error, 'value') && error.value === 'status_unavailable' ? 'status_unavailable' : 'signature_rejected');
    }
    const value = select(outcome, ['verified', 'certificateDigest', 'validUntil', 'statusSource', 'identity'], 'signature_identity_rejected');
    const identity = fields(value.identity, ['schema', 'personId', 'organizationId'], 'signature_identity_rejected');
    if (value.statusSource !== SOURCE || !hash(value.certificateDigest) || !integer(value.validUntil) ||
        identity.schema !== 'nca_test_subject_v1' || typeof identity.personId !== 'string' || !/^person:[a-f0-9]{64}$/.test(identity.personId)) fail('signature_identity_rejected');
    if (identity.organizationId !== null) fail('signature_organization_disabled');
    return { certificateDigest: value.certificateDigest, validUntil: value.validUntil, personId: identity.personId };
  }
  #enroll(actorId, identity) {
    const existing = this.#binding(actorId);
    if (existing) {
      if (existing.person_id !== identity.personId) fail('signature_identity_mismatch');
      if (existing.certificate_digest !== identity.certificateDigest) fail('signature_renewal_required');
      return existing.public;
    }
    const foreign = this.#db.prepare('SELECT actor_id FROM participant_signature_bindings WHERE person_id=?').get(identity.personId);
    if (foreign) { this.#binding(foreign.actor_id); fail('signature_person_already_bound'); }
    const reused = this.#db.prepare('SELECT actor_id FROM participant_signature_bindings WHERE certificate_digest=?').get(identity.certificateDigest);
    if (reused) { this.#binding(reused.actor_id); fail('signature_certificate_already_bound'); }
    const bindingId = randomUUID();
    const mac = this.#mac('binding', [actorId, bindingId, identity.personId, identity.certificateDigest, 0]);
    this.#db.prepare('INSERT INTO participant_signature_bindings VALUES (?,?,?,?,0,?)').run(actorId, bindingId, identity.personId, identity.certificateDigest, mac);
    this.#sealBindingSet();
    return this.#binding(actorId).public;
  }
  async submit(actorId, sessionHash, request, options) {
    const assertCurrent = guard(options); assertCurrent();
    const input = fields(request, ['intentId', 'cms']);
    if (!uuid(actorId) || !hash(sessionHash) || !uuid(input.intentId) || !Buffer.isBuffer(input.cms) ||
        types.isProxy(input.cms) || !input.cms.length || input.cms.length > 98_304) fail('signature_request_invalid');
    const cms = Buffer.from(input.cms), signatureHash = sha(cms);
    const initial = this.#transaction(assertCurrent, () => {
      this.#actor(actorId);
      const row = this.#row(actorId, sessionHash, input.intentId);
      if (!row) fail('signature_intent_not_found');
      if (row.receipt_json !== null) return { history: this.#history(row, signatureHash) };
      const decoded = this.#decode(row);
      this.#fresh(row, { row, ...decoded });
      this.#memoUnchanged(decoded.intent);
      if (decoded.intent.snapshot && !equal(this.#current(actorId, decoded.intent.snapshot.dealId), decoded.intent.snapshot)) fail('signature_snapshot_stale');
      return { row, ...decoded };
    });
    if (initial.history) {
      return this.#transaction(assertCurrent, () => initial.history, () => {
        this.#actor(actorId);
        const row = this.#row(actorId, sessionHash, input.intentId);
        if (!row || !equal(this.#history(row, signatureHash), initial.history)) fail('signature_receipt_changed');
      });
    }
    if (this.#slots.active >= 2) fail('verifier_busy');
    this.#slots.active++; this.#inflight++;
    const key = Buffer.from(this.#key);
    try {
      let outcome;
      try { outcome = await this.#sdk.verifyIdentity(Buffer.from(initial.bytes), Buffer.from(cms), key); }
      catch { fail('verifier_unavailable'); }
      assertCurrent();
      const identity = this.#identity(outcome);
      let finalized = null, committing = false;
      const check = () => {
        this.#actor(actorId);
        const row = this.#row(actorId, sessionHash, input.intentId);
        if (!row) fail('signature_intent_changed');
        if (!finalized) {
          this.#fresh(row, initial, identity.validUntil);
          if (!committing && initial.intent.snapshot && !equal(this.#current(actorId, initial.intent.snapshot.dealId), initial.intent.snapshot)) fail('signature_snapshot_stale');
          return;
        }
        if (!equal(this.#history(row, signatureHash).receipt, finalized.receipt)) fail('signature_receipt_changed');
        if (finalized.historical) return;
        const at = this.#time();
        if (at >= initial.intent.expiresAt) fail('signature_intent_expired');
        if (at >= identity.validUntil) fail('signature_status_expired');
        this.#bindingUnchanged(actorId, { bindingId: finalized.receipt.bindingId,
          certificateDigest: finalized.receipt.certificateDigest, authEpoch: 0, scope: SCOPE });
        if (initial.intent.snapshot) {
          let expected = initial.intent.snapshot;
          if (finalized.event) expected = { ...expected, state: ACTIONS[initial.intent.action].to,
            stateRevision: expected.stateRevision + 1, terminalEventId: initial.intent.action === 'accept' ? finalized.event.id : null };
          if (!equal(this.#current(actorId, initial.intent.snapshot.dealId), expected)) fail('signature_snapshot_stale');
        }
        this.#memoUnchanged(initial.intent);
      };
      return this.#transaction(assertCurrent, () => {
        this.#actor(actorId);
        const row = this.#row(actorId, sessionHash, input.intentId);
        if (!row) fail('signature_intent_changed');
        if (row.receipt_json !== null) { finalized = this.#history(row, signatureHash); return finalized; }
        this.#fresh(row, initial, identity.validUntil);
        this.#memoUnchanged(initial.intent);
        if (initial.intent.snapshot) {
          const current = this.#current(actorId, initial.intent.snapshot.dealId);
          if (!equal(current, initial.intent.snapshot)) fail('signature_snapshot_stale');
          this.#assertRequest(current, initial.intent.request);
          const binding = this.#binding(actorId);
          if (binding.person_id !== identity.personId || binding.certificate_digest !== identity.certificateDigest) fail('signature_identity_mismatch');
        }
        const usage = this.#db.prepare(`SELECT count(*) AS n,COALESCE(sum(length(cms)),0) AS bytes
          FROM participant_signature_intents WHERE receipt_json IS NOT NULL`).get();
        if (!integer(usage.n) || !integer(usage.bytes)) fail('signature_state_changed');
        if (usage.n >= PARTICIPANT_SIGNATURE_HISTORY_LIMIT || cms.length > PARTICIPANT_SIGNATURE_CMS_BYTE_LIMIT - usage.bytes) fail('signature_history_limit');
        const binding = initial.intent.action === ENROLL ? this.#enroll(actorId, identity) : initial.intent.binding;
        const receipt = { id: randomUUID(), intentId: row.id, intentHash: row.bytes_hash, actorId, action: initial.intent.action,
          dealId: initial.intent.snapshot?.dealId ?? null, eventId: initial.intent.operation?.eventId ?? null,
          snapshotHash: initial.intent.snapshot?.snapshotHash ?? null, bindingId: binding.bindingId, authEpoch: 0,
          certificateDigest: identity.certificateDigest, verifiedAt: this.#time(), validUntil: identity.validUntil, statusSource: SOURCE, scope: SCOPE };
        let event = null;
        if (Object.hasOwn(ACTIONS, initial.intent.action)) {
          committing = true;
          const result = sync(() => this.#commit(actorId, receipt.dealId, freeze({ ...initial.intent.request }),
            freeze(this.#authorization(receipt))), 'signature_state_changed');
          if (Object.getOwnPropertyDescriptor(result, 'historical')?.value === true) fail('signature_replay_conflict');
          const candidate = select(result, ['event'], 'signature_receipt_changed').event;
          receipt.eventId = select(candidate, ['id'], 'signature_receipt_changed').id;
          event = this.#event(candidate, receipt, initial.intent, 'signature_receipt_changed');
        }
        const accepted = { ...row, signature_hash: signatureHash, receipt_id: receipt.id,
          receipt_json: JSON.stringify(receipt), event_json: event ? JSON.stringify(event) : null };
        const result = this.#db.prepare(`UPDATE participant_signature_intents SET signature_hash=?,cms=?,receipt_id=?,
          receipt_json=?,event_json=?,receipt_mac=? WHERE id=? AND receipt_json IS NULL`)
          .run(signatureHash, cms, receipt.id, accepted.receipt_json, accepted.event_json, this.#receiptMac(accepted), row.id);
        if (result.changes !== 1) fail('signature_replay_conflict');
        finalized = event ? { receipt: freeze(receipt), historical: false, event: freeze(event) } : { receipt: freeze(receipt), historical: false };
        check(); return finalized;
      }, check);
    } finally { key.fill(0); this.#slots.active--; this.#inflight--; }
  }
  // Internal policy-issuer read only. This returns no wallet/payment grant and
  // must never be exposed as an HTTP capability or accepted client evidence.
  readMemoAuthorization(actorId, intentId) {
    if (!uuid(actorId) || !uuid(intentId)) fail('signature_request_invalid');
    return this.#transaction(() => {}, () => {
      this.#actor(actorId);
      const row = this.#db.prepare('SELECT * FROM participant_signature_intents WHERE id=? AND actor_id=?').get(intentId, actorId);
      if (!row || row.receipt_json === null) fail('signature_intent_not_found');
      const { receipt, intent } = this.#accepted(row);
      if (intent.action !== ANCHOR || !this.#memo) fail('signature_anchor_unavailable');
      this.#bindingUnchanged(actorId, intent.binding);
      const current = this.#current(actorId, receipt.dealId);
      if (!equal(current, intent.snapshot)) fail('signature_snapshot_stale');
      if (this.#time() >= receipt.validUntil || this.#time() >= intent.expiresAt) fail('signature_status_expired');
      const checked = operation(intent.operation, current);
      if (checked.walletAddress !== this.#memo.walletAddress || checked.maxFeeLamports !== this.#memo.maxFeeLamports) fail('signature_anchor_unavailable');
      return freeze({ operation: checked, receipt, binding: this.#binding(actorId).public, expiresAt: intent.expiresAt });
    });
  }
  async inspect() {
    this.#available();
    if (this.#slots.active >= 2) fail('verifier_busy');
    this.#slots.active++; this.#inflight++;
    try {
      let result;
      try { result = await this.#sdk.inspect(); } catch { fail('verifier_unavailable'); }
      this.#available();
      const inspected = select(result, ['ready', 'chain', 'validUntil', 'statusSource'], 'verifier_unavailable');
      const chain = array(inspected.chain, 2, 'verifier_unavailable', value => {
        if (typeof value !== 'string' || value.length > 8000 || !/^-----BEGIN CERTIFICATE-----\n[\s\S]+\n-----END CERTIFICATE-----\n?$/.test(value)) fail('verifier_unavailable');
        return value;
      });
      if (inspected.ready !== true || inspected.statusSource !== SOURCE || !integer(inspected.validUntil) ||
          inspected.validUntil <= this.#time() || chain.length !== 2) fail('verifier_unavailable');
      return freeze({ ready: true, chain, validUntil: inspected.validUntil, statusSource: SOURCE });
    } finally { this.#slots.active--; this.#inflight--; }
  }
  close() {
    if (this.#inflight) fail('verification_in_progress');
    if (!this.#closed) { this.#closed = true; this.#key.fill(0); }
  }
}
