import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { startParticipantWorkspace } from './participant-server.mjs';

const API = '/api/participants/v1';
const terms = { scenario: 'grain', quantity: 20, amount: 200_000, date: '2026-10-03' };

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-participant-http-'));
  let clock = Date.now();
  let stand = await startParticipantWorkspace({ directory, port: 0, now: () => clock });
  let origin = new URL(stand.url).origin;
  t.after(async () => { await stand.close(); rmSync(directory, { recursive: true, force: true }); });
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
        const set = response.headers.get('set-cookie');
        if (set) cookie = set.split(';')[0];
        const bytes = Buffer.from(await response.arrayBuffer());
        let data;
        try { data = JSON.parse(bytes.toString('utf8')); } catch { data = null; }
        if (data?.csrfToken) csrf = data.csrfToken;
        return { status: response.status, data, bytes, headers: response.headers };
      },
      async register() {
        assert.equal((await this.request(API + '/session')).status, 200);
        const result = await this.request(API + '/participants', {});
        assert.equal(result.status, 201); assert.equal(result.data.authenticated, true);
        return result.data;
      },
      async login(accessCode) {
        await this.request(API + '/session');
        return this.request(API + '/session/login', { accessCode });
      },
    };
  };
  async function pair() {
    const seller = client(), buyer = client(), outsider = client();
    const a = await seller.register(), b = await buyer.register(); await outsider.register();
    const made = await seller.request(API + '/deals', { requestId: randomUUID(), creatorRole: 'seller', ...terms });
    assert.equal(made.status, 201);
    const id = made.data.deal.id;
    const invited = await seller.request(`${API}/deals/${id}/invitations`, { expectedVersion: 1, participantId: b.participant.id });
    assert.equal(invited.status, 201);
    const claimed = await buyer.request(API + '/invitations/claims', { code: invited.data.code });
    assert.equal(claimed.status, 200);
    return { seller, buyer, outsider, id, a, b };
  }
  return { client, pair, get origin() { return origin; },
    tick(ms) { clock += ms; },
    async restart() { await stand.close(); stand = await startParticipantWorkspace({ directory, port: 0, now: () => clock }); origin = new URL(stand.url).origin; },
  };
}

async function detail(client, id) {
  const value = await client.request(`${API}/deals/${id}`);
  assert.equal(value.status, 200); return value.data.deal;
}
async function statement(client, deal, action, requestId = randomUUID()) {
  return client.request(`${API}/deals/${deal.id}/events`, {
    requestId, action, expectedVersion: deal.version,
    expectedStateRevision: deal.stateRevision, snapshotHash: deal.snapshotHash,
  });
}

test('independent listener denies every legacy/anonymous/private-file bypass', async t => {
  const f = await fixture(t), c = f.client();
  for (const path of ['/api/deals', '/api/test-workspace/status', '/personal/', '/test-workspace/',
    '/participants.sqlite', '/.local/participants.sqlite', '/nca-client.mjs', '/participants/../../README.md'])
    assert.equal((await c.request(path)).status, 404, path);
  assert.equal((await c.request(API + '/deals')).status, 401);
  await c.request(API + '/session');
  assert.equal((await c.request(API + '/deals')).status, 401);
  assert.equal((await c.request(API + '/participants', { role: 'seller' })).status, 400);
});

