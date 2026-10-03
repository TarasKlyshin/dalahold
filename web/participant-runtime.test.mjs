import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import fs, { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyParticipantEvidence } from './participant-evidence.mjs';
import {
  restoreParticipantRuntime, snapshotParticipantRuntime, startParticipantRuntime,
} from './participant-runtime.mjs';

const API = '/api/participants/v1';
const TERMS = { scenario: 'grain', quantity: 20, amount: 200_000, date: '2026-10-03' };
const sha = value => createHash('sha256').update(value).digest('hex');

function modelSdk() {
  return {
    statusSource: 'test_ocsp',
    async inspect() {
      return { ready: true, statusSource: 'test_ocsp', validUntil: Date.now() + 600_000,
        chain: ['-----BEGIN CERTIFICATE-----\nMODEL ROOT\n-----END CERTIFICATE-----',
          '-----BEGIN CERTIFICATE-----\nMODEL CA\n-----END CERTIFICATE-----'] };
    },
    async verifyIdentity(bytes, cms, key) {
      const value = JSON.parse(cms.toString('utf8'));
      if (value.hash !== sha(bytes)) return { verified: false };
      return { verified: true, statusSource: 'test_ocsp', validUntil: Date.now() + 300_000,
        certificateDigest: sha(`MODEL ${value.person}`),
        identity: { schema: 'nca_test_subject_v1',
          personId: `person:${createHmac('sha256', key).update(value.person).digest('hex')}`, organizationId: null } };
    },
  };
}

async function runtimeFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dalahold-participant-runtime-'));
  const directory = join(root, 'runtime');
  let stand = await startParticipantRuntime({ directory, port: 0 });
  let origin = new URL(stand.url).origin;
  t.after(async () => { await stand?.close(); rmSync(root, { recursive: true, force: true }); });
  const client = () => {
    let cookie = '', csrf = '';
    return {
      async request(path, body, options = {}) {
        const method = options.method || (body === undefined ? 'GET' : 'POST');
        const headers = { ...(cookie ? { Cookie: cookie } : {}),
          ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json', 'X-DalaHold-CSRF': csrf } : {}),
          ...options.headers };
        const response = await fetch(origin + path, { method, headers,
          ...(body === undefined ? {} : { body: options.raw ? body : JSON.stringify(body) }), redirect: 'manual' });
        const setCookie = response.headers.get('set-cookie');
        if (setCookie) cookie = setCookie.split(';')[0];
        const bytes = Buffer.from(await response.arrayBuffer());
        let data = null;
        try { data = JSON.parse(bytes.toString('utf8')); } catch { /* empty/attachment */ }
        if (data?.csrfToken) csrf = data.csrfToken;
        return { status: response.status, data, bytes, headers: response.headers };
      },
      async register() {
        assert.equal((await this.request(`${API}/session`)).status, 200);
        const result = await this.request(`${API}/participants`, {});
        assert.equal(result.status, 201);
        return result.data;
      },
      async login(accessCode) {
        assert.equal((await this.request(`${API}/session`)).status, 200);
        return this.request(`${API}/session/login`, { accessCode });
      },
    };
  };
  async function restart() {
    await stand.close();
    stand = await startParticipantRuntime({ directory, port: 0 });
    origin = new URL(stand.url).origin;
  }
  return { root, directory, client, restart, close: () => stand.close(),
    get stand() { return stand; } };
}

async function detail(client, dealId) {
  const result = await client.request(`${API}/deals/${dealId}`);
  assert.equal(result.status, 200);
  return result.data.deal;
}

async function action(client, deal, actionName) {
  return client.request(`${API}/deals/${deal.id}/events`, {
    requestId: randomUUID(), action: actionName, expectedVersion: deal.version,
    expectedStateRevision: deal.stateRevision, snapshotHash: deal.snapshotHash,
  });
}

