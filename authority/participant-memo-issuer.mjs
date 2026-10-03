// Internal bridge from protected personal TEST CMS records to Memo policy grants.
// Never accept a browser receipt/identity object or expose the envelope/wire bytes.
import { createPublicKey } from 'node:crypto';
import { createTestMemoEnvelope, openTestMemoEnvelope, TEST_MEMO_PROGRAM_ID } from '../signer/test-memo-grant.mjs';

const SCOPE = 'local_personal_test_signed_deal_only';
const fail = code => { throw new Error(code); };

export function createParticipantMemoIssuer({ store, policyPrivateKey, walletAddress,
  executionAccepted = false, now = Date.now } = {}) {
  if (!store?.signedTest || typeof store.readMemoAuthorization !== 'function' ||
      policyPrivateKey?.type !== 'private' || policyPrivateKey.asymmetricKeyType !== 'ed25519' ||
      typeof walletAddress !== 'string' || typeof executionAccepted !== 'boolean' || typeof now !== 'function')
    fail('participant_memo_issuer_invalid');
  const policyPublicKey = createPublicKey(policyPrivateKey).export({ format: 'jwk' }).x;

  function exactGrant(actorId, intentId) {
    // The store checks private CMS/receipt MAC, exact current snapshot, configured
    // operation, pinned certificate and signed/status deadlines. No caller evidence.
    const accepted = store.readMemoAuthorization(actorId, intentId);
    const { operation, receipt, binding, expiresAt } = accepted;
    const at = now();
    if (!Number.isSafeInteger(at) || at < 0 || receipt.scope !== SCOPE || binding.scope !== SCOPE ||
        receipt.action !== 'anchor_test_memo' || receipt.statusSource !== 'test_ocsp' ||
        receipt.actorId !== actorId || receipt.intentId !== intentId ||
        binding.bindingId !== receipt.bindingId || binding.certificateDigest !== receipt.certificateDigest ||
        binding.authEpoch !== receipt.authEpoch || operation.cluster !== 'devnet' ||
        operation.programId !== TEST_MEMO_PROGRAM_ID || operation.walletAddress !== walletAddress ||
        receipt.snapshotHash !== operation.snapshotHash || receipt.eventId !== operation.eventId ||
        !Number.isSafeInteger(expiresAt) || expiresAt <= at ||
        !Number.isSafeInteger(receipt.validUntil) || receipt.validUntil <= at)
      fail('participant_memo_authorization_rejected');
    return { v: 1, kind: 'test_memo', grantId: intentId, actorId,
      bindingId: binding.bindingId, authEpoch: binding.authEpoch, cluster: 'devnet',
      expiresAt: Math.min(expiresAt, receipt.validUntil), intentHash: receipt.intentHash,
      dealId: receipt.dealId, eventId: operation.eventId, snapshotHash: operation.snapshotHash,
      walletAddress, programId: TEST_MEMO_PROGRAM_ID, memo: operation.memo,
      maxFeeLamports: operation.maxFeeLamports };
  }

  function issue(actorId, intentId) {
    return createTestMemoEnvelope(exactGrant(actorId, intentId), policyPrivateKey, { now: now() });
  }

  // Sender repeats this synchronous assertion before build and after each await.
  // Execution remains closed until the operator accepts genuine signing/renewal,
  // replay/rotation gates and the stable fee-only TEST wallet. Code is not that proof.
  function authorize(grant, grantHash) {
    if (!executionAccepted) fail('participant_memo_execution_not_accepted');
    const expected = openTestMemoEnvelope(issue(grant.actorId, grant.grantId), policyPublicKey, { now: now() });
    if (expected.grantHash !== grantHash || JSON.stringify(expected.grant) !== JSON.stringify(grant))
      fail('participant_memo_authorization_rejected');
  }
  return Object.freeze({ policyPublicKey, issue, authorize, executionAccepted });
}
