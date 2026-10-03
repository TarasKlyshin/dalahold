import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createParticipantController, exportParticipantDeal, mountParticipantCabinet, PARTICIPANT_API, PARTICIPANT_SCOPE, validateDeal } from './participant-client.mjs';
import * as signing from './participant-signing-client.mjs';
import { PARTICIPANT_SIGNATURE_DOMAIN, PARTICIPANT_SIGNATURE_STATEMENT } from '../nca/participant-signatures.mjs';

const TIME = Date.UTC(2026, 9, 3, 10), SCOPE = signing.SIGNED_SCOPE;
const id = digit => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const SELLER = id('1'), BUYER = id('2'), DEAL = id('3'), REQUEST = id('4'), EVENT = id('5'), DOC = id('6'), INTENT = id('7'), BINDING = id('8'), BUYER_BINDING = id('9'), RECEIPT = id('a');
const CMS_MODEL = 'Y21z';
const hash = text => createHash('sha256').update(text).digest('hex');
const person = who => ({ id: who, label: who === SELLER ? 'TEST participant 001' : 'TEST participant 002' });
const binding = { bindingId: BINDING, certificateDigest: 'b'.repeat(64), authEpoch: 0, scope: SCOPE };
const chain = ['-----BEGIN CERTIFICATE-----\nQQ==\n-----END CERTIFICATE-----\n', '-----BEGIN CERTIFICATE-----\nQg==\n-----END CERTIFICATE-----\n'];
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(value) });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const canonicalTerms = deal => ['dalahold.unsigned-local-draft-terms.v1', `dealId=${deal.id}`, `version=${deal.version}`, `scenario=${deal.scenario}`, `quantity=${deal.quantity}`, `amount=${deal.amount}`, `date=${deal.date}`].map(line => line + '\n').join('');
function dealFixture(changes = {}) {
  const deal = { id: DEAL, creatorId: SELLER, version: 1, scenario: 'grain', quantity: 12, amount: 800000, date: '2026-10-10',
    state: 'draft', stateRevision: 0, role: 'seller', participants: [{ ...person(BUYER), role: 'buyer' }, { ...person(SELLER), role: 'seller' }],
    documents: [{ id: DOC, dealId: DEAL, termsVersion: 1, category: 'contract', byteLength: 4, sha256: hash('TEST'), createdAt: TIME, scope: 'local_test_document_only', fileKind: 'text' }],
    events: [], scope: SCOPE, ...changes };
  deal.documents = deal.documents.map(item => ({ ...item, termsVersion: deal.version }));
  deal.documentHistory = [...deal.documents];
  deal.termsFingerprint = hash(canonicalTerms(deal));
  deal.snapshotHash = hash(JSON.stringify({ schema: 'dalahold.local-test-participant-snapshot.v1', canonicalTerms: canonicalTerms(deal), documents: deal.documents, participants: deal.participants }));
  return deal;
}
function contextFixture(action = 'offer', deal = dealFixture(), currentBinding = binding) {
  return { actorId: SELLER, action, binding: currentBinding, deal: action === 'enroll_test_participant' ? null : deal,
    request: action === 'enroll_test_participant' || action === 'anchor_test_memo' ? null : { requestId: REQUEST, action, expectedVersion: deal.version, expectedStateRevision: deal.stateRevision, snapshotHash: deal.snapshotHash } };
}
function intentFixture(context, changes = {}) {
  const deal = context.deal;
  const snapshot = deal ? { dealId: deal.id, version: deal.version, canonicalTerms: canonicalTerms(deal), termsFingerprint: deal.termsFingerprint, documents: deal.documents,
    participants: deal.participants.map(item => ({ id: item.id, role: item.role, bindingId: item.id === SELLER ? BINDING : BUYER_BINDING, certificateDigest: (item.id === SELLER ? 'b' : 'c').repeat(64), authEpoch: 0 })),
    role: deal.role, state: deal.state, stateRevision: deal.stateRevision, snapshotHash: deal.snapshotHash, terminalEventId: deal.state === 'accepted' ? deal.events.at(-1).id : null } : null;
  const data = { domain: signing.SIGNATURE_DOMAIN, purpose: 'TEST', scope: SCOPE, statement: signing.SIGNATURE_STATEMENT,
    action: context.action, nonce: INTENT, actorId: context.actorId, sessionHash: 'd'.repeat(64), issuedAt: TIME, expiresAt: TIME + 300000, statusSource: 'test_ocsp', binding: context.binding, snapshot,
    request: context.action === 'anchor_test_memo' ? { requestId: REQUEST, action: context.action, expectedVersion: deal.version, expectedStateRevision: deal.stateRevision, snapshotHash: deal.snapshotHash } : context.request,
    operation: context.action === 'anchor_test_memo' ? { cluster: 'devnet', programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', walletAddress: '1'.repeat(32), maxFeeLamports: '5000',
      memo: `DalaHold TEST v1 ${deal.snapshotHash} ${deal.events.at(-1).id}`, snapshotHash: deal.snapshotHash, eventId: deal.events.at(-1).id } : null, ...changes };
  const text = JSON.stringify(data, null, 2) + '\n';
  return { id: INTENT, text, bytesBase64: Buffer.from(text).toString('base64'), hash: hash(text), expiresAt: data.expiresAt };
}
function receiptFixture(intent, context, changes = {}) {
  return { id: RECEIPT, intentId: intent.id, intentHash: intent.hash, actorId: SELLER, action: context.action, dealId: context.deal?.id ?? null,
    eventId: context.deal ? EVENT : null, snapshotHash: context.deal?.snapshotHash ?? null, bindingId: BINDING, authEpoch: 0, certificateDigest: binding.certificateDigest,
    verifiedAt: TIME + 1, validUntil: TIME + 60000, statusSource: 'test_ocsp', scope: SCOPE, ...changes };
}
function eventFixture(receipt, context) {
  const deal = context.deal, to = { offer: 'offered', agree: 'agreed', handover: 'handed_over', accept: 'accepted', dispute: 'disputed' };
  return { id: receipt.eventId, dealId: deal.id, action: context.action, actorId: SELLER, role: deal.role, termsVersion: deal.version, stateRevision: deal.stateRevision + 1,
    snapshotHash: deal.snapshotHash, termsFingerprint: deal.termsFingerprint, documentManifestHash: hash(JSON.stringify(deal.documents)), createdAt: TIME + 1, stateFrom: deal.state, stateTo: to[context.action], source: 'personal_test_nca_statement', scope: SCOPE,
    authorization: { receiptId: receipt.id, intentHash: receipt.intentHash, certificateDigest: receipt.certificateDigest, bindingId: receipt.bindingId, authEpoch: 0, statusSource: 'test_ocsp' } };
}
function domFixture() {
  const html = readFileSync(new URL('./participant.html', import.meta.url), 'utf8'), nodes = new Map();
  const make = (tag, attrs = new Map()) => {
    const listeners = new Map();
    return { tagName: tag.toUpperCase(), value: attrs.get('value') || '', type: attrs.get('type') || '', textContent: '', hidden: attrs.has('hidden'), disabled: attrs.has('disabled'), checked: false, files: [], children: [],
      setAttribute(key, value) { attrs.set(key, value); }, getAttribute(key) { return attrs.get(key) ?? null; }, classList: { toggle() {} }, replaceChildren(...values) { this.children = values; }, append(...values) { this.children.push(...values); },
      addEventListener(name, callback) { listeners.set(name, callback); }, removeEventListener(name) { listeners.delete(name); },
      dispatch(name) { if (!this.disabled) return listeners.get(name)?.({ preventDefault() {} }); }, click() { return this.dispatch('click'); }, focus() {}, remove() {} };
  };
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const attrs = new Map(); for (const attr of match[2].matchAll(/([a-z][\w-]*)(?:="([^"]*)")?/gi)) attrs.set(attr[1], attr[2] ?? '');
    if (attrs.has('id')) nodes.set(attrs.get('id'), make(match[1], attrs));
  }
  const $ = name => nodes.get(`pp-${name}`);
  for (const [name, value] of [['create-role', 'seller'], ['create-scenario', 'grain'], ['edit-scenario', 'grain'], ['category', 'contract']]) $(name).value = value;
  return { $, getElementById: key => nodes.get(key), createElement: make, body: make('body') };
}
async function harness({ route, callImpl, currentBinding = binding, scope = SCOPE, dom } = {}) {
  const calls = [], signed = [], views = [], secrets = [];
  let time = TIME, currentDeal = dealFixture({ scope }), identity = currentBinding, lastIntent, lastContext, tick, moduleLoads = 0;
  const fetchImpl = async (path, options) => {
    const call = { path, options }; calls.push(call);
    const override = route?.(call, { lastIntent, lastContext }); if (override !== undefined) return await override;
    if (path.endsWith('/session')) return response({ authenticated: true, scope, participant: person(SELLER), csrfToken: 'e'.repeat(64), expiresAt: TIME + 900000,
      ...(scope === SCOPE ? { signing: { enabled: true, statusSource: 'test_ocsp' } } : {}) });
    if (path.endsWith('/signing')) return response({ ready: true, chain, validUntil: TIME + 900000, statusSource: 'test_ocsp', scope, anchorEnabled: false });
    if (path.endsWith('/identity')) return response({ binding: identity, scope });
    if (path.endsWith('/deals')) return response({ deals: [currentDeal] });
    if (path.endsWith(`/deals/${DEAL}`)) return response({ deal: currentDeal });
    if (path.endsWith('/signature-intents') || path.endsWith('/identity-intents')) {
      const payload = JSON.parse(options.body), action = payload.action || 'enroll_test_participant';
      lastContext = contextFixture(action, currentDeal, identity); if (payload.action) lastContext.request = payload;
      lastIntent = intentFixture(lastContext); return response({ intent: lastIntent, scope }, 201);
    }
    if (path.endsWith('/signature-receipts')) {
      const receipt = receiptFixture(lastIntent, lastContext);
      if (lastContext.action === 'enroll_test_participant') { identity = binding; return response({ receipt, historical: false, scope }); }
      const event = eventFixture(receipt, lastContext);
      currentDeal = { ...currentDeal, state: event.stateTo, stateRevision: event.stateRevision, events: [...currentDeal.events, event] };
      return response({ receipt, historical: false, event, deal: currentDeal, scope });
    }
    if (path.endsWith('/session/logout')) return response({ closed: true, scope });
    throw new Error('unexpected model route');
  };
  const options = { fetchImpl, now: () => time, randomUUID: () => REQUEST, cryptoImpl: webcrypto,
    signingModuleLoader: async () => { moduleLoads++; return signing; }, signingOptions: { callImpl: async request => { signed.push(request); return callImpl ? await callImpl(request) : CMS_MODEL; } },
    onChange: value => views.push(value), onSecret: value => secrets.push(value) };
  const mounted = dom ? mountParticipantCabinet(dom, { ...options, setIntervalImpl(callback) { tick = callback; return 1; }, clearIntervalImpl() {} }) : null;
  const controller = mounted?.controller || createParticipantController(options);
  await (mounted?.initialized || controller.bootstrap());
  await controller.loadDeal(DEAL);
  return { controller, mounted, calls, signed, views, secrets, moduleLoads: () => moduleLoads, tick: () => tick?.(), advance(ms) { time += ms; controller.tick(); }, setDeal(value) { currentDeal = value; } };
}

