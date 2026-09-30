// Policy/storage test doubles only. Genuine cryptography lives in identity.test.mjs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, chmodSync, readdirSync,
  unlinkSync, renameSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { initializePersonalBindings, PersonalBindings } from './personal-bindings.mjs';

const SESSION = '9'.repeat(64), OTHER_SESSION = '8'.repeat(64);
const C1 = '1'.repeat(64), C2 = '2'.repeat(64), C3 = '3'.repeat(64);
const PERSON = 'person:' + 'a'.repeat(64), FOREIGN = 'person:' + 'b'.repeat(64);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sign = (bytes, certificateDigest = C1, personId = PERSON, organizationId = null) =>
  Buffer.from(JSON.stringify({ bytes: bytes.toString('base64'), certificateDigest, personId, organizationId }));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dalahold-binding-policy-'));
  const directory = join(root, 'registry');
  initializePersonalBindings(directory);
  let time = 1_000_000, calls = 0;
  const sdk = { statusSource: 'test_ocsp', async verifyIdentity(bytes, cms) {
    calls++;
    const payload = JSON.parse(cms.toString());
    if (payload.bytes !== bytes.toString('base64')) return { verified: false };
    return { verified: true, statusSource: 'test_ocsp', validUntil: time + 60_000,
      certificateDigest: payload.certificateDigest,
      identity: { schema: 'nca_test_subject_v1', personId: payload.personId, organizationId: payload.organizationId } };
  } };
  const stores = new Set();
  const open = (path = directory, verifier = sdk, now = () => time) => {
    const store = new PersonalBindings({ directory: path, sdk: verifier, now });
    const close = store.close.bind(store);
    store.close = () => { close(); stores.delete(store); };
    stores.add(store); return store;
  };
  const store = open();
  const sql = callback => {
    const db = new DatabaseSync(join(directory, 'personal.sqlite'));
    try { return callback(db); } finally { db.close(); }
  };
  const counts = () => sql(db => Object.fromEntries(['personal_bindings', 'retired_certificates']
    .map(table => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n])
    .concat([['receipts', db.prepare('SELECT count(*) AS n FROM binding_intents WHERE receipt_json IS NOT NULL').get().n]])));
  t.after(() => { for (const current of stores) current.close(); rmSync(root, { recursive: true }); });
  return { root, directory, store, sdk, open, sql, counts, get calls() { return calls; },
    get time() { return time; }, set time(value) { time = value; } };
}
const enroll = store => store.createIntent(SESSION, { action: 'enroll_test_person' });
const replace = (store, bindingId, newCertificateDigest = C2) => store.createIntent(SESSION,
  { action: 'replace_test_certificate', bindingId, newCertificateDigest });
const submit = (store, intent, cms = sign(intent.bytes), session = SESSION) =>
  store.submit(session, { intentId: intent.id, cms });
async function registered(f) {
  const intent = enroll(f.store);
  return (await submit(f.store, intent)).receipt.bindingId;
}
function unchanged(f, receipts = 0, bindings = 0, retired = 0) {
  assert.deepEqual(f.counts(), { personal_bindings: bindings, retired_certificates: retired, receipts });
}

test('explicit private provisioning refuses overwrite and never auto-creates a key or database', t => {
  const f = fixture(t);
  for (const [path, mode] of [[f.directory, 0o700], [join(f.directory, 'mapping.key'), 0o600],
    [join(f.directory, 'personal.sqlite'), 0o600]]) assert.equal(statSync(path).mode & 0o777, mode);
  assert.equal(readFileSync(join(f.directory, 'mapping.key')).length, 32);
  assert.throws(() => initializePersonalBindings(f.directory), /binding_state_exists/);
  assert.throws(() => f.open(join(f.root, 'not-provisioned')), /ENOENT/);
  assert.equal(existsSync(join(f.root, 'not-provisioned')), false);
  assert.throws(() => f.open(f.directory, { ...f.sdk, statusSource: 'test_crl_fixture' }), /test_identity_verifier_required/);
  unchanged(f);
});

