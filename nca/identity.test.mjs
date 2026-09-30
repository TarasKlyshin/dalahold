import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { prepareSdk, javaProcess } from './sdk.mjs';
import { OwnerStore } from '../authority/owner-store.mjs';

test('opaque subject identity: genuine TEST CMS, typed actors and offline owner-store compatibility',
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
    t.diagnostic('Genuine individual/director TEST certificates map to one subject; another subject in the same organization remains distinct. Employee in valid folder is actually revoked. Offline storage rotation/restart pass; no corporate powers or account endpoint.');
  });
