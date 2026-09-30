// Internal TEST personal bindings only. No HTTP login, wallet, powers or grants.
import { createHash, createHmac, timingSafeEqual, randomBytes, randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync,
  writeFileSync, mkdirSync, chmodSync, existsSync, mkdtempSync, renameSync, rmSync, fsyncSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DOMAIN = 'dalahold:test-person-binding:v1';
const SOURCE = 'test_ocsp';
const PURPOSE = 'ТЕСТОВАЯ ЛИЧНАЯ ПРИВЯЗКА. Вход, корпоративные полномочия, кошелёк и платёж не разрешаются.';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const keyId = key => hash(Buffer.concat([Buffer.from(`${DOMAIN}:mapping-key\0`), key]));
const fail = code => { throw new Error(code); };
const receiptMac = (key, row, signatureHash, receiptJson) => createHmac('sha256', key)
  .update(`${DOMAIN}:historical-receipt\0`).update(JSON.stringify([
    row.id, row.session_hash, row.bytes_hash, row.expires_at, signatureHash, receiptJson
  ])).digest('hex');

function privateDirectory(directory, create = false) {
  if (typeof directory !== 'string' || !directory) fail('binding_directory_required');
  directory = resolve(directory);
  if (create && !existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() ||
      (stat.mode & 0o077)) fail('insecure_binding_directory');
  return directory;
}

function privateFile(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) fail('insecure_binding_file');
    if (stat.size !== 32) fail('mapping_key_invalid');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

function databaseIdentity(directory) {
  const fd = openSync(join(directory, 'personal.sqlite'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) fail('insecure_binding_file');
    return `${stat.dev}:${stat.ino}`;
  } finally { closeSync(fd); }
}

function syncPath(path, directory = false) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (directory ? !stat.isDirectory() : !stat.isFile()) fail('invalid_backup_path');
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

function decodeIntent(bytes, row, expectedKeyId, sessionHash) {
  let intent;
  try { intent = JSON.parse(bytes.toString('utf8')); } catch { fail('binding_intent_changed'); }
  if (!intent || Object.keys(intent).sort().join(',') !==
      'action,bindingId,domain,expectedEpoch,expiresAt,issuedAt,mappingKeyId,newCertificateDigest,nonce,previousCertificateDigest,purpose,sessionHash,statusSource' ||
      intent.domain !== DOMAIN || intent.purpose !== PURPOSE || intent.mappingKeyId !== expectedKeyId ||
      intent.statusSource !== SOURCE || intent.nonce !== row.id || intent.sessionHash !== sessionHash ||
      !Number.isSafeInteger(intent.issuedAt) || !Number.isSafeInteger(intent.expiresAt) ||
      intent.expiresAt !== intent.issuedAt + 300_000 || intent.expiresAt !== row.expires_at ||
      !Buffer.from(JSON.stringify(intent, null, 2) + '\n').equals(bytes)) fail('binding_intent_changed');
  if (intent.action === 'enroll_test_person') {
    if ([intent.bindingId, intent.expectedEpoch, intent.previousCertificateDigest, intent.newCertificateDigest]
      .some(value => value !== null)) fail('binding_intent_changed');
  } else if (intent.action !== 'replace_test_certificate' || !UUID.test(intent.bindingId || '') ||
      !Number.isSafeInteger(intent.expectedEpoch) || intent.expectedEpoch < 0 ||
      !HASH.test(intent.previousCertificateDigest || '') || !HASH.test(intent.newCertificateDigest || '') ||
      intent.previousCertificateDigest === intent.newCertificateDigest) fail('binding_intent_changed');
  return intent;
}

function mappingKey(directory) {
  let key;
  try { key = privateFile(join(directory, 'mapping.key')); }
  catch { fail('mapping_key_unavailable'); }
  if (key.length !== 32) { key.fill(0); fail('mapping_key_invalid'); }
  return key;
}

// Operator-only, explicit first provisioning. Never called from a request or
// constructor; incomplete initialization is preserved for operator recovery.
export function initializePersonalBindings(directory) {
  directory = privateDirectory(directory, true);
  const database = join(directory, 'personal.sqlite');
  if (existsSync(database) || existsSync(join(directory, 'mapping.key'))) fail('binding_state_exists');
  const key = randomBytes(32);
  let db;
  try {
    writeFileSync(join(directory, 'mapping.key'), key, { flag: 'wx', mode: 0o600 });
    writeFileSync(database, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
    db = new DatabaseSync(database);
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE binding_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        domain TEXT NOT NULL, key_id TEXT NOT NULL) STRICT;
      CREATE TABLE personal_bindings (binding_id TEXT PRIMARY KEY, person_id TEXT NOT NULL UNIQUE,
        certificate_digest TEXT NOT NULL UNIQUE, epoch INTEGER NOT NULL CHECK(epoch>=0)) STRICT;
      CREATE TABLE retired_certificates (certificate_digest TEXT PRIMARY KEY,
        binding_id TEXT NOT NULL REFERENCES personal_bindings(binding_id)) STRICT;
      CREATE TABLE binding_intents (id TEXT PRIMARY KEY, session_hash TEXT NOT NULL,
        bytes BLOB NOT NULL, bytes_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
        signature_hash TEXT, receipt_json TEXT, receipt_mac TEXT) STRICT;`);
    db.prepare('INSERT INTO binding_meta VALUES (1, ?, ?)').run(DOMAIN, keyId(key));
  } finally { key.fill(0); db?.close(); }
}

export class PersonalBindings {
  #directory; #db; #sdk; #now; #keyId; #databaseIdentity; #inflight = 0;

  constructor({ directory, sdk, now = Date.now }) {
    if (!sdk || sdk.statusSource !== SOURCE || typeof sdk.verifyIdentity !== 'function' ||
        typeof now !== 'function') fail('test_identity_verifier_required');
    this.#directory = privateDirectory(directory);
    const key = mappingKey(this.#directory);
    try {
      // Existing file only; do not let SQLite recreate a missing registry.
      this.#databaseIdentity = databaseIdentity(this.#directory);
      this.#db = new DatabaseSync(join(this.#directory, 'personal.sqlite'));
      this.#db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      const meta = this.#db.prepare('SELECT domain, key_id FROM binding_meta WHERE singleton=1').get();
      if (!meta || meta.domain !== DOMAIN || meta.key_id !== keyId(key)) fail('mapping_key_changed');
      this.#keyId = meta.key_id;
      this.#sdk = sdk; this.#now = now;
    } catch (error) { this.#db?.close(); throw error; }
    finally { key.fill(0); }
  }

  #key() {
    privateDirectory(this.#directory);
    const key = mappingKey(this.#directory);
    try {
      if (databaseIdentity(this.#directory) !== this.#databaseIdentity) fail('binding_database_changed');
      const meta = this.#db.prepare('SELECT domain, key_id FROM binding_meta WHERE singleton=1').get();
      if (keyId(key) !== this.#keyId || meta?.domain !== DOMAIN || meta.key_id !== this.#keyId) fail('mapping_key_changed');
      return key;
    } catch (error) { key.fill(0); throw error; }
  }

  close() { if (this.#inflight) fail('verification_in_progress'); this.#db.close(); }

  binding(bindingId) {
    if (!UUID.test(bindingId || '')) fail('invalid_binding_id');
    const key = this.#key(); key.fill(0);
    const row = this.#db.prepare('SELECT * FROM personal_bindings WHERE binding_id=?').get(bindingId);
    return row && { bindingId: row.binding_id, personId: row.person_id,
      certificateDigest: row.certificate_digest, epoch: row.epoch };
  }

  createIntent(sessionHash, request) {
    if (!HASH.test(sessionHash || '') || !request || typeof request !== 'object' || Array.isArray(request)) fail('invalid_binding_request');
    const enroll = request.action === 'enroll_test_person';
    if (enroll ? Object.keys(request).sort().join(',') !== 'action' :
        request.action !== 'replace_test_certificate' ||
        Object.keys(request).sort().join(',') !== 'action,bindingId,newCertificateDigest' ||
        !HASH.test(request.newCertificateDigest || '')) fail('invalid_binding_request');
    const key = this.#key(); key.fill(0);
    const binding = enroll ? null : this.binding(request.bindingId);
    if (!enroll && !binding) fail('binding_not_found');
    if (binding && binding.certificateDigest === request.newCertificateDigest) fail('same_certificate');
    const issuedAt = this.#now();
    const intent = { domain: DOMAIN,
      purpose: PURPOSE,
      action: request.action, nonce: randomUUID(), sessionHash, mappingKeyId: this.#keyId,
      issuedAt, expiresAt: issuedAt + 300_000, statusSource: SOURCE,
      bindingId: binding?.bindingId || null, expectedEpoch: binding?.epoch ?? null,
      previousCertificateDigest: binding?.certificateDigest || null,
      newCertificateDigest: enroll ? null : request.newCertificateDigest };
    const bytes = Buffer.from(JSON.stringify(intent, null, 2) + '\n');
    this.#db.prepare('INSERT INTO binding_intents (id, session_hash, bytes, bytes_hash, expires_at) VALUES (?,?,?,?,?)')
      .run(intent.nonce, sessionHash, bytes, hash(bytes), intent.expiresAt);
    return { id: intent.nonce, bytes, hash: hash(bytes), expiresAt: intent.expiresAt };
  }

  #row(sessionHash, id) {
    return this.#db.prepare('SELECT * FROM binding_intents WHERE id=? AND session_hash=?').get(id, sessionHash);
  }

  #history(row, signatureHash, key) {
    if (row.signature_hash !== signatureHash) fail('binding_replay_conflict');
    if (!HASH.test(row.receipt_mac || '') || !timingSafeEqual(Buffer.from(row.receipt_mac, 'hex'),
      Buffer.from(receiptMac(key, row, signatureHash, row.receipt_json), 'hex'))) fail('binding_receipt_changed');
    const bytes = Buffer.from(row.bytes);
    if (hash(bytes) !== row.bytes_hash) fail('binding_receipt_changed');
    const intent = decodeIntent(bytes, row, this.#keyId, row.session_hash);
    let receipt;
    try { receipt = JSON.parse(row.receipt_json); } catch { fail('binding_receipt_changed'); }
    if (!receipt || receipt.intentHash !== row.bytes_hash || receipt.action !== intent.action ||
      receipt.mappingKeyId !== this.#keyId || receipt.statusSource !== SOURCE ||
      receipt.scope !== 'test_personal_binding_only' || !UUID.test(receipt.id || '') ||
      !UUID.test(receipt.bindingId || '') || !Number.isSafeInteger(receipt.epoch) || receipt.epoch < 0 ||
      !HASH.test(receipt.certificateDigest || '') || !Number.isSafeInteger(receipt.verifiedAt) ||
      !Number.isSafeInteger(receipt.validUntil) || receipt.validUntil <= receipt.verifiedAt) fail('binding_receipt_changed');
    return { receipt, historical: true };
  }

  async submit(sessionHash, request) {
    if (!HASH.test(sessionHash || '') || !request || Object.keys(request).sort().join(',') !== 'cms,intentId' ||
        !UUID.test(request.intentId || '') || !Buffer.isBuffer(request.cms) ||
        !request.cms.length || request.cms.length > 98_304) fail('invalid_binding_submission');
    const cms = Buffer.from(request.cms); // snapshot before any verifier await
    const signatureHash = hash(cms);
    const key = this.#key();
    try {
      const row = this.#row(sessionHash, request.intentId);
      if (!row) fail('binding_intent_not_found');
      if (row.receipt_json) return this.#history(row, signatureHash, key);
      const bytes = Buffer.from(row.bytes);
      if (row.expires_at <= this.#now()) fail('binding_intent_expired');
      if (hash(bytes) !== row.bytes_hash) fail('binding_intent_changed');
      const intent = decodeIntent(bytes, row, this.#keyId, sessionHash);
      if (intent.issuedAt > this.#now()) fail('binding_intent_expired');
      if (this.#inflight >= 2) fail('verifier_busy');
      this.#inflight++;
      let outcome;
      try { outcome = await this.#sdk.verifyIdentity(Buffer.from(bytes), Buffer.from(cms), key); }
      finally { this.#inflight--; }
      // Snapshot server-verifier evidence once, before the synchronous transaction.
      const identity = outcome?.identity;
      const verified = outcome?.verified, source = outcome?.statusSource, validUntil = outcome?.validUntil;
      const certificateDigest = outcome?.certificateDigest, schema = identity?.schema;
      const personId = identity?.personId, organizationId = identity?.organizationId;
      if (verified !== true || source !== SOURCE || !Number.isSafeInteger(validUntil) || validUntil <= this.#now() ||
          !HASH.test(certificateDigest || '') || schema !== 'nca_test_subject_v1' ||
          !/^person:[a-f0-9]{64}$/.test(personId || '')) fail('binding_identity_rejected');
      if (organizationId !== null) fail('organization_binding_disabled');
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        const freshKey = this.#key(); freshKey.fill(0);
        const current = this.#row(sessionHash, row.id);
        if (!current) fail('binding_intent_changed');
        let result;
        if (current.receipt_json) result = this.#history(current, signatureHash, key);
        else {
          if (current.bytes_hash !== row.bytes_hash || !Buffer.from(current.bytes).equals(bytes) ||
              current.expires_at !== row.expires_at) fail('binding_intent_changed');
          if (current.expires_at <= this.#now()) fail('binding_intent_expired');
          if (validUntil <= this.#now()) fail('binding_status_expired');
          if (this.#db.prepare('SELECT 1 FROM retired_certificates WHERE certificate_digest=?').get(certificateDigest)) fail('retired_certificate');
          let binding;
          if (intent.action === 'enroll_test_person') {
            const existing = this.#db.prepare('SELECT binding_id FROM personal_bindings WHERE person_id=?').get(personId);
            if (existing) {
              binding = this.binding(existing.binding_id);
              if (binding.certificateDigest !== certificateDigest) fail('certificate_rebind_required');
            } else {
              const id = randomUUID();
              this.#db.prepare('INSERT INTO personal_bindings VALUES (?,?,?,0)').run(id, personId, certificateDigest);
              binding = this.binding(id);
            }
          } else {
            binding = this.binding(intent.bindingId);
            if (!binding || binding.personId !== personId || binding.epoch !== intent.expectedEpoch ||
                binding.certificateDigest !== intent.previousCertificateDigest) fail('stale_or_foreign_binding');
            if (certificateDigest !== intent.newCertificateDigest ||
                certificateDigest === binding.certificateDigest || binding.epoch >= Number.MAX_SAFE_INTEGER) fail('replacement_certificate_mismatch');
            this.#db.prepare('INSERT INTO retired_certificates VALUES (?,?)').run(binding.certificateDigest, binding.bindingId);
            this.#db.prepare('UPDATE personal_bindings SET certificate_digest=?,epoch=epoch+1 WHERE binding_id=?')
              .run(certificateDigest, binding.bindingId);
            binding = this.binding(binding.bindingId);
          }
          const receipt = { id: randomUUID(), intentHash: row.bytes_hash, action: intent.action,
            bindingId: binding.bindingId, epoch: binding.epoch, certificateDigest: binding.certificateDigest,
            verifiedAt: this.#now(), validUntil, mappingKeyId: this.#keyId,
            statusSource: SOURCE, scope: 'test_personal_binding_only' };
          const receiptJson = JSON.stringify(receipt);
          this.#db.prepare('UPDATE binding_intents SET signature_hash=?,receipt_json=?,receipt_mac=? WHERE id=?')
            .run(signatureHash, receiptJson, receiptMac(key, current, signatureHash, receiptJson), row.id);
          result = { receipt, historical: false };
        }
        if (!result.historical) {
          const atCommit = this.#now();
          if (current.expires_at <= atCommit) fail('binding_intent_expired');
          if (result.receipt.validUntil <= atCommit) fail('binding_status_expired');
        }
        this.#db.exec('COMMIT'); return result;
      } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
    } finally { key.fill(0); }
  }

  async backupTo(directory) {
    if (typeof directory !== 'string' || !directory) fail('binding_directory_required');
    directory = resolve(directory);
    if (existsSync(directory)) fail('binding_state_exists');
    const parent = lstatSync(dirname(directory));
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() ||
        (parent.mode & 0o022)) fail('insecure_backup_parent');
    const key = this.#key();
    this.#inflight++;
    let staging;
    try {
      staging = mkdtempSync(join(dirname(directory), `.${basename(directory)}-staging-`));
      privateDirectory(staging);
      const keyPath = join(staging, 'mapping.key');
      writeFileSync(keyPath, key, { flag: 'wx', mode: 0o600 });
      const target = join(staging, 'personal.sqlite');
      writeFileSync(target, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
      await backup(this.#db, target);
      chmodSync(target, 0o600);
      const current = this.#key(); current.fill(0);
      const check = new DatabaseSync(target, { readOnly: true });
      try {
        const meta = check.prepare('SELECT domain,key_id FROM binding_meta WHERE singleton=1').get();
        if (meta?.domain !== DOMAIN || meta.key_id !== this.#keyId ||
            check.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('binding_backup_invalid');
      } finally { check.close(); }
      syncPath(keyPath); syncPath(target); syncPath(staging, true);
      if (existsSync(directory)) fail('binding_state_exists');
      // Private complete pair published in one rename, under a trusted parent.
      // A competing nonempty backup cannot be overwritten by directory rename.
      renameSync(staging, directory); staging = null;
      let durability = 'synced';
      try { syncPath(dirname(directory), true); }
      catch { durability = 'parent_sync_unconfirmed'; }
      // A completed target must not look like an unpublished failure and invite
      // overwrite/retry. Callers must inspect durability before relying on it.
      return { published: true, durability };
    } finally {
      try { if (staging) rmSync(staging, { recursive: true, force: true }); }
      finally { this.#inflight--; key.fill(0); }
    }
  }
}
