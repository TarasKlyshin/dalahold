// Offline-only Solana transaction assembly. No RPC client or send capability.
// This validates a policy-signed grant, but durable replay and current authority
// epoch remain the responsibility of the surrounding signer boundary.
import { createPublicKey, verify } from 'node:crypto';
import {
  address, appendTransactionMessageInstruction, createKeyPairSignerFromPrivateKeyBytes,
  createTransactionMessage, getBase58Decoder, getBase58Encoder, getSignatureFromTransaction,
  getTransactionEncoder, pipe, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
} from '@solana/kit';
import { getTransferSolInstruction, SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import {
  FEE_LAMPORTS, isAddress, MAX_AMOUNT_LAMPORTS, MAX_GRANT_TTL_MS,
  SIGNING_PREFIX, SYSTEM_PROGRAM_ID,
} from '../signer.mjs';

const GRANT_FIELDS = [
  'v', 'kind', 'grant_id', 'owner_id', 'auth_epoch', 'cluster', 'expires_at',
  'order_hash', 'wallet_address', 'program_id', 'asset', 'recipient',
  'amount_lamports', 'max_fee_lamports',
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const LAMPORTS = /^[1-9][0-9]{0,18}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function decodeBase64url(value) {
  if (typeof value !== 'string' || !BASE64URL.test(value)) throw new Error('invalid base64url');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw new Error('non-canonical base64url');
  return bytes;
}

function exactKeys(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function openGrant(envelope, policyPublicKey, now) {
  if (typeof envelope !== 'string' || typeof policyPublicKey !== 'string') {
    throw new Error('policy envelope and public key required');
  }
  let parsed;
  try { parsed = JSON.parse(envelope); }
  catch { throw new Error('invalid policy envelope'); }
  if (!exactKeys(parsed, ['payload', 'sig'])) throw new Error('invalid policy envelope');
  const payload = decodeBase64url(parsed.payload);
  const signature = decodeBase64url(parsed.sig);
  const publicBytes = decodeBase64url(policyPublicKey);
  if (signature.length !== 64 || publicBytes.length !== 32) throw new Error('invalid policy key or signature');
  const publicKey = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: policyPublicKey }, format: 'jwk',
  });
  if (!verify(null, Buffer.concat([SIGNING_PREFIX, payload]), publicKey, signature)) {
    throw new Error('policy signature rejected');
  }
  const text = payload.toString('utf8');
  let grant;
  try { grant = JSON.parse(text); }
  catch { throw new Error('invalid grant JSON'); }
  if (!exactKeys(grant, GRANT_FIELDS) || JSON.stringify(grant, GRANT_FIELDS) !== text) {
    throw new Error('non-canonical grant');
  }
  if (grant.v !== 1 || grant.kind !== 'test_transfer' ||
      !UUID.test(grant.grant_id) || !UUID.test(grant.owner_id) ||
      !Number.isSafeInteger(grant.auth_epoch) || grant.auth_epoch < 0 ||
      grant.cluster !== 'devnet' ||
      !Number.isSafeInteger(grant.expires_at) || grant.expires_at <= now ||
      grant.expires_at > now + MAX_GRANT_TTL_MS ||
      !SHA256_HEX.test(grant.order_hash) ||
      !isAddress(grant.wallet_address) || !isAddress(grant.recipient) ||
      grant.program_id !== SYSTEM_PROGRAM_ID || grant.asset !== 'SOL' ||
      typeof grant.amount_lamports !== 'string' || !LAMPORTS.test(grant.amount_lamports) ||
      typeof grant.max_fee_lamports !== 'string' || !LAMPORTS.test(grant.max_fee_lamports) ||
      BigInt(grant.amount_lamports) > MAX_AMOUNT_LAMPORTS ||
      BigInt(grant.max_fee_lamports) < FEE_LAMPORTS) {
    throw new Error('grant outside offline transfer policy');
  }
  return grant;
}

function checkBlockhash(recentBlockhash) {
  if (typeof recentBlockhash !== 'string') throw new Error('recent blockhash required');
  try {
    const raw = getBase58Encoder().encode(recentBlockhash);
    if (raw.length !== 32 || getBase58Decoder().decode(raw) !== recentBlockhash) {
      throw new Error('invalid recent blockhash');
    }
  } catch { throw new Error('invalid recent blockhash'); }
  return recentBlockhash;
}

/**
 * Assemble one real, signed Solana System Program transfer without broadcasting.
 * A caller must separately enforce durable grant replay and current owner epoch.
 * signerPrivateKey is a 32-byte ephemeral test key supplied in memory, never EDS.
 */
export async function buildOfflineTransfer({
  envelope, policyPublicKey, signerPrivateKey, recentBlockhash,
  lastValidBlockHeight, now = Date.now(),
}) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid clock');
  const grant = openGrant(envelope, policyPublicKey, now);
  if (!(signerPrivateKey instanceof Uint8Array) || signerPrivateKey.length !== 32) {
    throw new Error('32-byte signer private key required');
  }
  if (typeof lastValidBlockHeight !== 'bigint' || lastValidBlockHeight < 0n) {
    throw new Error('valid block height required');
  }
  checkBlockhash(recentBlockhash);
  if (SYSTEM_PROGRAM_ADDRESS !== SYSTEM_PROGRAM_ID) throw new Error('system program mismatch');

  // Copy so the caller's input is never mutated; clear the copy after import.
  const keyCopy = Uint8Array.from(signerPrivateKey);
  let signer;
  try { signer = await createKeyPairSignerFromPrivateKeyBytes(keyCopy); }
  finally { keyCopy.fill(0); }
  if (signer.address !== grant.wallet_address) throw new Error('signer wallet not bound to grant');

  const instruction = getTransferSolInstruction({
    source: signer, destination: address(grant.recipient),
    amount: BigInt(grant.amount_lamports),
  });
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (value) => setTransactionMessageFeePayerSigner(signer, value),
    (value) => setTransactionMessageLifetimeUsingBlockhash({
      blockhash: recentBlockhash, lastValidBlockHeight,
    }, value),
    (value) => appendTransactionMessageInstruction(instruction, value),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  return {
    wireBytes: Buffer.from(getTransactionEncoder().encode(transaction)),
    signature: getSignatureFromTransaction(transaction),
    walletAddress: signer.address,
    grantId: grant.grant_id,
    orderHash: grant.order_hash,
    broadcast: false,
  };
}
