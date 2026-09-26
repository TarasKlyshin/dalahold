import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { decompileTransactionMessage, getBase58Decoder,
  getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import { parseTransferSolInstruction } from '@solana-program/system';
import { SIGNING_PREFIX, Signer, SYSTEM_PROGRAM_ID } from '../signer.mjs';

const OWNER_ID = 'f1d05a12-5849-4a6b-9f47-a7a11dfa0132';
const RECIPIENT = 'DNJtnMP3CbEN5Wvio7zFDEUcBAEfdzrxdQVj2i4sYXwY';
const NOW = 1_799_999_940_000;
const BLOCKHASH = getBase58Decoder().decode(new Uint8Array(32).fill(1));
const OTHER_BLOCKHASH = getBase58Decoder().decode(new Uint8Array(32).fill(2));

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-offline-assembly-'));
  const dbPath = join(directory, 'signer.sqlite');
  const policy = generateKeyPairSync('ed25519');
  const wallet = generateKeyPairSync('ed25519');
  const walletJwk = wallet.privateKey.export({ format: 'jwk' });
  const walletAddress = getBase58Decoder().decode(Buffer.from(walletJwk.x, 'base64url'));
  const privateKey = Buffer.from(walletJwk.d, 'base64url');
  const policyPublicKey = policy.publicKey.export({ format: 'jwk' }).x;
  let simulatedSends = 0;
  let signer;
  const open = () => new Signer({
    dbPath, policyPublicKey, wallets: { [OWNER_ID]: walletAddress },
    send: () => { simulatedSends += 1; }, now: () => NOW,
  });
  signer = open();
  t.after(() => {
    signer?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const envelope = (value) => {
    const payload = Buffer.from(JSON.stringify(value));
    return JSON.stringify({
      payload: payload.toString('base64url'),
      sig: sign(null, Buffer.concat([SIGNING_PREFIX, payload]), policy.privateKey).toString('base64url'),
    });
  };
  const grant = {
    v: 1, kind: 'test_transfer',
    grant_id: 'c26bcdad-15f4-4fb4-95df-5ba7404d0680', owner_id: OWNER_ID,
    auth_epoch: 0, cluster: 'devnet', expires_at: NOW + 60_000,
    order_hash: 'a'.repeat(64), wallet_address: walletAddress,
    program_id: SYSTEM_PROGRAM_ID, asset: 'SOL', recipient: RECIPIENT,
    amount_lamports: '1200', max_fee_lamports: '5000',
  };
  const request = (changes = {}) => ({
    envelope: envelope(grant), signerPrivateKey: privateKey,
    recentBlockhash: BLOCKHASH, lastValidBlockHeight: 100n, ...changes,
  });
  return {
    grant, envelope, request, privateKey, wallet, dbPath,
    get signer() { return signer; },
    get simulatedSends() { return simulatedSends; },
    restart: () => { signer.close(); signer = open(); },
    close: () => { signer.close(); signer = null; },
  };
}

test('approved grant assembles once offline and replays the same bytes after restart', async (t) => {
  const fx = setup(t);
  const first = await fx.signer.prepareOfflineTransfer(fx.request());
  assert.equal(first.status, 'assembled');
  assert.equal(first.replayed, false);
  assert.equal(first.broadcast, false);
  assert.equal(fx.simulatedSends, 0);
  const transaction = getTransactionDecoder().decode(first.wireBytes);
  assert.equal(Object.values(transaction.signatures).length, 1);
  assert.equal(verify(null, transaction.messageBytes, fx.wallet.publicKey,
    Object.values(transaction.signatures)[0]), true);
  const message = decompileTransactionMessage(
    getCompiledTransactionMessageDecoder().decode(transaction.messageBytes));
  assert.equal(message.instructions.length, 1);
  const transfer = parseTransferSolInstruction(message.instructions[0]);
  assert.equal(transfer.accounts.source.address, fx.grant.wallet_address);
  assert.equal(transfer.accounts.destination.address, RECIPIENT);
  assert.equal(transfer.data.amount, 1200n);
  const expectedWireBytes = Buffer.from(first.wireBytes);
  first.wireBytes[0] ^= 0xff;

  const replay = await fx.signer.prepareOfflineTransfer(fx.request({
    recentBlockhash: OTHER_BLOCKHASH, lastValidBlockHeight: 200n,
  }));
  assert.equal(replay.replayed, true);
  assert.equal(replay.signature, first.signature);
  assert.deepEqual(replay.wireBytes, expectedWireBytes);
  await assert.rejects(fx.signer.transfer(fx.request().envelope), /order_already_assembled/);
  fx.restart();
  const afterRestart = await fx.signer.prepareOfflineTransfer(fx.request());
  assert.equal(afterRestart.replayed, true);
  assert.deepEqual(afterRestart.wireBytes, expectedWireBytes);
  assert.equal(fx.simulatedSends, 0);
});

test('parallel duplicates use one assembly and a competing grant cannot reuse the order', async (t) => {
  const fx = setup(t);
  const results = await Promise.all(Array.from({ length: 20 }, () =>
    fx.signer.prepareOfflineTransfer(fx.request())));
  assert.equal(results.filter((item) => !item.replayed).length, 1);
  assert.ok(results.every((item) => item.signature === results[0].signature));
  assert.ok(results.every((item) => item.wireBytes.equals(results[0].wireBytes)));
  assert.equal(fx.simulatedSends, 0);
  await assert.rejects(fx.signer.prepareOfflineTransfer(fx.request({
    envelope: fx.envelope({ ...fx.grant, grant_id: 'ac4a988b-c8cc-4c25-9c89-2369b732eb9f' }),
  })), /order_already_assembled/);
});

test('the existing simulated-transfer path cannot be repackaged as signed bytes', async (t) => {
  const fx = setup(t);
  assert.equal((await fx.signer.transfer(fx.request().envelope)).status, 'submitted');
  assert.equal(fx.simulatedSends, 1);
  await assert.rejects(fx.signer.prepareOfflineTransfer(fx.request()), /order_already_granted/);
});

test('an assembly failure can retry the same reservation, never the simulated path', async (t) => {
  const fx = setup(t);
  await assert.rejects(fx.signer.prepareOfflineTransfer(fx.request({
    recentBlockhash: 'invalid',
  })), /invalid recent blockhash/);
  await assert.rejects(fx.signer.transfer(fx.request().envelope), /order_already_assembled/);
  const recovered = await fx.signer.prepareOfflineTransfer(fx.request());
  assert.equal(recovered.status, 'assembled');
  assert.equal(recovered.replayed, false);
  assert.equal(fx.simulatedSends, 0);
});

test('wrong Solana key cannot assemble; replacement certificate epoch blocks old grant', async (t) => {
  const fx = setup(t);
  const foreign = generateKeyPairSync('ed25519');
  await assert.rejects(fx.signer.prepareOfflineTransfer(fx.request({
    signerPrivateKey: Buffer.from(foreign.privateKey.export({ format: 'jwk' }).d, 'base64url'),
  })), /signer wallet not bound/);
  await assert.rejects(fx.signer.prepareOfflineTransfer(fx.request({
    envelope: '{}',
  })), /bad_envelope/);
  const first = await fx.signer.prepareOfflineTransfer(fx.request());
  assert.equal(first.status, 'assembled');
  await assert.rejects(fx.signer.prepareOfflineTransfer(fx.request({
    signerPrivateKey: Buffer.from(foreign.privateKey.export({ format: 'jwk' }).d, 'base64url'),
  })), /signer wallet not bound/);
  const notice = fx.envelope({ v: 1, kind: 'epoch', owner_id: OWNER_ID, auth_epoch: 1 });
  assert.equal(fx.signer.epoch(notice).auth_epoch, 1);
  await assert.rejects(fx.signer.prepareOfflineTransfer(fx.request()), /stale_epoch/);
  fx.close();
  const database = new DatabaseSync(fx.dbPath);
  const row = database.prepare('SELECT status, wire_bytes, signature FROM assemblies WHERE grant_id = ?')
    .get(fx.grant.grant_id);
  database.close();
  assert.equal(row.status, 'cancelled');
  assert.equal(row.wire_bytes, null);
  assert.equal(row.signature, null);
  assert.equal(fx.simulatedSends, 0);
});
