import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { prepareSdk, javaProcess } from './sdk.mjs';
import { OwnerStore } from '../authority/owner-store.mjs';
import { initializePersonalBindings, PersonalBindings } from './personal-bindings.mjs';
import { createProbeServer } from './server.mjs';
import { DatabaseSync } from 'node:sqlite';

const IDENTITY_TEST_BUDGET_MS = 120_000;

test('opaque subject identity: genuine TEST CMS, dedicated personal binding and offline storage compatibility',
  // 61 serial Java calls took 56.4/58.1 seconds in bounded complete diagnostics;
  // the original 60-second harness cancelled twice. Match the existing terms
  // SDK HTTP budget; every Java process retains its sdk.mjs 15-second deadline.
  { skip: !process.env.NCA_SDK_ROOT, timeout: IDENTITY_TEST_BUDGET_MS }, async (t) => {
    const started = performance.now(), stages = [], callTimings = {};
    const activeCalls = new Map();
    let stage = 'fixture_setup', stageStarted = started, callSequence = 0, preflightRejections = 0;
    const measured = (kind, operation) => {
      const id = ++callSequence, began = performance.now();
      activeCalls.set(id, { kind, began });
      let pending;
      try { pending = operation(); }
      catch (error) {
        activeCalls.delete(id);
        if (kind === 'sdk_verify_identity') preflightRejections++;
        throw error; // malformed-key rejection must remain synchronous
      }
      const timing = callTimings[kind] ||= { calls: 0, totalMs: 0, maxMs: 0 };
      timing.calls++;
      return Promise.resolve(pending).finally(() => {
        const elapsed = performance.now() - began;
        timing.totalMs += elapsed; timing.maxMs = Math.max(timing.maxMs, elapsed);
        activeCalls.delete(id);
      });
    };
    const measuredJava = (kind, ...args) => measured(kind, () => javaProcess(...args));
    const nextStage = next => {
      const now = performance.now();
      stages.push({ stage, elapsedMs: Math.round(now - stageStarted) });
      stage = next; stageStarted = now;
    };
    t.after(() => {
      const now = performance.now();
      const calls = Object.fromEntries(Object.entries(callTimings).map(([kind, value]) => [kind,
        { calls: value.calls, totalMs: Math.round(value.totalMs), maxMs: Math.round(value.maxMs) }]));
      // Fixed labels, counts and monotonic durations only. Never log arguments,
      // outputs, CMS, subject, password, mapping key or private pseudonyms.
      t.diagnostic('IDENTITY_GATE_METRICS ' + JSON.stringify({ elapsedMs: Math.round(now - started),
        outerBudgetMs: IDENTITY_TEST_BUDGET_MS, perJavaProcessDeadlineMs: 15_000,
        javaProcessCalls: Object.values(calls).reduce((sum, value) => sum + value.calls, 0), stages,
        currentStage: stage, currentStageElapsedMs: Math.round(now - stageStarted), calls,
        preflightRejections, activeCalls: [...activeCalls.values()].map(call =>
          ({ kind: call.kind, elapsedMs: Math.round(now - call.began) })) }));
    });
    const root = process.env.NCA_SDK_ROOT;
    const java = process.env.NCA_JAVA_BIN || '/opt/homebrew/opt/openjdk@17/bin';
    const build = await mkdtemp(join(tmpdir(), 'dalahold-test-identity-'));
    t.after(() => rm(build, { recursive: true, force: true }));
    const jars = ['Java/provider/kalkancrypt-0.7.8-current.jar', 'Java/utils/knca_provider_util-0.8.5.jar']
      .map(name => join(root, name)).join(delimiter);
    await measuredJava('java_fixture_compile', join(java, 'javac'), ['-encoding', 'UTF-8', '-d', build, '-cp', jars,
      ...['CmsVerifier.java', 'OcspVerifier.java', 'TestCmsSigner.java', 'SubjectIdentityTest.java']
        .map(name => fileURLToPath(new URL(name, import.meta.url)))]);
    const cp = [build, jars].join(delimiter);
    const parser = JSON.parse(await measuredJava('java_subject_parser', join(java, 'java'), ['-cp', cp, 'SubjectIdentityTest']));
    assert.deepEqual(parser, { subjectChecks: 30, passed: true, syntheticOnly: true });
    const buffer = await readFile(join(root, 'Keys and Certs/Gost2015/README.txt'));
    const utf8 = buffer.toString('utf8');
    const readme = utf8.includes('\ufffd') ? new TextDecoder('windows-1251').decode(buffer) : utf8;
    const password = /Пароль к тестовым сертификатам:\s*(\S+)/u.exec(readme)?.[1];
    assert.ok(password, 'bundled test password required');
    const escapedRoot = join(build, 'sdk-with-escaped-test-keys');
    await mkdir(join(escapedRoot, 'Keys and Certs'), { recursive: true });
    await symlink(join(root, 'Keys and Certs/Gost2015'), join(escapedRoot, 'Keys and Certs/Gost2015'));
    const escapeResult = (await measuredJava('java_key_confinement', join(java, 'java'),
      ['-cp', cp, 'TestCmsSigner', escapedRoot, 'sign', join(root, 'Keys and Certs/CRL')],
      `${password}\n${Buffer.from('fixture root confinement check').toString('base64')}\n`)).trim();
    assert.ok(escapeResult.startsWith('{'), 'test-key selector must refuse a symlink outside its SDK root');
    assert.equal(JSON.parse(escapeResult).testError, 'load_test_key');
    const sign = async (bytes, mode) => {
      const cms = (await measuredJava('java_cms_sign', join(java, 'java'),
        ['-cp', cp, 'TestCmsSigner', root, mode, join(root, 'Keys and Certs/CRL')],
        `${password}\n${bytes.toString('base64')}\n`)).trim();
      assert.ok(!cms.startsWith('{'), 'bundled fixture must produce genuine CMS');
      return Buffer.from(cms, 'base64');
    };
    const runtimeSdk = await measured('sdk_compile', () => prepareSdk({ sdkRoot: root, javaBin: java, statusSource: 'ocsp' }));
    const sdk = { statusSource: runtimeSdk.statusSource, close: () => runtimeSdk.close(),
      inspect: (...args) => measured('sdk_inspect', () => runtimeSdk.inspect(...args)),
      verify: (...args) => measured('sdk_verify', () => runtimeSdk.verify(...args)),
      verifyIdentity: (...args) => measured('sdk_verify_identity', () => runtimeSdk.verifyIdentity(...args)),
    };
    t.after(() => sdk.close());
    const key = randomBytes(32);
    t.after(() => key.fill(0));
    const bytes = Buffer.from('DalaHold TEST identity/storage compatibility only. No account, powers, grant or wallet.');
    nextStage('profiles_and_sdk_negative_checks');
    assert.throws(() => sdk.verifyIdentity(bytes, bytes, Buffer.alloc(31)), /mapping key required/);
    const verify = async mode => sdk.verifyIdentity(bytes, await sign(bytes, mode), key);
    const first = await verify('legal-signer');
    const revokedEmployee = await verify('legal-employee');
    const director = await verify('legal-director');
    const individual = await verify('sign');
    for (const [profile, result] of [['signer', first], ['director', director], ['individual', individual]]) {
      assert.equal(result.verified, true, `${profile}: ${result.error || 'missing verified'} / ${result.reason || 'no reason'}`);
      assert.equal(result.statusSource, 'test_ocsp');
      assert.ok(result.validUntil > Date.now());
      assert.equal(result.identity.schema, 'nca_test_subject_v1');
      assert.match(result.identity.personId, /^person:[a-f0-9]{64}$/);
      assert.ok(!Object.hasOwn(result, 'powers') && !Object.hasOwn(result, 'ownerId'));
    }
    assert.notEqual(individual.certificateDigest, director.certificateDigest);
    assert.equal(first.identity.organizationId, director.identity.organizationId);
    assert.notEqual(first.identity.personId, director.identity.personId);
    assert.equal(individual.identity.personId, director.identity.personId);
    assert.equal(individual.identity.organizationId, null);
    assert.match(first.identity.organizationId, /^organization:[a-f0-9]{64}$/);
    assert.deepEqual(revokedEmployee, { verified: false, error: 'status_unavailable', reason: 'ocsp_status_revoked' });
    for (const [mode, error] of [['revoked', 'status_unavailable'], ['wrong-purpose', 'signature_rejected']]) {
      const refused = await verify(mode);
      assert.equal(refused.verified, false);
      assert.equal(refused.error, error);
      assert.ok(!Object.hasOwn(refused, 'identity'));
    }
    const firstCms = await sign(bytes, 'legal-signer');
    const tampered = await sdk.verifyIdentity(Buffer.concat([bytes, Buffer.from('altered')]), firstCms, key);
    assert.equal(tampered.verified, false);
    assert.ok(!Object.hasOwn(tampered, 'identity'));
    const signatureOnly = await sdk.verify(bytes, firstCms);
    assert.equal(signatureOnly.verified, true);
    assert.ok(!Object.hasOwn(signatureOnly, 'identity'), 'mapping must remain explicitly opt-in');
    const otherKey = randomBytes(32);
    try {
      const remapped = await sdk.verifyIdentity(bytes, firstCms, otherKey);
      assert.equal(remapped.verified, true);
      assert.notEqual(remapped.identity.personId, first.identity.personId);
    } finally { otherKey.fill(0); }

    nextStage('personal_binding_library_backup_and_replay');
    // Real bundled personal TEST CMS over a dedicated enrollment intent. This
    // internal binding has no HTTP session/account, corporate powers or wallet.
    const personalDirectory = join(build, 'personal-bindings');
    const personalAnchor = join(build, 'retained-personal-checkpoint');
    initializePersonalBindings(personalDirectory, { anchorDirectory: personalAnchor });
    const personal = new PersonalBindings({ directory: personalDirectory, anchorDirectory: personalAnchor, sdk });
    const sessionHash = '7'.repeat(64);
    let enrollment, enrollmentCms, enrollmentReceipt, personalBinding;
    try {
      enrollment = personal.createIntent(sessionHash, { action: 'enroll_test_person' });
      enrollmentCms = await sign(enrollment.bytes, 'sign');
      const accepted = await personal.submit(sessionHash, { intentId: enrollment.id, cms: enrollmentCms });
      enrollmentReceipt = accepted.receipt;
      personalBinding = personal.binding(enrollmentReceipt.bindingId);
      assert.equal(accepted.historical, false);
      assert.equal(enrollmentReceipt.scope, 'test_personal_binding_only');
      assert.equal(enrollmentReceipt.statusSource, 'test_ocsp');
      assert.equal(personalBinding.certificateDigest, individual.certificateDigest);
      assert.equal(personalBinding.epoch, 0);
      assert.ok(!Object.hasOwn(personalBinding, 'walletAddress'));
      assert.deepEqual(await personal.submit(sessionHash, { intentId: enrollment.id, cms: enrollmentCms }),
        { receipt: enrollmentReceipt, historical: true });

      const replacement = personal.createIntent(sessionHash, { action: 'replace_test_certificate',
        bindingId: personalBinding.bindingId, newCertificateDigest: director.certificateDigest });
      // Same IIN does not authorize replacing a personal binding with an org cert.
      await assert.rejects(personal.submit(sessionHash,
        { intentId: replacement.id, cms: await sign(replacement.bytes, 'legal-director') }), /organization_binding_disabled/);
      // Actual revoked CMS refuses in SDK before any candidate-certificate match.
      await assert.rejects(personal.submit(sessionHash,
        { intentId: replacement.id, cms: await sign(replacement.bytes, 'revoked') }), /binding_identity_rejected/);
      assert.deepEqual(personal.binding(personalBinding.bindingId), personalBinding);
      for (const mode of ['wrong-purpose', 'legal-signer']) {
        const rejected = personal.createIntent(sessionHash, { action: 'enroll_test_person' });
        await assert.rejects(personal.submit(sessionHash, { intentId: rejected.id, cms: await sign(rejected.bytes, mode) }),
          /binding_identity_rejected|organization_binding_disabled/);
      }
      const tamperedEnrollment = personal.createIntent(sessionHash, { action: 'enroll_test_person' });
      await assert.rejects(personal.submit(sessionHash, { intentId: tamperedEnrollment.id,
        cms: await sign(Buffer.concat([tamperedEnrollment.bytes, Buffer.from('changed')]), 'sign') }), /binding_identity_rejected/);
      const backupDirectory = join(build, 'personal-backup');
      assert.deepEqual(await personal.backupTo(backupDirectory), { published: true, durability: 'synced' });
      const restored = new PersonalBindings({ directory: backupDirectory, anchorDirectory: personalAnchor, sdk });
      try {
        assert.deepEqual(restored.binding(personalBinding.bindingId), personalBinding);
        const again = restored.createIntent(sessionHash, { action: 'enroll_test_person' });
        const fresh = await restored.submit(sessionHash, { intentId: again.id, cms: await sign(again.bytes, 'sign') });
        assert.equal(fresh.receipt.bindingId, personalBinding.bindingId);
        assert.equal(fresh.receipt.epoch, 0);
        assert.deepEqual(restored.binding(personalBinding.bindingId), personalBinding);
      } finally { restored.close(); }
    } finally { personal.close(); }
    assert.throws(() => new PersonalBindings({ directory: personalDirectory, anchorDirectory: personalAnchor, sdk }), /binding_state_stale/);
    const personalReopened = new PersonalBindings({ directory: join(build, 'personal-backup'), anchorDirectory: personalAnchor, sdk });
    try {
      assert.deepEqual(personalReopened.binding(personalBinding.bindingId), personalBinding);
      assert.deepEqual(await personalReopened.submit(sessionHash, { intentId: enrollment.id, cms: enrollmentCms }),
        { receipt: enrollmentReceipt, historical: true });
    } finally { personalReopened.close(); }

    nextStage('personal_http_enrollment_and_refusals');
    // Genuine SDK CMS through the opt-in HTTP enrollment boundary. No manual
    // browser/NCALayer UAT and no authenticated identity/business session.
    const browserDirectory = join(build, 'browser-personal-registry');
    const browserAnchor = join(build, 'browser-retained-checkpoint');
    initializePersonalBindings(browserDirectory, { anchorDirectory: browserAnchor });
    const browserServer = createProbeServer({ dbPath: join(build, 'browser-probe.sqlite'), sdk,
      personalTest: { directory: browserDirectory, anchorDirectory: browserAnchor } });
    await new Promise(resolve => browserServer.listen(0, '127.0.0.1', resolve));
    try {
      const origin = `http://127.0.0.1:${browserServer.address().port}`;
      const page = await fetch(origin + '/personal/'); assert.equal(page.status, 200);
      const cookie = page.headers.get('set-cookie').split(';')[0];
      const ready = await fetch(origin + '/api/personal-test/status', { headers: { Cookie: cookie } });
      assert.equal(ready.status, 200); const status = await ready.json();
      assert.equal(status.scope, 'test_personal_binding_only');
      const post = (path, body) => fetch(origin + path, { method: 'POST', headers: {
        Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-DalaHold-CSRF': status.csrfToken
      }, body: JSON.stringify(body) });
      const issued = await post('/api/personal-test/intents', { action: 'enroll_test_person' });
      assert.equal(issued.status, 201); const intent = (await issued.json()).intent;
      const exact = Buffer.from(intent.bytesBase64, 'base64');
      for (const mode of ['legal-signer', 'revoked', 'wrong-purpose', 'altered']) {
        const cms = await sign(mode === 'altered' ? Buffer.concat([exact, Buffer.from('changed')]) : exact,
          mode === 'altered' ? 'sign' : mode);
        assert.equal((await post('/api/personal-test/receipts', { intentId: intent.id, cms: cms.toString('base64') })).status, 422);
      }
      const db = new DatabaseSync(join(browserDirectory, 'personal.sqlite'), { readOnly: true });
      try {
        assert.equal(db.prepare('SELECT count(*) n FROM personal_bindings').get().n, 0);
        assert.equal(db.prepare('SELECT receipt_json FROM binding_intents WHERE id=?').get(intent.id).receipt_json, null);
      } finally { db.close(); }
      const cms = (await sign(exact, 'sign')).toString('base64');
      const accepted = await post('/api/personal-test/receipts', { intentId: intent.id, cms });
      assert.equal(accepted.status, 200); const result = await accepted.json();
      assert.equal(result.historical, false); assert.equal(result.receipt.scope, 'test_personal_binding_only');
      assert.equal(result.receipt.certificateDigest, individual.certificateDigest);
      assert.ok(['personId','organizationId','ownerId','mappingKeyId','powers','walletAddress','grant']
        .every(field => !Object.hasOwn(result.receipt, field)));
      const repeated = await post('/api/personal-test/receipts', { intentId: intent.id, cms });
      assert.deepEqual(await repeated.json(), { ...result, historical: true });

      nextStage('personal_http_replacement_refusals_and_retry');
      // A fresh anonymous TEST session may propose a replacement, but only the
      // exact eligible same-person personal CMS could commit it. These are REAL
      // bundled negative signatures, not a positive same-profile renewal pair.
      const replacementPage = await fetch(origin + '/personal/');
      const replacementCookie = replacementPage.headers.get('set-cookie').split(';')[0];
      const replacementStatus = await (await fetch(origin + '/api/personal-test/status',
        { headers: { Cookie: replacementCookie } })).json();
      const replacementPost = body => fetch(origin + '/api/personal-test/receipts', {
        method: 'POST', headers: { Cookie: replacementCookie, Origin: origin,
          'Content-Type': 'application/json', 'X-DalaHold-CSRF': replacementStatus.csrfToken },
        body: JSON.stringify(body) });
      const issuedReplacement = await fetch(origin + '/api/personal-test/intents', {
        method: 'POST', headers: { Cookie: replacementCookie, Origin: origin,
          'Content-Type': 'application/json', 'X-DalaHold-CSRF': replacementStatus.csrfToken },
        body: JSON.stringify({ action: 'replace_test_certificate', bindingId: result.receipt.bindingId,
          newCertificateDigest: director.certificateDigest }) });
      assert.equal(issuedReplacement.status, 201);
      const replaceIntent = (await issuedReplacement.json()).intent;
      const replaceBytes = Buffer.from(replaceIntent.bytesBase64, 'base64');
      for (const [mode, error] of [['legal-director','organization_binding_disabled'],
        ['revoked','binding_identity_rejected'], ['wrong-purpose','binding_identity_rejected'],
        ['sign','replacement_certificate_mismatch'], ['altered','binding_identity_rejected']]) {
        const replaceCms = await sign(mode === 'altered' ? Buffer.concat([replaceBytes, Buffer.from('changed')]) : replaceBytes,
          mode === 'altered' ? 'sign' : mode);
        const refused = await replacementPost({ intentId: replaceIntent.id, cms: replaceCms.toString('base64') });
        assert.equal(refused.status, 422); assert.deepEqual(await refused.json(), { error });
        const check = new DatabaseSync(join(browserDirectory, 'personal.sqlite'), { readOnly: true });
        try {
          const current = check.prepare('SELECT certificate_digest, epoch FROM personal_bindings WHERE binding_id=?')
            .get(result.receipt.bindingId);
          assert.equal(current.certificate_digest, individual.certificateDigest); assert.equal(current.epoch, 0);
          assert.equal(check.prepare('SELECT count(*) n FROM personal_bindings').get().n, 1);
          assert.equal(check.prepare('SELECT count(*) n FROM retired_certificates').get().n, 0);
          assert.equal(check.prepare('SELECT revision FROM binding_meta').get().revision, 3);
          assert.equal(check.prepare('SELECT receipt_json FROM binding_intents WHERE id=?').get(replaceIntent.id).receipt_json, null);
        } finally { check.close(); }
      }
      const replaceCms = (await sign(replaceBytes, 'sign')).toString('base64');
      for (let retry = 0; retry < 2; retry++) {
        const refused = await replacementPost({ intentId: replaceIntent.id, cms: replaceCms });
        assert.equal(refused.status, 422);
        assert.deepEqual(await refused.json(), { error: 'replacement_certificate_mismatch' });
      }
      const replacementClosed = await fetch(origin + '/api/personal-test/session/close', {
        method: 'POST', headers: { Cookie: replacementCookie, Origin: origin,
          'Content-Type': 'application/json', 'X-DalaHold-CSRF': replacementStatus.csrfToken }, body: '{}' });
      assert.equal(replacementClosed.status, 200);
      assert.equal((await replacementPost({ intentId: replaceIntent.id, cms: replaceCms })).status, 401);
      assert.equal((await post('/api/personal-test/session/close', {})).status, 200);
      assert.equal((await post('/api/personal-test/receipts', { intentId: intent.id, cms })).status, 401);
    } finally {
      await new Promise(resolve => browserServer.close(resolve)); await browserServer.resourcesClosed;
    }

    nextStage('offline_owner_storage_compatibility');
    // Trusted storage fixture only: no corporate powers policy, HTTP enrolment,
    // real Solana address/key, grant signature or business operation.
    const path = join(build, 'offline-owner.sqlite');
    const store = new OwnerStore(path);
    const owner = { ownerId: randomUUID(), subjectId: individual.identity.personId,
      certificateId: individual.certificateDigest, walletAddress: 'OFFLINE-WALLET-FIXTURE-NOT-SOLANA' };
    try {
      store.registerVerifiedOwner(owner);
      const next = store.rotateVerifiedCertificate({ ownerId: owner.ownerId,
        subjectId: director.identity.personId, previousCertificateId: individual.certificateDigest,
        newCertificateId: director.certificateDigest, nonce: 'fixture-rotation' });
      assert.equal(next.ownerId, owner.ownerId);
      assert.equal(next.walletAddress, owner.walletAddress);
      assert.equal(next.authEpoch, 1);
      assert.throws(() => store.rotateVerifiedCertificate({ ownerId: owner.ownerId,
        subjectId: first.identity.personId, previousCertificateId: director.certificateDigest,
        newCertificateId: first.certificateDigest, nonce: 'foreign-person' }), /foreign/);
      assert.throws(() => store.saveVerifiedGrant({ ...owner, authEpoch: 0, dealId: 'offline-deal',
        nonce: 'stale-credential', orderHash: 'a'.repeat(64), envelope: 'OFFLINE-NOT-A-GRANT' }), /stale authority/);
    } finally { store.close(); }
    const reopened = new OwnerStore(path);
    try { assert.deepEqual(reopened.owner(owner.ownerId), { ...owner,
      certificateId: director.certificateDigest, authEpoch: 1 }); }
    finally { reopened.close(); }
    nextStage('complete');
    t.diagnostic('Genuine TEST personal enrollment/library/current-backup/restart and opt-in HTTP enrollment/retry/close pass; genuine corporate/revoked/wrong-purpose/tampered and mismatched-candidate replacement CMS refuse through HTTP without changing binding/epoch or consuming the intent. Positive personal renewal remains synthetic only: no eligible second bundled personal certificate. No manual renewal UAT, identity login, corporate powers or wallet.');
  });
