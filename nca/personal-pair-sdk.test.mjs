// Opt-in genuine bundled TEST personal valid/revoked pair; disposable state only.
// Subject comparison is signature-only. Fresh bindings always require real TEST
// OCSP; this does not prove positive renewal, two participants or browser UAT.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { javaProcess, prepareSdk } from './sdk.mjs';
import { initializePersonalBindings, PersonalBindings } from './personal-bindings.mjs';

const sdkRoot = process.env.NCA_SDK_ROOT;
const javaBin = process.env.NCA_JAVA_BIN || '/opt/homebrew/opt/openjdk@17/bin';
// Public SHA-256 X.509 DER pins for the reviewed 2026 bundled personal pair.
const VALID = 'f9305218f91240e329afea23a250e67534c535ae6f217807e268cfe630e63d34';
const REVOKED = '6e5aa13bc638680bd5b873e30d9bf62ac4c65140f1f9de6c6a6dae0be417d3b3';
const SESSION = '7'.repeat(64);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const rowsHash = rows => hash(JSON.stringify(rows));

async function bundledPassword(root) {
  let bytes;
  try {
    bytes = await readFile(join(root, 'Keys and Certs/Gost2015/README.txt'));
    const utf8 = bytes.toString('utf8');
    const text = utf8.includes('\ufffd') ? new TextDecoder('windows-1251').decode(bytes) : utf8;
    const value = /Пароль к тестовым сертификатам:\s*(\S+)/u.exec(text)?.[1];
    if (!value) throw new Error();
    return value;
  } catch { throw new Error('bundled_test_password_unavailable'); }
  finally { bytes?.fill(0); }
}

