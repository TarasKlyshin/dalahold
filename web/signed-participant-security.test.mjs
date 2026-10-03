// Real ParticipantStore transaction adapter with an explicitly MODEL verifier.
// No NCALayer, SDK certificates, retained runtime data or network transactions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ParticipantStore } from './participant-store.mjs';

const SESSION = 'b'.repeat(64);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-signed-atomic-'));
  const dbPath = join(directory, 'participants.sqlite');
  let time = 1000000;
  const sdk = { statusSource: 'test_ocsp', inspect: async () => ({}),
    async verifyIdentity(bytes, cms, mappingKey) {
      const model = JSON.parse(cms.toString('utf8'));
      if (model.hash !== hash(bytes)) return { verified: false };
      return { verified: true, statusSource: 'test_ocsp', validUntil: time + 300000,
        certificateDigest: hash(`MODEL certificate ${model.person}`),
        identity: { schema: 'nca_test_subject_v1',
          personId: `person:${createHmac('sha256', mappingKey).update(model.person).digest('hex')}`,
          organizationId: null } };
    } };
  const store = new ParticipantStore({ dbPath, signatureSdk: sdk, now: () => time });
  const countIntents = () => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { return db.prepare('SELECT count(*) AS n FROM participant_signature_intents').get().n; }
    finally { db.close(); }
  };
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, countIntents, setTime(value) { time = value; },
    async enroll(actorId, person) {
      const intent = store.createEnrollmentIntent(actorId, SESSION, {});
      return store.submitSignature(actorId, SESSION, { intentId: intent.id,
        cms: Buffer.from(JSON.stringify({ person, hash: intent.hash })) });
    } };
}

test('actual store carries nested enrollment expiry to the outermost COMMIT', t => {
  const f = fixture(t), actor = f.store.register().participant.id;
  assert.throws(() => f.store.withCommitGuard(() => {}, () => {
    const issued = f.store.createEnrollmentIntent(actor, SESSION, {});
    f.setTime(issued.expiresAt);
  }), /signature_intent_expired/);
  assert.equal(f.countIntents(), 0);
});

test('actual store retains the nested signature session guard after RELEASE', t => {
  const f = fixture(t), actor = f.store.register().participant.id;
  let open = true;
  assert.throws(() => f.store.withCommitGuard(() => {}, () => {
    f.store.createEnrollmentIntent(actor, SESSION, {}, { assertCurrent() {
      if (!open) throw new Error('MODEL session closed');
    } });
    open = false;
  }), /MODEL session closed/);
  assert.equal(f.countIntents(), 0);
});

test('actual store rolls back an issued signature intent and later manifest change together', async t => {
  const f = fixture(t), seller = f.store.register().participant.id, buyer = f.store.register().participant.id;
  await f.enroll(seller, 'MODEL seller'); await f.enroll(buyer, 'MODEL buyer');
  const deal = f.store.createDeal(seller, { requestId: randomUUID(), creatorRole: 'seller',
    scenario: 'grain', quantity: 20, amount: 200000, date: '2026-10-03' });
  const invitation = f.store.createInvitation(seller, deal.id, { expectedVersion: 1, participantId: buyer });
  f.store.claimInvitation(buyer, { code: invitation.code });
  const current = f.store.getDeal(seller, deal.id), before = f.countIntents();
  assert.throws(() => f.store.withCommitGuard(() => {}, () => {
    f.store.createSignatureIntent(seller, deal.id, SESSION, { requestId: randomUUID(), action: 'offer',
      expectedVersion: current.version, expectedStateRevision: current.stateRevision, snapshotHash: current.snapshotHash });
    f.store.addDocument(seller, deal.id, { requestId: randomUUID(), expectedVersion: 1,
      category: 'contract', bytes: Buffer.from('ANONYMIZED MODEL TEST') });
  }), /signature_snapshot_stale/);
  assert.equal(f.countIntents(), before);
  assert.deepEqual(f.store.getDeal(seller, deal.id), current);
});
