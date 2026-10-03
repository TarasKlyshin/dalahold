import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ACTION_LABELS, PARTICIPANT_API, PARTICIPANT_SCOPE, availableActions, buildCreateDeal, buildStatement,
  buildVersion, createParticipantController, exportParticipantDeal, mountParticipantCabinet, readParticipantDocument, statementPreview, validateDeal, validateTerms } from './participant-client.mjs';

const TIME = Date.UTC(2026, 9, 3, 10);
const SELLER = '11111111-1111-4111-8111-111111111111';
const BUYER = '22222222-2222-4222-8222-222222222222';
const DEAL = '33333333-3333-4333-8333-333333333333';
const REQUEST = '44444444-4444-4444-8444-444444444444';
const EVENT = '55555555-5555-4555-8555-555555555555';
const DOC = '66666666-6666-4666-8666-666666666666';
const person = id => ({ id, label: id === SELLER ? 'TEST participant 001' : 'TEST participant 002' });
const terms = { scenario: 'grain', quantity: 12, amount: 800000, date: '2026-10-10' };
const document = { id: DOC, dealId: DEAL, termsVersion: 1, category: 'contract', byteLength: 4,
  sha256: 'd'.repeat(64), createdAt: TIME, scope: 'local_test_document_only', fileKind: 'text' };
const event = { id: EVENT, dealId: DEAL, action: 'offer', actorId: SELLER, role: 'seller', termsVersion: 1,
  stateRevision: 1, snapshotHash: 'b'.repeat(64), termsFingerprint: 'a'.repeat(64), documentManifestHash: 'c'.repeat(64),
  createdAt: TIME, stateFrom: 'draft', stateTo: 'offered', source: 'unsigned_test_participant_statement', scope: PARTICIPANT_SCOPE };
function fixture(changes = {}) {
  return { id: DEAL, creatorId: SELLER, version: 1, ...terms, state: 'draft', stateRevision: 0,
    termsFingerprint: 'a'.repeat(64), role: 'seller', participants: [{ ...person(SELLER), role: 'seller' }, { ...person(BUYER), role: 'buyer' }],
    documents: [], documentHistory: [], events: [], scope: PARTICIPANT_SCOPE, snapshotHash: 'b'.repeat(64), ...changes };
}
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(value) });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function harness({ authenticated = true, route, initial = fixture() } = {}) {
  const calls = [], secrets = [], views = []; let time = TIME;
  const session = () => ({ authenticated, csrfToken: 'e'.repeat(64), expiresAt: time + 900000, scope: PARTICIPANT_SCOPE,
    ...(authenticated ? { participant: person(SELLER) } : {}) });
  const controller = createParticipantController({ now: () => time, randomUUID: () => REQUEST,
    onChange: value => views.push(value), onSecret: value => secrets.push(value),
    fetchImpl: async (path, options) => {
      const call = { path, options }; calls.push(call);
      const override = route?.(call, calls); if (override !== undefined) return await override;
      if (path === PARTICIPANT_API + '/session') return response(session());
      if (path === PARTICIPANT_API + '/deals' && !options.method) return response({ deals: [initial] });
      if (path === PARTICIPANT_API + `/deals/${DEAL}`) return response({ deal: initial });
      throw new Error('unexpected fixture route');
    } });
  await controller.bootstrap();
  return { controller, calls, secrets, views, advance(ms) { time += ms; controller.tick(); } };
}
function domFixture() {
  const html = readFileSync(new URL('./participant.html', import.meta.url), 'utf8'), elements = new Map();
  const make = (tag, attributes = new Map()) => {
    const listeners = new Map(), classes = new Set();
    return { tagName: tag.toUpperCase(), value: attributes.get('value') || '', type: attributes.get('type') || '',
      textContent: '', hidden: attributes.has('hidden'), disabled: attributes.has('disabled'), checked: false, files: [], children: [],
      setAttribute(name, value) { attributes.set(name, value); }, getAttribute(name) { return attributes.get(name) ?? null; },
      classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } },
      replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); },
      addEventListener(name, callback) { listeners.set(name, callback); }, removeEventListener(name, callback) { if (listeners.get(name) === callback) listeners.delete(name); },
      click() { if (!this.disabled) return listeners.get('click')?.({ preventDefault() {} }); },
      dispatch(name) { if (!this.disabled) return listeners.get(name)?.({ preventDefault() {} }); }, focus() {}, remove() {},
    };
  };
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const attributes = new Map(); for (const attr of match[2].matchAll(/([a-z][\w-]*)(?:="([^"]*)")?/gi)) attributes.set(attr[1], attr[2] ?? '');
    if (attributes.has('id')) elements.set(attributes.get('id'), make(match[1], attributes));
  }
  const $ = name => elements.get(`pp-${name}`);
  for (const [name, value] of [['create-role', 'seller'], ['create-scenario', 'grain'], ['edit-scenario', 'grain'], ['category', 'contract']]) $(name).value = value;
  return { $, getElementById: id => elements.get(id), createElement: tag => make(tag), body: make('body') };
}

