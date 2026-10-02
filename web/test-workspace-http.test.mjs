// Loopback HTTP and injected verifier models only; no NCA/NCALayer or real CMS.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { TermsEvidence } from '../nca/terms-evidence.mjs';
import { TestDocuments } from './test-documents.mjs';
import { fingerprintDraftTerms } from './terms.mjs';
import { createTestWorkspaceHandler } from './test-workspace-http.mjs';

const DEAL = 'e85a7c90-cc44-4a9a-a5c5-e1f65c736227';
const OTHER = 'cccb1fa8-caa0-43cd-bc42-4e3a6085bcf1';
const CERT = '1'.repeat(64);
const CHAIN = ['-----BEGIN CERTIFICATE-----A', '-----BEGIN CERTIFICATE-----B'];
const PREFIX = '/api/test-workspace';
const DRAFT = { scenario: 'livestock', quantity: 12, amount: 8_400_000, date: '2026-10-10' };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY, scenario TEXT NOT NULL, quantity INTEGER NOT NULL,
      amount INTEGER NOT NULL, date TEXT NOT NULL, created_at INTEGER NOT NULL,
      version INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS draft_versions (
      deal_id TEXT NOT NULL REFERENCES drafts(id), version INTEGER NOT NULL,
      scenario TEXT NOT NULL, quantity INTEGER NOT NULL, amount INTEGER NOT NULL,
      date TEXT NOT NULL, changed_at INTEGER NOT NULL,
      PRIMARY KEY (deal_id, version)
    ) STRICT;
  `);
  if (!db.prepare('SELECT id FROM drafts WHERE id = ?').get(DEAL)) {
    for (const id of [DEAL, OTHER]) {
      db.prepare('INSERT INTO drafts VALUES (?, ?, ?, ?, ?, 1000, 1)').run(
        id, DRAFT.scenario, DRAFT.quantity, DRAFT.amount, DRAFT.date,
      );
      db.prepare('INSERT INTO draft_versions VALUES (?, 1, ?, ?, ?, ?, 1000)').run(
        id, DRAFT.scenario, DRAFT.quantity, DRAFT.amount, DRAFT.date,
      );
    }
  }
  return db;
}

async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-workspace-http-'));
  chmodSync(directory, 0o700);
  const dbPath = join(directory, 'workspace.sqlite');
  let db, documents, terms, handler, server, base, closePromise;
  let clock = 2_000_000_000_000, calls = 0, inspectCalls = 0, signingReady = true;
  function readDeal(id) {
    const row = db.prepare(`SELECT id, scenario, quantity, amount, date,
      created_at AS createdAt, version FROM drafts WHERE id = ?`).get(id);
    if (!row) return undefined;
    return { ...row, termsFingerprint: fingerprintDraftTerms({ dealId: row.id,
      version: row.version, scenario: row.scenario, quantity: row.quantity, amount: row.amount, date: row.date }) };
  }
  function readSnapshot(id) {
    const row = readDeal(id);
    if (!row) return undefined;
    return { terms: { dealId: row.id, version: row.version, scenario: row.scenario,
      quantity: row.quantity, amount: row.amount, date: row.date },
    termsFingerprint: row.termsFingerprint, documents: documents.manifest(id, row.version) };
  }
  function modelVerify(bytes, cms) {
    let value;
    try { value = JSON.parse(cms.toString('utf8')); } catch { return { verified: false }; }
    if (value.bytes !== bytes.toString('base64') || value.rejected) return { verified: false };
    return { verified: true, statusSource: 'test_ocsp', certificateDigest: value.certificateDigest,
      validUntil: clock + 60_000, personal: value.personal !== false, corporate: value.corporate === true,
      subject: 'PRIVATE-MODEL-SUBJECT', identity: 'PRIVATE-MODEL-IDENTITY', walletAddress: 'UNTRUSTED-EXTRA' };
  }
  async function start() {
    db = openDatabase(dbPath);
    chmodSync(dbPath, 0o600);
    documents = new TestDocuments({ db, now: () => clock });
    terms = new TermsEvidence({ db, readSnapshot, now: () => clock, verify: async (bytes, cms) => {
      calls++;
      return options.verify ? options.verify(bytes, cms, modelVerify, calls) : modelVerify(bytes, cms);
    } });
    handler = createTestWorkspaceHandler({ documents, terms, readSnapshot, readDeal,
      fixtureProvider: options.fixtureProvider || (() => null), now: () => clock,
      bodyTimeoutMs: options.bodyTimeoutMs || 15_000,
      inspect: async () => {
        inspectCalls++;
        const inspect = () => ({ ready: signingReady, statusSource: 'test_ocsp', validUntil: clock + 60_000,
          chain: CHAIN, subject: 'PRIVATE-STATUS-SUBJECT', profilePath: '/private/model/profile' });
        return options.inspect ? options.inspect(inspect, inspectCalls) : inspect();
      },
    });
    server = createServer(async (req, res) => {
      const expectedHost = `127.0.0.1:${server.address().port}`;
      const pathname = new URL(req.url, `http://${expectedHost}`).pathname;
      const handled = await handler.handle(req, res, pathname, expectedHost);
      if (!handled) { res.writeHead(404); res.end(); }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
    closePromise = undefined;
  }
  async function close() {
    if (!handler) return;
    if (!closePromise) closePromise = (async () => {
      await handler.close();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    })();
    return closePromise;
  }
  t.after(async () => {
    await close();
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await start();
  async function client(cookieOverride) {
    const response = await fetch(base + PREFIX + '/status', {
      headers: cookieOverride ? { Cookie: cookieOverride } : {},
    });
    const status = await response.json();
    const cookie = response.headers.get('set-cookie')?.split(';')[0] || cookieOverride;
    return { response, status, cookie,
      get: (path, headers = {}) => fetch(base + path, { headers: { Cookie: cookie || '', ...headers } }),
      post: (path, value, headers = {}, extra = {}) => fetch(base + path, {
        method: 'POST', headers: { Cookie: cookie || '', Origin: base, 'Content-Type': 'application/json',
          'X-DalaHold-CSRF': status.csrfToken || '', ...headers }, body: JSON.stringify(value), ...extra,
      }),
    };
  }
  const a = await client();
  return { a, client, close, readSnapshot,
    state: () => ({ documents: db.prepare('SELECT COUNT(*) AS n FROM test_documents').get().n,
      intents: db.prepare('SELECT COUNT(*) AS n FROM terms_evidence_intents').get().n,
      receipts: db.prepare('SELECT COUNT(*) AS n FROM terms_evidence_intents WHERE receipt_json IS NOT NULL').get().n }),
    revise() {
      db.exec('BEGIN IMMEDIATE');
      db.prepare('UPDATE drafts SET version = 2, quantity = 13 WHERE id = ?').run(DEAL);
      db.prepare('INSERT INTO draft_versions VALUES (?, 2, ?, 13, ?, ?, ?)').run(
        DEAL, DRAFT.scenario, DRAFT.amount, DRAFT.date, clock,
      );
      db.exec('COMMIT');
    },
    async restart() { await close(); db.close(); await start(); },
    get db() { return db; }, get documents() { return documents; }, get handler() { return handler; },
    get base() { return base; }, get calls() { return calls; }, get inspectCalls() { return inspectCalls; },
    get clock() { return clock; }, set clock(value) { clock = value; },
    set signingReady(value) { signingReady = value; },
  };
}

async function issue(client, overrides = {}) {
  const response = await client.post(PREFIX + '/intents', { dealId: DEAL, expectedVersion: 1, ...overrides });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).intent;
}
function sign(intent, overrides = {}) {
  return Buffer.from(JSON.stringify({ bytes: intent.bytesBase64, certificateDigest: CERT, ...overrides })).toString('base64');
}
function submit(client, intent, cms = sign(intent), extra = {}) {
  return client.post(PREFIX + '/receipts', { intentId: intent.id, cms }, {}, extra);
}
function uploadInput(overrides = {}) {
  return { expectedVersion: 1, requestId: randomUUID(), category: 'contract',
    bytesBase64: Buffer.from('Local TEST document\n').toString('base64'), ...overrides };
}
async function upload(client, overrides = {}, id = DEAL) {
  const response = await client.post(`${PREFIX}/deals/${id}/documents`, uploadInput(overrides));
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).document;
}
async function evidence(client, id = DEAL) {
  const response = await client.get(`${PREFIX}/deals/${id}/evidence`);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
function raw(base, path, { method = 'POST', cookie = '', csrf = '', value, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(base + path, { method, headers: { Cookie: cookie, Origin: base,
      'Content-Type': 'application/json', 'X-DalaHold-CSRF': csrf, ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(value === undefined ? undefined : JSON.stringify(value));
  });
}

test('status creates a bounded anonymous session and exposes only sanitized signing readiness', async t => {
  const f = await fixture(t);
  assert.equal(f.a.response.status, 200);
  assert.match(f.a.response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Path=\/; Max-Age=900/);
  assert.deepEqual(Object.keys(f.a.status).sort(), ['csrfToken', 'scope', 'sessionExpiresAt', 'signing']);
  assert.equal(f.a.status.scope, 'local_test_workspace_only');
  assert.equal(f.a.status.sessionExpiresAt, f.clock + 900_000);
  assert.match(f.a.status.csrfToken, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.a.status.signing, { ready: true, statusSource: 'test_ocsp', chain: CHAIN,
    validUntil: f.clock + 60_000 });
  assert.equal(f.a.response.headers.get('cache-control'), 'no-store');
  assert.equal(f.a.response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(f.a.response.headers.get('access-control-allow-origin'), null);
  const refreshed = await f.a.get(PREFIX + '/status');
  assert.equal(refreshed.headers.get('set-cookie'), null);
  assert.deepEqual(await refreshed.json(), f.a.status);
  const fixed = 'dalahold_workspace_test=' + 'f'.repeat(64);
  const replacement = await f.client(fixed);
  assert.notEqual(replacement.cookie, fixed);
  assert.notEqual(replacement.status.csrfToken, f.a.status.csrfToken);
});

test('missing, forged, duplicate, foreign and wrong-CSRF sessions refuse before verification', async t => {
  const f = await fixture(t), intent = await issue(f.a), before = f.state();
  for (const headers of [
    { Cookie: '' }, { Cookie: 'dalahold_workspace_test=' + 'e'.repeat(64) },
    { Cookie: `${f.a.cookie}; ${f.a.cookie}` }, { 'X-DalaHold-CSRF': '' },
    { 'X-DalaHold-CSRF': 'a'.repeat(64) }, { 'X-DalaHold-CSRF': ['x'] },
  ]) {
    const response = await f.a.post(PREFIX + '/receipts', { intentId: intent.id, cms: sign(intent) }, headers);
    assert.ok([401, 403].includes(response.status), await response.clone().text());
  }
  const b = await f.client();
  const foreign = await submit(b, intent);
  assert.equal(foreign.status, 404);
  assert.deepEqual(await foreign.json(), { error: 'terms_intent_not_found' });
  assert.equal(f.calls, 0);
  assert.deepEqual(f.state(), before);
  assert.equal((await f.a.get(`${PREFIX}/deals/${DEAL}/evidence`, { Cookie: '' })).status, 401);
});

test('Host, exact Origin and Fetch Metadata gates refuse before state writes', async t => {
  const f = await fixture(t), value = { dealId: DEAL, expectedVersion: 1 };
  for (const headers of [
    { Host: 'evil.example' }, { Host: `localhost:${new URL(f.base).port}` },
    { Origin: 'https://evil.example' }, { Origin: '' },
    { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' },
  ]) {
    const response = await raw(f.base, PREFIX + '/intents', {
      cookie: f.a.cookie, csrf: f.a.status.csrfToken, value, headers,
    });
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.deepEqual(JSON.parse(response.bytes), { error: 'local_origin_required' });
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  for (const headers of [{ Host: 'evil.example' }, { Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await raw(f.base, PREFIX + '/status', { method: 'GET', headers })).status, 403);
  }
  assert.deepEqual(f.state(), { documents: 0, intents: 0, receipts: 0 });
  assert.equal(f.calls, 0);
});

test('exact JSON envelopes reject filename, path, identity, arrays and oversized requests', async t => {
  const f = await fixture(t);
  const request = { dealId: DEAL, expectedVersion: 1 };
  for (const value of [
    null, [], { ...request, dealId: [DEAL] }, { ...request, expectedVersion: '1' },
    { ...request, expectedVersion: 0 }, { ...request, dealId: DEAL.toUpperCase() },
    ...['filename', 'path', 'personId', 'walletAddress', 'scope', 'purpose', 'sessionHash']
      .map(field => ({ ...request, [field]: 'injected' })),
  ]) assert.equal((await f.a.post(PREFIX + '/intents', value)).status, 400);
  assert.equal((await f.a.post(PREFIX + '/intents', request, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.a.post(PREFIX + '/intents', { padding: 'x'.repeat(4097) })).status, 413);
  assert.equal((await raw(f.base, PREFIX + '/intents', {
    cookie: f.a.cookie, csrf: f.a.status.csrfToken, value: request,
    headers: { 'Content-Type': 'application/json; charset=latin1' },
  })).status, 415);
  assert.deepEqual(f.state(), { documents: 0, intents: 0, receipts: 0 });
  assert.equal(f.calls, 0);
  assert.equal(f.inspectCalls, 1);
});

test('invalid receipt identifiers and noncanonical base64 consume no submit quota or verifier work', async t => {
  const f = await fixture(t), intent = await issue(f.a), before = f.state();
  const invalid = [
    { intentId: [intent.id], cms: sign(intent) }, { intentId: intent.id, cms: [sign(intent)] },
    { intentId: intent.id, cms: 'YQ' }, { intentId: intent.id, cms: 'YR==' },
    { intentId: intent.id, cms: 'YQ==\n' }, { intentId: intent.id, cms: '' },
    { intentId: intent.id, cms: sign(intent), filename: 'private.txt' },
    { intentId: intent.id, cms: sign(intent), path: '/private/model' },
  ];
  for (let index = 0; index < 24; index++) {
    const response = await f.a.post(PREFIX + '/receipts', invalid[index % invalid.length]);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_request' });
  }
  assert.equal(f.calls, 0);
  assert.deepEqual(f.state(), before);
  assert.equal((await submit(f.a, intent)).status, 200);
  assert.equal(f.calls, 1);
});

test('one positive verifier model stores one immutable receipt and exact CMS retries remain historical', async t => {
  const f = await fixture(t), document = await upload(f.a), intent = await issue(f.a);
  const encoded = JSON.parse(intent.text);
  assert.equal(intent.bytesBase64, Buffer.from(intent.text).toString('base64'));
  assert.equal(encoded.action, 'record_test_terms_signature');
  assert.equal(encoded.snapshot.terms.version, 1);
  assert.deepEqual(encoded.snapshot.documents, [{ id: document.id, category: document.category,
    byteLength: document.byteLength, sha256: document.sha256 }]);
  const cms = sign(intent), response = await submit(f.a, intent, cms);
  assert.equal(response.status, 200);
  const accepted = await response.json();
  assert.equal(accepted.historical, false);
  assert.equal(accepted.receipt.scope, 'test_terms_evidence_only');
  assert.equal(accepted.receipt.action, 'record_test_terms_signature');
  assert.equal(accepted.receipt.certificateDigest, CERT);
  assert.equal(accepted.receipt.termsVersion, 1);
  const view = await evidence(f.a);
  assert.equal(view.signatures.length, 1);
  assert.equal(view.signatures[0].currentMatches, true);
  assert.deepEqual(view.signatures[0].receipt, accepted.receipt);
  assert.deepEqual(view.signatures[0].snapshot, encoded.snapshot);
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE-|UNTRUSTED|sessionHash|cms|signature_hash|receipt_key/);
  f.revise();
  f.clock = intent.expiresAt + 1;
  f.signingReady = false;
  const calls = f.calls, inspections = f.inspectCalls;
  const repeated = await submit(f.a, intent, cms);
  assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), { ...accepted, historical: true });
  assert.equal(f.calls, calls);
  assert.equal(f.inspectCalls, inspections);
  const changed = await submit(f.a, intent, sign(intent, { extra: 'different CMS bytes' }));
  assert.equal(changed.status, 409);
  assert.deepEqual(await changed.json(), { error: 'terms_replay_conflict' });
  assert.equal(f.calls, calls);
  const historical = await evidence(f.a);
  assert.deepEqual(historical.documents, []);
  assert.equal(historical.terms.version, 2);
  assert.equal(historical.signatures[0].currentMatches, false);
  assert.deepEqual(historical.signatures[0].snapshot, encoded.snapshot);
  assert.deepEqual(f.state(), { documents: 1, intents: 1, receipts: 1 });
});

test('rejected, corporate, wrong-byte and foreign CMS models preserve pending intent', async t => {
  const f = await fixture(t), intent = await issue(f.a), before = f.state();
  for (const extras of [
    { rejected: true }, { corporate: true }, { personal: false },
    { bytes: Buffer.from('changed signed bytes').toString('base64') },
    { certificateDigest: 'bad' },
  ]) {
    const response = await submit(f.a, intent, sign(intent, extras));
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: 'terms_signature_rejected' });
    assert.deepEqual(f.state(), before);
  }
  assert.equal((await submit(f.a, intent)).status, 200);
  assert.equal(f.state().receipts, 1);
});

test('stale issuance and expired pending intent refuse without a verifier call', async t => {
  const f = await fixture(t), intent = await issue(f.a);
  f.revise();
  const stale = await f.a.post(PREFIX + '/intents', { dealId: DEAL, expectedVersion: 1 });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: 'terms_snapshot_stale' });
  f.clock = intent.expiresAt;
  const expired = await submit(f.a, intent);
  assert.equal(expired.status, 410);
  assert.deepEqual(await expired.json(), { error: 'terms_intent_expired' });
  assert.equal(f.calls, 0);
  assert.deepEqual(f.state(), { documents: 0, intents: 1, receipts: 0 });
});