test('dedicated enrollment binds exact bytes/session/key/source, not a signature-probe receipt', async t => {
  const f = fixture(t), intent = enroll(f.store);
  const parsed = JSON.parse(intent.bytes);
  assert.equal(parsed.action, 'enroll_test_person');
  assert.equal(parsed.sessionHash, SESSION);
  assert.equal(parsed.statusSource, 'test_ocsp');
  assert.equal(parsed.bindingId, null);
  assert.equal(parsed.expectedEpoch, null);
  assert.equal(intent.hash, sha(intent.bytes));
  assert.match(parsed.purpose, /Вход.*не разрешаются/);
  await assert.rejects(submit(f.store, intent, sign(Buffer.from('test_signature_only receipt'))), /binding_identity_rejected/);
  await assert.rejects(submit(f.store, intent, sign(intent.bytes), OTHER_SESSION), /binding_intent_not_found/);
  unchanged(f);
  const result = await submit(f.store, intent);
  assert.equal(result.historical, false);
  assert.equal(result.receipt.scope, 'test_personal_binding_only');
  assert.equal(result.receipt.intentHash, intent.hash);
  assert.equal(result.receipt.epoch, 0);
  assert.ok(!Object.hasOwn(result.receipt, 'personId') && !Object.hasOwn(result.receipt, 'walletAddress'));
  assert.equal(f.store.binding(result.receipt.bindingId).personId, PERSON);
  unchanged(f, 1, 1);
});

test('identical parallel submissions consume once; retry/restart returns historical receipt without new verification', async t => {
  const f = fixture(t), second = f.open(), intent = enroll(f.store), cms = sign(intent.bytes);
  const [one, two] = await Promise.all([submit(f.store, intent, cms), submit(second, intent, cms)]);
  assert.deepEqual(one.receipt, two.receipt);
  assert.deepEqual([one.historical, two.historical].sort(), [false, true]);
  unchanged(f, 1, 1);
  f.time += 400_000;
  f.store.close(); second.close();
  const reopened = f.open(f.directory, { statusSource: 'test_ocsp', verifyIdentity() { throw new Error('must not reverify'); } });
  assert.deepEqual(await submit(reopened, intent, cms), { receipt: one.receipt, historical: true });
  await assert.rejects(submit(reopened, intent, Buffer.concat([cms, Buffer.from('different')])), /binding_replay_conflict/);
  const fresh = enroll(reopened);
  await assert.rejects(submit(reopened, fresh), /must not reverify/);
  unchanged(f, 1, 1);
});

test('fresh enrollment retains binding for current certificate; a new certificate requires explicit replacement', async t => {
  const f = fixture(t), id = await registered(f), next = enroll(f.store);
  assert.equal((await submit(f.store, next)).receipt.bindingId, id);
  const unauthorized = enroll(f.store);
  await assert.rejects(submit(f.store, unauthorized, sign(unauthorized.bytes, C2)), /certificate_rebind_required/);
  assert.equal(f.store.binding(id).epoch, 0);
  unchanged(f, 2, 1);
});