test('request builders validate dates, integers, server roles and exact statement snapshot', () => {
  assert.deepEqual(buildCreateDeal({ creatorRole: 'buyer', ...terms }, REQUEST), { requestId: REQUEST, creatorRole: 'buyer', ...terms });
  assert.deepEqual(buildVersion(fixture(), terms, REQUEST), { requestId: REQUEST, expectedVersion: 1, ...terms });
  assert.deepEqual(buildStatement(fixture(), 'offer', REQUEST, true), { requestId: REQUEST, action: 'offer',
    expectedVersion: 1, expectedStateRevision: 0, snapshotHash: 'b'.repeat(64) });
  for (const change of [{ quantity: '12' }, { quantity: 1.5 }, { amount: 0 }, { date: '2026-02-30' }, { scenario: 'payment' }]) assert.throws(() => validateTerms({ ...terms, ...change }));
  assert.throws(() => buildStatement(fixture(), 'offer', REQUEST, false), /statement_consent_required/);
  assert.throws(() => buildStatement(fixture({ role: 'buyer' }), 'offer', REQUEST, true), /forbidden/);
  assert.throws(() => buildVersion(fixture({ state: 'offered' }), terms, REQUEST), /forbidden/);
  assert.throws(() => buildVersion(fixture({ role: 'buyer' }), terms, REQUEST), /forbidden/);
});

test('actions require both distinct roles and stop in terminal states', () => {
  assert.deepEqual(availableActions(fixture({ participants: [{ ...person(SELLER), role: 'seller' }] })), []);
  assert.deepEqual(availableActions(fixture({ role: 'buyer', state: 'offered' })), ['agree']);
  assert.deepEqual(availableActions(fixture({ state: 'agreed' })), ['handover', 'dispute']);
  assert.deepEqual(availableActions(fixture({ role: 'buyer', state: 'handed_over' })), ['accept', 'dispute']);
  for (const state of ['accepted', 'disputed']) assert.deepEqual(availableActions(fixture({ state })), []);
  assert.throws(() => validateDeal(fixture({ participants: [{ ...person(SELLER), role: 'seller' }, { ...person(SELLER), role: 'buyer' }] })), /invalid_response/);
  assert.throws(() => validateDeal(fixture({ scope: 'actual_transaction' })), /invalid_response/);
});

test('preview displays exact terms, participants, current document bytes metadata and snapshot hash', () => {
  const deal = fixture({ documents: [document], documentHistory: [document] });
  const preview = JSON.parse(statementPreview(deal, 'offer'));
  assert.deepEqual(preview.terms, { version: 1, ...terms });
  assert.deepEqual(preview.documents, [document]); assert.deepEqual(preview.participants, deal.participants);
  assert.equal(preview.snapshotHash, deal.snapshotHash); assert.equal(preview.source, 'unsigned_test_participant_statement');
  for (const label of Object.values(ACTION_LABELS)) assert.match(label, /TEST.+без ЭЦП/);
});

test('text file is not read before consent, enforces byte limit and rejects binary/control content', async () => {
  let reads = 0;
  const file = bytes => ({ name: 'private-fixture.txt', type: 'text/plain', size: bytes.length,
    async arrayBuffer() { reads += 1; return Uint8Array.from(bytes).buffer; } });
  await assert.rejects(readParticipantDocument(file(Buffer.from('Тест')), false), /consent_required/); assert.equal(reads, 0);
  const result = await readParticipantDocument(file(Buffer.from('Тест\n')), true);
  assert.deepEqual(result, { contentBase64: Buffer.from('Тест\n').toString('base64') });
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from([0]), Buffer.from('%PDF-1.7')]) await assert.rejects(readParticipantDocument(file(bytes), true), /invalid_file/);
  await assert.rejects(readParticipantDocument({ ...file(Buffer.from('x')), size: 262145 }, true), /invalid_file/);
  await assert.rejects(readParticipantDocument({ ...file(Buffer.from('x')), name: 'x.pdf' }, true), /invalid_file/);
});

