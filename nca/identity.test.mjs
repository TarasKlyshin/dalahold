import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { prepareSdk, javaProcess } from './sdk.mjs';
import { OwnerStore } from '../authority/owner-store.mjs';
import { initializePersonalBindings, PersonalBindings } from './personal-bindings.mjs';

test('opaque subject identity: genuine TEST CMS, dedicated personal binding and offline storage compatibility',
  { skip: !process.env.NCA_SDK_ROOT, timeout: 60_000 }, async (t) => {
    const root = process.env.NCA_SDK_ROOT;
    const java = process.env.NCA_JAVA_BIN || '/opt/homebrew/opt/openjdk@17/bin';
    const build = await mkdtemp(join(tmpdir(), 'dalahold-test-identity-'));
    t.after(() => rm(build, { recursive: true, force: true }));
    const jars = ['Java/provider/kalkancrypt-0.7.8-current.jar', 'Java/utils/knca_provider_util-0.8.5.jar']
      .map(name => join(root, name)).join(delimiter);
    await javaProcess(join(java, 'javac'), ['-encoding', 'UTF-8', '-d', build, '-cp', jars,
      ...['CmsVerifier.java', 'OcspVerifier.java', 'TestCmsSigner.java', 'SubjectIdentityTest.java']
        .map(name => fileURLToPath(new URL(name, import.meta.url)))]);
    const cp = [build, jars].join(delimiter);
    const parser = JSON.parse(await javaProcess(join(java, 'java'), ['-cp', cp, 'SubjectIdentityTest']));
    assert.deepEqual(parser, { subjectChecks: 30, passed: true, syntheticOnly: true });
    const buffer = await readFile(join(root, 'Keys and Certs/Gost2015/README.txt'));
    const utf8 = buffer.toString('utf8');
    const readme = utf8.includes('\ufffd') ? new TextDecoder('windows-1251').decode(buffer) : utf8;
    const password = /Пароль к тестовым сертификатам:\s*(\S+)/u.exec(readme)?.[1];
    assert.ok(password, 'bundled test password required');
    const escapedRoot = join(build, 'sdk-with-escaped-test-keys');
    await mkdir(join(escapedRoot, 'Keys and Certs'), { recursive: true });
    await symlink(join(root, 'Keys and Certs/Gost2015'), join(escapedRoot, 'Keys and Certs/Gost2015'));
    const escapeResult = (await javaProcess(join(java, 'java'),
      ['-cp', cp, 'TestCmsSigner', escapedRoot, 'sign', join(root, 'Keys and Certs/CRL')],
      `${password}\n${Buffer.from('fixture root confinement check').toString('base64')}\n`)).trim();
    assert.ok(escapeResult.startsWith('{'), 'test-key selector must refuse a symlink outside its SDK root');
    assert.equal(JSON.parse(escapeResult).testError, 'load_test_key');
    const sign = async (bytes, mode) => {
      const cms = (await javaProcess(join(java, 'java'),
        ['-cp', cp, 'TestCmsSigner', root, mode, join(root, 'Keys and Certs/CRL')],
        `${password}\n${bytes.toString('base64')}\n`)).trim();
      assert.ok(!cms.startsWith('{'), 'bundled fixture must produce genuine CMS');
      return Buffer.from(cms, 'base64');
    };
    const sdk = await prepareSdk({ sdkRoot: root, javaBin: java, statusSource: 'ocsp' });
    t.after(() => sdk.close());
    const key = randomBytes(32);
    t.after(() => key.fill(0));
    const bytes = Buffer.from('DalaHold TEST identity/storage compatibility only. No account, powers, grant or wallet.');
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
    t.diagnostic('Genuine TEST personal enrollment, historical retry, stable mapping after private backup/restart and corporate/revoked/wrong-purpose/tampered refusals pass. Positive personal renewal is synthetic only: no eligible second bundled personal certificate. No HTTP account, corporate powers or wallet.');
  });