test('signed intent contract matches core and rejects byte, purpose, actor, binding, document and snapshot tampering before transport', async () => {
  assert.equal(signing.SIGNATURE_DOMAIN, PARTICIPANT_SIGNATURE_DOMAIN);
  assert.equal(signing.SIGNATURE_STATEMENT, PARTICIPANT_SIGNATURE_STATEMENT);
  const context = contextFixture(), valid = intentFixture(context);
  assert.deepEqual(await signing.validateIntent(valid, context, TIME, webcrypto), valid);
  for (const changed of [{ ...valid, text: valid.text + ' ' }, { ...valid, bytesBase64: valid.bytesBase64 + '\n' }, { ...valid, hash: '0'.repeat(64) }, { ...valid, expiresAt: TIME },
    intentFixture(context, { purpose: 'approve real payment' }), intentFixture(context, { actorId: BUYER }), intentFixture(context, { binding: { ...binding, authEpoch: 1 } }),
    intentFixture(context, { snapshot: { ...JSON.parse(valid.text).snapshot, documents: [] } }), intentFixture(context, { snapshot: { ...JSON.parse(valid.text).snapshot, participants: JSON.parse(valid.text).snapshot.participants.map(item => ({ ...item, bindingId: BINDING })) } })]) {
    await assert.rejects(signing.validateIntent(changed, context, TIME, webcrypto), /invalid_signature_intent/);
  }
});