async function acceptedDeal(fixture) {
  const seller = fixture.client(), buyer = fixture.client();
  const sellerAccount = await seller.register(), buyerAccount = await buyer.register();
  const created = await seller.request(`${API}/deals`, { requestId: randomUUID(), creatorRole: 'seller', ...TERMS });
  assert.equal(created.status, 201);
  const dealId = created.data.deal.id;
  const invitation = await seller.request(`${API}/deals/${dealId}/invitations`, {
    expectedVersion: 1, participantId: buyerAccount.participant.id,
  });
  assert.equal(invitation.status, 201);
  assert.equal((await buyer.request(`${API}/invitations/claims`, { code: invitation.data.code })).status, 200);
  const bytes = Buffer.from('ANONYMIZED TEST delivery record\n');
  const document = await seller.request(`${API}/deals/${dealId}/documents`, {
    requestId: randomUUID(), expectedVersion: 1, category: 'delivery', contentBase64: bytes.toString('base64'),
  });
  assert.equal(document.status, 201);
  let current = await detail(seller, dealId);
  for (const [actor, name] of [[seller, 'offer'], [buyer, 'agree'], [seller, 'handover'], [buyer, 'accept']]) {
    const result = await action(actor, current, name);
    assert.equal(result.status, 201);
    current = result.data.deal;
  }
  assert.equal(current.state, 'accepted');
  const reviewInput = (score) => ({ requestId: randomUUID(), expectedVersion: current.version,
    expectedStateRevision: current.stateRevision, snapshotHash: current.snapshotHash, score });
  const buyerReview = await buyer.request(`${API}/deals/${dealId}/reviews`, reviewInput(5));
  const sellerReview = await seller.request(`${API}/deals/${dealId}/reviews`, reviewInput(4));
  assert.equal(buyerReview.status, 201); assert.equal(sellerReview.status, 201);
  const exported = await buyer.request(`${API}/deals/${dealId}/evidence`);
  assert.equal(exported.status, 200);
  assert.equal(verifyParticipantEvidence(exported.data).valid, true);
  assert.doesNotMatch(JSON.stringify(exported.data), /accessCode|csrfToken|sessionHash|cms|mappingKey/);
  return { seller, buyer, sellerAccount, buyerAccount, dealId, bytes,
    document: document.data.document, evidence: exported.data,
    reviews: [buyerReview.data.review, sellerReview.data.review] };
}

