import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyParticipantEvidence } from './participant-evidence.mjs';
import { startParticipantRuntime } from './participant-runtime.mjs';
import { parseDemoArgs, prepareParticipantDemo } from './participant-demo.mjs';

const root = process.cwd();
const forbiddenShareable = /accessCode|csrfToken|sessionHash|mappingKey|cookie|set-cookie/;

function mode(path) { return statSync(path).mode & 0o777; }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['web/participant-demo.mjs', ...args], { cwd: root });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function serveCli(args) {
  const child = spawn(process.execPath, ['web/participant-demo.mjs', ...args], { cwd: root });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('serve_ready_timeout')), 15_000);
    const check = () => {
      if (!stdout.includes('Serving:')) return;
      clearTimeout(timer); resolve();
    };
    child.stdout.on('data', check);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', () => { clearTimeout(timer); reject(new Error('serve_exited')); });
  });
  return { child, ready, closed, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

test('fresh one-command demo produces exact accepted/disputed unsigned artifacts and safe report', async t => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'dalahold-participant-demo-'));
  const runDirectory = join(fixtureRoot, 'run');
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const demo = await prepareParticipantDemo({ runDirectory, port: 0, now: Date.now });
  t.after(() => demo.close());

  assert.equal(mode(demo.runDirectory), 0o700);
  assert.equal(mode(demo.runtimeDirectory), 0o700);
  assert.equal(mode(demo.operatorPath), 0o600);
  for (const path of [demo.reportPath, demo.acceptedEvidencePath, demo.disputedEvidencePath]) {
    assert.equal(mode(path) & 0o022, 0);
    assert.equal(mode(path) & 0o111, 0);
  }

  const reportBytes = readFileSync(demo.reportPath);
  const reportText = reportBytes.toString('utf8');
  const report = JSON.parse(reportText);
  assert.equal(report.schema, 'dalahold.local-test-participant-demo-report.v1');
  assert.equal(report.mode, 'unsigned_local_test_only');
  assert.equal(report.checks.twoSeparateAnonymousAccounts, true);
  assert.equal(report.checks.acceptedStateAndVersion, true);
  assert.equal(report.checks.acceptedDocuments, true);
  assert.equal(report.checks.bothRoleReviews, true);
  assert.equal(report.checks.disputedStateAndNoReviews, true);
  assert.equal(report.checks.actionRetry, true);
  assert.equal(report.checks.strictInput, true);
  assert.equal(report.checks.disputedReviewGuard, true);
  assert.equal(report.checks.unsignedReceipts, 0);
  assert.equal(report.checks.invalidCapabilityDenied, true);
  assert.doesNotMatch(reportText, forbiddenShareable);
  assert.deepEqual(report.acceptedDeal.reviewSummary.map(item => [item.authorRole, item.targetRole, item.score]).sort(),
    [['buyer', 'seller', 5], ['seller', 'buyer', 4]].sort());
  assert.deepEqual(report.disputedDeal.reviewSummary, []);
  assert.deepEqual(report.acceptedDeal.documentSummary.map(item => item.termsVersion), [1, 2]);

  const codes = JSON.parse(readFileSync(demo.operatorPath, 'utf8'));
  assert.deepEqual(Object.keys(codes).sort(), ['buyerAccessCode', 'schema', 'sellerAccessCode']);
  assert.match(codes.sellerAccessCode, /^[a-f0-9]{64}$/);
  assert.match(codes.buyerAccessCode, /^[a-f0-9]{64}$/);
  assert.notEqual(codes.sellerAccessCode, codes.buyerAccessCode);
  assert.doesNotMatch(JSON.stringify(codes), /csrfToken|cookie|sessionHash|cms|mappingKey/);

  const acceptedBytes = readFileSync(demo.acceptedEvidencePath);
  const disputedBytes = readFileSync(demo.disputedEvidencePath);
  for (const [bytes, expectedState, expectedVersion] of [[acceptedBytes, 'accepted', 2], [disputedBytes, 'disputed', 1]]) {
    const value = JSON.parse(bytes);
    const checked = verifyParticipantEvidence(value);
    assert.equal(checked.valid, true);
    assert.equal(value.deal.state, expectedState);
    assert.equal(value.deal.version, expectedVersion);
    assert.equal(value.receipts.length, 0);
    assert.doesNotMatch(bytes.toString('utf8'), forbiddenShareable);
    assert.equal(bytes.includes(Buffer.from(codes.sellerAccessCode)), false);
    assert.equal(bytes.includes(Buffer.from(codes.buyerAccessCode)), false);
  }
  assert.equal(report.acceptedDeal.evidence.sha256, hash(acceptedBytes));
  assert.equal(report.disputedDeal.evidence.sha256, hash(disputedBytes));
  assert.equal(JSON.parse(acceptedBytes).documents[0].contentBase64,
    Buffer.from('ANONYMOUS TEST CONTRACT v1\n').toString('base64'));
  assert.equal(JSON.parse(acceptedBytes).documents[1].contentBase64,
    Buffer.from('ANONYMOUS TEST DELIVERY v2\n').toString('base64'));
  assert.equal(JSON.parse(acceptedBytes).documents.length, 2);
  assert.equal(JSON.parse(acceptedBytes).versions.length, 2);
  assert.equal(JSON.parse(acceptedBytes).deal.events.length, 4);
  assert.equal(JSON.parse(disputedBytes).deal.events.length, 3);
  assert.equal(JSON.parse(disputedBytes).documents.length, 0);
  await demo.close();
  assert.equal(existsSync(join(demo.runtimeDirectory, '.participant-runtime-active')), false);
});

