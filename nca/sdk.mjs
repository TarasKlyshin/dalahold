import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function javaProcess(binary, args, input = '', timeout = 15_000) {
  return new Promise((resolve, reject) => {
    const child = execFile(binary, args, { timeout, maxBuffer: 32_768 }, (error, stdout) => {
      if (error) return reject(new Error('verifier_unavailable'));
      resolve(stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function prepareSdk({ sdkRoot, javaBin = '/opt/homebrew/opt/openjdk@17/bin',
  crlDirectory = sdkRoot && join(sdkRoot, 'Keys and Certs/CRL'), statusSource = 'crl' }) {
  if (typeof sdkRoot !== 'string' || !sdkRoot) throw new Error('NCA_SDK_ROOT required');
  if (!['crl', 'ocsp'].includes(statusSource)) throw new Error('unsupported_test_status_source');
  const build = await mkdtemp(join(tmpdir(), 'dalahold-nca-'));
  const jars = ['Java/provider/kalkancrypt-0.7.8-current.jar',
    'Java/utils/knca_provider_util-0.8.5.jar'].map((name) => join(sdkRoot, name)).join(delimiter);
  try {
    await javaProcess(join(javaBin, 'javac'), ['-encoding', 'UTF-8', '-d', build, '-cp', jars,
      fileURLToPath(new URL('./CmsVerifier.java', import.meta.url)),
      fileURLToPath(new URL('./OcspVerifier.java', import.meta.url))]);
  } catch (error) {
    await rm(build, { recursive: true, force: true });
    throw error;
  }
  const classpath = [build, jars].join(delimiter);
  async function call(command, input) {
    try {
      return JSON.parse(await javaProcess(join(javaBin, 'java'),
        ['-cp', classpath, 'CmsVerifier', sdkRoot, crlDirectory,
          statusSource === 'ocsp' ? `${command}_ocsp` : command], input));
    } catch { throw new Error('verifier_unavailable'); }
  }
  return {
    statusSource: statusSource === 'ocsp' ? 'test_ocsp' : 'test_crl_fixture',
    inspect: () => call('inspect'),
    verify: (bytes, cms) => call('verify', `${bytes.toString('base64')}\n${cms.toString('base64')}\n`),
    // Internal opt-in evidence only. The HTTP stand never calls this or binds
    // probe receipts to owners. Mapping key is stdin-only, never argv/env/logs.
    verifyIdentity: (bytes, cms, identityKey) => {
      if (!Buffer.isBuffer(identityKey) || identityKey.length !== 32) {
        throw new Error('32-byte identity mapping key required');
      }
      return call('verify_identity', `${bytes.toString('base64')}\n${cms.toString('base64')}\n${identityKey.toString('base64')}\n`);
    },
    close: () => rm(build, { recursive: true, force: true }),
  };
}