test('export whitelists every level and excludes injected credentials, request bodies and session', () => {
  const dangerous = fixture({ documents: [{ ...document, accessCode: 'DO-NOT-EXPORT' }],
    documentHistory: [{ ...document, csrfToken: 'DO-NOT-EXPORT' }], state: 'offered', stateRevision: 1,
    events: [{ ...event, code: 'DO-NOT-EXPORT', body: { private: 'DO-NOT-EXPORT' } }],
    participants: fixture().participants.map(item => ({ ...item, accessCode: 'DO-NOT-EXPORT' })),
    session: { csrfToken: 'DO-NOT-EXPORT' }, invitationCode: 'DO-NOT-EXPORT', accessCode: 'DO-NOT-EXPORT' });
  const text = exportParticipantDeal(dangerous), parsed = JSON.parse(text);
  assert.doesNotMatch(text, /DO-NOT-EXPORT|csrfToken|accessCode|invitationCode|"session"|"body"/);
  assert.deepEqual(parsed.deal, validateDeal(dangerous)); assert.equal(parsed.scope, PARTICIPANT_SCOPE);
});

test('anonymous registration and login use CSRF, rotate session, and expose new code only via one-time callback', async () => {
  const h = await harness({ authenticated: false, route(call) {
    if (call.path.endsWith('/participants')) return response({ authenticated: true, scope: PARTICIPANT_SCOPE, participant: person(SELLER), accessCode: '9'.repeat(64),
      csrfToken: 'f'.repeat(64), expiresAt: TIME + 900000 }, 201);
  } });
  await h.controller.register();
  const call = h.calls.find(item => item.options.method === 'POST');
  assert.equal(call.options.headers['X-DalaHold-CSRF'], 'e'.repeat(64)); assert.equal(call.options.body, '{}');
  assert.equal(call.options.credentials, 'same-origin'); assert.equal(call.options.redirect, 'error');
  assert.equal(h.controller.getState().authenticated, true); assert.equal(h.secrets.filter(item => item?.kind === 'access').length, 1);
  assert.doesNotMatch(JSON.stringify(h.controller.getState()), new RegExp('9'.repeat(64) + '|csrfToken|"body"'));
  const login = await harness({ authenticated: false, route(call) {
    if (call.path.endsWith('/session/login')) return response({ authenticated: true, scope: PARTICIPANT_SCOPE, participant: person(SELLER), csrfToken: 'f'.repeat(64), expiresAt: TIME + 900000 });
  } });
  await login.controller.login('PRIVATE-LOGIN-FIXTURE');
  assert.deepEqual(JSON.parse(login.calls.find(item => item.options.method === 'POST').options.body), { accessCode: 'PRIVATE-LOGIN-FIXTURE' });
  assert.equal(login.controller.getState().authenticated, true); assert.doesNotMatch(JSON.stringify(login.views), /PRIVATE-LOGIN-FIXTURE/);
});

test('new masked access code survives account transition and timer renders, hides once, and clears on deal selection', async () => {
  const dom = domFixture(); let tick;
  const mounted = mountParticipantCabinet(dom, { now: () => TIME, randomUUID: () => REQUEST,
    setIntervalImpl(callback) { tick = callback; return 1; }, clearIntervalImpl() {},
    fetchImpl: async path => {
      if (path.endsWith('/session')) return response({ authenticated: false, scope: PARTICIPANT_SCOPE, csrfToken: 'e'.repeat(64), expiresAt: TIME + 900000 });
      if (path.endsWith('/participants')) return response({ authenticated: true, scope: PARTICIPANT_SCOPE, participant: person(SELLER),
        accessCode: '9'.repeat(64), csrfToken: 'f'.repeat(64), expiresAt: TIME + 900000 }, 201);
      if (path.endsWith('/deals')) return response({ deals: [] });
      if (path.endsWith(`/deals/${DEAL}`)) return response({ deal: fixture() });
      throw new Error('unexpected fixture route');
    } });
  await mounted.initialized; await dom.$('register').click();
  assert.equal(dom.$('access-secret').hidden, false); assert.equal(dom.$('new-access-code').type, 'password');
  assert.equal(dom.$('new-access-code').value.length, 64); tick(); tick();
  assert.equal(dom.$('new-access-code').value.length, 64); assert.equal(dom.$('access-secret').hidden, false);
  dom.$('hide-access').click(); tick(); assert.equal(dom.$('new-access-code').value, ''); assert.equal(dom.$('access-secret').hidden, true);
  // The reveal toggle never restores a hidden one-time code.
  dom.$('reveal-access').click(); assert.equal(dom.$('new-access-code').value, '');
  await mounted.controller.loadDeal(DEAL); assert.equal(dom.$('access-secret').hidden, true); assert.equal(dom.$('new-access-code').value, '');
  mounted.dispose();
});