test('CLI default preparation prints only safe locations and closes the runtime', async t => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'dalahold-participant-demo-cli-'));
  const runDirectory = join(fixtureRoot, 'run');
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const result = await runCli(['--run-dir', runDirectory, '--port', '0']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /anonymous unsigned TEST demo prepared/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, forbiddenShareable);
  assert.equal(existsSync(join(runDirectory, 'run-report.json')), true);
  assert.equal(existsSync(join(runDirectory, 'accepted-evidence.json')), true);
  assert.equal(existsSync(join(runDirectory, 'disputed-evidence.json')), true);
  assert.equal(mode(join(runDirectory, 'operator-access.json')), 0o600);
  assert.equal(existsSync(join(runDirectory, 'runtime', '.participant-runtime-active')), false);
});

test('serve is explicit, reports the listener and closes on SIGTERM', async t => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'dalahold-participant-demo-serve-'));
  const runDirectory = join(fixtureRoot, 'run');
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const processHandle = serveCli(['--run-dir', runDirectory, '--port', '0', '--serve']);
  t.after(() => { if (processHandle.child.exitCode === null) processHandle.child.kill('SIGTERM'); });
  await processHandle.ready;
  assert.doesNotMatch(`${processHandle.stdout}\n${processHandle.stderr}`, forbiddenShareable);
  assert.match(processHandle.stdout, /Serving: http:\/\/127\.0\.0\.1:\d+\/participants\//);
  processHandle.child.kill('SIGTERM');
  const result = await processHandle.closed;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(join(runDirectory, 'runtime', '.participant-runtime-active')), false);
});