test('fresh accounts, deal, document, reviews and export survive real listener restart and owner-only restore', async t => {
  const fixture = await runtimeFixture(t);
  const state = await acceptedDeal(fixture);
  const sourceEvidence = structuredClone(state.evidence);
  await fixture.close();
  assert.equal(existsSync(join(fixture.directory, '.participant-runtime-active')), false);

  // Restart the real HTTP listener against the same fresh directory.
  await fixture.restart();
  const stale = await state.seller.request(`${API}/deals/${state.dealId}`);
  assert.equal(stale.status, 401, 'sessions are memory-only across a real restart');
  assert.equal((await state.seller.login(state.sellerAccount.accessCode)).status, 200);
  assert.equal((await state.buyer.login(state.buyerAccount.accessCode)).status, 200);
  const afterRestart = await state.buyer.request(`${API}/deals/${state.dealId}/evidence`);
  assert.equal(afterRestart.status, 200);
  const stableEvidence = value => {
    const { exportedAt, packageSha256, ...stable } = value;
    return stable;
  };
  assert.deepEqual(stableEvidence(afterRestart.data), stableEvidence(sourceEvidence));
  const downloaded = await state.buyer.request(`${API}/deals/${state.dealId}/documents/${state.document.id}`);
  assert.deepEqual(downloaded.bytes, state.bytes);
  assert.deepEqual((await state.buyer.request(`${API}/deals/${state.dealId}/reviews`)).data.reviews, state.reviews);

  await fixture.close();
  const backupDirectory = join(fixture.root, 'owner-backup');
  const backup = snapshotParticipantRuntime({ directory: fixture.directory, backupDirectory, capturedAt: 1_000 });
  assert.equal(backup.kind, 'dalahold.local-test-participants.v1');
  assert.equal(statSync(backupDirectory).mode & 0o777, 0o700);
  assert.equal(statSync(join(backupDirectory, 'participants.sqlite')).mode & 0o777, 0o600);
  const restoredDirectory = join(fixture.root, 'restored-runtime');
  const restored = restoreParticipantRuntime({ backupDirectory, directory: restoredDirectory });
  assert.equal(restored.kind, backup.kind);

  // A fresh listener over the restored owner-only snapshot sees the same
  // account codes, deal, exact bytes, reviews and evidence package.
  const restoredStand = await startParticipantRuntime({ directory: restoredDirectory, port: 0 });
  t.after(() => restoredStand.close());
  const restoredOrigin = new URL(restoredStand.url).origin;
  const restoredClient = () => {
    let cookie = '', csrf = '';
    return { async call(path, body) {
      const response = await fetch(restoredOrigin + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : {
          Origin: restoredOrigin, 'Content-Type': 'application/json', 'X-DalaHold-CSRF': csrf }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      const bytes = Buffer.from(await response.arrayBuffer()); let data = null;
      try { data = JSON.parse(bytes.toString('utf8')); } catch { /* attachment */ }
      if (data?.csrfToken) csrf = data.csrfToken;
      return { status: response.status, data, bytes };
    } };
  };
  const restoredBuyer = restoredClient();
  assert.equal((await restoredBuyer.call(`${API}/session`)).status, 200);
  assert.equal((await restoredBuyer.call(`${API}/session/login`, { accessCode: state.buyerAccount.accessCode })).status, 200);
  const restoredEvidence = await restoredBuyer.call(`${API}/deals/${state.dealId}/evidence`);
  assert.deepEqual(stableEvidence(restoredEvidence.data), stableEvidence(sourceEvidence));
  const restoredFile = await restoredBuyer.call(`${API}/deals/${state.dealId}/documents/${state.document.id}`);
  assert.deepEqual(restoredFile.bytes, state.bytes);
  assert.deepEqual((await restoredBuyer.call(`${API}/deals/${state.dealId}/reviews`)).data.reviews, state.reviews);
  await restoredStand.close();
});

test('signed mode is explicit, never downgraded, and remains incompatible with unsigned storage', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dalahold-runtime-mode-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const missingSdkDirectory = join(root, 'missing-sdk');
  await assert.rejects(startParticipantRuntime({ mode: 'signed', directory: missingSdkDirectory, port: 0 }),
    error => error?.code === 'runtime_signed_sdk_required');
  assert.equal(existsSync(missingSdkDirectory), false);

  const signedDirectory = join(root, 'signed');
  const signed = await startParticipantRuntime({ mode: 'signed', directory: signedDirectory, port: 0, sdk: modelSdk() });
  assert.equal(signed.mode, 'signed');
  await signed.close();
  const signedDb = new DatabaseSync(join(signedDirectory, 'participants.sqlite'), { readOnly: true });
  assert.equal(signedDb.prepare('SELECT kind FROM participant_store_meta WHERE singleton=1').get().kind,
    'dalahold.local-test-participants.v1.personal-test-signed');
  signedDb.close();
  await assert.rejects(startParticipantRuntime({ mode: 'unsigned', directory: signedDirectory, port: 0 }),
    error => error?.code === 'incompatible_store');
  await assert.rejects(Promise.resolve().then(() => snapshotParticipantRuntime({ directory: signedDirectory,
    backupDirectory: join(root, 'signed-backup'), mode: 'signed' })),
    error => error?.code === 'runtime_signed_backup_requires_key_material');
  await assert.rejects(Promise.resolve().then(() => restoreParticipantRuntime({ backupDirectory: signedDirectory,
    directory: join(root, 'signed-restore'), mode: 'signed' })),
    error => error?.code === 'runtime_signed_restore_requires_key_material');
  await assert.rejects(startParticipantRuntime({ mode: 'unsigned', directory: join(root, 'unsigned-with-sdk'), port: 0, sdk: modelSdk() }),
    error => error?.code === 'runtime_unsigned_sdk_forbidden');
});

