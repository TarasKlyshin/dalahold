import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createProbeServer } from './server.mjs';

// Injected verifier for HTTP/transaction tests only, never an NCA proof.
const digest = 'a'.repeat(64);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fakeSdk = {
  inspect: async () => ({ ready: true, statusSource: 'test_crl_fixture',
    validUntil: Date.now() + 3_600_000, chain: ['-----BEGIN CERTIFICATE-----A', '-----BEGIN CERTIFICATE-----B'] }),
  verify: async (bytes, cms) => ({ verified: cms.equals(bytes),
    certificateDigest: digest, validUntil: Date.now() + 3_600_000, statusSource: 'test_crl_fixture' }),
};

export async function startProbe(dbPath, options = {}) {
  const server = createProbeServer({ dbPath, sdk: fakeSdk, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base);
  const cookie = page.headers.get('set-cookie').split(';')[0];
  return {
    base, cookie,
    post: (path, value, overrides = {}) => fetch(`${base}${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie, ...overrides },
      body: JSON.stringify(value) }),
    get: (path) => fetch(`${base}${path}`, { headers: { Cookie: cookie } }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-nca-http-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'probe.sqlite');
}

async function challenge(app) {
  const response = await app.post('/api/challenges', {});
  assert.equal(response.status, 201);
  return (await response.json()).challenge;
}

test('exact session-bound challenge commits once, survives restart and returns a historical receipt', async (t) => {
  const dbPath = temporary(t);
  let app = await startProbe(dbPath);
  const created = await challenge(app);
  assert.equal(Buffer.from(created.bytesBase64, 'base64').toString('utf8'), created.text);
  assert.equal(hash(Buffer.from(created.text)), created.hash);
  const input = { challengeId: created.id, cms: created.bytesBase64 };
  const responses = await Promise.all([app.post('/api/verify', input), app.post('/api/verify', input)]);
  const results = await Promise.all(responses.map((response) => response.json()));
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal(results.filter((item) => !item.replay).length, 1);
  assert.deepEqual(results[0].receipt, results[1].receipt);
  assert.equal(results[0].receipt.challengeHash, created.hash);
  const cookie = app.cookie;
  await app.close();
  app = await startProbe(dbPath, { now: () => created.expiresAt + 1,
    sdk: { ...fakeSdk, verify: () => { throw new Error('must not reverify history'); } } });
  t.after(() => app.close());
  const historical = await fetch(`${app.base}/api/verify`, { method: 'POST',
    headers: { Origin: app.base, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const replay = await historical.json();
  assert.equal(historical.status, 200);
  assert.equal(replay.replay, true);
  assert.deepEqual(replay.receipt, results[0].receipt);
  const altered = await fetch(`${app.base}/api/verify`, { method: 'POST',
    headers: { Origin: app.base, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, cms: Buffer.from('different').toString('base64') }) });
  assert.equal(altered.status, 409);
});

test('altered amount/recipient bytes, browser fields, other session and malformed requests never commit', async (t) => {
  const app = await startProbe(temporary(t));
  t.after(() => app.close());
  const created = await challenge(app);
  for (const text of [created.text.replace('8400000', '8400001'), created.text.replace('test-buyer', 'attacker')]) {
    assert.equal((await app.post('/api/verify', { challengeId: created.id,
      cms: Buffer.from(text).toString('base64') })).status, 422);
  }
  assert.equal((await app.post('/api/challenges', { amount: 1 })).status, 400);
  assert.equal((await app.post('/api/verify', { challengeId: created.id, cms: created.bytesBase64, role: 'seller' })).status, 400);
  for (const cms of ['', 'not-base64', 'AB==', 'A'.repeat(131_076)]) {
    assert.equal((await app.post('/api/verify', { challengeId: created.id, cms })).status, 400);
  }
  const other = await startProbe(temporary(t));
  t.after(() => other.close());
  assert.equal((await app.post('/api/verify', { challengeId: created.id, cms: created.bytesBase64 },
    { Cookie: other.cookie })).status, 404);
  assert.equal((await app.post('/api/challenges', {}, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await app.post('/api/challenges', {}, { Origin: '' })).status, 403);
  assert.equal((await app.post('/api/challenges', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await app.post('/api/challenges', {}, { 'Sec-Fetch-Site': 'same-site' })).status, 403);
  assert.equal((await app.post('/api/verify', { challengeId: created.id, cms: 'A'.repeat(140_000) })).status, 413);
  assert.equal((await app.post('/api/verify', { challengeId: created.id, cms: created.bytesBase64 })).status, 200);
});

test('pending challenge expiry, status unavailability and SDK error reject before consumption', async (t) => {
  let clock = Date.now();
  let outcome = { verified: false, error: 'status_unavailable' };
  const app = await startProbe(temporary(t), { now: () => clock,
    sdk: { ...fakeSdk, verify: async () => outcome } });
  t.after(() => app.close());
  const created = await challenge(app);
  const input = { challengeId: created.id, cms: created.bytesBase64 };
  assert.equal((await app.post('/api/verify', input)).status, 503);
  outcome = { verified: false, error: 'unknown' };
  assert.equal((await app.post('/api/verify', input)).status, 422);
  outcome = { verified: true, certificateDigest: digest, validUntil: clock };
  assert.equal((await app.post('/api/verify', input)).status, 503);
  clock = created.expiresAt;
  assert.equal((await app.post('/api/verify', input)).status, 410);
  const unavailable = await startProbe(temporary(t), { sdk: { inspect: async () => ({ ready: false }) } });
  t.after(() => unavailable.close());
  assert.equal((await unavailable.post('/api/challenges', {})).status, 503);
  assert.equal((await unavailable.get('/api/status')).status, 503);
});

test('expiry or changed bytes while verification awaits are checked again at commit time', async (t) => {
  for (const mutation of ['expiry', 'bytes', 'status']) {
    const dbPath = temporary(t);
    let clock = Date.now();
    let mutate;
    const app = await startProbe(dbPath, { now: () => clock, sdk: {
      ...fakeSdk, verify: async () => { mutate(); return { verified: true, certificateDigest: digest, statusSource: 'test_crl_fixture',
        validUntil: mutation === 'status' ? clock : clock + 10000 }; },
    } });
    const created = await challenge(app);
    mutate = () => {
      if (mutation === 'expiry') clock = created.expiresAt;
      if (mutation === 'bytes') {
        const db = new DatabaseSync(dbPath);
        db.prepare('UPDATE nca_test_challenges SET bytes = ? WHERE id = ?').run(Buffer.from('altered'), created.id);
        db.close();
      }
    };
    const response = await app.post('/api/verify', { challengeId: created.id, cms: created.bytesBase64 });
    assert.equal(response.status, mutation === 'expiry' ? 410 : mutation === 'status' ? 503 : 409);
    const db = new DatabaseSync(dbPath);
    assert.equal(db.prepare('SELECT receipt_json FROM nca_test_challenges').get().receipt_json, null);
    db.close();
    await app.close();
  }
});

test('failed SQLite commit leaves no receipt and no consumed challenge; sanitized events omit CMS', async (t) => {
  const dbPath = temporary(t);
  const app = await startProbe(dbPath);
  t.after(() => app.close());
  const created = await challenge(app);
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TRIGGER fail_probe BEFORE UPDATE ON nca_test_challenges BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
  const input = { challengeId: created.id, cms: created.bytesBase64 };
  assert.equal((await app.post('/api/verify', input)).status, 503);
  assert.equal(db.prepare('SELECT receipt_json, signature_hash FROM nca_test_challenges').get().receipt_json, null);
  assert.equal(db.prepare('SELECT signature_hash FROM nca_test_challenges').get().signature_hash, null);
  db.exec('DROP TRIGGER fail_probe');
  db.close();
  assert.equal((await app.post('/api/verify', input)).status, 200);
  const response = await app.get('/api/events');
  const text = await response.text();
  assert.ok(!text.includes(created.bytesBase64) && !text.includes(created.id) && !text.includes(digest));
  assert.deepEqual(Object.keys(JSON.parse(text).events[0]).sort(), ['at', 'code', 'durationMs']);
});

test('two different valid concurrent containers cannot create two receipts and a verifier crash can retry', async (t) => {
  let crash = true;
  const app = await startProbe(temporary(t), { sdk: { ...fakeSdk, verify: async () => {
    if (crash) throw new Error('do not expose SDK certificate details');
    return { verified: true, certificateDigest: digest, validUntil: Date.now() + 10000, statusSource: 'test_crl_fixture' };
  } } });
  t.after(() => app.close());
  const created = await challenge(app);
  const input = { challengeId: created.id, cms: Buffer.from('first CMS').toString('base64') };
  const failed = await app.post('/api/verify', input);
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: 'verifier_unavailable' });
  crash = false;
  const responses = await Promise.all([app.post('/api/verify', input), app.post('/api/verify', {
    ...input, cms: Buffer.from('second valid CMS').toString('base64') })]);
  assert.deepEqual(responses.map((item) => item.status).sort(), [200, 409]);
});

test('explicit OCSP mode binds source and short status expiry; wrong source cannot issue a receipt', async (t) => {
  let clock = Date.now();
  let resultSource = 'test_crl_fixture';
  const dbPath = temporary(t);
  const ocsp = { ...fakeSdk, statusSource: 'test_ocsp',
    inspect: async () => ({ ...(await fakeSdk.inspect()), statusSource: 'test_ocsp' }),
    verify: async () => ({ verified: true, certificateDigest: digest,
      validUntil: clock + 5000, statusSource: resultSource }) };
  const app = await startProbe(dbPath, { sdk: ocsp, now: () => clock });
  t.after(() => app.close());
  const created = await challenge(app);
  assert.equal(JSON.parse(created.text).statusSource, 'test_ocsp');
  const input = { challengeId: created.id, cms: created.bytesBase64 };
  assert.equal((await app.post('/api/verify', input)).status, 503);
  resultSource = 'test_ocsp';
  const receipt = (await (await app.post('/api/verify', input)).json()).receipt;
  assert.equal(receipt.statusSource, 'test_ocsp');
  assert.equal(receipt.validUntil, clock + 5000);
  clock += 10000;
  const replay = await app.post('/api/verify', input);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replay, true);
});

test('switching status mode across restart rejects a pending instruction instead of falling back', async (t) => {
  const dbPath = temporary(t);
  let app = await startProbe(dbPath);
  const created = await challenge(app);
  const cookie = app.cookie;
  await app.close();
  let verifies = 0;
  app = await startProbe(dbPath, { sdk: { ...fakeSdk, statusSource: 'test_ocsp',
    inspect: async () => ({ ...(await fakeSdk.inspect()), statusSource: 'test_ocsp' }),
    verify: async () => { verifies++; throw new Error('must not fall back'); } } });
  t.after(() => app.close());
  const response = await app.post('/api/verify', { challengeId: created.id, cms: created.bytesBase64 }, { Cookie: cookie });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'status_source_changed' });
  assert.equal(verifies, 0);
});