test('genuine same-person personal TEST valid/revoked pair preserves binding and historical replay gates',
  { skip: !sdkRoot, timeout: 180_000 }, async t => {
    const runtime = await mkdtemp(join(tmpdir(), 'dalahold-personal-pair-sdk-'));
    const directory = join(runtime, 'registry'), anchorDirectory = join(runtime, 'checkpoint');
    const cmsBuffers = [];
    let sdk, store, password, lastEvidence;
    const sdkCalls = { inspect: 0, verify: 0, verifyIdentity: 0 };
    t.after(async () => {
      password = undefined;
      for (const cms of cmsBuffers) cms.fill(0);
      try { store?.close(); }
      finally {
        try { await sdk?.close(); }
        finally { await rm(runtime, { recursive: true, force: true }); }
      }
    });
    const jars = ['Java/provider/kalkancrypt-0.7.8-current.jar', 'Java/utils/knca_provider_util-0.8.5.jar']
      .map(name => join(sdkRoot, name)).join(delimiter);
    await javaProcess(join(javaBin, 'javac'), ['-encoding', 'UTF-8', '-d', runtime, '-cp', jars,
      ...['CmsVerifier.java', 'OcspVerifier.java', 'TestCmsSigner.java', 'PersonalPairFixtureProbe.java']
        .map(name => fileURLToPath(new URL(name, import.meta.url)))]);
    const classpath = [runtime, jars].join(delimiter);
    password = await bundledPassword(sdkRoot);
    let pair, pairConfirmed = false;
    await t.test('CA-authenticated exact CMS proves one personal subject and two distinct TEST certificates only', async () => {
      try {
        pair = JSON.parse(await javaProcess(join(javaBin, 'java'),
          ['-cp', classpath, 'PersonalPairFixtureProbe', sdkRoot], `${password}\n`));
      } catch { throw new Error('bundled_personal_pair_probe_unavailable'); }
      // Validate the output shape before assertions could display any value.
      assert.ok(pair && typeof pair === 'object' && !Array.isArray(pair) &&
        Object.keys(pair).sort().join(',') ===
          'bothPersonalSubjects,identityEvidence,revokedDigest,sameCertificate,samePerson,validDigest' &&
        pair.identityEvidence === 'ca_authenticated_cms_subject_comparison_only' &&
        ['samePerson', 'sameCertificate', 'bothPersonalSubjects'].every(key => typeof pair[key] === 'boolean') &&
        [pair.validDigest, pair.revokedDigest].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)),
      'fixture comparison exposes only bounded booleans and public DER digests');
      assert.deepEqual(pair, { identityEvidence: 'ca_authenticated_cms_subject_comparison_only',
        samePerson: true, sameCertificate: false, bothPersonalSubjects: true,
        validDigest: VALID, revokedDigest: REVOKED });
      pairConfirmed = true;
    });
    assert.ok(pairConfirmed, 'authenticated pinned pair required before genuine binding cases');
    const sign = async (bytes, mode) => {
      assert.ok(['sign', 'revoked'].includes(mode), 'only the fixed personal TEST pair may sign');
      const encoded = (await javaProcess(join(javaBin, 'java'),
        ['-cp', classpath, 'TestCmsSigner', sdkRoot, mode, join(sdkRoot, 'Keys and Certs/CRL')],
        `${password}\n${bytes.toString('base64')}\n`)).trim();
      assert.ok(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded),
        'bundled fixture must return genuine detached TEST CMS without diagnostics');
      const cms = Buffer.from(encoded, 'base64');
      assert.ok(cms.length > 0 && cms.length <= 98_304, 'genuine CMS fits the personal binding boundary');
      cmsBuffers.push(cms);
      return cms;
    };
    sdk = await prepareSdk({ sdkRoot, javaBin, statusSource: 'ocsp' });
    const observedSdk = { statusSource: sdk.statusSource,
      async inspect(...args) { sdkCalls.inspect++; return sdk.inspect(...args); },
      async verify(...args) { sdkCalls.verify++; return sdk.verify(...args); },
      async verifyIdentity(...args) {
        sdkCalls.verifyIdentity++;
        const outcome = await sdk.verifyIdentity(...args);
        // Never retain or display private pseudonyms in assertion diagnostics.
        lastEvidence = { verified: outcome.verified === true, identityReturned: Object.hasOwn(outcome, 'identity'),
          personal: outcome.identity?.organizationId === null, validDigest: outcome.certificateDigest === VALID,
          testOcsp: outcome.statusSource === 'test_ocsp',
          revoked: outcome.error === 'status_unavailable' && outcome.reason === 'ocsp_status_revoked' };
        return outcome;
      },
    };
    initializePersonalBindings(directory, { anchorDirectory });
    store = new PersonalBindings({ directory, anchorDirectory, sdk: observedSdk });
    const sql = (path, callback) => {
      const db = new DatabaseSync(path, { readOnly: true });
      try { return callback(db); } finally { db.close(); }
    };
    const registry = callback => sql(join(directory, 'personal.sqlite'), callback);
    const snapshot = () => {
      const key = readFileSync(join(directory, 'mapping.key'));
      try {
        // All columns/rows, including bytes, signature hash, receipt JSON/MAC,
        // metadata and full checkpoint, are compared via in-memory fingerprints.
        return { mappingKey: hash(key), registry: registry(db => ({
          schema: rowsHash(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name').all()),
          metadata: rowsHash(db.prepare('SELECT * FROM binding_meta ORDER BY singleton').all()),
          bindings: rowsHash(db.prepare('SELECT * FROM personal_bindings ORDER BY binding_id').all()),
          retired: rowsHash(db.prepare('SELECT * FROM retired_certificates ORDER BY certificate_digest').all()),
          intents: rowsHash(db.prepare('SELECT * FROM binding_intents ORDER BY id').all()
            .map(row => ({ ...row, bytes: Buffer.from(row.bytes).toString('base64') }))),
        })), checkpoint: sql(join(anchorDirectory, 'checkpoint.sqlite'), db => ({
          schema: rowsHash(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name').all()),
          rows: rowsHash(db.prepare('SELECT * FROM checkpoint ORDER BY singleton').all()),
        })) };
      } finally { key.fill(0); }
    };
    const counts = () => registry(db => ({
      bindings: db.prepare('SELECT count(*) n FROM personal_bindings').get().n,
      receipts: db.prepare('SELECT count(*) n FROM binding_intents WHERE receipt_json IS NOT NULL').get().n,
      retired: db.prepare('SELECT count(*) n FROM retired_certificates').get().n,
      intents: db.prepare('SELECT count(*) n FROM binding_intents').get().n,
      revision: db.prepare('SELECT revision FROM binding_meta WHERE singleton=1').get().revision,
    }));
    const unconsumed = intent => {
      const row = registry(db => db.prepare('SELECT signature_hash,receipt_json,receipt_mac FROM binding_intents WHERE id=?').get(intent.id));
      assert.ok(row && row.signature_hash === null && row.receipt_json === null && row.receipt_mac === null,
        'refused intent retains no signature hash, receipt or receipt MAC');
    };
    const submit = (intent, cms) => store.submit(SESSION, { intentId: intent.id, cms });
    const revokedEvidence = { verified: false, identityReturned: false, personal: false,
      validDigest: false, testOcsp: false, revoked: true };
    const enrollment = store.createIntent(SESSION, { action: 'enroll_test_person' });
    let enrollmentCms, accepted;

    await t.test('fresh genuine revoked enrollment refuses without changing any row, MAC, key or checkpoint', async () => {
      const before = snapshot();
      await assert.rejects(submit(enrollment, await sign(enrollment.bytes, 'revoked')), /^Error: binding_identity_rejected$/);
      assert.deepEqual(lastEvidence, revokedEvidence, 'strict current OCSP rejects before exposing identity');
      assert.deepEqual(snapshot(), before);
      unconsumed(enrollment);
      assert.deepEqual(counts(), { bindings: 0, receipts: 0, retired: 0, intents: 1, revision: 1 });
      assert.deepEqual(sdkCalls, { inspect: 0, verify: 0, verifyIdentity: 1 });
    });
    await t.test('valid genuine CMS accepts the exact same unconsumed enrollment intent', async () => {
      enrollmentCms = await sign(enrollment.bytes, 'sign');
      accepted = await submit(enrollment, enrollmentCms);
      assert.deepEqual(lastEvidence, { verified: true, identityReturned: true, personal: true,
        validDigest: true, testOcsp: true, revoked: false });
      assert.equal(accepted.historical, false);
      assert.equal(accepted.receipt.intentHash, enrollment.hash);
      assert.equal(accepted.receipt.certificateDigest, VALID);
      assert.equal(accepted.receipt.epoch, 0);
      assert.equal(accepted.receipt.scope, 'test_personal_binding_only');
      assert.equal(accepted.receipt.statusSource, 'test_ocsp');
      assert.ok(accepted.receipt.validUntil > Date.now(), 'fresh genuine status remains eligible at acceptance');
      assert.deepEqual(counts(), { bindings: 1, receipts: 1, retired: 0, intents: 1, revision: 2 });
      assert.deepEqual(sdkCalls, { inspect: 0, verify: 0, verifyIdentity: 2 });
    });
    assert.ok(accepted && enrollmentCms, 'accepted genuine enrollment required for replacement/replay cases');
    await t.test('exact revoked replacement target and genuine CMS refuse with all protected state unchanged', async () => {
      const replacement = store.createIntent(SESSION, { action: 'replace_test_certificate',
        bindingId: accepted.receipt.bindingId, newCertificateDigest: REVOKED });
      const contract = JSON.parse(replacement.bytes);
      assert.equal(contract.bindingId, accepted.receipt.bindingId);
      assert.equal(contract.previousCertificateDigest, VALID);
      assert.equal(contract.newCertificateDigest, REVOKED);
      assert.equal(contract.expectedEpoch, 0);
      // Issuing an intent deliberately advances revision; refusal is compared
      // with that post-issuance state, never with a fabricated historical binding.
      const before = snapshot();
      await assert.rejects(submit(replacement, await sign(replacement.bytes, 'revoked')), /^Error: binding_identity_rejected$/);
      assert.deepEqual(lastEvidence, revokedEvidence);
      assert.deepEqual(snapshot(), before);
      unconsumed(replacement);
      const current = store.binding(accepted.receipt.bindingId);
      assert.equal(current.bindingId, accepted.receipt.bindingId);
      assert.equal(current.certificateDigest, VALID);
      assert.equal(current.epoch, 0);
      assert.deepEqual(counts(), { bindings: 1, receipts: 1, retired: 0, intents: 2, revision: 3 });
      assert.deepEqual(sdkCalls, { inspect: 0, verify: 0, verifyIdentity: 3 });
    });
    await t.test('exact accepted enrollment replay is historical with zero new SDK calls or state changes', async () => {
      const before = snapshot(), callsBefore = { ...sdkCalls };
      const replay = await submit(enrollment, enrollmentCms);
      assert.equal(replay.historical, true);
      assert.deepEqual(replay.receipt, accepted.receipt);
      assert.deepEqual(sdkCalls, callsBefore);
      assert.deepEqual(snapshot(), before);
      assert.deepEqual(counts(), { bindings: 1, receipts: 1, retired: 0, intents: 2, revision: 3 });
    });
    t.diagnostic(JSON.stringify({ acceptanceScenarios: 5, authenticatedPairCms: 2, genuineSdkCalls: sdkCalls,
      exactHistoricalReplayNewSdkCalls: 0, finalCounts: counts(), epoch: 0,
      positiveReplacementProven: false, twoParticipantsProven: false }));
  });
