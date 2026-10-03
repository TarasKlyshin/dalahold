// Client protocol/state tests against disposable HTTP stores, not a browser,
// NCALayer, genuine identity, payment or natural user acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID, webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startParticipantWorkspace } from './participant-server.mjs';
import { createParticipantController, PARTICIPANT_API as API } from './participant-client.mjs';
import { verifyParticipantEvidence } from './participant-evidence.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const terms = { scenario: 'grain', quantity: 15, amount: 350000, date: '2026-10-03' };
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, signed = false, terminal = 'accept', { cryptoImpl = webcrypto } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-feedback-controller-'));
  let clock = Date.UTC(2026, 9, 3, 10), intercept = null;
  const sdk = { statusSource: 'test_ocsp',
    async inspect() { return { ready: true, statusSource: 'test_ocsp', validUntil: clock + 600000,
      chain: ['-----BEGIN CERTIFICATE-----\nMODEL ROOT\n-----END CERTIFICATE-----',
        '-----BEGIN CERTIFICATE-----\nMODEL ISSUER\n-----END CERTIFICATE-----'] }; },
    async verifyIdentity(bytes, cms, key) {
      const model = JSON.parse(cms.toString('utf8'));
      if (model.hash !== hash(bytes)) return { verified: false };
      return { verified: true, statusSource: 'test_ocsp', validUntil: clock + 300000,
        certificateDigest: hash(`MODEL ${model.person}`), identity: { schema: 'nca_test_subject_v1',
          personId: `person:${createHmac('sha256', key).update(model.person).digest('hex')}`, organizationId: null } };
    } };
  const stand = await startParticipantWorkspace({ directory, port: 0, now: () => clock,
    ...(signed ? { signatureSdk: sdk } : {}) });
  const origin = new URL(stand.url).origin;
  t.after(async () => { await stand.close(); rmSync(directory, { recursive: true, force: true }); });
  function client(person) {
    let cookie = '', csrf = '';
    const calls = [];
    const perform = async (path, options = {}) => {
      const response = await fetch(origin + path, { ...options, redirect: 'manual',
        headers: { ...(cookie ? { Cookie: cookie } : {}), ...(options.method === 'POST' ? { Origin: origin } : {}), ...options.headers } });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return response;
    };
    return { calls,
      async fetch(path, options = {}) {
        calls.push({ path, method: options.method || 'GET', body: options.body });
        return intercept ? intercept({ path, options, person }, () => perform(path, options)) : perform(path, options);
      },
      async raw(path, body) {
        const response = await perform(API + path, body === undefined ? {} : { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-DalaHold-CSRF': csrf }, body: JSON.stringify(body) });
        const data = await response.json(); if (data.csrfToken) csrf = data.csrfToken;
        assert.ok(response.ok, 'disposable backend fixture must accept its explicit MODEL/unsigned setup');
        return data;
      },
      async register() {
        await this.raw('/session'); const account = await this.raw('/participants', {});
        if (signed) await this.sign((await this.raw('/identity-intents', {})).intent);
        return account.participant;
      },
      sign(intent) { return this.raw('/signature-receipts', { intentId: intent.id,
        cms: Buffer.from(JSON.stringify({ person, hash: intent.hash })).toString('base64') }); },
      async action(id, action) {
        const deal = (await this.raw(`/deals/${id}`)).deal;
        const input = { requestId: randomUUID(), action, expectedVersion: deal.version,
          expectedStateRevision: deal.stateRevision, snapshotHash: deal.snapshotHash };
        if (signed) return this.sign((await this.raw(`/deals/${id}/signature-intents`, input)).intent);
        return this.raw(`/deals/${id}/events`, input);
      },
    };
  }
  const seller = client('MODEL seller'), buyer = client('MODEL buyer');
  const a = await seller.register(), b = await buyer.register();
  const id = (await seller.raw('/deals', { requestId: randomUUID(), creatorRole: 'seller', ...terms })).deal.id;
  const invite = await seller.raw(`/deals/${id}/invitations`, { expectedVersion: 1, participantId: b.id });
  await buyer.raw('/invitations/claims', { code: invite.code });
  const oldText = Buffer.from('ANONYMOUS OLD TEST TERMS\n'), newText = Buffer.from('ANONYMOUS CURRENT TEST TERMS\n');
  await seller.raw(`/deals/${id}/documents`, { requestId: randomUUID(), expectedVersion: 1,
    category: 'contract', contentBase64: oldText.toString('base64') });
  await seller.raw(`/deals/${id}/versions`, { requestId: randomUUID(), expectedVersion: 1, ...terms, amount: terms.amount + 1 });
  await seller.raw(`/deals/${id}/documents`, { requestId: randomUUID(), expectedVersion: 2,
    category: 'quality', contentBase64: newText.toString('base64') });
  for (const [actor, action] of [[seller, 'offer'], [buyer, 'agree'], [seller, 'handover'], [buyer, terminal]]) await actor.action(id, action);
  const controller = createParticipantController({ fetchImpl: (path, options) => buyer.fetch(path, options),
    now: () => clock, randomUUID, cryptoImpl });
  t.after(() => controller.dispose());
  await controller.bootstrap(); await controller.loadDeal(id);
  assert.equal(controller.getState().deal?.state, terminal === 'accept' ? 'accepted' : 'disputed');
  return { controller, seller, buyer, sellerId: a.id, buyerId: b.id, id, oldText, newText,
    setIntercept(value) { intercept = value; }, tick(ms) { clock += ms; controller.tick(); } };
}

for (const signed of [false, true]) {
  test(`${signed ? 'MODEL personal-signed' : 'unsigned'} controller loads distinct role feedback and submits one unsigned score`, async t => {
    const f = await fixture(t, signed);
    await f.controller.refreshFeedback();
    const loaded = f.controller.getState();
    assert.equal(loaded.reputation.signatureVerified, false);
    assert.equal(loaded.feedback.reviews.length, 0);
    assert.equal(loaded.feedback.parties.length, 2);
    assert.throws(() => f.controller.submitReview(5, false), /review_consent_required/);
    await f.controller.submitReview(5, true);
    const state = f.controller.getState();
    assert.equal(state.pending, null); assert.equal(state.feedback.reviews.length, 1);
    const review = state.feedback.reviews[0];
    assert.equal(review.authorId, f.buyerId); assert.equal(review.targetId, f.sellerId);
    assert.equal(review.targetRole, 'seller'); assert.equal(review.score, 5);
    assert.equal(review.source, 'unsigned_test_participant_review');
    assert.equal(state.feedback.parties.find(p => p.id === f.sellerId).reputation.roles.seller.average, 5);
    assert.throws(() => f.controller.submitReview(4, true), /review_already_exists/);
    f.tick(900001);
    assert.equal(f.controller.getState().feedback, null); assert.equal(f.controller.getState().reputation, null);
  });
  test(`${signed ? 'MODEL personal-signed' : 'unsigned'} controller exports every version/file and only public receipts`, async t => {
    const f = await fixture(t, signed);
    // Static asset/readback contract only, not navigation or rendered UI QA.
    const asset = await f.buyer.fetch('/participants/delivery-client.mjs');
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /^text\/javascript;/);
    assert.match(asset.headers.get('cache-control'), /no-store/);
    assert.match(await asset.text(), /export async function readEvidenceResponse/);
    const exported = await f.controller.exportEvidence();
    const evidence = JSON.parse(exported.text);
    assert.equal(exported.dealId, f.id); assert.equal(exported.version, 2);
    assert.equal(verifyParticipantEvidence(evidence).valid, true);
    assert.equal(evidence.receipts.length, signed ? 4 : 0);
    assert.equal(evidence.documents.length, 2);
    assert.ok(evidence.documents.some(item => Buffer.from(item.contentBase64, 'base64').equals(f.oldText)));
    assert.ok(evidence.documents.some(item => Buffer.from(item.contentBase64, 'base64').equals(f.newText)));
    assert.doesNotMatch(exported.text, /"(?:cms|personId|organizationId|accessCode|csrfToken|grant|wireBytes|sessionHash)"/);
    assert.equal(f.controller.getState().pending, null);
  });
}

