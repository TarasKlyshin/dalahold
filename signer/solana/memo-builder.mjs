// Internal offline builder. Signed bytes must stay inside the trusted sender.
import { createPublicKey, verify } from 'node:crypto';
import {
  address, appendTransactionMessageInstruction, createKeyPairSignerFromPrivateKeyBytes,
  createTransactionMessage, decompileTransactionMessage, getBase58Decoder, getBase58Encoder,
  getCompiledTransactionMessageDecoder, getSignatureFromTransaction, getTransactionDecoder,
  getTransactionEncoder, pipe, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
} from '@solana/kit';
import {
  checkTestMemoAuthorization, isTestMemoBase58, isTestMemoUint, openTestMemoEnvelope,
  rejectTestMemo, TEST_MEMO_PROGRAM_ID,
} from '../test-memo-grant.mjs';

export function checkTestMemoLifetime(recentBlockhash, lastValidBlockHeight) {
  if (!isTestMemoBase58(recentBlockhash, 32)) rejectTestMemo('invalid_memo_blockhash');
  if (typeof lastValidBlockHeight !== 'bigint' || lastValidBlockHeight < 0n || lastValidBlockHeight > 18_446_744_073_709_551_615n)
    rejectTestMemo('invalid_memo_block_height');
}

/** Decode, authenticate and check the one permitted transaction shape. */
export function inspectTestMemoTransaction({ wireBytes, grant, recentBlockhash, signature }) {
  if (!(wireBytes instanceof Uint8Array) || wireBytes.length < 100 || wireBytes.length > 1_232)
    rejectTestMemo('invalid_memo_wire');
  try {
    const bytes = Buffer.from(wireBytes);
    const tx = getTransactionDecoder().decode(bytes);
    if (!Buffer.from(getTransactionEncoder().encode(tx)).equals(bytes)) rejectTestMemo('invalid_memo_wire');
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const message = decompileTransactionMessage(compiled);
    const entries = Object.entries(tx.signatures);
    const instruction = message.instructions[0];
    if (message.version !== 0 || message.feePayer?.address !== grant.walletAddress ||
        message.lifetimeConstraint?.blockhash !== recentBlockhash || entries.length !== 1 ||
        entries[0][0] !== grant.walletAddress || entries[0][1]?.length !== 64 ||
        compiled.header.numSignerAccounts !== 1 || compiled.header.numReadonlySignerAccounts !== 0 ||
        compiled.header.numReadonlyNonSignerAccounts !== 1 ||
        compiled.staticAccounts.length !== 2 || compiled.staticAccounts[0] !== grant.walletAddress ||
        compiled.staticAccounts[1] !== TEST_MEMO_PROGRAM_ID || (compiled.addressTableLookups?.length ?? 0) !== 0 ||
        message.instructions.length !== 1 || instruction.programAddress !== TEST_MEMO_PROGRAM_ID ||
        (instruction.accounts?.length ?? 0) !== 0 ||
        !Buffer.from(instruction.data ?? []).equals(Buffer.from(grant.memo)) ||
        getSignatureFromTransaction(tx) !== signature) rejectTestMemo('invalid_memo_wire');
    const publicBytes = getBase58Encoder().encode(grant.walletAddress);
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicBytes).toString('base64url') }, format: 'jwk' });
    if (!verify(null, tx.messageBytes, key, entries[0][1])) rejectTestMemo('invalid_memo_wire_signature');
    return { messageBytes: Buffer.from(tx.messageBytes), signature, walletAddress: message.feePayer.address };
  } catch { rejectTestMemo('invalid_memo_wire'); }
}

/** No network calls, accounts, arbitrary instructions, payment or signed-byte HTTP route. */
export async function buildOfflineTestMemo({ envelope, policyPublicKey, signerPrivateKey,
  recentBlockhash, lastValidBlockHeight, now = Date.now(), authorize }) {
  if (!isTestMemoUint(now)) rejectTestMemo('invalid_clock');
  const { grant, grantHash } = openTestMemoEnvelope(envelope, policyPublicKey, { now });
  const guard = () => checkTestMemoAuthorization(authorize, grant, grantHash);
  guard();
  checkTestMemoLifetime(recentBlockhash, lastValidBlockHeight);
  if (!(signerPrivateKey instanceof Uint8Array) || signerPrivateKey.length !== 32)
    rejectTestMemo('memo_signer_key_required');
  const keyCopy = Uint8Array.from(signerPrivateKey);
  let signer;
  try { signer = await createKeyPairSignerFromPrivateKeyBytes(keyCopy); }
  finally { keyCopy.fill(0); guard(); }
  if (signer.address !== grant.walletAddress) rejectTestMemo('memo_wallet_not_bound');
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    value => setTransactionMessageFeePayerSigner(signer, value),
    value => setTransactionMessageLifetimeUsingBlockhash({ blockhash: recentBlockhash, lastValidBlockHeight }, value),
    value => appendTransactionMessageInstruction({ programAddress: address(TEST_MEMO_PROGRAM_ID),
      accounts: [], data: Buffer.from(grant.memo) }, value),
  );
  guard();
  let transaction;
  try { transaction = await signTransactionMessageWithSigners(message); }
  finally { guard(); }
  const wireBytes = Buffer.from(getTransactionEncoder().encode(transaction));
  const signature = getSignatureFromTransaction(transaction);
  const checked = inspectTestMemoTransaction({ wireBytes, grant, recentBlockhash, signature });
  return { wireBytes, messageBytes: checked.messageBytes, signature, walletAddress: signer.address,
    grantId: grant.grantId, recentBlockhash, lastValidBlockHeight, broadcast: false };
}

export async function deriveTestMemoWalletAddress(privateKey) {
  if (!(privateKey instanceof Uint8Array) || privateKey.length !== 32) rejectTestMemo('memo_signer_key_required');
  const copy = Uint8Array.from(privateKey);
  try { return (await createKeyPairSignerFromPrivateKeyBytes(copy)).address; }
  finally { copy.fill(0); }
}

export const encodeTestMemoBase58 = bytes => getBase58Decoder().decode(bytes);
