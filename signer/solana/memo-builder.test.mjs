import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import test from 'node:test';
import { decompileTransactionMessage, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import { createTestMemoEnvelope, TEST_MEMO_PROGRAM_ID } from '../test-memo-grant.mjs';
import { buildOfflineTestMemo, encodeTestMemoBase58, inspectTestMemoTransaction } from './memo-builder.mjs';

const NOW = 1_800_000_000_000;
const BLOCKHASH = encodeTestMemoBase58(new Uint8Array(32).fill(1));
function model() {
  const policy = generateKeyPairSync('ed25519'), wallet = generateKeyPairSync('ed25519');
  const jwk = wallet.privateKey.export({ format: 'jwk' }), snapshotHash = 'a'.repeat(64), eventId = randomUUID();
  const grant = { v: 1, kind: 'test_memo', grantId: randomUUID(), actorId: randomUUID(), bindingId: randomUUID(),
    authEpoch: 1, cluster: 'devnet', expiresAt: NOW + 60_000, intentHash: 'b'.repeat(64), dealId: randomUUID(),
    eventId, snapshotHash, walletAddress: encodeTestMemoBase58(Buffer.from(jwk.x, 'base64url')), programId: TEST_MEMO_PROGRAM_ID,
    memo: `DalaHold TEST v1 ${snapshotHash} ${eventId}`, maxFeeLamports: '10000' };
  const privateKey = Buffer.from(jwk.d, 'base64url');
  const input = patch => ({ envelope: createTestMemoEnvelope(grant, policy.privateKey, { now: NOW }),
    policyPublicKey: policy.publicKey.export({ format: 'jwk' }).x, signerPrivateKey: privateKey,
    recentBlockhash: BLOCKHASH, lastValidBlockHeight: 100n, now: NOW, authorize: () => {}, ...patch });
  return { grant, privateKey, wallet, input };
}

test('offline TEST Memo model signs one exact instruction and payer with no network or SOL transfer', async t => {
  const f = model(), originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('live RPC forbidden'); };
  t.after(() => { globalThis.fetch = originalFetch; f.privateKey.fill(0); });
  const keyBefore = Buffer.from(f.privateKey), built = await buildOfflineTestMemo(f.input());
  assert.deepEqual(f.privateKey, keyBefore);
  assert.equal(built.broadcast, false);
  assert.equal(built.grantId, f.grant.grantId);
  const tx = getTransactionDecoder().decode(built.wireBytes);
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes), message = decompileTransactionMessage(compiled);
  assert.equal(message.version, 0);
  assert.equal(message.feePayer.address, f.grant.walletAddress);
  assert.equal(message.lifetimeConstraint.blockhash, BLOCKHASH);
  assert.deepEqual(compiled.staticAccounts, [f.grant.walletAddress, TEST_MEMO_PROGRAM_ID]);
  assert.equal((compiled.addressTableLookups ?? []).length, 0);
  assert.equal(message.instructions.length, 1);
  assert.equal(message.instructions[0].programAddress, TEST_MEMO_PROGRAM_ID);
  assert.equal((message.instructions[0].accounts ?? []).length, 0);
  assert.deepEqual(Buffer.from(message.instructions[0].data), Buffer.from(f.grant.memo));
  assert.equal(Object.keys(tx.signatures).length, 1);
  assert.equal(verify(null, tx.messageBytes, f.wallet.publicKey, Object.values(tx.signatures)[0]), true);
  assert.deepEqual(built.messageBytes, Buffer.from(tx.messageBytes));
  assert.equal(inspectTestMemoTransaction({ wireBytes: built.wireBytes, grant: f.grant,
    recentBlockhash: BLOCKHASH, signature: built.signature }).walletAddress, f.grant.walletAddress);
});

test('offline TEST Memo model rejects foreign wallet, missing assertion, malformed lifetime and key', async () => {
  const f = model(), foreign = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  for (const patch of [{ signerPrivateKey: Buffer.alloc(64) }, { signerPrivateKey: Buffer.alloc(0) },
    { recentBlockhash: 'bad' }, { lastValidBlockHeight: -1n }, { lastValidBlockHeight: 100 },
    { lastValidBlockHeight: 18_446_744_073_709_551_616n }, { authorize: undefined }, { authorize: () => true }])
    await assert.rejects(buildOfflineTestMemo(f.input(patch)), /memo_signer_key_required|invalid_memo_blockhash|invalid_memo_block_height|memo_authorization_contract_invalid/);
  await assert.rejects(buildOfflineTestMemo(f.input({ signerPrivateKey: Buffer.from(foreign.d, 'base64url') })), /memo_wallet_not_bound/);
  const envelope = JSON.parse(f.input().envelope);
  await assert.rejects(buildOfflineTestMemo(f.input({ envelope: JSON.stringify({ ...envelope,
    payload: Buffer.from(JSON.stringify({ ...f.grant, memo: 'arbitrary memo' })).toString('base64url') }) })), /memo_policy_signature_rejected/);
  f.privateKey.fill(0);
});

test('offline TEST Memo model reasserts authority after both crypto awaits and never returns bytes on rotation', async () => {
  for (const failAt of [1, 2, 3, 4]) {
    const f = model(); let checks = 0;
    await assert.rejects(buildOfflineTestMemo(f.input({ authorize: () => {
      if (++checks === failAt) throw new Error('rotated TEST binding');
    } })), /memo_authorization_rejected/);
    assert.equal(checks, failAt);
    f.privateKey.fill(0);
  }
});

test('offline TEST Memo model authenticates decoded bytes and rejects altered memo/signature/trailing wire', async () => {
  const f = model(), built = await buildOfflineTestMemo(f.input());
  for (const offset of [5, built.wireBytes.length - 1]) {
    const wire = Buffer.from(built.wireBytes); wire[offset] ^= 1;
    assert.throws(() => inspectTestMemoTransaction({ wireBytes: wire, grant: f.grant,
      recentBlockhash: BLOCKHASH, signature: built.signature }), /invalid_memo_wire/);
  }
  assert.throws(() => inspectTestMemoTransaction({ wireBytes: Buffer.concat([built.wireBytes, Buffer.from([0])]),
    grant: f.grant, recentBlockhash: BLOCKHASH, signature: built.signature }), /invalid_memo_wire/);
  assert.throws(() => inspectTestMemoTransaction({ wireBytes: built.wireBytes,
    grant: f.grant, recentBlockhash: encodeTestMemoBase58(new Uint8Array(32).fill(2)), signature: built.signature }), /invalid_memo_wire/);
  f.privateKey.fill(0);
});

test('offline TEST Memo model refuses a validly signed message with writable program or readonly fee payer', async () => {
  const f = model(), built = await buildOfflineTestMemo(f.input());
  for (const [offset, value] of [[68, 0], [67, 1]]) {
    const wire = Buffer.from(built.wireBytes);
    assert.equal(wire[65], 128); // one compact signature + version-0 header
    wire[offset] = value;
    const signature = sign(null, wire.subarray(65), f.wallet.privateKey);
    signature.copy(wire, 1);
    assert.throws(() => inspectTestMemoTransaction({ wireBytes: wire, grant: f.grant,
      recentBlockhash: BLOCKHASH, signature: encodeTestMemoBase58(signature) }), /invalid_memo_wire/);
  }
  f.privateKey.fill(0);
});