test('registration ambiguity cannot create a second participant through retry', async () => {
  const h = await harness({ authenticated: false, route(call) { if (call.options.method === 'POST') throw new Error('lost registration response'); } });
  await h.controller.register(); assert.equal(h.controller.getState().pending.kind, 'register');
  assert.throws(() => h.controller.retry(), /registration_recovery_required/);
  assert.equal(h.calls.filter(item => item.options.method === 'POST').length, 1); assert.match(h.controller.getState().message, /потерянный код не восстанавливается/);
});

test('sessions reject missing scope and registration rejects mismatched authentication and nonhex secrets', async () => {
  const bad = await harness({ route(call) { if (call.path.endsWith('/session')) return response({ authenticated: true, participant: person(SELLER), csrfToken: 'e'.repeat(64), expiresAt: TIME + 900000 }); } });
  assert.equal(bad.controller.getState().sessionReady, false);
  for (const changes of [{ authenticated: false }, { accessCode: 'invalid-secret-format' }, { scope: 'other' }]) {
    const h = await harness({ authenticated: false, route(call) {
      if (call.path.endsWith('/participants')) return response({ authenticated: true, scope: PARTICIPANT_SCOPE, participant: person(SELLER),
        accessCode: '9'.repeat(64), csrfToken: 'f'.repeat(64), expiresAt: TIME + 900000, ...changes }, 201);
    } });
    await h.controller.register(); assert.equal(h.controller.getState().authenticated, false); assert.equal(h.controller.getState().pending.ambiguous, true);
    assert.equal(h.secrets.filter(item => item?.kind === 'access').length, 0);
  }
});

test('ambiguous write blocks new writes and explicit retry sends identical path, bytes, ID and CSRF', async () => {
  let attempts = 0;
  const h = await harness({ route(call) {
    if (call.path.endsWith('/deals') && call.options.method === 'POST') {
      attempts += 1; if (attempts === 1) throw new Error('lost response');
      return response({ deal: fixture() }, 201);
    }
  } });
  await h.controller.createDeal({ creatorRole: 'seller', ...terms });
  assert.equal(h.controller.getState().pending.ambiguous, true);
  assert.throws(() => h.controller.createDeal({ creatorRole: 'buyer', ...terms }), /pending_write/);
  assert.equal(attempts, 1); await h.controller.retry();
  const writes = h.calls.filter(item => item.options.method === 'POST');
  assert.equal(writes.length, 2); assert.equal(writes[0].path, writes[1].path);
  assert.equal(writes[0].options.body, writes[1].options.body); assert.deepEqual(writes[0].options.headers, writes[1].options.headers);
  assert.equal(JSON.parse(writes[1].options.body).requestId, REQUEST);
  assert.equal(h.controller.getState().pending, null); assert.equal(h.controller.getState().deal.id, DEAL);
});

test('malformed success and server 5xx remain ambiguous and do not retry automatically', async () => {
  for (const reply of [{ ok: true, status: 201, json: async () => { throw new Error('truncated'); } },
    response({ error: { code: 'server_error', message: 'fixture' } }, 503), response({ deal: { scope: 'wrong' } }, 201)]) {
    const h = await harness({ route(call) { if (call.options.method === 'POST') return reply; } });
    await h.controller.createDeal({ creatorRole: 'seller', ...terms });
    assert.equal(h.controller.getState().pending.ambiguous, true); assert.equal(h.calls.filter(item => item.options.method === 'POST').length, 1);
  }
});