test('replacement retains binding, increments epoch, retires old credential and survives protected backup/restart', async t => {
  const f = fixture(t), id = await registered(f), old = f.store.binding(id), intent = replace(f.store, id);
  const result = await submit(f.store, intent, sign(intent.bytes, C2));
  const current = f.store.binding(id);
  assert.deepEqual(current, { ...old, certificateDigest: C2, epoch: 1 });
  assert.equal(result.receipt.epoch, 1);
  assert.equal(result.receipt.bindingId, id);
  const retry = await submit(f.store, intent, sign(intent.bytes, C2));
  assert.deepEqual(retry, { ...result, historical: true });
  for (const attempt of [enroll(f.store), replace(f.store, id, C1)]) {
    await assert.rejects(submit(f.store, attempt, sign(attempt.bytes, C1)), /retired_certificate/);
  }
  unchanged(f, 2, 1, 1);
  const target = join(f.root, 'backup');
  assert.deepEqual(await f.store.backupTo(target), { published: true, durability: 'synced' });
  assert.equal(statSync(target).mode & 0o777, 0o700);
  for (const file of ['mapping.key', 'personal.sqlite']) assert.equal(statSync(join(target, file)).mode & 0o777, 0o600);
  assert.ok(readFileSync(join(target, 'mapping.key')).equals(readFileSync(join(f.directory, 'mapping.key'))));
  const restored = f.open(target);
  assert.deepEqual(restored.binding(id), current);
  assert.deepEqual(await submit(restored, intent, sign(intent.bytes, C2)), retry);
  const retired = enroll(restored);
  await assert.rejects(submit(restored, retired, sign(retired.bytes, C1)), /retired_certificate/);
  await assert.rejects(f.store.backupTo(target), /binding_state_exists/);
  assert.deepEqual(restored.binding(id), current);
});

test('parallel replacement intents are epoch-bound: exactly one wins, stale request remains unconsumed', async t => {
  const f = fixture(t), id = await registered(f), second = f.open();
  const intents = [replace(f.store, id, C2), replace(second, id, C3)];
  const results = await Promise.allSettled(intents.map((intent, index) => submit(index ? second : f.store,
    intent, sign(intent.bytes, index ? C3 : C2))));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /stale_or_foreign_binding/);
  assert.equal(f.store.binding(id).epoch, 1);
  unchanged(f, 2, 1, 1);
});

test('corporate, foreign, missing organization classification and wrong replacement certificate refuse', async t => {
  const f = fixture(t), id = await registered(f), initial = f.store.binding(id);
  const intent = replace(f.store, id);
  for (const [person, organization, cert, error] of [
    [PERSON, 'organization:' + 'c'.repeat(64), C2, /organization_binding_disabled/],
    [FOREIGN, null, C2, /stale_or_foreign_binding/],
    [PERSON, undefined, C2, /organization_binding_disabled/],
    [PERSON, null, C3, /replacement_certificate_mismatch/],
    [PERSON, null, C1, /replacement_certificate_mismatch/]
  ]) {
    const cms = Buffer.from(JSON.stringify({ bytes: intent.bytes.toString('base64'),
      certificateDigest: cert, personId: person, organizationId: organization }));
    await assert.rejects(submit(f.store, intent, cms), error);
    assert.deepEqual(f.store.binding(id), initial);
    unchanged(f, 1, 1);
  }
  const corporateEnrollment = enroll(f.store);
  await assert.rejects(submit(f.store, corporateEnrollment,
    sign(corporateEnrollment.bytes, C2, PERSON, 'organization:' + 'c'.repeat(64))), /organization_binding_disabled/);
  unchanged(f, 1, 1);
});

test('caller cannot inject owner/epoch/source/wallet fields or mutate stored intent through returned bytes', async t => {
  const f = fixture(t);
  for (const request of [{ action: 'enroll_test_person', ownerId: 'fake' }, { action: 'login' },
    { action: 'replace_test_certificate', bindingId: 'fake', newCertificateDigest: C2 },
    { action: 'enroll_test_person', statusSource: 'test_crl_fixture' }]) {
    assert.throws(() => f.store.createIntent(SESSION, request), /invalid_binding_request|invalid_binding_id/);
  }
  const intent = enroll(f.store), original = Buffer.from(intent.bytes);
  intent.bytes.fill(0);
  await assert.rejects(submit(f.store, intent), /binding_identity_rejected/);
  await assert.rejects(f.store.submit(SESSION, { intentId: intent.id, cms: sign(original), walletAddress: 'fake' }), /invalid_binding_submission/);
  assert.equal((await submit(f.store, intent, sign(original))).receipt.intentHash, sha(original));
});

