// Explicit separate personal TEST stand. Never opens the unsigned cabinet or
// the retained personal binding/key/checkpoint. No production/corporate rail.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareSdk } from '../nca/sdk.mjs';
import { startParticipantWorkspace } from './participant-server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function startSignedParticipantWorkspace({ sdkRoot, sdk,
  javaBin = '/opt/homebrew/opt/openjdk@17/bin',
  directory = resolve(root, '.local/signed-participant-test-cabinet'),
  port = 4178, now = Date.now, memoConfiguration } = {}) {
  // Tests may inject a trusted verifier in process, never via HTTP/CLI fields.
  // The runnable stand always compiles the official SDK in explicit TEST OCSP.
  const verifier = sdk || await prepareSdk({ sdkRoot, javaBin, statusSource: 'ocsp' });
  let stand;
  try {
    if (verifier.statusSource !== 'test_ocsp') throw new Error('test_ocsp_required');
    stand = await startParticipantWorkspace({ directory, port, now,
      signatureSdk: verifier, memoConfiguration });
  } catch (error) { if (!sdk) await verifier.close(); throw error; }
  let closing;
  return { ...stand, close: () => closing ||= (async () => {
    await stand.close();
    if (!sdk) await verifier.close();
  })() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const stand = await startSignedParticipantWorkspace({ sdkRoot: process.env.NCA_SDK_ROOT,
      javaBin: process.env.NCA_JAVA_BIN || undefined,
      ...(process.env.NCA_TEST_MEMO_WALLET ? { memoConfiguration: {
        walletAddress: process.env.NCA_TEST_MEMO_WALLET, maxFeeLamports: '10000',
      } } : {}) });
    process.stdout.write(`DalaHold personal TEST signatures: ${stand.url}\n`);
    const stop = () => stand.close().then(() => process.exit(0));
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch {
    process.stderr.write('Signed personal TEST stand unavailable; inspect SDK/private directory/port. No fallback.\n');
    process.exitCode = 1;
  }
}
