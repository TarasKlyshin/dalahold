import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import test from 'node:test';
import {
  decompileTransactionMessage, getBase58Decoder, getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit';
import { parseTransferSolInstruction, SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { SIGNING_PREFIX } from '../signer.mjs';
import { buildOfflineTransfer } from './transaction-builder.mjs';

const NOW = 1_799_999_940_000;
const OWNER_ID = 'f1d05a12-5849-4a6b-9f47-a7a11dfa0132';
const GRANT_ID = 'c26bcdad-15f4-4fb4-95df-5ba7404d0680';
const RECIPIENT = 'DNJtnMP3CbEN5Wvio7zFDEUcBAEfdzrxdQVj2i4sYXwY';
const BLOCKHASH = getBase58Decoder().decode(new Uint8Array(32).fill(1));

function fixture() {
  const policy = generateKeyPairSync('ed25519');
  const wallet = generateKeyPairSync('ed25519');
  const walletJwk = wallet.privateKey.export({ format: 'jwk' });
  const walletAddress = getBase58Decoder().decode(Buffer.from(walletJwk.x, 'base64url'));
  const grant = {
    v: 1, kind: 'test_transfer', grant_id: GRANT_ID,
    owner_id: OWNER_ID, auth_epoch: 0, cluster: 'devnet',
    expires_at: NOW + 60_000, order_hash: 'a'.repeat(64),
    wallet_address: walletAddress, program_id: SYSTEM_PROGRAM_ADDRESS,
    asset: 'SOL', recipient: RECIPIENT, amount_lamports: '1200',
    max_fee_lamports: '5000',
  };
  const envelopeFor = (value) => {
    const payload = Buffer.from(JSON.stringify(value));
    return JSON.stringify({
      payload: payload.toString('base64url'),
      sig: sign(null, Buffer.concat([SIGNING_PREFIX, payload]), policy.privateKey).toString('base64url'),
    });
  };
  const input = (overrides = {}) => ({
    envelope: envelopeFor(grant),
    policyPublicKey: policy.publicKey.export({ format: 'jwk' }).x,
    signerPrivateKey: Buffer.from(walletJwk.d, 'base64url'),
    recentBlockhash: BLOCKHASH, lastValidBlockHeight: 100n,
    now: NOW, ...overrides,
  });
  return { policy, wallet, grant, input, envelopeFor };
}

test('serializes one exact signed System Program transfer without network access', async (t) => {
  const fx = fixture();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => { fetchCalls += 1; throw new Error('network forbidden'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const request = fx.input();
  const privateKeyBefore = Buffer.from(request.signerPrivateKey);
  const result = await buildOfflineTransfer(request);
  assert.equal(fetchCalls, 0);
  assert.equal(result.broadcast, false);
  assert.equal(result.walletAddress, fx.grant.wallet_address);
  assert.equal(result.grantId, GRANT_ID);
  assert.deepEqual(request.signerPrivateKey, privateKeyBefore);
  assert.ok(result.wireBytes.length > 0);

  const transaction = getTransactionDecoder().decode(result.wireBytes);
  const signatures = Object.values(transaction.signatures);
  assert.equal(signatures.length, 1);
  assert.equal(verify(null, transaction.messageBytes, fx.wallet.publicKey,
    signatures[0]), true);
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const message = decompileTransactionMessage(compiled);
  assert.equal(message.version, 0);
  assert.equal(message.feePayer.address, fx.grant.wallet_address);
  assert.equal(message.lifetimeConstraint.blockhash, BLOCKHASH);
  assert.equal(message.instructions.length, 1);
  assert.equal(message.instructions[0].programAddress, SYSTEM_PROGRAM_ADDRESS);
  const transfer = parseTransferSolInstruction(message.instructions[0]);
  assert.equal(transfer.accounts.source.address, fx.grant.wallet_address);
  assert.equal(transfer.accounts.destination.address, RECIPIENT);
  assert.equal(transfer.data.amount, 1200n);
  assert.equal(result.signature, getBase58Decoder().decode(signatures[0]));
});

test('rejects direct bypass, tampering, wrong signer and unsupported transaction shape', async () => {
  const fx = fixture();
  const valid = JSON.parse(fx.input().envelope);
  const changedAmount = { ...fx.grant, amount_lamports: '1300' };
  const changedRecipient = { ...fx.grant, recipient: fx.grant.wallet_address };
  const tamper = (value) => JSON.stringify({ ...valid,
    payload: Buffer.from(JSON.stringify(value)).toString('base64url'),
  });
  await assert.rejects(buildOfflineTransfer(fx.input({ envelope: tamper(changedAmount) })),
    /policy signature rejected/);
  await assert.rejects(buildOfflineTransfer(fx.input({ envelope: tamper(changedRecipient) })),
    /policy signature rejected/);
  const foreign = generateKeyPairSync('ed25519');
  await assert.rejects(buildOfflineTransfer(fx.input({
    signerPrivateKey: Buffer.from(foreign.privateKey.export({ format: 'jwk' }).d, 'base64url'),
  })), /signer wallet not bound/);
  for (const modified of [
    { cluster: 'mainnet-beta' }, { program_id: RECIPIENT }, { asset: 'USDC' },
    { amount_lamports: '1000001' }, { max_fee_lamports: '4999' },
    { expires_at: NOW - 1 },
  ]) {
    await assert.rejects(buildOfflineTransfer(fx.input({
      envelope: fx.envelopeFor({ ...fx.grant, ...modified }),
    })), /grant outside offline transfer policy/);
  }
  await assert.rejects(buildOfflineTransfer(fx.input({ recentBlockhash: 'bad' })),
    /invalid recent blockhash/);
  await assert.rejects(buildOfflineTransfer(fx.input({ signerPrivateKey: Buffer.alloc(64) })),
    /32-byte signer private key required/);
});