test('term revision or a document added during verifier await prevents receipt persistence', async t => {
  for (const change of ['terms', 'documents']) {
    const started = deferred(), waiting = deferred();
    const f = await fixture(t, { verify: async (bytes, cms, model) => {
      started.resolve(); await waiting.promise; return model(bytes, cms);
    } });
    const intent = await issue(f.a), pending = submit(f.a, intent);
    await started.promise;
    try {
      if (change === 'terms') f.revise();
      else await upload(f.a, { category: 'quality' });
    } finally { waiting.resolve(); }
    const response = await pending;
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'terms_snapshot_stale' });
    assert.equal(f.state().receipts, 0);
    assert.equal(f.db.prepare('SELECT cms FROM terms_evidence_intents').get().cms, null);
  }
});

test('session close and expiry during verifier await prevent receipt persistence', async t => {
  for (const change of ['close', 'expire']) {
    const started = deferred(), waiting = deferred();
    const f = await fixture(t, { verify: async (bytes, cms, model) => {
      started.resolve(); await waiting.promise; return model(bytes, cms);
    } });
    const intent = await issue(f.a), before = f.state(), pending = submit(f.a, intent);
    await started.promise;
    try {
      if (change === 'close') assert.equal((await f.a.post(PREFIX + '/session/close', {})).status, 200);
      else f.clock = f.a.status.sessionExpiresAt;
    } finally { waiting.resolve(); }
    const response = await pending;
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'workspace_session_unavailable' });
    assert.deepEqual(f.state(), before);
  }
});

