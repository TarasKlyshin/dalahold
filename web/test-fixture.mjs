// Trusted startup-only fixture. No HTTP operation chooses actors or decisions.
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SignedDecisionFixture } from '../workflow/signed-decision-fixture.mjs';
import { preparePrivateTestDatabase } from './private-test-store.mjs';

export const TEST_DEAL_ID = '18000000-0000-4000-8000-000000000001';
const SELLER = '18000000-0000-4000-8000-000000000002';
const BUYER = '18000000-0000-4000-8000-000000000003';

export async function prepareReadOnlyTestFixture({ draftDbPath, decisionDbPath }) {
  preparePrivateTestDatabase(decisionDbPath);
  const draft = new DatabaseSync(draftDbPath);
  try {
    if (!draft.prepare('SELECT 1 FROM drafts WHERE id=?').get(TEST_DEAL_ID)) {
      // An existing offered fixture must NEVER acquire a replacement draft.
      const existing = new DatabaseSync(decisionDbPath);
      try {
        if (existing.prepare("SELECT 1 FROM sqlite_schema WHERE name='decision_deals'").get() &&
            existing.prepare('SELECT 1 FROM decision_deals WHERE deal_id=?').get(TEST_DEAL_ID))
          throw new Error('test_fixture_draft_missing');
      } finally { existing.close(); }
      draft.exec('BEGIN IMMEDIATE');
      try {
        const now = Date.now();
        draft.prepare('INSERT INTO drafts(id,scenario,quantity,amount,date,created_at,version) VALUES(?,?,?,?,?,?,1)')
          .run(TEST_DEAL_ID,'grain',20000,5000000,'2026-10-10',now);
        draft.prepare('INSERT INTO draft_versions(deal_id,version,scenario,quantity,amount,date,changed_at) VALUES(?,1,?,?,?,?,?)')
          .run(TEST_DEAL_ID,'grain',20000,5000000,'2026-10-10',now);
        draft.exec('COMMIT');
      } catch (error) { draft.exec('ROLLBACK'); throw error; }
    }
  } finally { draft.close(); }
  const keys = { seller:generateKeyPairSync('ed25519'), buyer:generateKeyPairSync('ed25519') };
  const fixture = new SignedDecisionFixture({ draftDbPath,decisionDbPath,
    verifySigned:async (bytes,signature,certificateId) => {
      const key = keys[certificateId];
      return key && verify(null,bytes,key.publicKey,signature)
        ? {actorId:certificateId === 'seller' ? SELLER : BUYER,status:'valid'} : null;
    }, verifyPowers:async () => true }); // Synthetic fixture only; not corporate powers.
  try {
    if (!fixture.deal(TEST_DEAL_ID)) fixture.bindDeal({dealId:TEST_DEAL_ID,sellerId:SELLER,buyerId:BUYER});
    // Setup is resumable only along this one frozen TEST path. Generated keys
    // sign NEW fixture decisions; stored hashes remain test-key metadata only.
    const actions = { draft:['offer','seller'], offered:['accept_terms','buyer'],
      agreed:['reserve_demo','buyer'], demo_reserved:['claim_handover','seller'],
      handover_claimed:['accept_delivery','buyer'], delivery_accepted:['release_demo','buyer'] };
    for (let i=0;i<6;i++) {
      const state = fixture.deal(TEST_DEAL_ID);
      const step = actions[state.status];
      if (!step) break;
      const [action,role] = step;
      const challenge = fixture.issueChallenge({dealId:TEST_DEAL_ID,actorId:role==='seller'?SELLER:BUYER,action});
      const signature = sign(null,Buffer.from(challenge.bytesBase64url,'base64url'),keys[role].privateKey);
      await fixture.submitChallenge({challengeId:challenge.challengeId,signature,certificateId:role});
    }
    fixture.demoEvidence(TEST_DEAL_ID); // Validate before exposing the callback.
    return { read:dealId => dealId === TEST_DEAL_ID ? fixture.demoEvidence(dealId) : null,
      close:() => fixture.close() };
  } catch (error) { fixture.close(); throw error; }
}
