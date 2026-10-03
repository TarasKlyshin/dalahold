// In-process model SDK + isolated loopback fixtures. Not real signatures/UAT.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSignedParticipantWorkspace } from './signed-participant-server.mjs';
import { startParticipantWorkspace } from './participant-server.mjs';

const API = '/api/participants/v1';
const SCOPE = 'local_personal_test_signed_deal_only';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const terms = { scenario: 'grain', quantity: 20, amount: 200000, date: '2026-10-03' };
const privateKeys = new Set(['personId', 'organizationId', 'iin', 'bin', 'subject', 'cms',
  'sessionHash', 'mappingKeyId', 'key', 'wireBytes', 'grant']);
function safePublic(value) {
  return !value || typeof value !== 'object' || Object.entries(value)
    .every(([key, child]) => !privateKeys.has(key) && safePublic(child));
}

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-signed-http-'));
  let clock = Date.now(), calls = 0, hook = null, available = true;
  const sdk = { statusSource: 'test_ocsp',
    async inspect() { return { ready: true, statusSource: 'test_ocsp', validUntil: clock + 600000,
      chain: ['-----BEGIN CERTIFICATE-----\nTEST ROOT\n-----END CERTIFICATE-----',
        '-----BEGIN CERTIFICATE-----\nTEST CA\n-----END CERTIFICATE-----'] }; },
    async verifyIdentity(bytes, cms, key) {
      calls++; if (hook) await hook();
      if (!available) throw new Error('verifier_unavailable');
      const model = JSON.parse(cms.toString('utf8'));
      if (model.hash !== hash(bytes)) return { verified: false };
      return { verified: true, statusSource: 'test_ocsp', validUntil: clock + 300000,
        certificateDigest: hash(`MODEL certificate ${model.certificate || model.person}`),
        identity: { schema: 'nca_test_subject_v1',
          personId: `person:${createHmac('sha256', key).update(model.person).digest('hex')}`,
          organizationId: model.corporate ? `organization:${'a'.repeat(64)}` : null } };
    } };
  let stand = await startSignedParticipantWorkspace({ directory, port: 0, sdk, now: () => clock });
  let origin = new URL(stand.url).origin;
  t.after(async () => { await stand.close(); rmSync(directory, { recursive: true, force: true }); });
  const client = () => {
    let cookie = '', csrf = '';
    return {
      async request(path, body, extraHeaders = {}) {
        const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST',
          headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : {
            Origin: origin, 'Content-Type': 'application/json', 'X-DalaHold-CSRF': csrf }), ...extraHeaders },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual' });
        const header = response.headers.get('set-cookie'); if (header) cookie = header.split(';')[0];
        let data; try { data = await response.json(); } catch { data = null; }
        if (data?.csrfToken) csrf = data.csrfToken;
        return { status: response.status, data, headers: response.headers };
      },
      async register() {
        await this.request(API + '/session');
        const result = await this.request(API + '/participants', {});
        assert.equal(result.status, 201); return result.data;
      },
      async enroll(person, properties = {}) {
        const issued = await this.request(API + '/identity-intents', {});
        assert.equal(issued.status, 201);
        const cms = modelCms(issued.data.intent, person, properties);
        return this.request(API + '/signature-receipts', { intentId: issued.data.intent.id, cms });
      },
    };
  };
  return { client, sdk, directory, get calls() { return calls; },
    tick(ms) { clock += ms; }, setHook(fn) { hook = fn; }, unavailable() { available = false; },
    async restart() { await stand.close(); stand = await startSignedParticipantWorkspace({ directory, port: 0, sdk, now: () => clock }); origin = new URL(stand.url).origin; } };
}