test('enrollment model prepares exact intent without a signature and signing uses actual detached CMS request builder', async () => {
  const h = await harness({ currentBinding: null });
  await h.controller.prepareSignature('enroll_test_participant');
  assert.equal(h.signed.length, 0); assert.equal(h.calls.filter(call => call.path.endsWith('/signature-receipts')).length, 0);
  await assert.rejects(h.controller.signPrepared(false), /signature_consent_required/); assert.equal(h.signed.length, 0);
  await h.controller.signPrepared(true);
  assert.equal(h.signed.length, 1); assert.deepEqual(h.controller.getState().signing.binding, binding);
  assert.equal(h.controller.getState().signing.receipt.action, 'enroll_test_participant');
  assert.match(h.controller.getState().message, /Реальный вход, организация/);
});

test('signed statement model requires distinct explicit consent, uses one NCALayer request and applies exact receipt metadata', async () => {
  const h = await harness();
  assert.throws(() => h.controller.statement('offer', true), /signature_required/);
  await h.controller.prepareSignature('offer');
  await assert.rejects(h.controller.signPrepared(false), /signature_consent_required/);
  const preview = h.controller.getState().signing.intent;
  await h.controller.signPrepared(true);
  assert.equal(h.signed.length, 1); assert.equal(h.signed[0].args.data, Buffer.from(preview.text).toString('base64'));
  assert.deepEqual(h.signed[0].args.signingParams, { decode: true, encapsulate: false, digested: false });
  assert.equal(h.controller.getState().deal.state, 'offered'); assert.equal(h.controller.getState().signing.intent, null);
  assert.equal(h.controller.getState().deal.events[0].authorization.receiptId, RECEIPT);
  assert.equal(h.calls.filter(call => call.path.endsWith('/events')).length, 0);
  const post = h.calls.find(call => call.path.endsWith('/signature-receipts'));
  assert.equal(post.options.headers['X-DalaHold-CSRF'], 'e'.repeat(64));
  assert.equal(post.options.credentials, 'same-origin'); assert.equal(post.options.redirect, 'error');
});

