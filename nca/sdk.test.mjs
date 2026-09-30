import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createProbeServer } from './server.mjs';
import { javaProcess, prepareSdk } from './sdk.mjs';

const sdkRoot = process.env.NCA_SDK_ROOT;
const crlDirectory = process.env.NCA_TEST_CRL_DIR;
const javaBin = process.env.NCA_JAVA_BIN || '/opt/homebrew/opt/openjdk@17/bin';

test('real SDK exact-byte signature checks and status refusal; full HTTP acceptance requires coherent test CRLs',
  { skip: !sdkRoot, timeout: 60_000 }, async (t) => {
    const build = await mkdtemp(join(tmpdir(), 'dalahold-nca-sdk-test-'));
    t.after(() => rm(build, { recursive: true, force: true }));
    const sdk = await prepareSdk({ sdkRoot, javaBin, crlDirectory });
    t.after(() => sdk.close());
    const jars = [join(sdkRoot, 'Java/provider/kalkancrypt-0.7.8-current.jar'),
      join(sdkRoot, 'Java/utils/knca_provider_util-0.8.5.jar')].join(delimiter);
    await javaProcess(join(javaBin, 'javac'), ['-encoding', 'UTF-8', '-d', build, '-cp', jars,
      fileURLToPath(new URL('./CmsVerifier.java', import.meta.url)),
      fileURLToPath(new URL('./SdkProbe.java', import.meta.url)),
      fileURLToPath(new URL('./TestCmsSigner.java', import.meta.url))]);
    const buffer = await readFile(join(sdkRoot, 'Keys and Certs/Gost2015/README.txt'));
    const utf8 = buffer.toString('utf8');
    const readme = utf8.includes('\ufffd') ? new TextDecoder('windows-1251').decode(buffer) : utf8;
    // Shared bundled TEST password only. Read locally; never echo, persist or put in argv/env.
    const password = /Пароль к тестовым сертификатам:\s*(\S+)/u.exec(readme)?.[1];
    assert.ok(password, 'bundled test password not found');
    const sign = async (bytes, mode = 'sign') => (await javaProcess(join(javaBin, 'java'),
      ['-cp', [build, jars].join(delimiter), 'TestCmsSigner', sdkRoot, mode, crlDirectory],
      `${password}\n${bytes.toString('base64')}\n`)).trim();
    const health = await sdk.inspect();
    const bundled = await prepareSdk({ sdkRoot, javaBin });
    try { assert.equal((await bundled.inspect()).error, 'status_unavailable'); }
    finally { await bundled.close(); }
    const cryptoChecks = JSON.parse(await sign(Buffer.from('SDK exact-byte self-check'), 'crypto-checks'));
    assert.deepEqual(cryptoChecks, { cryptoChecks: 4, passed: true, signatureOnly: true });
    if (health.ready !== true) {
      assert.equal(health.error, 'status_unavailable');
      assert.equal(health.reason, 'crl_pair');
      const blocked = createProbeServer({ dbPath: join(build, 'blocked.sqlite'), sdk });
      await new Promise((resolve) => blocked.listen(0, '127.0.0.1', resolve));
      try {
        const base = `http://127.0.0.1:${blocked.address().port}`;
        const cookie = (await fetch(base)).headers.get('set-cookie').split(';')[0];
        assert.equal((await fetch(`${base}/api/status`, { headers: { Cookie: cookie } })).status, 503);
        const rejected = await fetch(`${base}/api/challenges`, { method: 'POST',
          headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(rejected.status, 503);
        assert.deepEqual(await rejected.json(), { error: 'status_unavailable', reason: 'crl_pair' });
        t.diagnostic('Full status acceptance BLOCKED: SDK base CRL 166 is below delta BaseCRLNumber 167. Signature-only checks passed; no verified receipt issued.');
      } finally { await new Promise((resolve) => blocked.close(resolve)); }
      return;
    }
    assert.equal(health.chain.length, 2);
    const checks = JSON.parse(await sign(Buffer.from('SDK exact-byte self-check'), 'checks'));
    assert.deepEqual(checks, { sdkChecks: 6, passed: true });
    const server = createProbeServer({ dbPath: join(build, 'probe.sqlite'), sdk });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const cookie = (await fetch(base)).headers.get('set-cookie').split(';')[0];
    const post = (path, value) => fetch(`${base}${path}`, { method: 'POST',
      headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    const issued = await post('/api/challenges', {});
    assert.equal(issued.status, 201);
    const challenge = (await issued.json()).challenge;
    const bytes = Buffer.from(challenge.bytesBase64, 'base64');
    for (const field of [['8400000', '8400001'], ['test-buyer', 'attacker']]) {
      const cms = await sign(Buffer.from(challenge.text.replace(...field)));
      const response = await post('/api/verify', { challengeId: challenge.id, cms });
      assert.equal(response.status, 422);
    }
    for (const mode of ['attached', 'multi', 'expired']) {
      const cms = await sign(bytes, mode);
      const response = await post('/api/verify', { challengeId: challenge.id, cms });
      assert.equal(response.status, 422, `mode ${mode} did not reach SDK rejection`);
    }
    const auth = await sign(bytes, 'auth');
    if (auth.startsWith('{')) {
      assert.equal(JSON.parse(auth).testError, 'load_test_key');
      t.diagnostic('No separate authentication-only key in current individual test bundle; wrong-purpose certificate acceptance remains open.');
    } else {
      assert.equal((await post('/api/verify', { challengeId: challenge.id, cms: auth })).status, 422);
    }
    const cms = await sign(bytes);
    const response = await post('/api/verify', { challengeId: challenge.id, cms });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.replay, false);
    assert.equal(result.receipt.challengeHash, challenge.hash);
    assert.match(result.receipt.certificateDigest, /^[a-f0-9]{64}$/);
    assert.equal(result.receipt.scope, 'test_signature_only');
    const retry = await post('/api/verify', { challengeId: challenge.id, cms });
    assert.deepEqual((await retry.json()).receipt, result.receipt);
  });
