// Public test CRLs only. Signature/date/pair checks precede printing the usable path.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareSdk } from './sdk.mjs';

const local = fileURLToPath(new URL('../.local/', import.meta.url));

export async function refreshCrls({ sdkRoot, javaBin }) {
  await mkdir(local, { recursive: true });
  const candidate = await mkdtemp(join(local, 'nca-test-crls-'));
  let sdk;
  try {
    for (const name of ['nca_gost2022_test.crl', 'nca_gost2022_d_test.crl']) {
      // Official test endpoint published in the SDK. HTTP is authenticated by
      // the CRL's Kalkan signature against the pinned local test CA, not TLS.
      const response = await fetch(`http://test.pki.gov.kz/crl/${name}`,
        { redirect: 'error', signal: AbortSignal.timeout(8000) });
      if (!response.ok || Number(response.headers.get('content-length')) > 100_000) throw new Error();
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 100_000) throw new Error();
        chunks.push(chunk);
      }
      await writeFile(join(candidate, name), Buffer.concat(chunks));
    }
    sdk = await prepareSdk({ sdkRoot, javaBin, crlDirectory: candidate });
    const status = await sdk.inspect();
    if (status.ready !== true) throw new Error(status.reason);
    return { directory: candidate, validUntil: status.validUntil };
  } catch (error) {
    await rm(candidate, { recursive: true, force: true });
    const code = ['test_ca', 'crl_files', 'crl_pair', 'crl_time_or_issuer', 'crl_signature'].includes(error.message)
      ? error.message : 'download_or_verifier_unavailable';
    throw new Error(code);
  } finally { if (sdk) await sdk.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await refreshCrls({ sdkRoot: process.env.NCA_SDK_ROOT,
      javaBin: process.env.NCA_JAVA_BIN });
    process.stdout.write(`NCA_TEST_CRL_DIR=${result.directory}\nTest CRLs valid until ${new Date(result.validUntil).toISOString()}\n`);
  } catch (error) { process.stderr.write(`Test CRL refresh rejected: ${error.message}\n`); process.exitCode = 1; }
}
