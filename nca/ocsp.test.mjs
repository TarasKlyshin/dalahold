import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { javaProcess } from './sdk.mjs';

test('strict OCSP policy verifies signed synthetic responses and refuses adversarial fixtures',
  { skip: !process.env.NCA_SDK_ROOT, timeout: 30000 }, async (t) => {
    const root = process.env.NCA_SDK_ROOT;
    const java = process.env.NCA_JAVA_BIN || '/opt/homebrew/opt/openjdk@17/bin';
    const build = await mkdtemp(join(tmpdir(), 'dalahold-ocsp-checks-'));
    t.after(() => rm(build, { recursive: true, force: true }));
    const jars = ['Java/provider/kalkancrypt-0.7.8-current.jar', 'Java/utils/knca_provider_util-0.8.5.jar']
      .map((name) => join(root, name)).join(delimiter);
    await javaProcess(join(java, 'javac'), ['-encoding','UTF-8','-d',build,'-cp',jars,
      ...['CmsVerifier.java','OcspVerifier.java','OcspVerifierTest.java']
        .map((name) => fileURLToPath(new URL(name, import.meta.url)))]);
    const result = JSON.parse(await javaProcess(join(java, 'java'),
      ['-cp',[build,jars].join(delimiter),'OcspVerifierTest']));
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(result.fixtureChecks, 47);
  });