test('stale retry preserves original payload and reloads detail without generating a replacement statement', async () => {
  let attempts = 0;
  const changed = fixture({ version: 2, quantity: 14, snapshotHash: 'c'.repeat(64) });
  const h = await harness({ route(call) {
    if (call.path.endsWith('/events')) { attempts += 1; if (attempts === 1) throw new Error('lost response'); return response({ error: { code: 'stale_deal', message: 'fixture' } }, 409); }
    if (call.path.endsWith(`/deals/${DEAL}`) && attempts === 2) return response({ deal: changed });
  } });
  await h.controller.loadDeal(DEAL); await h.controller.statement('offer', true);
  const original = h.calls.find(item => item.path.endsWith('/events')).options.body;
  await h.controller.retry();
  const writes = h.calls.filter(item => item.options.method === 'POST'); assert.equal(writes.length, 2);
  assert.equal(writes[1].options.body, original); assert.equal(h.controller.getState().deal.version, 2);
  assert.equal(h.controller.getState().pending, null); assert.equal(h.controller.getState().issue, true);
});

test('historical statement response is displayed as prior evidence and no additional POST is sent', async () => {
  const offered = fixture({ state: 'offered', stateRevision: 1, events: [event] });
  const h = await harness({ route(call) { if (call.path.endsWith('/events')) return response({ event, historical: true, deal: offered }); } });
  await h.controller.loadDeal(DEAL); await h.controller.statement('offer', true);
  assert.match(h.controller.getState().message, /прежняя запись/); assert.equal(h.controller.getState().deal.state, 'offered');
  assert.equal(h.calls.filter(item => item.options.method === 'POST').length, 1);
});

test('historical version receipt reloads current state and cannot reopen an offered draft', async () => {
  let revised = false;
  const offered = fixture({ state: 'offered', stateRevision: 1, events: [event] });
  const h = await harness({ route(call) {
    if (call.path.endsWith('/versions')) { revised = true; return response({ deal: { ...fixture(), historical: true } }); }
    if (revised && call.path.endsWith(`/deals/${DEAL}`)) return response({ deal: offered });
  } });
  await h.controller.loadDeal(DEAL); await h.controller.reviseDeal(terms);
  assert.equal(h.controller.getState().deal.state, 'offered'); assert.match(h.controller.getState().message, /прежний запрос/);
  assert.throws(() => h.controller.reviseDeal(terms), /forbidden/);
});

test('confirmed write followed by read401 clears account and loaded data without replaying the write', async () => {
  let uploaded = false;
  const h = await harness({ route(call) {
    if (call.path.endsWith('/documents')) { uploaded = true; return response({ document }, 201); }
    if (uploaded && call.path.endsWith(`/deals/${DEAL}`)) return response({ error: { code: 'unauthorized', message: 'fixture' } }, 401);
  } });
  await h.controller.loadDeal(DEAL); const bytes = Buffer.from('TEST');
  await h.controller.uploadDocument({ name: 'fixture.txt', type: 'text/plain', size: 4, arrayBuffer: async () => Uint8Array.from(bytes).buffer }, 'contract', true);
  assert.equal(h.controller.getState().authenticated, false); assert.equal(h.controller.getState().deal, null);
  assert.equal(h.controller.getState().ended, true); assert.equal(h.controller.getState().pending, null);
  assert.equal(h.calls.filter(item => item.options.method === 'POST').length, 1); assert.match(h.controller.getState().message, /Запись подтверждена/);
});

test('recipient-bound invitation sends target UUID, displays code once and never puts code in view/export', async () => {
  const oneParty = fixture({ participants: [{ ...person(SELLER), role: 'seller' }] });
  const h = await harness({ initial: oneParty, route(call) {
    if (call.path.endsWith('/invitations')) return response({ code: '8'.repeat(64), expiresAt: TIME + 300000 }, 201);
  } });
  await h.controller.loadDeal(DEAL); await h.controller.inviteParticipant(BUYER);
  const call = h.calls.find(item => item.options.method === 'POST');
  assert.deepEqual(JSON.parse(call.options.body), { expectedVersion: 1, participantId: BUYER });
  assert.equal(h.secrets.filter(item => item?.kind === 'invitation').length, 1);
  assert.doesNotMatch(JSON.stringify(h.views), new RegExp('8'.repeat(64))); assert.doesNotMatch(h.controller.exportDeal(), new RegExp('8'.repeat(64)));
  assert.throws(() => h.controller.inviteParticipant(SELLER), /invalid_participant/);
});

