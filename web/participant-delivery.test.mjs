// API integration on ephemeral stores. Signed path uses MODEL certificates,
// never genuine NCA, browser acceptance, authority, payment or Solana evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startParticipantWorkspace } from './participant-server.mjs';
import { verifyParticipantEvidence } from './participant-evidence.mjs';

const API = '/api/participants/v1';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const terms = { scenario: 'grain', quantity: 20, amount: 200000, date: '2026-10-03' };
function reviewInput(deal, score = 5) { return { requestId: randomUUID(), expectedVersion: deal.version,
  expectedStateRevision: deal.stateRevision, snapshotHash: deal.snapshotHash, score }; }

async function fixture(t, signed = false) {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-participant-delivery-'));
  let clock = 1000000, calls = 0;
  const sdk = { statusSource: 'test_ocsp',
    async inspect() { return { ready: true, statusSource: 'test_ocsp', validUntil: clock + 600000 }; },
    async verifyIdentity(bytes, cms, key) {
      calls++;
      const model = JSON.parse(cms.toString('utf8'));
      if (model.hash !== hash(bytes)) return { verified: false };
      return { verified: true, statusSource: 'test_ocsp', validUntil: clock + 300000,
        certificateDigest: hash(`MODEL ${model.person}`), identity: { schema: 'nca_test_subject_v1',
          personId: `person:${createHmac('sha256', key).update(model.person).digest('hex')}`, organizationId: null } };
    } };
  const config = { directory, port: 0, now: () => clock, ...(signed ? { signatureSdk: sdk } : {}) };
  let stand = await startParticipantWorkspace(config), origin = new URL(stand.url).origin;
  t.after(async () => { await stand.close(); rmSync(directory, { recursive: true, force: true }); });
  const client = (person) => {
    let cookie = '', csrf;
    return {
      async call(path, body, extra = {}) {
        const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST',
          headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : {
            Origin: origin, 'Content-Type': 'application/json', 'X-DalaHold-CSRF': csrf }), ...extra },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
        const data = await response.json(); if (data.csrfToken) csrf = data.csrfToken;
        return { status: response.status, data, headers: response.headers };
      },
      async register() {
        await this.call(API + '/session'); const result = await this.call(API + '/participants', {});
        assert.equal(result.status, 201);
        if (signed) {
          const intent = (await this.call(API + '/identity-intents', {})).data.intent;
          assert.equal((await this.submit(intent)).status, 200);
        }
        return result.data;
      },
      async login(code) { await this.call(API + '/session'); return this.call(API + '/session/login', { accessCode: code }); },
      submit(intent) { return this.call(API + '/signature-receipts', { intentId: intent.id,
        cms: Buffer.from(JSON.stringify({ person, hash: intent.hash })).toString('base64') }); },
      async detail(id) { const result = await this.call(`${API}/deals/${id}`); assert.equal(result.status, 200); return result.data.deal; },
      async action(id, action) {
        const deal = await this.detail(id), input = { requestId: randomUUID(), action,
          expectedVersion: deal.version, expectedStateRevision: deal.stateRevision, snapshotHash: deal.snapshotHash };
        if (!signed) return this.call(`${API}/deals/${id}/events`, input);
        const issued = await this.call(`${API}/deals/${id}/signature-intents`, input);
        assert.equal(issued.status, 201); return this.submit(issued.data.intent);
      },
    };
  };
  const seller = client('MODEL seller'), buyer = client('MODEL buyer'), outsider = client('MODEL outsider');
  const a = await seller.register(), b = await buyer.register(); await outsider.register();
  const deal = (await seller.call(API + '/deals', { requestId: randomUUID(), creatorRole: 'seller', ...terms })).data.deal;
  const invite = (await seller.call(`${API}/deals/${deal.id}/invitations`, { expectedVersion: 1, participantId: b.participant.id })).data;
  assert.equal((await buyer.call(API + '/invitations/claims', { code: invite.code })).status, 200);
  return { seller, buyer, outsider, a, b, id: deal.id, get calls() { return calls; },
    async complete() {
      for (const [actor, action] of [[seller, 'offer'], [buyer, 'agree'], [seller, 'handover'], [buyer, 'accept']])
        assert.equal((await actor.action(deal.id, action)).status, signed ? 200 : 201);
      return buyer.detail(deal.id);
    },
    tick(ms) { clock += ms; },
    async restart() { await stand.close(); stand = await startParticipantWorkspace(config); origin = new URL(stand.url).origin; },
    sql(fn) { const db = new DatabaseSync(join(directory, 'participants.sqlite')); try { return fn(db); } finally { db.close(); } } };
}

