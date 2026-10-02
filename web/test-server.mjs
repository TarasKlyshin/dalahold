// Explicit independent loopback stand; never touches existing operator registries.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDraftServer } from './server.mjs';
import { prepareSdk } from '../nca/sdk.mjs';
import { prepareReadOnlyTestFixture } from './test-fixture.mjs';

const root = fileURLToPath(new URL('../',import.meta.url));

export async function startTestWorkspace({ directory = resolve(root,'.local/test-deal-workspace'),
  sdkRoot = process.env.NCA_SDK_ROOT, port = 4176 } = {}) {
  mkdirSync(resolve(root,'.local'),{recursive:true});
  let sdk, fixture, server;
  try {
    if (sdkRoot) sdk = await prepareSdk({sdkRoot,statusSource:'ocsp'});
    const dbPath = resolve(directory,'workspace.sqlite');
    server = createDraftServer({dbPath,testWorkspace:{sdk,fixtureProvider:dealId => fixture?.read(dealId)}});
    fixture = await prepareReadOnlyTestFixture({draftDbPath:dbPath,decisionDbPath:resolve(directory,'offline.sqlite')});
    await new Promise((yes,no) => { server.once('error',no); server.listen(port,'127.0.0.1',yes); });
    let stopping;
    const close = () => stopping ||= (async () => {
      await server.workspaceShutdown();
      await new Promise(resolve => server.close(resolve));
      await server.resourcesClosed; fixture.close(); await sdk?.close();
    })();
    return { server,close,url:`http://127.0.0.1:${server.address().port}/test-workspace/` };
  } catch (error) {
    if (server) { await server.workspaceShutdown(); await new Promise(resolve=>server.close(resolve)); await server.resourcesClosed; }
    fixture?.close(); await sdk?.close(); throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const stand = await startTestWorkspace();
    process.stdout.write(`DalaHold local TEST workspace: ${stand.url}\n`);
    const stop = () => stand.close().then(()=>process.exit(0));
    process.once('SIGINT',stop); process.once('SIGTERM',stop);
  } catch { process.stderr.write('TEST workspace unavailable; check private directory, SDK and local port.\n'); process.exitCode=1; }
}
