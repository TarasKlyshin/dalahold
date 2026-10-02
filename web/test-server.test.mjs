import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createDraftServer } from './server.mjs';
import { startTestWorkspace } from './test-server.mjs';
import { TEST_DEAL_ID } from './test-fixture.mjs';

test('incompatible schema startup closes its opened database before throwing', t => {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-startup-'));
  t.after(() => rmSync(directory, { recursive:true, force:true }));
  const path = join(directory, 'invalid.sqlite');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE drafts(id TEXT PRIMARY KEY) STRICT'); db.close();
  const original = DatabaseSync.prototype.close;
  let closed = 0;
  t.mock.method(DatabaseSync.prototype, 'close', function () { closed++; return original.call(this); });
  assert.throws(() => createDraftServer({ dbPath:path }), /no such column/);
  assert.equal(closed, 1, 'failed initialization must not retain a database handle');
});

test('independent stand persists documents and frozen six-event fixture through restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-stand-'));
  let stand;
  t.after(async () => { await stand?.close(); rmSync(directory, { recursive:true, force:true }); });
  const start = async () => {
    stand = await startTestWorkspace({ directory, sdkRoot:undefined, port:0 });
    return new URL(stand.url).origin;
  };
  let base = await start();
  const statusResponse = await fetch(`${base}/api/test-workspace/status`);
  const cookie = statusResponse.headers.get('set-cookie').split(';')[0];
  const status = await statusResponse.json();
  assert.equal(status.signing.ready, false);
  const bytes = Buffer.from('ANONYMIZED TEST ONLY\nGrain delivery sample.\n');
  const response = await fetch(`${base}/api/test-workspace/deals/${TEST_DEAL_ID}/documents`, {
    method:'POST', headers:{ 'content-type':'application/json', origin:base, cookie, 'x-dalahold-csrf':status.csrfToken },
    body:JSON.stringify({ expectedVersion:1, requestId:'18000000-0000-4000-8000-000000000009', category:'contract', bytesBase64:bytes.toString('base64') }),
  });
  assert.equal(response.status, 201);
  const { document } = await response.json();
  const path = `/api/test-workspace/deals/${TEST_DEAL_ID}/evidence`;
  const evidence = await (await fetch(base+path, { headers:{cookie} })).json();
  assert.equal(evidence.offlineEvidence.status, 'completed_demo');
  assert.equal(evidence.offlineEvidence.decisions.length, 6);
  const frozen = structuredClone(evidence.offlineEvidence);
  await stand.close(); stand = undefined;
  base = await start();
  const next = await fetch(`${base}/api/test-workspace/status`);
  const nextCookie = next.headers.get('set-cookie').split(';')[0];
  const after = await (await fetch(base+path, {headers:{cookie:nextCookie}})).json();
  assert.deepEqual(after.offlineEvidence, frozen);
  assert.deepEqual(after.documents, [document]);
  const download = await fetch(`${base}/api/test-workspace/deals/${TEST_DEAL_ID}/documents/${document.id}`, {headers:{cookie:nextCookie}});
  assert.equal(download.status,200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
  for (const file of ['workspace.sqlite','offline.sqlite']) assert.equal(statSync(join(directory,file)).mode & 0o777, 0o600);
  assert.equal((await (await fetch(base+path, {headers:{cookie}})).json()).error, 'workspace_session_unavailable');
});

test('fixture refuses a missing original draft and failed startup releases resources', async t => {
  const directory = mkdtempSync(join(tmpdir(),'dalahold-fixture-missing-'));
  let stand = await startTestWorkspace({directory,sdkRoot:undefined,port:0});
  t.after(async () => { await stand?.close(); rmSync(directory,{recursive:true,force:true}); });
  await stand.close(); stand=undefined;
  const db = new DatabaseSync(join(directory,'workspace.sqlite'));
  db.exec('PRAGMA foreign_keys=OFF');
  db.prepare('DELETE FROM draft_versions WHERE deal_id=?').run(TEST_DEAL_ID);
  db.prepare('DELETE FROM drafts WHERE id=?').run(TEST_DEAL_ID); db.close();
  await assert.rejects(startTestWorkspace({directory,sdkRoot:undefined,port:0}), /test_fixture_draft_missing/);
  const readback = new DatabaseSync(join(directory,'workspace.sqlite'));
  assert.equal(readback.prepare('SELECT COUNT(*) AS n FROM drafts').get().n,0); readback.close();
});