function modelCms(intent, person, properties = {}) {
  assert.equal(hash(Buffer.from(intent.bytesBase64, 'base64')), intent.hash);
  assert.equal(Buffer.from(intent.bytesBase64, 'base64').toString('utf8'), intent.text);
  return Buffer.from(JSON.stringify({ hash: intent.hash, person, ...properties })).toString('base64');
}
async function pair(f) {
  const seller = f.client(), buyer = f.client(), outsider = f.client();
  const a = await seller.register(), b = await buyer.register(); await outsider.register();
  assert.equal((await seller.enroll('MODEL seller')).status, 200);
  assert.equal((await buyer.enroll('MODEL buyer')).status, 200);
  const made = await seller.request(API + '/deals', { requestId: randomUUID(), creatorRole: 'seller', ...terms });
  assert.equal(made.status, 201);
  const id = made.data.deal.id;
  const invitation = await seller.request(`${API}/deals/${id}/invitations`, { expectedVersion: 1, participantId: b.participant.id });
  assert.equal((await buyer.request(API + '/invitations/claims', { code: invitation.data.code })).status, 200);
  return { seller, buyer, outsider, a, b, id };
}
async function issue(client, id, action) {
  const result = await client.request(`${API}/deals/${id}`); assert.equal(result.status, 200);
  const deal = result.data.deal;
  return client.request(`${API}/deals/${id}/signature-intents`, { requestId: randomUUID(), action,
    expectedVersion: deal.version, expectedStateRevision: deal.stateRevision, snapshotHash: deal.snapshotHash });
}
async function action(client, id, verb, person) {
  const issued = await issue(client, id, verb); assert.equal(issued.status, 201);
  const input = { intentId: issued.data.intent.id, cms: modelCms(issued.data.intent, person) };
  return { input, result: await client.request(API + '/signature-receipts', input) };
}

test('signed listener bootstraps separate scope and refuses unsigned/API/secret bypasses', async t => {
  const f = await fixture(t), c = f.client();
  const initial = await c.request(API + '/session');
  assert.equal(initial.data.scope, SCOPE); assert.equal(initial.data.signing.enabled, true);
  await c.register();
  assert.equal((await c.request(API + '/signing')).data.anchorEnabled, false);
  assert.equal((await c.request(API + '/identity')).data.binding, null);
  for (const path of ['/api/deals', '/api/test-workspace/status', '/personal/', '/.local/participants.sqlite', '/api/participants/v1/grants', '/api/participants/v1/broadcast'])
    assert.equal((await c.request(path)).status, 404);
  assert.equal((await c.request(API + '/identity-intents', { actorId: randomUUID() })).status, 400);
  assert.equal((await c.request(API + '/identity-intents', {}, { Origin: 'https://wrong.invalid' })).status, 403);
});

test('fresh enrolled TEST certificate is private; duplicate person/corporate/changed cert refuses', async t => {
  const f = await fixture(t), a = f.client(), b = f.client(); await a.register(); await b.register();
  const enrolled = await a.enroll('MODEL person'); assert.equal(enrolled.status, 200);
  assert.equal(enrolled.data.historical, false); assert.equal(safePublic(enrolled.data), true);
  assert.equal((await b.enroll('MODEL person')).status, 409);
  assert.notEqual((await b.enroll('MODEL corporate', { corporate: true })).status, 200);
  assert.notEqual((await a.enroll('MODEL person', { certificate: 'MODEL replacement' })).status, 200);
  const identity = await a.request(API + '/identity');
  assert.equal(identity.data.binding.certificateDigest, enrolled.data.receipt.certificateDigest);
  assert.equal(safePublic(identity.data), true);
});

test('two model TEST identities use exact role-bound CMS for every transition', async t => {
  const f = await fixture(t), p = await pair(f);
  const before = await p.seller.request(`${API}/deals/${p.id}`);
  const d = before.data.deal;
  const unsigned = { requestId: randomUUID(), action: 'offer', expectedVersion: d.version,
    expectedStateRevision: d.stateRevision, snapshotHash: d.snapshotHash };
  assert.equal((await p.seller.request(`${API}/deals/${p.id}/events`, unsigned)).status, 403);
  assert.equal((await issue(p.buyer, p.id, 'offer')).status, 403);
  assert.equal((await p.outsider.request(`${API}/deals/${p.id}`)).status, 404);
  let first;
  for (const [client, verb, person] of [[p.seller, 'offer', 'MODEL seller'], [p.buyer, 'agree', 'MODEL buyer'],
    [p.seller, 'handover', 'MODEL seller'], [p.buyer, 'accept', 'MODEL buyer']]) {
    const { result, input } = await action(client, p.id, verb, person);
    assert.equal(result.status, 200); assert.equal(result.data.historical, false);
    assert.equal(result.data.receipt.scope, SCOPE); assert.equal(safePublic(result.data), true);
    assert.equal(result.data.deal.events.at(-1).source, 'personal_test_nca_statement');
    if (!first) first = { input, receipt: result.data.receipt };
  }
  const terminal = (await p.buyer.request(`${API}/deals/${p.id}`)).data.deal;
  assert.equal(terminal.state, 'accepted'); assert.equal(terminal.events.length, 4);
  const calls = f.calls;
  const historical = await p.seller.request(API + '/signature-receipts', first.input);
  assert.equal(historical.status, 200); assert.equal(historical.data.historical, true);
  assert.deepEqual(historical.data.receipt, first.receipt); assert.equal(f.calls, calls);
  assert.equal(historical.data.deal.state, 'accepted');
  assert.notEqual((await p.buyer.request(`${API}/deals/${p.id}/anchor-intents`, {
    expectedVersion: terminal.version, expectedStateRevision: terminal.stateRevision, snapshotHash: terminal.snapshotHash })).status, 201);
});