test('handler close drains verification and refuses commit before closing its store', async t => {
  const started = deferred(), waiting = deferred();
  const f = await fixture(t, { verify: async (bytes, cms, model) => {
    started.resolve(); await waiting.promise; return model(bytes, cms);
  } });
  const intent = await issue(f.a), before = f.state(), pending = submit(f.a, intent);
  await started.promise;
  let drained = false;
  const closing = f.handler.close().then(() => { drained = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(drained, false);
  } finally { waiting.resolve(); }
  assert.equal((await pending).status, 401);
  await closing;
  assert.deepEqual(f.state(), before);
  assert.equal((await f.a.get(PREFIX + '/status')).status, 401);
});

test('text download uses exact bytes, generated attachment headers and durable version binding', async t => {
  const f = await fixture(t);
  const bytes = Buffer.from('Қазақша TEST\n<script>literal text only</script>');
  const value = uploadInput({ bytesBase64: bytes.toString('base64') });
  const created = await f.a.post(`${PREFIX}/deals/${DEAL}/documents`, value);
  assert.equal(created.status, 201);
  const first = (await created.json()).document;
  const retry = await f.a.post(`${PREFIX}/deals/${DEAL}/documents`, value);
  assert.equal(retry.status, 201);
  assert.deepEqual((await retry.json()).document, first);
  let download = await f.a.get(`${PREFIX}/deals/${DEAL}/documents/${first.id}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.equal(download.headers.get('content-disposition'), `attachment; filename="test-${first.id}.txt"`);
  assert.equal(download.headers.get('content-length'), String(bytes.length));
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(download.headers.get('cache-control'), 'no-store');
  assert.equal(download.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  f.revise();
  const second = await upload(f.a, { expectedVersion: 2, category: 'delivery' });
  assert.deepEqual((await evidence(f.a)).documents, [second]);
  assert.equal((await f.a.get(`${PREFIX}/deals/${OTHER}/documents/${first.id}`)).status, 404);
  await f.restart();
  assert.equal((await f.a.get(`${PREFIX}/deals/${DEAL}/documents/${first.id}`)).status, 401);
  const client = await f.client();
  download = await client.get(`${PREFIX}/deals/${DEAL}/documents/${first.id}`);
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  assert.deepEqual((await evidence(client)).documents, [second]);
  assert.deepEqual(f.documents.list(DEAL, 1), [first]);
});

test('document envelopes reject binary, type and filename injection before storage', async t => {
  const f = await fixture(t), value = uploadInput();
  for (const changed of [
    { filename: 'private.txt' }, { path: '/private/model' }, { author: 'verified person' },
    { expectedVersion: [1] }, { requestId: [value.requestId] }, { category: ['contract'] },
    { bytesBase64: [value.bytesBase64] }, { bytesBase64: 'YQ' },
    { bytesBase64: Buffer.from('text\0').toString('base64') },
    { bytesBase64: Buffer.from([0xc3, 0x28]).toString('base64') },
    { bytesBase64: Buffer.from('%PDF-1.7\n').toString('base64') },
  ]) assert.equal((await f.a.post(`${PREFIX}/deals/${DEAL}/documents`, { ...value, ...changed })).status, 400);
  assert.deepEqual(f.state(), { documents: 0, intents: 0, receipts: 0 });
  const oversized = await f.a.post(`${PREFIX}/deals/${DEAL}/documents`, { padding: 'x'.repeat(370001) });
  assert.equal(oversized.status, 413);
  f.revise();
  const stale = await f.a.post(`${PREFIX}/deals/${DEAL}/documents`, uploadInput());
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: 'stale_draft' });
});

test('corrupt document bytes or stored receipt fail closed through download and evidence routes', async t => {
  const f = await fixture(t), document = await upload(f.a), intent = await issue(f.a);
  assert.equal((await submit(f.a, intent)).status, 200);
  f.db.exec('PRAGMA ignore_check_constraints = ON');
  f.db.prepare('UPDATE test_documents SET bytes = ? WHERE id = ?').run(Buffer.from('corrupt'), document.id);
  for (const path of [`${PREFIX}/deals/${DEAL}/documents/${document.id}`, `${PREFIX}/deals/${DEAL}/evidence`]) {
    const response = await f.a.get(path);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'document_corrupt' });
  }
  const g = await fixture(t), second = await issue(g.a);
  assert.equal((await submit(g.a, second)).status, 200);
  g.db.prepare('UPDATE terms_evidence_intents SET cms = ? WHERE id = ?').run(Buffer.from('corrupt'), second.id);
  const response = await g.a.get(`${PREFIX}/deals/${DEAL}/evidence`);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'terms_receipt_changed' });
});

test('signing unavailable preserves document and evidence access and sanitizes adapter errors', async t => {
  const f = await fixture(t, { inspect: () => { throw new Error('/private/profile SECRET-CREDENTIAL'); } });
  assert.equal(f.a.response.status, 200);
  assert.deepEqual(f.a.status.signing, { ready: false, error: 'status_unavailable' });
  const document = await upload(f.a);
  assert.deepEqual((await evidence(f.a)).documents, [document]);
  const response = await f.a.post(PREFIX + '/intents', { dealId: DEAL, expectedVersion: 1 });
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /SECRET|private|profile/);
  assert.equal(f.state().intents, 0);
  const g = await fixture(t, { verify: async () => { throw new Error('/private/SDK SECRET-CREDENTIAL'); } });
  const intent = await issue(g.a), rejected = await submit(g.a, intent);
  assert.equal(rejected.status, 503);
  assert.deepEqual(await rejected.json(), { error: 'workspace_unavailable' });
  assert.equal(g.state().receipts, 0);
});

test('intent issuance requires the same strict readiness contract as status', async t => {
  for (const malformed of [
    { ready: 'true' }, { validUntil: '2000000060000' },
    { validUntil: Infinity }, { chain: ['-----BEGIN CERTIFICATE-----A'] },
  ]) {
    const f = await fixture(t, { inspect: inspect => ({ ...inspect(), ...malformed }) });
    assert.equal(f.a.status.signing.ready, false);
    const response = await f.a.post(PREFIX + '/intents', { dealId: DEAL, expectedVersion: 1 });
    assert.equal(response.status, 503, JSON.stringify(malformed));
    assert.deepEqual(await response.json(), { error: 'status_unavailable' });
    assert.deepEqual(f.state(), { documents: 0, intents: 0, receipts: 0 });
  }
});

test('two verifier slots bound concurrent submissions and the refused request can retry', async t => {
  const started = deferred(), waiting = deferred();
  let entered = 0;
  const f = await fixture(t, { verify: async (bytes, cms, model) => {
    if (++entered === 2) started.resolve();
    await waiting.promise;
    return model(bytes, cms);
  } });
  const intents = [await issue(f.a), await issue(f.a), await issue(f.a)];
  const pending = [submit(f.a, intents[0]), submit(f.a, intents[1])];
  await started.promise;
  try {
    const busy = await submit(f.a, intents[2]);
    assert.equal(busy.status, 503);
    assert.deepEqual(await busy.json(), { error: 'verifier_busy' });
    assert.match(busy.headers.get('retry-after'), /^\d+$/);
    assert.equal(f.calls, 2);
    assert.equal(f.state().receipts, 0);
  } finally { waiting.resolve(); }
  assert.deepEqual((await Promise.all(pending)).map(response => response.status), [200, 200]);
  assert.equal((await submit(f.a, intents[2])).status, 200);
  assert.equal(f.calls, 3);
  assert.deepEqual(f.state(), { documents: 0, intents: 3, receipts: 3 });
});

test('offline fixture evidence is a trusted read callback and no decision-write route exists', async t => {
  let reads = 0;
  const offline = { schema: 'dalahold.offline-evidence.v1', trustLevel: 'local_test_fixture_only',
    disclaimer: 'No NCA signature, verified file, payment or chain transaction.', dealId: DEAL,
    terms: { dealId: DEAL, version: 1, ...DRAFT }, status: 'draft', decisions: [], documentMarkers: [] };
  const f = await fixture(t, { fixtureProvider: id => { reads++; return id === DEAL ? offline : null; } });
  assert.deepEqual((await evidence(f.a)).offlineEvidence, offline);
  const before = f.state();
  for (const path of [
    `${PREFIX}/deals/${DEAL}/decisions`, `${PREFIX}/deals/${DEAL}/approve`,
    `${PREFIX}/deals/${DEAL}/challenges`, `${PREFIX}/decisions`,
  ]) {
    assert.equal((await f.a.post(path, { action: 'approve' })).status, 404);
    assert.equal((await f.a.get(path)).status, 404);
  }
  assert.deepEqual(f.state(), before);
  assert.equal(reads, 1);
  const g = await fixture(t, { fixtureProvider: () => { throw new Error('/private/fixture SECRET'); } });
  const response = await g.a.get(`${PREFIX}/deals/${DEAL}/evidence`);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'evidence_corrupt' });
});

test('status and issuance are rate bounded while session close remains available', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 9; index++) assert.equal((await f.a.get(PREFIX + '/status')).status, 200);
  const limited = await f.a.get(PREFIX + '/status');
  assert.equal(limited.status, 429);
  assert.match(limited.headers.get('retry-after'), /^\d+$/);
  assert.deepEqual(await limited.json(), { error: 'workspace_rate_limited' });
  assert.equal((await f.a.post(PREFIX + '/session/close', { extra: true })).status, 400);
  const closed = await f.a.post(PREFIX + '/session/close', {});
  assert.equal(closed.status, 200);
  assert.match(closed.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await f.a.get(`${PREFIX}/deals/${DEAL}/evidence`)).status, 401);
  const g = await fixture(t);
  for (let index = 0; index < 5; index++) await issue(g.a);
  const sixth = await g.a.post(PREFIX + '/intents', { dealId: DEAL, expectedVersion: 1 });
  assert.equal(sixth.status, 429);
  assert.equal(g.state().intents, 5);
  assert.equal((await g.a.post(PREFIX + '/session/close', {})).status, 200);
});

test('new anonymous sessions have a global creation bound and existing clients can close', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 19; index++) assert.equal((await f.client()).response.status, 200);
  const refused = await f.client();
  assert.equal(refused.response.status, 429);
  assert.equal(refused.response.headers.get('set-cookie'), null);
  assert.match(refused.response.headers.get('retry-after'), /^\d+$/);
  assert.deepEqual(refused.status, { error: 'workspace_rate_limited' });
  assert.equal((await f.a.post(PREFIX + '/session/close', {})).status, 200);
  assert.deepEqual(f.state(), { documents: 0, intents: 0, receipts: 0 });
});

test('slow incomplete JSON is drained by body timeout without reserving intent state', async t => {
  const f = await fixture(t, { bodyTimeoutMs: 30 });
  const outcome = await new Promise(resolve => {
    const req = request(f.base + PREFIX + '/intents', { method: 'POST', headers: {
      Cookie: f.a.cookie, Origin: f.base, 'Content-Type': 'application/json',
      'X-DalaHold-CSRF': f.a.status.csrfToken, 'Content-Length': 100,
    } }, res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
    req.on('error', error => resolve({ code: error.code }));
    req.setTimeout(500, () => { req.destroy(); resolve({ code: 'TEST_TIMEOUT' }); });
    req.write('{');
  });
  assert.notEqual(outcome.code, 'TEST_TIMEOUT');
  assert.ok(outcome.code === 'ECONNRESET' || outcome.status === 408);
  assert.deepEqual(f.state(), { documents: 0, intents: 0, receipts: 0 });
  assert.equal(f.inspectCalls, 1);
  await issue(f.a);
});
