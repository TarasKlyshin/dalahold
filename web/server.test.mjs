import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createDraftServer } from './server.mjs';

const draft = { scenario: 'livestock', quantity: 12, amount: 8_400_000, date: '2026-10-10' };
const markerInput = {
  expectedVersion: 1,
  requestId: '44cb89a2-2c90-4ef6-bf7b-d646b4648e0c',
  category: 'veterinary',
  context: 'Партия 1',
  note: 'Тестовая запись',
  claimedRole: 'seller',
  fileKind: 'pdf',
};

async function start(dbPath) {
  const server = createDraftServer({ dbPath });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('browser API saves exact unsigned draft through server restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-web-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'drafts.sqlite');
  let app = await start(dbPath);
  const page = await fetch(app.base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Кликабельный UX-прототип/);
  const created = await fetch(`${app.base}/api/deals`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: app.base },
    body: JSON.stringify(draft),
  });
  assert.equal(created.status, 201);
  const { deal } = await created.json();
  assert.match(deal.id, /^[0-9a-f-]{36}$/);
  assert.equal(deal.scenario, draft.scenario);
  assert.equal(deal.amount, draft.amount);
  assert.equal(deal.version, 1);
  assert.match(deal.termsFingerprint, /^[0-9a-f]{64}$/);
  await app.close();

  app = await start(dbPath);
  t.after(() => app.close());
  const list = await fetch(`${app.base}/api/deals`);
  assert.deepEqual((await list.json()).deals, [deal]);
  const read = await fetch(`${app.base}/api/deals/${deal.id}`);
  assert.deepEqual((await read.json()).deal, deal);
});

test('bad, cross-origin and oversized writes do not create drafts', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-web-'));
  const app = await start(join(directory, 'drafts.sqlite'));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const post = (body, headers = { 'Content-Type': 'application/json', Origin: app.base }) =>
    fetch(`${app.base}/api/deals`, { method: 'POST', headers, body });
  assert.equal((await post(JSON.stringify({ ...draft, amount: 0 }))).status, 400);
  assert.equal((await post(JSON.stringify({ ...draft, date: '2026-02-30' }))).status, 400);
  assert.equal((await post(JSON.stringify({ ...draft, recipient: 'changed' }))).status, 400);
  assert.equal((await post('{')).status, 400);
  assert.equal((await post(JSON.stringify(draft), {
    'Content-Type': 'application/json', Origin: 'https://attacker.example',
  })).status, 403);
  assert.equal((await post(JSON.stringify(draft), {
    'Content-Type': 'text/plain', Origin: app.base,
  })).status, 415);
  assert.equal((await post(JSON.stringify(draft) + ' '.repeat(4096))).status, 413);
  const list = await fetch(`${app.base}/api/deals`);
  assert.deepEqual((await list.json()).deals, []);
});

test('revising unsigned terms preserves each version across restart and rejects stale writes', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-versions-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'drafts.sqlite');
  let app = await start(dbPath);
  const write = (path, method, body) => fetch(`${app.base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', Origin: app.base },
    body: JSON.stringify(body),
  });
  const created = await write('/api/deals', 'POST', draft);
  const first = (await created.json()).deal;
  const path = `/api/deals/${first.id}`;
  const changed = { ...draft, quantity: 13, amount: 8_800_000 };
  const revised = await write(path, 'PUT', { ...changed, expectedVersion: 1 });
  assert.equal(revised.status, 200);
  const second = (await revised.json()).deal;
  assert.equal(second.version, 2);
  assert.equal(second.amount, changed.amount);
  assert.notEqual(second.termsFingerprint, first.termsFingerprint);
  const stale = await write(path, 'PUT', { ...draft, expectedVersion: 1 });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).current.termsFingerprint, second.termsFingerprint);
  assert.equal((await write(path, 'PUT', { ...changed, expectedVersion: 2 })).status, 200);
  assert.equal((await write(path, 'PUT', { ...changed, expectedVersion: 0 })).status, 400);
  assert.equal((await write(path, 'PUT', { ...changed, expectedVersion: 2, approved: true })).status, 400);
  assert.equal((await write(path, 'PUT', { ...changed, expectedVersion: 2, amount: 0 })).status, 400);
  const history = await fetch(`${app.base}${path}/versions`);
  assert.equal(history.status, 200);
  const versions = (await history.json()).versions;
  assert.deepEqual(versions.map((item) => [item.version, item.amount]), [[2, changed.amount], [1, draft.amount]]);
  assert.deepEqual(versions.map((item) => item.termsFingerprint), [second.termsFingerprint, first.termsFingerprint]);
  await app.close();

  app = await start(dbPath);
  t.after(() => app.close());
  assert.deepEqual((await (await fetch(`${app.base}${path}`)).json()).deal, second);
  const afterRestart = (await (await fetch(`${app.base}${path}/versions`)).json()).versions;
  assert.deepEqual(afterRestart, versions);
});

test('existing unsigned drafts migrate to version one without losing terms', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-legacy-'));
  const dbPath = join(directory, 'drafts.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE drafts (
    id TEXT PRIMARY KEY, scenario TEXT NOT NULL, quantity INTEGER NOT NULL,
    amount INTEGER NOT NULL, date TEXT NOT NULL, created_at INTEGER NOT NULL
  ) STRICT`);
  const id = 'fbe1e870-687c-4cf6-841c-37937c7e6716';
  db.prepare('INSERT INTO drafts VALUES (?, ?, ?, ?, ?, ?)').run(
    id, draft.scenario, draft.quantity, draft.amount, draft.date, 1_000,
  );
  db.close();
  const app = await start(dbPath);
  t.after(() => app.close());
  const deal = (await (await fetch(`${app.base}/api/deals/${id}`)).json()).deal;
  assert.equal(deal.version, 1);
  assert.equal(deal.amount, draft.amount);
  const versions = (await (await fetch(`${app.base}/api/deals/${id}/versions`)).json()).versions;
  assert.deepEqual(versions.map((item) => item.version), [1]);
});