for (const signed of [false, true]) {
  test(`${signed ? 'MODEL-signed' : 'unsigned'} API feedback keeps local source, exact retry and protected role summaries`, async t => {
    const f = await fixture(t, signed), draft = await f.buyer.detail(f.id);
    assert.equal((await f.buyer.call(`${API}/deals/${f.id}/reviews`, reviewInput(draft))).status, 409);
    const deal = await f.complete(), input = reviewInput(deal, 4), calls = f.calls;
    const saved = await f.buyer.call(`${API}/deals/${f.id}/reviews`, input);
    assert.equal(saved.status, 201); assert.equal(saved.data.review.targetId, f.a.participant.id);
    assert.equal(saved.data.review.source, 'unsigned_test_participant_review');
    assert.equal(saved.data.scope, 'local_test_role_reputation_only');
    assert.equal(saved.data.dealScope, signed ? 'local_personal_test_signed_deal_only' : 'local_test_participant_statements_only');
    assert.equal(f.calls, calls, 'local feedback does not forge an NCA status or signature check');
    assert.equal((await f.buyer.call(saved.headers.get('location'))).data.review.id, saved.data.review.id);
    const replay = await f.buyer.call(`${API}/deals/${f.id}/reviews`, input);
    assert.equal(replay.status, 200); assert.equal(replay.data.historical, true);
    assert.deepEqual(replay.data.review, saved.data.review);
    assert.equal((await f.buyer.call(`${API}/deals/${f.id}/reviews`, { ...input, score: 5 })).status, 409);
    assert.equal((await f.buyer.call(`${API}/deals/${f.id}/reviews`, reviewInput(deal))).data.error.code, 'review_already_exists');
    assert.equal((await f.buyer.call(`${API}/deals/${f.id}/reviews`, { ...input, targetId: f.b.participant.id })).status, 400);
    assert.equal((await f.outsider.call(`${API}/deals/${f.id}/reviews`, input)).status, 404);
    for (const suffix of ['reviews', 'reputation']) assert.equal((await f.outsider.call(`${API}/deals/${f.id}/${suffix}`)).status, 404);
    assert.equal((await f.buyer.call(`${API}/deals/${f.id}/reviews`, input, { 'X-DalaHold-CSRF': '0'.repeat(64) })).status, 403);
    assert.equal((await f.buyer.call(`${API}/deals/${f.id}/reviews`, input, { Origin: 'https://other.invalid' })).status, 403);
    const summary = await f.seller.call(API + '/reputation');
    assert.equal(summary.status, 200); assert.equal(summary.headers.get('cache-control'), 'no-store');
    assert.deepEqual(summary.data.reputation.roles.seller, { count: 1, scoreTotal: 4, average: 4 });
    assert.equal(summary.data.reputation.signatureVerified, false);
    assert.equal((await f.outsider.call(API + '/reputation')).data.reputation.roles.seller.count, 0);
    assert.equal((await f.outsider.call(`${API}/reputation?participantId=${f.a.participant.id}`)).status, 404);
    assert.equal((await f.buyer.detail(f.id)).events.length, 4);
    if (signed) assert.equal((await f.buyer.call(`${API}/deals/${f.id}/events`, {
      requestId: randomUUID(), action: 'accept', expectedVersion: deal.version,
      expectedStateRevision: deal.stateRevision, snapshotHash: deal.snapshotHash })).status, 403);
    await f.restart();
    assert.equal((await f.buyer.call(`${API}/deals/${f.id}/reviews`, input)).status, 401);
    assert.equal((await f.buyer.login(f.b.accessCode)).status, 200);
    assert.equal((await f.buyer.call(`${API}/deals/${f.id}/reviews`, input)).data.historical, true);
    f.tick(900000);
    assert.equal((await f.buyer.call(`${API}/deals/${f.id}/reputation`)).status, 401);
  });
  test(`${signed ? 'MODEL-signed' : 'unsigned'} API exports all terms versions, exact file bytes and protected event receipts without writing state`, async t => {
    const f = await fixture(t, signed);
    const oldBytes = Buffer.from('ANONYMIZED TEST contract version one\n');
    const newBytes = Buffer.from('ANONYMIZED TEST delivery version two\n');
    assert.equal((await f.seller.call(`${API}/deals/${f.id}/documents`, { requestId: randomUUID(), expectedVersion: 1,
      category: 'contract', contentBase64: oldBytes.toString('base64') })).status, 201);
    assert.equal((await f.seller.call(`${API}/deals/${f.id}/versions`, { requestId: randomUUID(), expectedVersion: 1,
      ...terms, quantity: 21 })).status, 201);
    assert.equal((await f.buyer.call(`${API}/deals/${f.id}/documents`, { requestId: randomUUID(), expectedVersion: 2,
      category: 'delivery', contentBase64: newBytes.toString('base64') })).status, 201);
    await f.complete();
    const snapshot = () => f.sql(db => hash(JSON.stringify(db.prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) =>
      ({ table: name, rows: db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all() })))));
    const before = snapshot(), calls = f.calls;
    const response = await f.buyer.call(`${API}/deals/${f.id}/evidence`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-disposition'), /^attachment; filename="test-evidence-[a-f0-9-]+\.json"$/);
    const evidence = response.data, report = verifyParticipantEvidence(evidence);
    assert.equal(report.valid, true);
    assert.equal(report.authenticityVerified, false); assert.equal(report.sdkVerificationPerformed, false);
    assert.equal(report.freshStatusChecked, false);
    assert.equal(evidence.versions.length, 2); assert.equal(evidence.documents.length, 2);
    assert.equal(evidence.deal.state, 'accepted'); assert.equal(evidence.deal.events.length, 4);
    assert.equal(evidence.receipts.length, signed ? 4 : 0);
    assert.ok(evidence.documents.some(doc => Buffer.from(doc.contentBase64, 'base64').equals(oldBytes)));
    assert.ok(evidence.documents.some(doc => Buffer.from(doc.contentBase64, 'base64').equals(newBytes)));
    assert.doesNotMatch(JSON.stringify(evidence), /\"(?:personId|organizationId|iin|bin|subject|cms|sessionHash|accessCode|csrfToken|mappingKeyId|grant|wireBytes)\"/);
    assert.equal(snapshot(), before); assert.equal(f.calls, calls);
    assert.deepEqual((await f.buyer.call(`${API}/deals/${f.id}/evidence`)).data, evidence);
    assert.equal((await f.outsider.call(`${API}/deals/${f.id}/evidence`)).status, 404);
    assert.equal((await f.buyer.call(`${API}/deals/${f.id}/evidence`, undefined, { Origin: 'https://attacker.invalid' })).status, 403);
    assert.equal((await f.buyer.call(`${API}/deals/${f.id}/evidence`, {})).status, 404);
    await f.restart();
    assert.equal((await f.buyer.call(`${API}/deals/${f.id}/evidence`)).status, 401);
    f.tick(901000);
    assert.equal((await f.buyer.login(f.b.accessCode)).status, 200);
    const historical = await f.buyer.call(`${API}/deals/${f.id}/evidence`);
    assert.equal(historical.status, 200); assert.equal(verifyParticipantEvidence(historical.data).valid, true);
    assert.equal(f.calls, calls, 'export is historical evidence, never a new certificate status check');
    assert.equal(snapshot(), before);
    assert.equal((await f.buyer.call(API + '/session/logout', {})).status, 200);
    assert.equal((await f.buyer.call(`${API}/deals/${f.id}/evidence`)).status, 401);
  });
}

test('evidence export refuses a corrupt protected MODEL signed receipt rather than exporting raw receipt JSON', async t => {
  const f = await fixture(t, true); await f.complete();
  f.sql(db => {
    const row = db.prepare("SELECT id,receipt_json FROM participant_signature_intents WHERE event_json IS NOT NULL LIMIT 1").get();
    const receipt = JSON.parse(row.receipt_json); receipt.snapshotHash = 'f'.repeat(64);
    db.prepare('UPDATE participant_signature_intents SET receipt_json=? WHERE id=?').run(JSON.stringify(receipt), row.id);
  });
  const result = await f.buyer.call(`${API}/deals/${f.id}/evidence`);
  assert.equal(result.status, 409); assert.equal(result.data.error.code, 'signature_receipt_changed');
  assert.doesNotMatch(JSON.stringify(result.data), /SELECT|sqlite|cms|personId|sessionHash|\/Volumes\//);
});