test('lost review response pins one exact request; changed scores cannot replace it; retry reads the saved review', async t => {
  const f = await fixture(t); await f.controller.refreshFeedback(); let lost = true;
  f.setIntercept(async ({ path, options }, next) => {
    const response = await next();
    if (lost && path.endsWith('/reviews') && options.method === 'POST') { lost = false; await response.arrayBuffer(); throw new Error('MODEL lost response'); }
    return response;
  });
  await f.controller.submitReview(4, true);
  assert.equal(f.controller.getState().pending.kind, 'review'); assert.equal(f.controller.getState().pending.ambiguous, true);
  assert.throws(() => f.controller.submitReview(5, true), /pending_write/);
  await f.controller.retry();
  const posts = f.buyer.calls.filter(call => call.path.endsWith('/reviews') && call.method === 'POST');
  assert.equal(posts.length, 2); assert.equal(posts[0].body, posts[1].body);
  assert.equal(f.controller.getState().feedback.reviews.length, 1); assert.equal(f.controller.getState().feedback.reviews[0].score, 4);
  assert.equal(f.controller.getState().pending, null);
});

test('session expiry during evidence read returns no downloadable payload and clears feedback', async t => {
  const f = await fixture(t); await f.controller.refreshFeedback();
  const entered = defer(), release = defer();
  f.setIntercept(async ({ path }, next) => {
    const response = await next(); if (path.endsWith('/evidence')) { entered.resolve(); await release.promise; } return response;
  });
  const exported = f.controller.exportEvidence(); await entered.promise;
  f.tick(900001); release.resolve();
  assert.equal(await exported, null); assert.equal(f.controller.getState().ended, true);
  assert.equal(f.controller.getState().feedback, null); assert.equal(f.controller.getState().reputation, null);
});