test('cancellation model keeps only prepared intent and never posts CMS', async () => {
  const h = await harness({ callImpl: () => { throw new Error('signing_cancelled_or_rejected'); } });
  await h.controller.prepareSignature('offer'); await h.controller.signPrepared(true);
  assert.equal(h.controller.getState().pending, null); assert.equal(h.controller.getState().busy, false);
  assert.equal(h.controller.getState().signing.intent.id, INTENT);
  assert.equal(h.calls.filter(call => call.path.endsWith('/signature-receipts')).length, 0);
  assert.match(h.controller.getState().message, /отменено/);
});

test('ambiguous signed model blocks new work and exact CMS, intent ID and CSRF retry never reopens signing', async () => {
  let attempts = 0;
  const h = await harness({ route(call, issued) {
    if (!call.path.endsWith('/signature-receipts')) return;
    attempts++; if (attempts === 1) throw new Error('model response lost');
    const receipt = receiptFixture(issued.lastIntent, issued.lastContext), event = eventFixture(receipt, issued.lastContext);
    return response({ receipt, historical: true, event, deal: { ...issued.lastContext.deal, state: 'offered', stateRevision: 1, events: [event] }, scope: SCOPE });
  } });
  await h.controller.prepareSignature('offer'); await h.controller.signPrepared(true);
  assert.equal(h.controller.getState().pending.ambiguous, true);
  assert.throws(() => h.controller.prepareSignature('offer'), /pending_write/);
  assert.throws(() => h.controller.createDeal({ creatorRole: 'seller', scenario: 'grain', quantity: 1, amount: 1, date: '2026-10-10' }), /pending_write/);
  await assert.rejects(h.controller.signPrepared(true), /pending_write/);
  h.advance(300001); await h.controller.retry();
  const posts = h.calls.filter(call => call.path.endsWith('/signature-receipts'));
  assert.equal(posts.length, 2); assert.equal(posts[0].options.body, posts[1].options.body); assert.deepEqual(posts[0].options.headers, posts[1].options.headers);
  assert.deepEqual(JSON.parse(posts[1].options.body), { intentId: INTENT, cms: CMS_MODEL });
  assert.equal(h.signed.length, 1); assert.equal(h.controller.getState().pending, null); assert.match(h.controller.getState().message, /сохранённая/);
});