test('expired intent, untrusted/missing status and verifier exception leave no binding/receipt', async t => {
  const f = fixture(t), expired = enroll(f.store);
  f.time = expired.expiresAt;
  await assert.rejects(submit(f.store, expired), /binding_intent_expired/);
  assert.equal(f.calls, 0);
  const intent = enroll(f.store), base = await f.sdk.verifyIdentity(intent.bytes, sign(intent.bytes));
  for (const outcome of [{ verified: false, error: 'revoked' }, { ...base, statusSource: 'test_crl_fixture' },
    { ...base, validUntil: f.time }, { ...base, certificateDigest: 'not-a-digest' },
    { ...base, identity: { ...base.identity, schema: 'production' } }, { ...base, identity: undefined }]) {
    const store = f.open(f.directory, { statusSource: 'test_ocsp', async verifyIdentity() { return outcome; } });
    await assert.rejects(submit(store, intent), /binding_identity_rejected/);
    unchanged(f); store.close();
  }
  const unavailable = f.open(f.directory, { statusSource: 'test_ocsp', async verifyIdentity() { throw new Error('test timeout'); } });
  await assert.rejects(submit(unavailable, intent), /test timeout/);
  unchanged(f);
  await submit(f.store, intent); unchanged(f, 1, 1);
});

test('expiry and stored-intent mutation during verification are rechecked at commit', async t => {
  const f = fixture(t);
  for (const kind of ['intent', 'bytes', 'status', 'expiry']) {
    const entered = deferred(), resume = deferred(), intent = enroll(f.store);
    const store = f.open(f.directory, { statusSource: 'test_ocsp', async verifyIdentity(bytes, cms) {
      const outcome = await f.sdk.verifyIdentity(bytes, cms); entered.resolve(); await resume.promise; return outcome;
    } });
    const pending = submit(store, intent);
    await entered.promise;
    if (kind === 'intent') f.time = intent.expiresAt;
    if (kind === 'status') f.time += 60_000;
    if (kind === 'bytes') f.sql(db => db.prepare('UPDATE binding_intents SET bytes=? WHERE id=?').run(Buffer.from('changed'), intent.id));
    if (kind === 'expiry') f.sql(db => db.prepare('UPDATE binding_intents SET expires_at=expires_at+10000 WHERE id=?').run(intent.id));
    resume.resolve();
    await assert.rejects(pending, /binding_intent_expired|binding_identity_rejected|binding_intent_changed/);
    unchanged(f); store.close();
  }
});

test('canonical intent rejects altered nonce/key/source/purpose/shape even with a rewritten content hash', async t => {
  const f = fixture(t);
  for (const mutation of [p => { p.nonce = '00000000-0000-0000-0000-000000000000'; },
    p => { p.mappingKeyId = C1; }, p => { p.statusSource = 'test_crl_fixture'; },
    p => { p.purpose = 'Login'; }, p => { p.expectedEpoch = 0; }, p => { p.issuedAt++; },
    p => { p.extra = true; }]) {
    const intent = enroll(f.store), payload = JSON.parse(intent.bytes); mutation(payload);
    const bytes = Buffer.from(JSON.stringify(payload, null, 2) + '\n');
    f.sql(db => db.prepare('UPDATE binding_intents SET bytes=?,bytes_hash=? WHERE id=?').run(bytes, sha(bytes), intent.id));
    await assert.rejects(submit(f.store, intent, sign(bytes)), /binding_intent_changed/);
  }
  unchanged(f); assert.equal(f.calls, 0);
});