test('snapshot and restore refuse wrong kind, symlinks, insecure modes and overwrite targets', async t => {
  const fixture = await runtimeFixture(t);
  await fixture.close();
  const backupDirectory = join(fixture.root, 'backup');
  snapshotParticipantRuntime({ directory: fixture.directory, backupDirectory, capturedAt: 2_000 });

  const active = await startParticipantRuntime({ directory: fixture.directory, port: 0 });
  await assert.rejects(startParticipantRuntime({ directory: fixture.directory, port: 0 }),
    error => error?.code === 'runtime_active');
  await assert.rejects(Promise.resolve().then(() => snapshotParticipantRuntime({ directory: fixture.directory,
    backupDirectory: join(fixture.root, 'active-backup') })), error => error?.code === 'runtime_active');
  await active.close();

  writeFileSync(join(fixture.directory, 'participants.sqlite-journal'), 'active-journal', { mode: 0o600 });
  await assert.rejects(Promise.resolve().then(() => snapshotParticipantRuntime({ directory: fixture.directory,
    backupDirectory: join(fixture.root, 'sidecar-backup') })), error => error?.code === 'runtime_sidecar_present');
  rmSync(join(fixture.directory, 'participants.sqlite-journal'));

  const symlinkSource = join(fixture.root, 'source-alias');
  symlinkSync(fixture.directory, symlinkSource, 'dir');
  await assert.rejects(Promise.resolve().then(() => snapshotParticipantRuntime({ directory: symlinkSource,
    backupDirectory: join(fixture.root, 'symlink-backup') })), error => error?.code === 'runtime_directory_symlink');
  const symlinkBackup = join(fixture.root, 'backup-alias');
  symlinkSync(backupDirectory, symlinkBackup, 'dir');
  await assert.rejects(Promise.resolve().then(() => restoreParticipantRuntime({ backupDirectory: symlinkBackup,
    directory: join(fixture.root, 'symlink-restore') })), error => error?.code === 'runtime_directory_symlink');

  chmodSync(fixture.directory, 0o750);
  await assert.rejects(Promise.resolve().then(() => snapshotParticipantRuntime({ directory: fixture.directory,
    backupDirectory: join(fixture.root, 'insecure-backup') })), error => error?.code === 'runtime_directory_private_required');
  chmodSync(fixture.directory, 0o700);

  const existing = join(fixture.root, 'existing-target');
  mkdirSync(existing, { mode: 0o700 });
  const before = lstatSync(existing);
  await assert.rejects(Promise.resolve().then(() => restoreParticipantRuntime({ backupDirectory,
    directory: existing })), error => error?.code === 'runtime_destination_exists');
  assert.equal(lstatSync(existing).ino, before.ino);
  const manifestBefore = readFileSync(join(backupDirectory, 'manifest.json'));
  await assert.rejects(Promise.resolve().then(() => snapshotParticipantRuntime({ directory: fixture.directory,
    backupDirectory })), error => error?.code === 'runtime_backup_exists');
  assert.deepEqual(readFileSync(join(backupDirectory, 'manifest.json')), manifestBefore);

  // A signed-kind database cannot be treated as an unsigned source, even for
  // a stopped snapshot operation.
  const signedDirectory = join(fixture.root, 'wrong-kind');
  const signed = await startParticipantRuntime({ mode: 'signed', directory: signedDirectory, port: 0, sdk: modelSdk() });
  await signed.close();
  await assert.rejects(Promise.resolve().then(() => snapshotParticipantRuntime({ directory: signedDirectory,
    backupDirectory: join(fixture.root, 'wrong-kind-backup') })), error => error?.code === 'runtime_kind_mismatch');
});

test('snapshot cleanup never removes a replacement directory or unrelated residue', async t => {
  const fixture = await runtimeFixture(t);
  await fixture.close();
  const backupDirectory = join(fixture.root, 'replacement-backup');
  const movedDirectory = join(fixture.root, 'replacement-backup-moved');
  const sentinel = join(backupDirectory, 'owner-sentinel');
  await assert.rejects(Promise.resolve().then(() => snapshotParticipantRuntime({
    directory: fixture.directory, backupDirectory,
    testOnlyHooks: { afterDatabaseWrite({ directory }) {
      renameSync(directory, movedDirectory);
      mkdirSync(directory, { mode: 0o700 });
      writeFileSync(sentinel, 'preserve replacement', { flag: 'wx', mode: 0o600 });
    } },
  })), error => error?.code === 'runtime_backup_manifest_invalid');
  assert.equal(lstatSync(backupDirectory).isDirectory(), true);
  assert.equal(readFileSync(sentinel, 'utf8'), 'preserve replacement');
  assert.equal(lstatSync(movedDirectory).isDirectory(), true);
  assert.equal(existsSync(join(movedDirectory, 'participants.sqlite')), true);
});

test('snapshot lease excludes a concurrent launcher start during inspection', async t => {
  const fixture = await runtimeFixture(t);
  await fixture.close();
  let attemptedStart;
  const backupDirectory = join(fixture.root, 'lease-backup');
  snapshotParticipantRuntime({ directory: fixture.directory, backupDirectory,
    testOnlyHooks: { afterLease() {
      attemptedStart = startParticipantRuntime({ directory: fixture.directory, port: 0 });
    } } });
  await assert.rejects(attemptedStart, error => error?.code === 'runtime_active');
  assert.equal(existsSync(join(fixture.directory, '.participant-runtime-active')), false);
});