test('existing target is refused without overwrite and occupied port leaves safe residue', async t => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'dalahold-participant-demo-failure-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const existing = join(fixtureRoot, 'existing');
  mkdirSync(existing, { mode: 0o700 });
  const sentinel = join(existing, 'owner-data.txt');
  writeFileSync(sentinel, 'preserve me', { mode: 0o600 });
  await assert.rejects(prepareParticipantDemo({ runDirectory: existing, port: 0 }),
    error => error?.code === 'demo_target_exists');
  assert.equal(readFileSync(sentinel, 'utf8'), 'preserve me');
  assert.equal(mode(existing), 0o700);

  const blocker = await startParticipantRuntime({ directory: join(fixtureRoot, 'blocker'), port: 0 });
  t.after(() => blocker.close());
  const failed = join(fixtureRoot, 'failed');
  await assert.rejects(prepareParticipantDemo({ runDirectory: failed, port: blocker.server.address().port }),
    error => error?.code === 'demo_port_in_use');
  assert.equal(mode(failed), 0o700);
  assert.equal(existsSync(join(failed, 'runtime', 'participants.sqlite')), true);
  assert.equal(existsSync(join(failed, 'run-report.json')), false);
  assert.equal(existsSync(join(failed, 'operator-access.json')), false);
  assert.equal(readFileSync(sentinel, 'utf8'), 'preserve me');
});

test('argument contract rejects unknown/duplicate options and keeps intended default port', () => {
  assert.deepEqual(parseDemoArgs([]), { port: 4177, serve: false });
  assert.deepEqual(parseDemoArgs(['--serve', '--port', '0']), { port: 0, serve: true });
  assert.deepEqual(parseDemoArgs(['--help']), { port: 4177, serve: false, help: true });
  assert.throws(() => parseDemoArgs(['--unknown']), error => error?.code === 'demo_usage');
  assert.throws(() => parseDemoArgs(['--serve', '--serve']), error => error?.code === 'demo_usage');
  assert.throws(() => parseDemoArgs(['--port', '4177', '--port', '4178']), error => error?.code === 'demo_usage');
  assert.throws(() => parseDemoArgs(['--port', '65536']), error => error?.code === 'demo_port_invalid');
});

test('programmatic demo options are exact plain data and validate before disk/network', async t => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'dalahold-participant-demo-options-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  const signedTarget = join(fixtureRoot, 'signed-key');
  await assert.rejects(prepareParticipantDemo({ runDirectory: signedTarget, port: 0, signed: true }),
    error => error?.code === 'demo_options_invalid');
  assert.equal(existsSync(signedTarget), false);

  const serveTarget = join(fixtureRoot, 'serve-key');
  await assert.rejects(prepareParticipantDemo({ runDirectory: serveTarget, port: 0, serve: true }),
    error => error?.code === 'demo_options_invalid');
  assert.equal(existsSync(serveTarget), false);

  const getterTarget = join(fixtureRoot, 'getter-key');
  let getterEvaluated = false;
  const getterOptions = {};
  Object.defineProperty(getterOptions, 'runDirectory', {
    enumerable: true,
    get() { getterEvaluated = true; throw new Error('getter must not run'); },
  });
  await assert.rejects(prepareParticipantDemo(getterOptions), error => error?.code === 'demo_options_invalid');
  assert.equal(getterEvaluated, false);
  assert.equal(existsSync(getterTarget), false);

  const symbolTarget = join(fixtureRoot, 'symbol-key');
  await assert.rejects(prepareParticipantDemo({ runDirectory: symbolTarget, [Symbol('privileged')]: true }),
    error => error?.code === 'demo_options_invalid');
  assert.equal(existsSync(symbolTarget), false);

  const proxyTarget = join(fixtureRoot, 'proxy-key');
  await assert.rejects(prepareParticipantDemo(new Proxy({ runDirectory: proxyTarget }, {})),
    error => error?.code === 'demo_options_invalid');
  assert.equal(existsSync(proxyTarget), false);
  const revokedOptions = Proxy.revocable({ runDirectory: proxyTarget }, {});
  revokedOptions.revoke();
  await assert.rejects(prepareParticipantDemo(revokedOptions.proxy),
    error => error?.code === 'demo_options_invalid');
  assert.equal(existsSync(proxyTarget), false);
});

test('CLI help is safe and does not create a run directory', async () => {
  const result = await runCli(['--help']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Usage: node web\/participant-demo\.mjs/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, forbiddenShareable);
});