test('missing/replaced/insecure/symlinked mapping key fails closed, without remapping or automatic recovery', async t => {
  const f = fixture(t), id = await registered(f), intent = replace(f.store, id), initial = f.store.binding(id);
  const path = join(f.directory, 'mapping.key'), original = readFileSync(path), saved = join(f.root, 'saved.key');
  renameSync(path, saved);
  await assert.rejects(submit(f.store, intent, sign(intent.bytes, C2)), /mapping_key_unavailable/);
  assert.equal(existsSync(path), false);
  assert.throws(() => initializePersonalBindings(f.directory), /binding_state_exists/);
  renameSync(saved, path);
  writeFileSync(path, Buffer.alloc(32, 42));
  await assert.rejects(submit(f.store, intent, sign(intent.bytes, C2)), /mapping_key_changed/);
  assert.throws(() => f.open(), /mapping_key_changed/);
  writeFileSync(path, original); chmodSync(path, 0o644);
  await assert.rejects(submit(f.store, intent, sign(intent.bytes, C2)), /mapping_key_unavailable/);
  chmodSync(path, 0o600); renameSync(path, saved); symlinkSync(saved, path);
  await assert.rejects(submit(f.store, intent, sign(intent.bytes, C2)), /mapping_key_unavailable/);
  unlinkSync(path); renameSync(saved, path);
  assert.deepEqual(f.store.binding(id), initial); unchanged(f, 1, 1);
  await submit(f.store, intent, sign(intent.bytes, C2)); unchanged(f, 2, 1, 1);
});

test('mapping metadata/file changes while verifier awaits cannot commit', async t => {
  const f = fixture(t), path = join(f.directory, 'mapping.key'), original = readFileSync(path);
  for (const kind of ['file', 'meta']) {
    const entered = deferred(), resume = deferred(), intent = enroll(f.store);
    const store = f.open(f.directory, { statusSource: 'test_ocsp', async verifyIdentity(bytes, cms) {
      const outcome = await f.sdk.verifyIdentity(bytes, cms); entered.resolve(); await resume.promise; return outcome;
    } });
    const meta = f.sql(db => db.prepare('SELECT key_id FROM binding_meta').get().key_id);
    const pending = submit(store, intent); await entered.promise;
    if (kind === 'file') writeFileSync(path, Buffer.alloc(32, 7));
    else f.sql(db => db.prepare('UPDATE binding_meta SET key_id=?').run(C1));
    resume.resolve(); await assert.rejects(pending, /mapping_key_changed/);
    writeFileSync(path, original);
    f.sql(db => db.prepare('UPDATE binding_meta SET key_id=?').run(meta));
    unchanged(f); store.close();
  }
});