test('document POST pins the permitted bytes without filename and refreshes current snapshot', async () => {
  let upload;
  const updated = fixture({ documents: [document], documentHistory: [document], snapshotHash: 'c'.repeat(64) });
  const h = await harness({ route(call) {
    if (call.path.endsWith('/documents')) { upload = call; return response({ document }, 201); }
    if (upload && call.path.endsWith(`/deals/${DEAL}`)) return response({ deal: updated });
  } });
  await h.controller.loadDeal(DEAL);
  const bytes = Buffer.from('TEST');
  await h.controller.uploadDocument({ name: 'private-filename.txt', type: 'text/plain', size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer }, 'contract', true);
  assert.deepEqual(JSON.parse(upload.options.body), { requestId: REQUEST, expectedVersion: 1, category: 'contract', contentBase64: bytes.toString('base64') });
  assert.doesNotMatch(upload.options.body, /private-filename/); assert.equal(h.controller.getState().deal.snapshotHash, updated.snapshotHash);
});

test('expiry clears loaded data and secrets, rejects writes, ignores late success and never auto-authenticates', async () => {
  const wait = deferred();
  const h = await harness({ route(call) { if (call.options.method === 'POST') return wait.promise; } });
  await h.controller.loadDeal(DEAL); const inflight = h.controller.statement('offer', true);
  h.advance(900001); const ended = h.controller.getState();
  assert.equal(ended.authenticated, false); assert.equal(ended.deal, null); assert.deepEqual(ended.deals, []);
  assert.equal(ended.pending, null); assert.equal(ended.ended, true); assert.equal(h.secrets.at(-1), null);
  wait.resolve(response({ event, historical: false, deal: fixture({ state: 'offered', stateRevision: 1, events: [event] }) })); await inflight;
  assert.equal(h.controller.getState().deal, null); assert.throws(() => h.controller.statement('offer', true), /session_ended/);
  await assert.rejects(h.controller.bootstrap(), /session_ended/);
  assert.equal(h.calls.filter(item => item.path.endsWith('/session')).length, 1);
});

test('logout requires ambiguity acknowledgement, clears data immediately and retries only same close request', async () => {
  let closeAttempts = 0;
  const h = await harness({ route(call) {
    if (call.path.endsWith('/events')) throw new Error('lost statement response');
    if (call.path.endsWith('/session/logout')) { closeAttempts += 1; if (closeAttempts === 1) throw new Error('lost logout response'); return response({ closed: true }); }
  } });
  await h.controller.loadDeal(DEAL); await h.controller.statement('offer', true);
  assert.throws(() => h.controller.logout(), /logout_ack_required/);
  await h.controller.logout(true); assert.equal(h.controller.getState().deal, null); assert.equal(h.controller.getState().authenticated, false);
  assert.equal(h.controller.getState().pending.kind, 'logout'); assert.equal(h.secrets.at(-1), null);
  await h.controller.retry(); const closes = h.calls.filter(item => item.path.endsWith('/session/logout'));
  assert.equal(closes.length, 2); assert.equal(closes[0].options.body, '{}'); assert.equal(closes[0].options.body, closes[1].options.body);
  assert.deepEqual(closes[0].options.headers, closes[1].options.headers); assert.equal(h.controller.getState().pending, null);
  assert.throws(() => h.controller.createDeal({ creatorRole: 'seller', ...terms }), /session_ended/);
});

test('isolated Russian assets have labelled credentials, native consent, live status and no persistent credential store', () => {
  const html = readFileSync(new URL('./participant.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./participant.css', import.meta.url), 'utf8');
  const source = readFileSync(new URL('./participant-client.mjs', import.meta.url), 'utf8');
  assert.match(html, /<html lang="ru">/); assert.match(html, /aria-live="polite" aria-atomic="true"/);
  for (const id of ['pp-access-code', 'pp-new-access-code', 'pp-new-invite-code', 'pp-claim-code']) {
    assert.match(html, new RegExp(`<label[^>]*for="${id}"`));
    assert.match(html, new RegExp(`<input[^>]*id="${id}"[^>]*type="password"`));
  }
  for (const id of ['pp-document-consent', 'pp-statement-consent']) assert.match(html, new RegExp(`<label[^>]*for="${id}"`));
  assert.match(css, /:focus-visible/); assert.match(css, /min-height: 44px/); assert.match(css, /@media print[^]*\.secret/);
  assert.doesNotMatch(source, /innerHTML|console\.|localStorage|sessionStorage|indexedDB|ncalayer|\/api\/test-workspace|\/api\/deals/);
  assert.match(html, /Личность, организация и полномочия человека не проверены/);
});