test('restore captures one source byte image and leaves a replacement target untouched', async t => {
  const fixture = await runtimeFixture(t);
  await fixture.close();
  const backupDirectory = join(fixture.root, 'captured-backup');
  snapshotParticipantRuntime({ directory: fixture.directory, backupDirectory });
  const originalBytes = readFileSync(join(backupDirectory, 'participants.sqlite'));

  const replacementDirectory = join(fixture.root, 'replacement-source');
  const replacement = await startParticipantRuntime({ directory: replacementDirectory, port: 0 });
  replacement.store.register();
  await replacement.close();
  const replacementBytes = readFileSync(join(replacementDirectory, 'participants.sqlite'));
  assert.notDeepEqual(replacementBytes, originalBytes);

  const restoredDirectory = join(fixture.root, 'captured-restore');
  const movedDirectory = join(fixture.root, 'captured-restore-moved');
  const sentinel = join(restoredDirectory, 'owner-sentinel');
  const restored = restoreParticipantRuntime({ backupDirectory, directory: restoredDirectory,
    testOnlyHooks: { afterSourceCapture({ path }) {
      writeFileSync(path, replacementBytes, { flag: 'w' });
    } } });
  assert.equal(restored.databaseSha256, sha(originalBytes));
  assert.deepEqual(readFileSync(join(restoredDirectory, 'participants.sqlite')), originalBytes);

  // A replacement target during post-copy validation must not be recursively
  // deleted by the catch path.
  const backupForRace = join(fixture.root, 'target-race-backup');
  snapshotParticipantRuntime({ directory: fixture.directory, backupDirectory: backupForRace });
  const targetRace = join(fixture.root, 'target-race');
  const targetMoved = join(fixture.root, 'target-race-moved');
  const targetSentinel = join(targetRace, 'owner-sentinel');
  await assert.rejects(Promise.resolve().then(() => restoreParticipantRuntime({
    backupDirectory: backupForRace, directory: targetRace,
    testOnlyHooks: { afterDatabaseWrite({ directory }) {
      renameSync(directory, targetMoved);
      mkdirSync(directory, { mode: 0o700 });
      writeFileSync(join(directory, 'owner-sentinel'), 'preserve target replacement', { flag: 'wx', mode: 0o600 });
    } },
  })), error => error?.code === 'runtime_file_required');
  assert.equal(readFileSync(targetSentinel, 'utf8'), 'preserve target replacement');
  assert.equal(lstatSync(targetMoved).isDirectory(), true);
  assert.equal(existsSync(join(targetMoved, 'participants.sqlite')), true);
});

test('failed cleanup never unlinks a replacement owner file after identity check', async t => {
  const fixture = await runtimeFixture(t);
  await fixture.close();
  const backupDirectory = join(fixture.root, 'cleanup-race-backup');
  let databasePath;
  const movedDatabasePath = join(fixture.root, 'cleanup-race-moved.sqlite');
  const replacementPath = join(fixture.root, 'cleanup-race-owner.sqlite');
  const originalLstatSync = fs.lstatSync;
  let originalIdentity;
  let raceObserved = false;

  try {
    await assert.rejects(Promise.resolve().then(() => snapshotParticipantRuntime({
      directory: fixture.directory,
      backupDirectory,
      testOnlyHooks: {
        afterDatabaseWrite({ path }) {
          databasePath = path;
          originalIdentity = originalLstatSync(path);
          renameSync(path, movedDatabasePath);
          writeFileSync(replacementPath, 'owner replacement', { mode: 0o600 });
          renameSync(replacementPath, path);
          fs.lstatSync = (candidate, ...args) => {
            const result = originalLstatSync(candidate, ...args);
            if (candidate === path && !raceObserved) {
              raceObserved = true;
              return originalIdentity;
            }
            return result;
          };
          syncBuiltinESMExports();
          throw new Error('injected_cleanup_failure');
        },
      },
    })), error => error?.message === 'injected_cleanup_failure');
  } finally {
    fs.lstatSync = originalLstatSync;
    syncBuiltinESMExports();
  }

  // The operation-created database and the replacement owner file are both
  // recoverable evidence. Any cleanup pathname unlink would destroy the latter.
  assert.equal(existsSync(movedDatabasePath), true);
  assert.equal(readFileSync(databasePath, 'utf8'), 'owner replacement');
  assert.equal(raceObserved, false, 'cleanup must not perform a lstat before pathname deletion');
});

test('canonical overlap checks reject an ancestor symlink alias before restore writes', async t => {
  const fixture = await runtimeFixture(t);
  await fixture.close();
  const backupDirectory = join(fixture.root, 'alias-backup');
  snapshotParticipantRuntime({ directory: fixture.directory, backupDirectory });
  const alias = join(fixture.root, 'alias');
  symlinkSync(fixture.root, alias, 'dir');
  const before = readdirSync(backupDirectory).sort();
  await assert.rejects(Promise.resolve().then(() => restoreParticipantRuntime({ backupDirectory,
    directory: join(alias, 'alias-backup', 'nested') })), error => error?.code === 'runtime_path_overlap');
  assert.deepEqual(readdirSync(backupDirectory).sort(), before);
  assert.equal(existsSync(join(backupDirectory, 'nested')), false);
});
