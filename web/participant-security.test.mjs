import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ParticipantStore } from './participant-store.mjs';
import { createParticipantServer } from './participant-server.mjs';

const API = '/api/participants/v1';

test('expiry reached inside a store mutation rolls back before HTTP success', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-participant-security-'));
  let clock = Date.now(), expireDuringMutation = false, sessionExpiresAt;
  // The store observes time passing during its transaction, after the HTTP
  // handler's preflight session check. No retained or operator store is used.
  const store = new ParticipantStore({ dbPath: join(directory, 'participants.sqlite'), now() {
    if (expireDuringMutation) clock = sessionExpiresAt;
    return clock;
  } });
  const server = createParticipantServer({ store, now: () => clock });
  t.after(async () => {
    server.stopParticipantSessions();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie = '', csrf;
  async function call(path, input) {
    const response = await fetch(origin + path, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(input === undefined ? {} : {
        Origin: origin, 'Content-Type': 'application/json', 'X-DalaHold-CSRF': csrf,
      }) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const data = await response.json();
    if (data.csrfToken) csrf = data.csrfToken;
    return { status: response.status, data };
  }
  assert.equal((await call(API + '/session')).status, 200);
  const registered = await call(API + '/participants', {});
  assert.equal(registered.status, 201);
  sessionExpiresAt = registered.data.expiresAt;
  expireDuringMutation = true;
  const response = await call(API + '/deals', {
    requestId: randomUUID(), creatorRole: 'seller', scenario: 'grain',
    quantity: 20, amount: 200_000, date: '2026-10-03',
  });
  expireDuringMutation = false;
  assert.equal(response.status, 401);
  assert.equal(response.data.error.code, 'session_unavailable');
  assert.deepEqual(store.listDeals(registered.data.participant.id), []);
});

test('invitation expiry reached inside redemption does not persist membership', t => {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-invitation-security-'));
  let clock = Date.now(), redemptionTicks = 0, invitationExpiresAt;
  const store = new ParticipantStore({ dbPath: join(directory, 'participants.sqlite'), now() {
    if (redemptionTicks) return ++redemptionTicks === 2 ? invitationExpiresAt - 1 : invitationExpiresAt;
    return clock;
  } });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const seller = store.register().participant, buyer = store.register().participant;
  const deal = store.createDeal(seller.id, { requestId: randomUUID(), creatorRole: 'seller',
    scenario: 'grain', quantity: 20, amount: 200_000, date: '2026-10-03' });
  const invite = store.createInvitation(seller.id, deal.id, { expectedVersion: 1, participantId: buyer.id });
  invitationExpiresAt = invite.expiresAt;
  // Initial expiry check is valid; recording claimed_at reaches expiry.
  redemptionTicks = 1;
  assert.throws(() => store.claimInvitation(buyer.id, { code: invite.code }), error => error.code === 'not_found');
  redemptionTicks = 0;
  assert.throws(() => store.getDeal(buyer.id, deal.id), error => error.code === 'not_found');
});

test('read-only deal refuses a journal that attributes seller offer to buyer', t => {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-event-security-'));
  const dbPath = join(directory, 'participants.sqlite');
  const store = new ParticipantStore({ dbPath });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const seller = store.register().participant, buyer = store.register().participant;
  let deal = store.createDeal(seller.id, { requestId: randomUUID(), creatorRole: 'seller',
    scenario: 'grain', quantity: 20, amount: 200_000, date: '2026-10-03' });
  const invite = store.createInvitation(seller.id, deal.id, { expectedVersion: 1, participantId: buyer.id });
  store.claimInvitation(buyer.id, { code: invite.code });
  deal = store.getDeal(seller.id, deal.id);
  const offered = store.action(seller.id, deal.id, { requestId: randomUUID(), action: 'offer',
    expectedVersion: deal.version, expectedStateRevision: deal.stateRevision, snapshotHash: deal.snapshotHash });
  // This changes only isolated test data, modelling a damaged durable journal.
  const corrupt = { ...offered.event, actorId: buyer.id, role: 'buyer' };
  const db = new DatabaseSync(dbPath);
  try { db.prepare('UPDATE participant_events SET event_json = ? WHERE id = ?').run(JSON.stringify(corrupt), corrupt.id); }
  finally { db.close(); }
  assert.throws(() => store.getDeal(seller.id, deal.id), error => error.code === 'store_corrupt');
});

test('HTTP expiry during feedback persistence rolls back review and retry receipt together', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-feedback-security-'));
  const dbPath = join(directory, 'participants.sqlite');
  let clock = 1000000, expireDuringWrite = false, expiresAt;
  const store = new ParticipantStore({ dbPath, now() {
    if (expireDuringWrite) clock = expiresAt;
    return clock;
  } });
  const seller = store.register().participant, buyer = store.register();
  let deal = store.createDeal(seller.id, { requestId: randomUUID(), creatorRole: 'seller',
    scenario: 'grain', quantity: 20, amount: 200000, date: '2026-10-03' });
  const invite = store.createInvitation(seller.id, deal.id, { expectedVersion: 1, participantId: buyer.participant.id });
  store.claimInvitation(buyer.participant.id, { code: invite.code });
  for (const [actor, action] of [[seller.id, 'offer'], [buyer.participant.id, 'agree'], [seller.id, 'handover'], [buyer.participant.id, 'accept']]) {
    deal = store.getDeal(actor, deal.id);
    deal = store.action(actor, deal.id, { requestId: randomUUID(), action, expectedVersion: deal.version,
      expectedStateRevision: deal.stateRevision, snapshotHash: deal.snapshotHash }).deal;
  }
  const server = createParticipantServer({ store, now: () => clock });
  t.after(async () => {
    server.stopParticipantSessions(); await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie = '', csrf;
  async function call(path, input) {
    const response = await fetch(origin + path, { method: input === undefined ? 'GET' : 'POST',
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(input === undefined ? {} : {
        Origin: origin, 'Content-Type': 'application/json', 'X-DalaHold-CSRF': csrf }) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const data = await response.json(); if (data.csrfToken) csrf = data.csrfToken;
    return { status: response.status, data };
  }
  await call(API + '/session');
  const login = await call(API + '/session/login', { accessCode: buyer.accessCode });
  assert.equal(login.status, 200); expiresAt = login.data.expiresAt;
  const input = { requestId: randomUUID(), expectedVersion: deal.version, expectedStateRevision: deal.stateRevision,
    snapshotHash: deal.snapshotHash, score: 5 };
  expireDuringWrite = true;
  assert.equal((await call(`${API}/deals/${deal.id}/reviews`, input)).status, 401);
  expireDuringWrite = false;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM participant_reviews').get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM participant_requests WHERE kind='review'").get().n, 0);
  } finally { db.close(); }
  await call(API + '/session');
  assert.equal((await call(API + '/session/login', { accessCode: buyer.accessCode })).status, 200);
  const retry = await call(`${API}/deals/${deal.id}/reviews`, input);
  assert.equal(retry.status, 201); assert.equal(retry.data.historical, false);
  assert.equal(store.listReviews(seller.id, deal.id).length, 1);
});