test('expiry during model transport or module await clears signing data and ignores late CMS without a receipt POST', async () => {
  for (const duringImport of [false, true]) {
    const wait = deferred(), started = deferred(); let calls = 0;
    const h = await harness({ callImpl: async () => { calls++; started.resolve(); return wait.promise; } });
    if (duringImport) {
      const transport = await import('../nca/client.mjs');
      const signingModule = { ...signing, signIntent: (intent, chain, options) => signing.signIntent(intent, chain, { ...options, moduleLoader: () => { started.resolve(); return wait.promise; } }) };
      // Replace only the test module-loader seam, with an independently mounted controller.
      h.controller.dispose();
      const callsBefore = h.calls.length;
      const controller = createParticipantController({ fetchImpl: async (path, options) => {
        h.calls.push({ path, options });
        if (path.endsWith('/session')) return response({ authenticated: true, scope: SCOPE, signing: { enabled: true, statusSource: 'test_ocsp' }, participant: person(SELLER), csrfToken: 'e'.repeat(64), expiresAt: TIME + 900000 });
        if (path.endsWith('/deals')) return response({ deals: [dealFixture()] });
        if (path.endsWith('/signing')) return response({ ready: true, chain, validUntil: TIME + 900000, statusSource: 'test_ocsp', scope: SCOPE });
        if (path.endsWith('/identity')) return response({ binding, scope: SCOPE });
        if (path.endsWith(`/deals/${DEAL}`)) return response({ deal: dealFixture() });
        if (path.endsWith('/signature-intents')) return response({ intent: intentFixture(contextFixture()), scope: SCOPE });
        throw new Error('late request must not occur');
      }, now: () => duringImportTime, randomUUID: () => REQUEST, cryptoImpl: webcrypto, signingModuleLoader: async () => signingModule, signingOptions: { callImpl: () => { calls++; return CMS_MODEL; } } });
      let duringImportTime = TIME;
      await controller.bootstrap(); await controller.loadDeal(DEAL); await controller.prepareSignature('offer');
      const pending = controller.signPrepared(true);
      await started.promise;
      duringImportTime += 900001; controller.tick(); wait.resolve(transport); await pending;
      assert.equal(controller.getState().signing.intent, null); assert.equal(controller.getState().signing.binding, null);
      assert.equal(calls, 0); assert.equal(h.calls.slice(callsBefore).filter(call => call.path.endsWith('/signature-receipts')).length, 0);
    } else {
      await h.controller.prepareSignature('offer'); const pending = h.controller.signPrepared(true);
      await started.promise; h.advance(900001); wait.resolve(CMS_MODEL); await pending;
      assert.equal(h.controller.getState().ended, true); assert.equal(h.controller.getState().signing.intent, null);
      assert.equal(h.controller.getState().signing.binding, null); assert.equal(h.controller.getState().signing.ready, false);
      assert.equal(h.calls.filter(call => call.path.endsWith('/signature-receipts')).length, 0);
    }
  }
});

test('current snapshot refresh invalidates prepared model intent and logout clears preview, chain readiness and binding', async () => {
  const h = await harness();
  await h.controller.prepareSignature('offer'); h.setDeal(dealFixture({ version: 2, quantity: 14 })); await h.controller.loadDeal(DEAL);
  assert.equal(h.controller.getState().signing.intent, null);
  await assert.rejects(h.controller.signPrepared(true), /invalid_signature_intent/);
  await h.controller.prepareSignature('offer'); await h.controller.logout();
  const state = h.controller.getState(); assert.equal(state.ended, true); assert.equal(state.signing.intent, null); assert.equal(state.signing.binding, null); assert.equal(state.signing.ready, false);
  assert.doesNotMatch(JSON.stringify(state), /bytesBase64|Y21z|csrfToken/);
});

test('signed conflict followed by session rejection clears account, intent and loaded data without replaying CMS', async () => {
  let rejected = false;
  const h = await harness({ route(call) {
    if (call.path.endsWith('/signature-receipts')) { rejected = true; return response({ error: { code: 'signature_snapshot_stale' } }, 409); }
    if (rejected && call.path.endsWith(`/deals/${DEAL}`)) return response({ error: { code: 'unauthorized' } }, 401);
  } });
  await h.controller.prepareSignature('offer'); await h.controller.signPrepared(true);
  const state = h.controller.getState();
  assert.equal(state.authenticated, false); assert.equal(state.ended, true); assert.equal(state.deal, null); assert.equal(state.signing.intent, null);
  assert.equal(h.calls.filter(call => call.path.endsWith('/signature-receipts')).length, 1);
});

