// Injected policy/HTTP fixtures, not real NCALayer, NCA cryptography or login.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createProbeServer } from './server.mjs';
import { initializePersonalBindings, PersonalBindings } from './personal-bindings.mjs';

const PERSON = 'person:' + 'a'.repeat(64), CERT = '1'.repeat(64);
const CHAIN = ['-----BEGIN CERTIFICATE-----A', '-----BEGIN CERTIFICATE-----B'];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const sign = (intent, extras = {}) => Buffer.from(JSON.stringify({ bytes: intent.bytesBase64,
  certificateDigest: CERT, organizationId: null, ...extras })).toString('base64');

async function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dalahold-personal-http-'));
  const directory = join(root, 'registry'), anchorDirectory = join(root, 'retained');
  initializePersonalBindings(directory, { anchorDirectory });
  let clock = Date.now(), calls = 0, inspectCalls = 0;
  const sdk = { statusSource: 'test_ocsp', async inspect() {
    inspectCalls++; return { ready: true, statusSource: 'test_ocsp', validUntil: clock + 60_000, chain: CHAIN };
  }, async verifyIdentity(bytes, cms) {
    calls++;
    const data = JSON.parse(cms.toString());
    if (data.bytes !== bytes.toString('base64') || data.rejected) return { verified: false };
    return { verified: true, statusSource: 'test_ocsp', validUntil: clock + 60_000,
      certificateDigest: data.certificateDigest, identity: { schema: 'nca_test_subject_v1',
        personId: PERSON, organizationId: data.organizationId }, powers: true, walletAddress: 'UNTRUSTED-EXTRA' };
  } };
  const makeServer = () => createProbeServer({ dbPath: join(root, 'probe.sqlite'), now: () => clock,
    bodyTimeoutMs: options.bodyTimeoutMs,
    sdk: options.sdk ? options.sdk(sdk) : sdk, personalTest: options.disabled ? null : { directory, anchorDirectory } });
  let server = makeServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let base = `http://127.0.0.1:${server.address().port}`;
  const clients = [];
  async function client(cookieOverride) {
    const page = await fetch(base + '/personal/', { headers: cookieOverride ? { Cookie: cookieOverride } : {} });
    const cookie = page.headers.get('set-cookie')?.split(';')[0] || cookieOverride;
    const get = (path, headers = {}) => fetch(base + path, { headers: { Cookie: cookie || '', ...headers } });
    const ready = await get('/api/personal-test/status');
    const status = await ready.json();
    const result = { page, cookie, status, get, post: (path, value, headers = {}) => fetch(base + path, {
      method: 'POST', headers: { Cookie: cookie || '', Origin: base, 'Content-Type': 'application/json',
        'X-DalaHold-CSRF': status.csrfToken || '', ...headers }, body: JSON.stringify(value) }) };
    clients.push(result); return result;
  }
  const a = await client();
  const state = () => {
    const db = new DatabaseSync(join(directory, 'personal.sqlite'), { readOnly: true });
    try { return { bindings: db.prepare('SELECT count(*) n FROM personal_bindings').get().n,
      receipts: db.prepare('SELECT count(*) n FROM binding_intents WHERE receipt_json IS NOT NULL').get().n,
      intents: db.prepare('SELECT count(*) n FROM binding_intents').get().n,
      revision: db.prepare('SELECT revision FROM binding_meta').get().revision }; } finally { db.close(); }
  };
  const close = async () => { await new Promise(resolve => server.close(resolve)); await server.resourcesClosed; };
  t.after(async () => { if (server.listening) await close(); rmSync(root, { recursive: true, force: true }); });
  return { root, directory, anchorDirectory, sdk, a, client, state, close,
    get server() { return server; },
    get base() { return base; }, get clock() { return clock; }, set clock(value) { clock = value; },
    get calls() { return calls; }, get inspectCalls() { return inspectCalls; },
    async restart() { await close(); server = makeServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`; } };
}
async function intent(client) {
  const response = await client.post('/api/personal-test/intents', { action: 'enroll_test_person' });
  assert.equal(response.status, 201); return (await response.json()).intent;
}
const submit = (client, issued, cms = sign(issued)) => client.post('/api/personal-test/receipts', { intentId: issued.id, cms });
function rawPost(base, cookie, csrf, value, headers) {
  // Node fetch normalizes Host; use real HTTP transport for rebinding tests.
  return new Promise((resolve, reject) => {
    const req = request(base + '/api/personal-test/intents', { method: 'POST', headers: {
      Cookie: cookie, Origin: base, 'Content-Type': 'application/json', 'X-DalaHold-CSRF': csrf, ...headers
    } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end(JSON.stringify(value));
  });
}

test('disabled opt-in exposes no personal API; fresh ready session is server-issued and bounded', async t => {
  const disabled = await fixture(t, { disabled: true });
  assert.equal(disabled.a.status.error, 'personal_test_unavailable');
  assert.equal((await disabled.a.post('/api/personal-test/intents', { action: 'enroll_test_person' })).status, 503);
  assert.deepEqual(disabled.state(), { bindings: 0, receipts: 0, intents: 0, revision: 0 });
  const f = await fixture(t);
  assert.equal(f.a.page.status, 200);
  assert.match(f.a.page.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Path=\/; Max-Age=900/);
  assert.equal(f.a.status.scope, 'test_personal_binding_only');
  assert.equal(f.a.status.sessionExpiresAt, f.clock + 900_000);
  assert.deepEqual(Object.keys(f.a.status).sort(), ['chain','csrfToken','enabled','ready','scope','sessionExpiresAt','statusSource','validUntil']);
  assert.equal((await f.a.get('/api/personal-test/status', { Cookie: 'dalahold_nca_test=' + 'e'.repeat(64) })).status, 401);
});

test('forged, duplicate, missing, foreign and wrong-CSRF sessions cannot issue or consume intents', async t => {
  const f = await fixture(t), issued = await intent(f.a), before = f.state(), b = await f.client();
  for (const headers of [{ Cookie: '' }, { Cookie: 'dalahold_personal_test=' + 'e'.repeat(64) },
    { Cookie: f.a.cookie + '; ' + f.a.cookie }, { 'X-DalaHold-CSRF': '' }, { 'X-DalaHold-CSRF': 'b'.repeat(64) }]) {
    const response = await submit({ post: (path, value) => f.a.post(path, value, headers) }, issued);
    assert.ok([401,403].includes(response.status));
  }
  const foreign = await submit(b, issued);
  assert.equal(foreign.status, 404); assert.equal(f.calls, 0); assert.deepEqual(f.state(), before);
  const fixation = 'dalahold_personal_test=' + 'f'.repeat(64), replacement = await f.client(fixation);
  assert.notEqual(replacement.cookie, fixation);
  assert.notEqual(replacement.status.csrfToken, f.a.status.csrfToken);
});

test('Host/Origin/Fetch-Metadata/JSON and server-field gates reject before state writes', async t => {
  const f = await fixture(t), value = { action: 'enroll_test_person' };
  for (const headers of [{ Host: 'evil.example' }, { Origin: 'https://evil.example' }, { Origin: '' },
    { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }])
    assert.equal(await rawPost(f.base, f.a.cookie, f.a.status.csrfToken, value, headers), 403, JSON.stringify(headers));
  assert.equal((await f.a.post('/api/personal-test/intents', value, { 'Content-Type': 'text/plain' })).status, 415);
  for (const input of [[], null, { ...value, ownerId: 'injected' }, { action: 'replace_test_certificate' }])
    assert.equal((await f.a.post('/api/personal-test/intents', input)).status, 400);
  assert.equal((await f.a.post('/api/personal-test/intents', { padding: 'x'.repeat(140001) })).status, 413);
  assert.deepEqual(f.state(), { bindings: 0, receipts: 0, intents: 0, revision: 0 });
});

test('exact personal evidence commits once; historical repeat is not fresh access and exposes only whitelisted receipt', async t => {
  const f = await fixture(t), issued = await intent(f.a), signed = sign(issued);
  const decoded = Buffer.from(issued.bytesBase64, 'base64'); assert.equal(decoded.toString(), issued.text);
  const first = await submit(f.a, issued, signed); assert.equal(first.status, 200);
  const accepted = await first.json(); assert.equal(accepted.historical, false);
  assert.equal(accepted.receipt.scope, 'test_personal_binding_only');
  assert.deepEqual(Object.keys(accepted.receipt).sort(), ['action','bindingId','certificateDigest','epoch','id','intentHash','scope','statusSource','validUntil','verifiedAt']);
  assert.deepEqual(f.state(), { bindings: 1, receipts: 1, intents: 1, revision: 2 });
  const repeat = await submit(f.a, issued, signed); assert.equal(repeat.status, 200);
  assert.deepEqual(await repeat.json(), { ...accepted, historical: true }); assert.equal(f.calls, 1);
  const conflict = await submit(f.a, issued, sign(issued, { ignored: true }));
  assert.equal(conflict.status, 409); assert.equal(f.calls, 1);
  const db = new DatabaseSync(join(f.root, 'probe.sqlite'), { readOnly: true });
  try { assert.deepEqual(db.prepare('SELECT name FROM sqlite_schema WHERE type=?').all('table').map(r=>r.name), ['nca_test_challenges']); }
  finally { db.close(); }
});

test('corporate, revoked-model, altered content and ambiguous/oversized CMS cannot enroll', async t => {
  const f = await fixture(t), issued = await intent(f.a);
  for (const [cms, status] of [[sign(issued, { organizationId: 'organization:' + 'b'.repeat(64) }),422],
    [sign(issued, { rejected: true }),422], [sign({ bytesBase64: Buffer.from('altered').toString('base64') }),422],
    ['AB==',400], ['Y21z\n',400], ['A'.repeat(131076),400]])
    assert.equal((await submit(f.a, issued, cms)).status, status);
  assert.deepEqual(f.state(), { bindings: 0, receipts: 0, intents: 1, revision: 1 });
});

test('session closes independently; in-flight verification cannot commit and no late receipt grants access', async t => {
  const waiting = deferred(), started = deferred();
  const f = await fixture(t, { sdk: base => ({ ...base, async verifyIdentity(...args) {
    started.resolve(); await waiting.promise; return base.verifyIdentity(...args);
  } }) });
  const issued = await intent(f.a), pending = submit(f.a, issued);
  await started.promise;
  const closed = await f.a.post('/api/personal-test/session/close', {});
  assert.equal(closed.status, 200); assert.match(closed.headers.get('set-cookie'), /Max-Age=0/);
  waiting.resolve(); assert.equal((await pending).status, 401);
  assert.deepEqual(f.state(), { bindings: 0, receipts: 0, intents: 1, revision: 1 });
  assert.equal((await submit(f.a, issued)).status, 401);
  const next = await f.client(f.a.cookie); assert.notEqual(next.cookie, f.a.cookie);
  assert.equal((await submit(next, issued)).status, 404);
});

test('expiry during SDK await and expired pending intent refuse before checkpoint advancement', async t => {
  const waiting = deferred(), started = deferred();
  const f = await fixture(t, { sdk: base => ({ ...base, async verifyIdentity(...args) {
    started.resolve(); await waiting.promise; return base.verifyIdentity(...args);
  } }) });
  const issued = await intent(f.a), pending = submit(f.a, issued); await started.promise;
  f.clock = f.a.status.sessionExpiresAt; waiting.resolve();
  assert.equal((await pending).status, 401); assert.equal(f.state().receipts, 0);
  const g = await fixture(t), expired = await intent(g.a); g.clock = expired.expiresAt;
  assert.equal((await submit(g.a, expired)).status, 410); assert.equal(g.calls, 0);
});

test('status/issue/submit and new-session limits are bounded; session close is never blocked by the limiter', async t => {
  const f = await fixture(t);
  for (let i=0;i<3;i++) await intent(f.a);
  const limited = await f.a.post('/api/personal-test/intents', { action: 'enroll_test_person' });
  assert.equal(limited.status, 429); assert.match(limited.headers.get('retry-after'), /^\d+$/);
  assert.equal((await f.a.post('/api/personal-test/session/close', {})).status, 200);
  for(let i=0;i<19;i++) await fetch(f.base + '/personal/');
  assert.equal((await fetch(f.base + '/personal/')).status, 429);
  f.clock += 60_000; const newPage=await fetch(f.base + '/personal/'); assert.equal(newPage.status,200);
});

test('restart loses browser sessions safely; stale restored registry and verifier exceptions are sanitized', async t => {
  const f = await fixture(t), issued = await intent(f.a);
  assert.equal((await submit(f.a,issued)).status,200);
  const originalCookie=f.a.cookie; await f.restart();
  assert.equal((await fetch(f.base+'/api/personal-test/status',{headers:{Cookie:originalCookie}})).status,401);
  const next=await f.client(originalCookie); assert.notEqual(next.cookie,originalCookie);
  assert.equal((await submit(next,issued)).status,404);
  const crash=await fixture(t,{sdk:base=>({...base,verifyIdentity:async()=>{throw new Error('PRIVATE certificate path must not leak');}})});
  const candidate=await intent(crash.a), response=await submit(crash.a,candidate);
  assert.equal(response.status,503); assert.deepEqual(await response.json(),{error:'binding_state_unavailable'});
  assert.equal(crash.state().receipts,0);
  // No old-state restoration is performed in a persistent operator registry.
  const path=join(f.root,'stale.sqlite');
  const current=new PersonalBindings({directory:f.directory,anchorDirectory:f.anchorDirectory,sdk:f.sdk});
  const snapshot=join(f.root,'before-next'); await current.backupTo(snapshot);
  current.createIntent('9'.repeat(64),{action:'enroll_test_person'}); current.close();
  assert.throws(()=>createProbeServer({dbPath:path,sdk:f.sdk,personalTest:{directory:snapshot,anchorDirectory:f.anchorDirectory}}),/binding_state_stale/);
});

test('personal verification and signature-probe inspection share the same two SDK slots', async t => {
  const waiting = deferred(), started = deferred(); let active = 0;
  const f = await fixture(t, { sdk: base => ({ ...base, async verifyIdentity(...args) {
    if (++active === 2) started.resolve(); await waiting.promise; return base.verifyIdentity(...args);
  } }) });
  const first = await intent(f.a), second = await intent(f.a);
  const pending = [submit(f.a, first), submit(f.a, second)]; await started.promise;
  const personal = await f.a.get('/api/personal-test/status');
  assert.equal(personal.status, 503); assert.deepEqual(await personal.json(), { error: 'verifier_busy' });
  const page = await fetch(f.base), cookie = page.headers.get('set-cookie').split(';')[0];
  const probe = await fetch(f.base + '/api/status', { headers: { Cookie: cookie } });
  assert.equal(probe.status, 503); assert.deepEqual(await probe.json(), { error: 'verifier_busy' });
  waiting.resolve(); assert.deepEqual((await Promise.all(pending)).map(response => response.status), [200,200]);
  assert.equal(f.calls, 2); assert.equal(f.state().bindings, 1);
});

test('disconnected in-flight request drains safely on shutdown without committing a closed personal session', async t => {
  const waiting = deferred(), started = deferred();
  const f = await fixture(t, { sdk: base => ({ ...base, async verifyIdentity(...args) {
    started.resolve(); await waiting.promise; return base.verifyIdentity(...args);
  } }) });
  const issued = await intent(f.a), controller = new AbortController();
  const pending = fetch(f.base + '/api/personal-test/receipts', { method: 'POST', signal: controller.signal,
    headers: { Cookie: f.a.cookie, Origin: f.base, 'Content-Type': 'application/json',
      'X-DalaHold-CSRF': f.a.status.csrfToken }, body: JSON.stringify({ intentId: issued.id, cms: sign(issued) }) });
  await started.promise; controller.abort(); await assert.rejects(pending);
  const closeEvent = once(f.server, 'close'), closing = f.close();
  await closeEvent; waiting.resolve(); await closing;
  assert.deepEqual(f.state(), { bindings: 0, receipts: 0, intents: 1, revision: 1 });
});

test('stale live registry fails readiness, issuance and submission without doing new identity verification', async t => {
  const f = await fixture(t), issued = await intent(f.a), snapshot = join(f.root,'new-writer');
  const source = new PersonalBindings({directory:f.directory,anchorDirectory:f.anchorDirectory,sdk:f.sdk});
  try { await source.backupTo(snapshot); } finally { source.close(); }
  const other = new PersonalBindings({directory:snapshot,anchorDirectory:f.anchorDirectory,sdk:f.sdk});
  try { other.createIntent('9'.repeat(64),{action:'enroll_test_person'}); } finally { other.close(); }
  for(const response of [await f.a.get('/api/personal-test/status'),
    await f.a.post('/api/personal-test/intents',{action:'enroll_test_person'}),await submit(f.a,issued)]) {
    assert.equal(response.status,503); assert.deepEqual(await response.json(),{error:'binding_state_unavailable'});
  }
  assert.equal(f.calls,0); assert.deepEqual(f.state(),{bindings:0,receipts:0,intents:1,revision:1});
});

test('unfinished POST body is time-bounded and cannot indefinitely hold shutdown or a verifier slot', async t => {
  const f = await fixture(t, { bodyTimeoutMs: 50 }), inspections = f.inspectCalls;
  const disconnected = new Promise(resolve => {
    const req = request(f.base + '/api/personal-test/intents', { method: 'POST', headers: {
      Cookie: f.a.cookie, Origin: f.base, 'Content-Type': 'application/json',
      'X-DalaHold-CSRF': f.a.status.csrfToken, 'Content-Length': '1000'
    } });
    req.on('error', () => resolve()); req.on('close', () => resolve());
    req.write('{'); // deliberately never end; the server must destroy this body
  });
  await disconnected; await f.close();
  assert.equal(f.inspectCalls, inspections); assert.equal(f.calls, 0);
  assert.deepEqual(f.state(), {bindings:0,receipts:0,intents:0,revision:0});
});