test('private directory/database gates refuse permission loss and replaced database inode', async t => {
  const f = fixture(t), intent = enroll(f.store), path = join(f.directory, 'personal.sqlite');
  chmodSync(f.directory, 0o755);
  await assert.rejects(submit(f.store, intent), /insecure_binding_directory/);
  chmodSync(f.directory, 0o700); chmodSync(path, 0o644);
  await assert.rejects(submit(f.store, intent), /insecure_binding_file/);
  chmodSync(path, 0o600);
  const moved = join(f.root, 'previous.sqlite'); renameSync(path, moved);
  writeFileSync(path, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
  await assert.rejects(submit(f.store, intent), /binding_database_changed/);
  unlinkSync(path); renameSync(moved, path);
  unchanged(f);
});

test('receipt-write failure rolls back enrollment, replacement and retirement; same intent safely retries', async t => {
  const f = fixture(t);
  const block = () => f.sql(db => db.exec(`CREATE TRIGGER block_receipt BEFORE UPDATE OF receipt_json ON binding_intents
    BEGIN SELECT RAISE(ABORT,'test receipt write failure'); END;`));
  const unblock = () => f.sql(db => db.exec('DROP TRIGGER block_receipt;'));
  const enrollment = enroll(f.store); block();
  await assert.rejects(submit(f.store, enrollment), /test receipt write failure/);
  unchanged(f); unblock();
  const id = (await submit(f.store, enrollment)).receipt.bindingId, initial = f.store.binding(id);
  const replacement = replace(f.store, id); block();
  await assert.rejects(submit(f.store, replacement, sign(replacement.bytes, C2)), /test receipt write failure/);
  assert.deepEqual(f.store.binding(id), initial); unchanged(f, 1, 1);
  unblock(); await submit(f.store, replacement, sign(replacement.bytes, C2)); unchanged(f, 2, 1, 1);
});

test('submission snapshots CMS and caps verification concurrency; shutdown refuses in-flight verification', async t => {
  const f = fixture(t), resume = deferred(), intent = enroll(f.store), cms = sign(intent.bytes);
  const store = f.open(f.directory, { statusSource: 'test_ocsp', async verifyIdentity(bytes, received) {
    await resume.promise; return f.sdk.verifyIdentity(bytes, received);
  } });
  const pending = [submit(store, intent, cms), submit(store, intent, cms)];
  cms.fill(0);
  await assert.rejects(submit(store, intent), /verifier_busy/);
  assert.throws(() => store.close(), /verification_in_progress/);
  resume.resolve();
  const results = await Promise.all(pending);
  assert.deepEqual(results[0].receipt, results[1].receipt);
  unchanged(f, 1, 1);
});

test('verifier evidence scalars are read once and never become public login/wallet grants', async t => {
  const f = fixture(t), intent = enroll(f.store);
  const base = await f.sdk.verifyIdentity(intent.bytes, sign(intent.bytes));
  let certReads = 0, personReads = 0;
  Object.defineProperty(base, 'certificateDigest', { get() { certReads++; return certReads === 1 ? C1 : C2; } });
  Object.defineProperty(base.identity, 'personId', { get() { personReads++; return personReads === 1 ? PERSON : FOREIGN; } });
  const store = f.open(f.directory, { statusSource: 'test_ocsp', async verifyIdentity() { return base; } });
  const result = await submit(store, intent);
  assert.equal(certReads, 1); assert.equal(personReads, 1);
  assert.equal(store.binding(result.receipt.bindingId).personId, PERSON);
  assert.equal(result.receipt.certificateDigest, C1);
  unchanged(f, 1, 1);
});

test('status expiry at the transactional recheck rolls back before any binding or receipt write', async t => {
  const f = fixture(t), intent = enroll(f.store);
  const outcome = await f.sdk.verifyIdentity(intent.bytes, sign(intent.bytes));
  let calls = 0;
  const store = f.open(f.directory, { statusSource: 'test_ocsp', async verifyIdentity() { return outcome; } },
    () => ++calls >= 5 ? outcome.validUntil : f.time);
  await assert.rejects(submit(store, intent), /binding_status_expired/);
  unchanged(f);
});

test('pre-replacement backup is an older snapshot, not proof of global retirement after restoring it', async t => {
  const f = fixture(t), id = await registered(f), snapshot = join(f.root, 'older-backup');
  await f.store.backupTo(snapshot);
  const replacement = replace(f.store, id);
  await submit(f.store, replacement, sign(replacement.bytes, C2));
  const restored = f.open(snapshot);
  assert.equal(f.store.binding(id).epoch, 1);
  assert.equal(restored.binding(id).epoch, 0);
  assert.equal(restored.binding(id).certificateDigest, C1);
  // Public authorization must stay disabled until external anti-rollback/recovery
  // policy exists; a copied old TEST database cannot prove live revocations.
  assert.equal((await submit(restored, enroll(restored))).receipt.epoch, 0);
  unchanged(f, 2, 1, 1);
});

test('historical receipt authenticates stored intent and receipt; tampered rows cannot return a forged history', async t => {
  const f = fixture(t), intent = enroll(f.store), cms = sign(intent.bytes), accepted = await submit(f.store, intent, cms);
  const original = f.sql(db => db.prepare('SELECT * FROM binding_intents WHERE id=?').get(intent.id));
  const reset = () => f.sql(db => db.prepare(`UPDATE binding_intents SET bytes=?,bytes_hash=?,receipt_json=?,receipt_mac=? WHERE id=?`)
    .run(original.bytes, original.bytes_hash, original.receipt_json, original.receipt_mac, intent.id));
  for (const mutation of [
    db => db.prepare('UPDATE binding_intents SET receipt_json=? WHERE id=?')
      .run(JSON.stringify({ ...accepted.receipt, scope: 'login_grant' }), intent.id),
    db => db.prepare('UPDATE binding_intents SET bytes=? WHERE id=?').run(Buffer.from('changed'), intent.id),
    db => db.prepare('UPDATE binding_intents SET bytes=?,bytes_hash=? WHERE id=?').run(Buffer.from('changed'), sha('changed'), intent.id),
    db => db.prepare('UPDATE binding_intents SET receipt_mac=? WHERE id=?').run(C1, intent.id),
    db => db.prepare('UPDATE binding_intents SET receipt_mac=NULL WHERE id=?').run(intent.id)
  ]) {
    f.sql(mutation);
    await assert.rejects(submit(f.store, intent, cms), /binding_receipt_changed/);
    reset();
  }
  assert.equal(f.calls, 1, 'historical refusal must not call verifier');
  const replacement = replace(f.store, accepted.receipt.bindingId);
  await submit(f.store, replacement, sign(replacement.bytes, C2));
  assert.deepEqual(await submit(f.store, intent, cms), { ...accepted, historical: true });
  assert.equal(f.store.binding(accepted.receipt.bindingId).epoch, 1);
  unchanged(f, 2, 1, 1);
});

test('failed backup publishes no target, removes owned staging, and permits a clean retry', async t => {
  const f = fixture(t), id = await registered(f), target = join(f.root, 'failed-backup');
  const expectedKeyId = f.sql(db => db.prepare('SELECT key_id FROM binding_meta').get().key_id);
  const pending = f.store.backupTo(target);
  assert.equal(existsSync(target), false, 'incomplete backup must remain unpublished');
  assert.throws(() => f.store.close(), /verification_in_progress/);
  f.sql(db => db.prepare('UPDATE binding_meta SET key_id=?').run(C1));
  await assert.rejects(pending, /mapping_key_changed/);
  f.sql(db => db.prepare('UPDATE binding_meta SET key_id=?').run(expectedKeyId));
  assert.equal(existsSync(target), false);
  assert.equal(readdirSync(f.root).filter(name => name.startsWith('.failed-backup-staging-')).length, 0);
  await f.store.backupTo(target);
  assert.deepEqual(f.open(target).binding(id), f.store.binding(id));
  unchanged(f, 1, 1);
});

test('concurrent backups to one new destination publish once without overwriting or leaking staging', async t => {
  const f = fixture(t), id = await registered(f), target = join(f.root, 'concurrent-backup');
  const results = await Promise.allSettled([f.store.backupTo(target), f.store.backupTo(target)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /binding_state_exists/);
  assert.deepEqual(results.find(r => r.status === 'fulfilled').value, { published: true, durability: 'synced' });
  assert.equal(readdirSync(f.root).filter(name => name.startsWith('.concurrent-backup-staging-')).length, 0);
  assert.deepEqual(f.open(target).binding(id), f.store.binding(id));
  unchanged(f, 1, 1);
});

test('expiry after receipt write but before COMMIT rolls back the entire enrollment', async t => {
  const f = fixture(t), intent = enroll(f.store);
  const outcome = await f.sdk.verifyIdentity(intent.bytes, sign(intent.bytes));
  let calls = 0;
  const store = f.open(f.directory, { statusSource: 'test_ocsp', async verifyIdentity() { return outcome; } },
    () => ++calls >= 7 ? outcome.validUntil : f.time);
  await assert.rejects(submit(store, intent), /binding_status_expired/);
  unchanged(f);
  await submit(f.store, intent); unchanged(f, 1, 1);
});