test('signed export whitelists authorization metadata and rejects event authorization tampering', async () => {
  const context = contextFixture(), intent = intentFixture(context), receipt = receiptFixture(intent, context), event = eventFixture(receipt, context);
  const deal = { ...context.deal, state: 'offered', stateRevision: 1, events: [{ ...event, cms: CMS_MODEL, personId: 'person:PRIVATE', wire: 'PRIVATE' }],
    participants: context.deal.participants.map(item => ({ ...item, key: 'PRIVATE' })), session: 'PRIVATE', grant: 'PRIVATE', cms: CMS_MODEL };
  const text = exportParticipantDeal(deal), exported = JSON.parse(text);
  assert.equal(exported.scope, SCOPE); assert.deepEqual(exported.deal.events[0].authorization, event.authorization);
  assert.doesNotMatch(text, /PRIVATE|personId|"cms"|"session"|"grant"|"wire"|"key"|bytesBase64/);
  assert.throws(() => validateDeal({ ...deal, events: [{ ...event, authorization: { ...event.authorization, authEpoch: 1 } }] }), /invalid_response/);
});

test('DOM model separates intent creation and signature consent, cancellation resets consent, and unchanged timer preserves new consent', async () => {
  const dom = domFixture(), h = await harness({ dom, callImpl: () => { throw new Error('signing_cancelled_or_rejected'); } });
  assert.equal(dom.$('signing').hidden, false); assert.equal(dom.$('statement-consent-row').hidden, true); assert.equal(dom.$('statement-consent').required, false);
  await dom.$('action-form').dispatch('submit');
  assert.equal(h.signed.length, 0); assert.equal(dom.$('signature-preview').hidden, false); assert.equal(dom.$('signature-submit').disabled, true);
  dom.$('signature-consent').checked = true; dom.$('signature-consent').dispatch('change'); h.tick();
  assert.equal(dom.$('signature-consent').checked, true); assert.equal(dom.$('signature-submit').disabled, false);
  await dom.$('signature-form').dispatch('submit');
  assert.equal(h.signed.length, 1); assert.equal(dom.$('signature-consent').checked, false); assert.equal(dom.$('signature-submit').disabled, true);
  assert.equal(h.calls.filter(call => call.path.endsWith('/signature-receipts')).length, 0);
  h.mounted.dispose(); assert.equal(dom.$('new-access-code').value, '');
});

test('unsigned DOM model makes no signing API or module requests and retains the unsigned action path', async () => {
  const dom = domFixture(), h = await harness({ dom, scope: PARTICIPANT_SCOPE });
  assert.equal(dom.$('signing').hidden, true); assert.equal(dom.$('statement-consent-row').hidden, false); assert.equal(dom.$('statement-consent').required, true);
  assert.equal(h.controller.getState().signing, undefined);
  assert.equal(h.moduleLoads(), 0);
  assert.equal(h.calls.some(call => /\/signing|\/identity|signature-intents|signature-receipts/.test(call.path)), false); assert.equal(h.signed.length, 0);
  assert.match(dom.$('statement').textContent, /без ЭЦП/);
  h.mounted.dispose();
});

test('anchor validator fixes accepted terminal event, devnet Memo program, hash and maximum fee; default readiness disables publication', async () => {
  const accepted = dealFixture({ state: 'accepted', stateRevision: 4, events: [{ id: EVENT }] }), context = contextFixture('anchor_test_memo', accepted), valid = intentFixture(context);
  await signing.validateIntent(valid, context, TIME, webcrypto);
  const operation = JSON.parse(valid.text).operation;
  for (const changed of [{ cluster: 'mainnet-beta' }, { programId: '11111111111111111111111111111111' }, { maxFeeLamports: '10001' }, { memo: 'transfer real funds' }, { eventId: REQUEST }]) {
    await assert.rejects(signing.validateIntent(intentFixture(context, { operation: { ...operation, ...changed } }), context, TIME, webcrypto), /invalid_signature_intent/);
  }
  const h = await harness(); assert.throws(() => h.controller.prepareSignature('anchor_test_memo'), /anchor_unavailable/);
  assert.equal(h.calls.filter(call => call.path.endsWith('/anchor-intents')).length, 0);
});