test('metadata-only document markers bind to a draft version and survive restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-markers-'));
  const dbPath = join(directory, 'drafts.sqlite');
  let app = await start(dbPath);
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const write = (path, method, body) => fetch(`${app.base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', Origin: app.base }, body: JSON.stringify(body),
  });
  const deal = (await (await write('/api/deals', 'POST', draft)).json()).deal;
  const path = `/api/deals/${deal.id}/markers`;
  const created = await write(path, 'POST', markerInput);
  assert.equal(created.status, 201);
  const first = (await created.json()).marker;
  assert.equal(first.dealId, deal.id);
  assert.equal(first.termsVersion, 1);
  assert.equal(first.termsFingerprint, deal.termsFingerprint);
  assert.equal(first.category, 'veterinary');
  assert.equal(first.claimedRole, 'seller');
  assert.equal(first.fileKind, 'pdf');
  assert.equal(Object.hasOwn(first, 'name'), false);
  assert.equal(Object.hasOwn(first, 'contents'), false);
  assert.match(first.id, /^[0-9a-f-]{36}$/);
  assert.equal((await write(path, 'POST', markerInput)).status, 200);
  assert.deepEqual((await (await fetch(`${app.base}${path}`)).json()).markers, [first]);
  const next = (await (await write(`/api/deals/${deal.id}`, 'PUT', {
    ...draft, scenario: 'grain', quantity: 13, expectedVersion: 1,
  })).json()).deal;
  assert.equal(next.version, 2);
  assert.equal((await write(path, 'POST', markerInput)).status, 200);
  const stale = await write(path, 'POST', { ...markerInput,
    requestId: '1682f58e-9d11-4b60-a4ba-8ba21b07c443',
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).current.version, 2);
  const secondInput = { ...markerInput, expectedVersion: 2,
    requestId: 'b1657db0-caa9-4543-87ca-7a4202ca9702', category: 'quality',
  };
  assert.equal((await write(path, 'POST', secondInput)).status, 201);
  const markers = (await (await fetch(`${app.base}${path}`)).json()).markers;
  assert.deepEqual(markers.map((item) => item.termsVersion), [2, 1]);
  assert.deepEqual(markers.map((item) => item.termsScenario), ['grain', 'livestock']);
  assert.notEqual(markers[0].termsFingerprint, markers[1].termsFingerprint);
  await app.close();
  app = await start(dbPath);
  assert.deepEqual((await (await fetch(`${app.base}${path}`)).json()).markers, markers);
});

test('document marker API rejects spoofed or stale metadata and never accepts file contents', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-marker-bad-'));
  const app = await start(join(directory, 'drafts.sqlite'));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const write = (path, body, headers = { 'Content-Type': 'application/json', Origin: app.base }) =>
    fetch(`${app.base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const deal = (await (await write('/api/deals', draft)).json()).deal;
  const path = `/api/deals/${deal.id}/markers`;
  assert.equal((await write(path, { ...markerInput, category: 'quality' })).status, 400);
  assert.equal((await write(path, { ...markerInput, filename: 'secret.pdf' })).status, 400);
  assert.equal((await write(path, { ...markerInput, contents: 'private bytes' })).status, 400);
  assert.equal((await write(path, { ...markerInput, claimedRole: 'authority' })).status, 400);
  assert.equal((await write(path, markerInput, {
    'Content-Type': 'application/json', Origin: 'https://attacker.example',
  })).status, 403);
  assert.equal((await write(path, { ...markerInput, note: 'x'.repeat(5000) })).status, 413);
  assert.equal((await write('/api/deals/00000000-0000-4000-8000-000000000000/markers', markerInput)).status, 404);
  assert.equal((await write(path, markerInput)).status, 201);
  assert.equal((await write(path, { ...markerInput, note: 'Changed' })).status, 409);
  assert.equal((await (await fetch(`${app.base}${path}`)).json()).markers.length, 1);
});