test('wrong signer and changed intent bytes cannot commit or consume the valid signature', async t => {
  const f = await fixture(t), p = await pair(f);
  const issued = await issue(p.seller, p.id, 'offer'); assert.equal(issued.status, 201);
  const intent = issued.data.intent;
  assert.notEqual((await p.seller.request(API + '/signature-receipts', {
    intentId: intent.id, cms: modelCms(intent, 'MODEL buyer') })).status, 200);
  const changed = { ...intent, hash: hash('changed instructions') };
  const badCms = Buffer.from(JSON.stringify({ hash: changed.hash, person: 'MODEL seller' })).toString('base64');
  assert.notEqual((await p.seller.request(API + '/signature-receipts', { intentId: intent.id, cms: badCms })).status, 200);
  const good = { intentId: intent.id, cms: modelCms(intent, 'MODEL seller') };
  assert.equal((await p.buyer.request(API + '/signature-receipts', good)).status, 404);
  assert.equal((await p.seller.request(API + '/signature-receipts', good)).status, 200);
  assert.equal((await p.seller.request(`${API}/deals/${p.id}`)).data.deal.events.length, 1);
});

test('manifest change after issuance refuses old CMS; terminal dispute freezes the deal', async t => {
  const f = await fixture(t), p = await pair(f);
  const issued = await issue(p.seller, p.id, 'offer'); assert.equal(issued.status, 201);
  assert.equal((await p.seller.request(`${API}/deals/${p.id}/documents`, { requestId: randomUUID(), expectedVersion: 1,
    category: 'contract', contentBase64: Buffer.from('ANONYMIZED TEST').toString('base64') })).status, 201);
  assert.notEqual((await p.seller.request(API + '/signature-receipts', {
    intentId: issued.data.intent.id, cms: modelCms(issued.data.intent, 'MODEL seller') })).status, 200);
  assert.equal((await action(p.seller, p.id, 'offer', 'MODEL seller')).result.status, 200);
  assert.equal((await action(p.buyer, p.id, 'agree', 'MODEL buyer')).result.status, 200);
  assert.equal((await action(p.seller, p.id, 'dispute', 'MODEL seller')).result.status, 200);
  assert.notEqual((await issue(p.seller, p.id, 'handover')).status, 201);
  const deal = (await p.seller.request(`${API}/deals/${p.id}`)).data.deal;
  assert.equal(deal.state, 'disputed'); assert.equal(deal.events.length, 3);
});

test('closed HTTP session during verifier await rolls back binding enrollment', async t => {
  const f = await fixture(t), c = f.client(); await c.register();
  const issued = await c.request(API + '/identity-intents', {}); assert.equal(issued.status, 201);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.setHook(() => new Promise(resolve => { release = resolve; entered(); }));
  const pending = c.request(API + '/signature-receipts', { intentId: issued.data.intent.id,
    cms: modelCms(issued.data.intent, 'MODEL delayed') });
  await started;
  assert.equal((await c.request(API + '/session/logout', {})).status, 200);
  release(); assert.equal((await pending).status, 401);
});

test('unsigned and signed DB kinds cannot silently reopen each other', async t => {
  const f = await fixture(t);
  await assert.rejects(startParticipantWorkspace({ directory: f.directory, port: 0 }), /incompatible_store/);
});

test('restart preserves TEST certificate/membership but not browser sessions', async t => {
  const f = await fixture(t), c = f.client(); const account = await c.register();
  assert.equal((await c.enroll('MODEL restart')).status, 200);
  const original = (await c.request(API + '/identity')).data.binding;
  await f.restart(); assert.equal((await c.request(API + '/identity')).status, 401);
  await c.request(API + '/session');
  assert.equal((await c.request(API + '/session/login', { accessCode: account.accessCode })).status, 200);
  assert.deepEqual((await c.request(API + '/identity')).data.binding, original);
});