test('origin, CSRF, methods, query, body and error disclosure fail closed', async t => {
  const f = await fixture(t), c = f.client(); await c.request(API + '/session');
  assert.equal((await c.request(API + '/participants', {}, { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal((await c.request(API + '/participants', {}, { headers: { 'X-DalaHold-CSRF': '0'.repeat(64) } })).status, 403);
  const badHost = await new Promise((yes, no) => {
    const req = httpRequest(f.origin + API + '/session', { headers: { Host: 'evil.invalid' } }, res => {
      res.resume(); res.once('end', () => yes(res.statusCode));
    });
    req.once('error', no); req.end();
  });
  assert.equal(badHost, 403);
  assert.equal((await c.request(API + '/session', undefined, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await c.request(API + '/session?accessCode=never')).status, 404);
  assert.equal((await c.request(API + '/participants', '[]', { raw: true })).status, 400);
  assert.equal((await c.request(API + '/participants', '{', { raw: true })).status, 400);
  assert.equal((await c.request(API + '/participants', {}, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  const oversized = await c.request(API + '/participants', { padding: 'x'.repeat(380_000) });
  assert.equal(oversized.status, 413);
  const rejected = await c.request(API + '/session/login', { accessCode: 'wrong' });
  assert.equal(rejected.status, 401);
  assert.doesNotMatch(JSON.stringify(rejected.data), /sqlite|SELECT|stack|\/Volumes\/|\/Users\//);
});

test('registration rotation, code login, logout, expiry and restart sessions', async t => {
  const f = await fixture(t), c = f.client();
  const registered = await c.register();
  assert.match(registered.accessCode, /^[a-f0-9]{64}$/);
  const session = await c.request(API + '/session');
  assert.equal(session.data.participant.id, registered.participant.id);
  assert.equal(session.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(JSON.stringify(session.data), new RegExp(registered.accessCode));
  assert.equal((await c.request(API + '/participants', {})).status, 409);
  assert.equal((await c.request(API + '/session/logout', {})).status, 200);
  assert.equal((await c.request(API + '/deals')).status, 401);
  assert.equal((await c.login(registered.accessCode)).status, 200);
  f.tick(900_001);
  assert.equal((await c.request(API + '/deals')).status, 401);
  assert.equal((await c.request(API + '/session')).data.authenticated, false);
  assert.equal((await c.login(registered.accessCode)).status, 200);
  await f.restart();
  assert.equal((await c.request(API + '/deals')).status, 401);
  assert.equal((await c.login(registered.accessCode)).status, 200);
});

test('recipient-bound invitations refuse theft, self-claim, actor injection and expiry', async t => {
  const f = await fixture(t), a = f.client(), b = f.client(), c = f.client();
  const aa = await a.register(), bb = await b.register(); await c.register();
  const d = (await a.request(API + '/deals', { requestId: randomUUID(), creatorRole: 'seller', ...terms })).data.deal;
  assert.equal((await a.request(`${API}/deals/${d.id}/invitations`, { expectedVersion: 1, participantId: aa.participant.id })).status, 403);
  let invite = (await a.request(`${API}/deals/${d.id}/invitations`, { expectedVersion: 1, participantId: bb.participant.id })).data;
  assert.equal((await c.request(API + '/invitations/claims', { code: invite.code })).status, 404);
  assert.equal((await b.request(API + '/invitations/claims', { code: invite.code, actorId: aa.participant.id })).status, 400);
  f.tick(901_000);
  await b.login(bb.accessCode); await a.login(aa.accessCode);
  assert.notEqual((await b.request(API + '/invitations/claims', { code: invite.code })).status, 200);
  invite = (await a.request(`${API}/deals/${d.id}/invitations`, { expectedVersion: 1, participantId: bb.participant.id })).data;
  const accepted = await b.request(API + '/invitations/claims', { code: invite.code }); assert.equal(accepted.status, 200);
  const repeated = await b.request(API + '/invitations/claims', { code: invite.code });
  assert.equal(repeated.status, 200); assert.equal(repeated.data.historical, true);
});

test('all deal and document resources deny outsiders including cached replay', async t => {
  const f = await fixture(t), p = await f.pair();
  const bytes = Buffer.from('Anonymous TEST document\n');
  const input = { requestId: randomUUID(), expectedVersion: 1, category: 'contract', contentBase64: bytes.toString('base64') };
  const saved = await p.seller.request(`${API}/deals/${p.id}/documents`, input); assert.equal(saved.status, 201);
  const docId = saved.data.document.id;
  assert.equal((await p.outsider.request(API + '/deals')).data.deals.length, 0);
  for (const path of [`${API}/deals/${p.id}`, `${API}/deals/${p.id}/documents`, `${API}/deals/${p.id}/documents/${docId}`])
    assert.equal((await p.outsider.request(path)).status, 404);
  assert.equal((await p.outsider.request(`${API}/deals/${p.id}/documents`, input)).status, 404);
  const got = await p.buyer.request(`${API}/deals/${p.id}/documents/${docId}`);
  assert.equal(got.status, 200); assert.deepEqual(got.bytes, bytes);
  assert.equal(createHash('sha256').update(got.bytes).digest('hex'), saved.data.document.sha256);
  assert.match(got.headers.get('content-disposition'), /^attachment; filename="test-[a-f0-9-]+\.txt"$/);
  assert.equal(got.headers.get('cache-control'), 'no-store');
  assert.equal((await p.seller.request(`${API}/deals/${p.id}/documents`, { ...input, actorId: p.b.participant.id })).status, 400);
});

test('exact snapshot, server roles and one-time statement drive unsigned TEST flow', async t => {
  const f = await fixture(t), p = await f.pair();
  let d = await detail(p.seller, p.id);
  assert.equal((await statement(p.buyer, d, 'offer')).status, 403);
  assert.equal((await statement(p.seller, d, 'offer', randomUUID())).status, 201);
  d = await detail(p.buyer, p.id);
  const payload = { requestId: randomUUID(), action: 'agree', expectedVersion: d.version,
    expectedStateRevision: d.stateRevision, snapshotHash: d.snapshotHash };
  assert.equal((await p.buyer.request(`${API}/deals/${p.id}/events`, { ...payload, role: 'seller' })).status, 400);
  assert.equal((await p.outsider.request(`${API}/deals/${p.id}/events`, payload)).status, 404);
  assert.equal((await p.buyer.request(`${API}/deals/${p.id}/events`, { ...payload, snapshotHash: '0'.repeat(64) })).status, 409);
  const accepted = await p.buyer.request(`${API}/deals/${p.id}/events`, payload); assert.equal(accepted.status, 201);
  assert.equal((await p.buyer.request(`${API}/deals/${p.id}/events`, payload)).data.historical, true);
  assert.equal((await p.buyer.request(`${API}/deals/${p.id}/events`, { ...payload, action: 'accept' })).status, 409);
  d = accepted.data.deal;
  const handover = await statement(p.seller, d, 'handover'); assert.equal(handover.status, 201);
  const final = await statement(p.buyer, handover.data.deal, 'accept'); assert.equal(final.status, 201);
  assert.equal(final.data.deal.state, 'accepted');
  assert.equal((await detail(p.seller, p.id)).events.filter(e => ['offer', 'agree', 'handover', 'accept'].includes(e.action)).length, 4);
  for (const event of final.data.deal.events.filter(e => ['offer', 'agree', 'handover', 'accept'].includes(e.action)))
    assert.equal(event.source, 'unsigned_test_participant_statement');
  assert.equal((await statement(p.seller, final.data.deal, 'dispute')).status, 409);
});

test('offer freezes version/manifest and concurrent accept/dispute commits just once', async t => {
  const f = await fixture(t), p = await f.pair();
  let d = await detail(p.seller, p.id);
  const stale = { ...d };
  assert.equal((await p.seller.request(`${API}/deals/${p.id}/documents`, { requestId: randomUUID(), expectedVersion: 1,
    category: 'quality', contentBase64: Buffer.from('TEST quality\n').toString('base64') })).status, 201);
  assert.equal((await statement(p.seller, stale, 'offer')).status, 409);
  d = (await statement(p.seller, await detail(p.seller, p.id), 'offer')).data.deal;
  assert.equal((await p.seller.request(`${API}/deals/${p.id}/versions`, { requestId: randomUUID(), expectedVersion: 1, ...terms, amount: 1 })).status, 409);
  assert.equal((await p.seller.request(`${API}/deals/${p.id}/documents`, { requestId: randomUUID(), expectedVersion: 1,
    category: 'other', contentBase64: Buffer.from('TEST extra\n').toString('base64') })).status, 409);
  d = (await statement(p.buyer, d, 'agree')).data.deal;
  d = (await statement(p.seller, d, 'handover')).data.deal;
  const results = await Promise.all([statement(p.buyer, d, 'accept'), statement(p.seller, d, 'dispute')]);
  assert.deepEqual(results.map(x => x.status).sort(), [201, 409]);
  const final = await detail(p.buyer, p.id);
  assert.equal(final.events.filter(e => ['accept', 'dispute'].includes(e.action)).length, 1);
  assert.equal((await statement(p.seller, final, 'release')).status, 400);
});

test('private document and statements survive restart; sessions do not', async t => {
  const f = await fixture(t), p = await f.pair();
  const file = Buffer.from('TEST persisted attachment\n');
  const saved = await p.seller.request(`${API}/deals/${p.id}/documents`, { requestId: randomUUID(), expectedVersion: 1,
    category: 'contract', contentBase64: file.toString('base64') });
  const offer = await statement(p.seller, await detail(p.seller, p.id), 'offer');
  assert.equal(offer.status, 201);
  await f.restart();
  assert.equal((await p.seller.request(`${API}/deals/${p.id}`)).status, 401);
  assert.equal((await p.seller.login(p.a.accessCode)).status, 200);
  assert.equal((await p.buyer.login(p.b.accessCode)).status, 200);
  const read = await p.buyer.request(`${API}/deals/${p.id}/documents/${saved.data.document.id}`);
  assert.deepEqual(read.bytes, file);
  const d = await detail(p.buyer, p.id); assert.equal(d.state, 'offered');
  assert.equal(d.snapshotHash, offer.data.deal.snapshotHash);
  assert.equal((await statement(p.buyer, d, 'agree')).status, 201);
});

test('login rate cap returns safe retry header and never leaks code', async t => {
  const f = await fixture(t), c = f.client(); await c.request(API + '/session');
  let result;
  for (let n = 0; n < 21; n++) result = await c.request(API + '/session/login', { accessCode: 'f'.repeat(64) });
  assert.equal(result.status, 429); assert.equal(result.headers.get('retry-after'), '60');
  assert.doesNotMatch(JSON.stringify(result.data), /f{64}/);
});