test('dispute remains unrated and an unauthorized feedback read clears previously loaded summaries', async t => {
  const f = await fixture(t, false, 'dispute'); await f.controller.refreshFeedback();
  assert.throws(() => f.controller.submitReview(5, true), /review_not_allowed/);
  f.setIntercept(({ path }, next) => path.endsWith('/reputation')
    ? new Response(JSON.stringify({ error: { code: 'session_unavailable' } }), { status: 401, headers: { 'Content-Type': 'application/json' } }) : next());
  await f.controller.refreshFeedback();
  assert.equal(f.controller.getState().ended, true);
  assert.equal(f.controller.getState().feedback, null); assert.equal(f.controller.getState().reputation, null);
});

test('confirmed review followed by an expired read is never replayable', async t => {
  const f = await fixture(t); await f.controller.refreshFeedback();
  let posted = false;
  f.setIntercept(async ({ path, options }, next) => {
    if (options.method === 'POST' && path.endsWith('/reviews')) { const response = await next(); posted = true; return response; }
    if (posted && path === `${API}/deals/${f.id}`) return new Response(JSON.stringify({ error: { code: 'session_unavailable' } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } });
    return next();
  });
  await f.controller.submitReview(3, true);
  const state = f.controller.getState();
  assert.equal(state.ended, true); assert.equal(state.pending, null);
  assert.equal(state.feedback, null); assert.equal(state.reputation, null);
  assert.throws(() => f.controller.retry(), /pending_write/);
  assert.equal(f.buyer.calls.filter(call => call.method === 'POST' && call.path.endsWith('/reviews')).length, 1);
  assert.equal((await f.seller.raw(`/deals/${f.id}/reviews`)).reviews.length, 1);
});

test('unexpected private fields or wrong selected role never return an evidence payload', async t => {
  const f = await fixture(t);
  for (const mutate of [value => { value.cms = 'MODEL PRIVATE FIELD'; }, value => { value.deal.role = 'seller'; }]) {
    f.setIntercept(async ({ path }, next) => {
      const response = await next(); if (!path.endsWith('/evidence')) return response;
      const value = await response.json(); mutate(value);
      return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    });
    assert.equal(await f.controller.exportEvidence(), null);
    assert.equal(f.controller.getState().issue, true);
    assert.equal(f.controller.getState().pending, null);
    assert.equal(f.controller.getState().deal.id, f.id);
  }
});

test('expiry while WebCrypto checks evidence prevents a late downloadable result', async t => {
  const entered = defer(), release = defer();
  const cryptoImpl = { subtle: { async digest(...args) { entered.resolve(); await release.promise; return webcrypto.subtle.digest(...args); } } };
  const f = await fixture(t, false, 'accept', { cryptoImpl });
  await f.controller.refreshFeedback();
  const exported = f.controller.exportEvidence(); await entered.promise;
  f.tick(900001); release.resolve();
  assert.equal(await exported, null);
  assert.equal(f.controller.getState().ended, true);
  assert.equal(f.controller.getState().feedback, null); assert.equal(f.controller.getState().reputation, null);
});
