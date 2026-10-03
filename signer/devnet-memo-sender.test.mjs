import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { preparePrivateTestDatabase } from '../web/private-test-store.mjs';
import { DevnetMemoSender } from './devnet-memo-sender.mjs';
import { createTestMemoEnvelope, DEVNET_GENESIS_HASH, openTestMemoEnvelope, TEST_MEMO_PROGRAM_ID } from './test-memo-grant.mjs';
import { encodeTestMemoBase58, inspectTestMemoTransaction } from './solana/memo-builder.mjs';

const NOW = 1_800_000_000_000, BLOCKHASH = encodeTestMemoBase58(new Uint8Array(32).fill(1));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function model(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dalahold-devnet-memo-model-')); chmodSync(root, 0o700);
  const dbPath = join(root, 'private', 'memo.sqlite');
  const policy = generateKeyPairSync('ed25519'), wallet = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  const privateKey = Buffer.from(wallet.d, 'base64url'), snapshotHash = 'a'.repeat(64), eventId = randomUUID();
  const grant = { v: 1, kind: 'test_memo', grantId: randomUUID(), actorId: randomUUID(), bindingId: randomUUID(),
    authEpoch: 1, cluster: 'devnet', expiresAt: NOW + 60_000, intentHash: 'b'.repeat(64), dealId: randomUUID(), eventId,
    snapshotHash, walletAddress: encodeTestMemoBase58(Buffer.from(wallet.x, 'base64url')), programId: TEST_MEMO_PROGRAM_ID,
    memo: `DalaHold TEST v1 ${snapshotHash} ${eventId}`, maxFeeLamports: '10000' };
  const policyPublicKey = policy.publicKey.export({ format: 'jwk' }).x;
  const envelope = createTestMemoEnvelope(grant, policy.privateKey, { now: NOW });
  const grantHash = openTestMemoEnvelope(envelope, policyPublicKey, { now: NOW }).grantHash;
  const state = { time: NOW, receiptAccepted: true, currentEpoch: 1, currentBinding: grant.bindingId,
    currentActor: grant.actorId, keyCalls: 0, authCalls: 0, calls: [], sends: 0, wire: null, signature: null,
    fee: 5000, balance: 10000, height: 50, genesis: DEVNET_GENESIS_HASH, status: null, transaction: 'exact' };
  const call = async (method, action) => {
    state.calls.push(method);
    await options.onRpc?.(method, state);
    return action();
  };
  const rpc = {
    getGenesisHash: () => call('getGenesisHash', () => state.genesis),
    getLatestBlockhash: () => call('getLatestBlockhash', () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 100 })),
    getFeeForMessage: bytes => call('getFeeForMessage', () => { assert.ok(bytes instanceof Uint8Array); return state.fee; }),
    getBalance: address => call('getBalance', () => { assert.equal(address, grant.walletAddress); return state.balance; }),
    getBlockHeight: () => call('getBlockHeight', () => state.height),
    getSignatureStatus: signature => call('getSignatureStatus', () => { assert.equal(signature, state.signature); return state.status; }),
    getTransaction: signature => call('getTransaction', () => {
      assert.equal(signature, state.signature);
      if (state.transaction !== 'exact') return state.transaction;
      return { slot: 70, version: 0, blockTime: 1_800_000_000, transaction: [state.wire.toString('base64'), 'base64'],
        meta: { err: null, fee: state.fee, innerInstructions: [], loadedAddresses: { readonly: [], writable: [] } } };
    }),
    sendTransaction: async wire => {
      state.calls.push('sendTransaction'); state.sends++; state.wire = Buffer.from(wire);
      assert.equal(state.wire[0], 1);
      state.signature = encodeTestMemoBase58(state.wire.subarray(1, 65));
      inspectTestMemoTransaction({ wireBytes: state.wire, grant, recentBlockhash: BLOCKHASH, signature: state.signature });
      await options.onSend?.(state);
      return state.signature;
    },
  };
  const config = {
    dbPath, policyPublicKey, walletAddress: grant.walletAddress, rpc,
    executeEnabled: options.executeEnabled ?? true,
    now: () => { options.onNow?.(state); return state.time; },
    keyProvider: async () => { state.keyCalls++; await options.onKey?.(state); return privateKey; },
    authorize: (value, hash) => {
      state.authCalls++;
      assert.equal(hash, grantHash); assert.deepEqual(value, grant);
      options.onAuth?.(state);
      if (!state.receiptAccepted || state.currentEpoch !== value.authEpoch || state.currentBinding !== value.bindingId ||
          state.currentActor !== value.actorId) throw new Error('MODEL lacks exact accepted TEST-NCA anchor/current personal binding');
    },
  };
  const opened = [];
  const open = patch => { const sender = new DevnetMemoSender({ ...config, ...patch }); opened.push(sender); return sender; };
  t.after(() => { for (const sender of opened) sender.close(); privateKey.fill(0); rmSync(root, { recursive: true, force: true }); });
  const sender = open();
  const row = () => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { return db.prepare('SELECT * FROM devnet_memo_transactions WHERE grant_id=?').get(grant.grantId); }
    finally { db.close(); }
  };
  const seal = value => createTestMemoEnvelope(value, policy.privateKey, { now: state.time });
  return { root, dbPath, state, config, sender, open, row, envelope, grant, seal, privateKey };
}
const confirmed = { slot: 70, confirmations: 2, err: null, confirmationStatus: 'confirmed' };
const outcomeFields = ['grantId', 'signature', 'status', 'historical', 'sendAttempts'];

test('TEST Memo sender model is opt-in disabled before any key, signing, reservation or send', async t => {
  const f = model(t, { executeEnabled: false });
  assert.throws(() => f.sender.execute(f.envelope), /memo_execute_disabled/);
  assert.equal(f.state.keyCalls, 0); assert.equal(f.state.sends, 0); assert.deepEqual(f.state.calls, []);
  f.sender.close();
  const db = new DatabaseSync(f.dbPath, { readOnly: true });
  assert.equal(db.prepare('SELECT count(*) AS count FROM devnet_memo_transactions').get().count, 0); db.close();
});

test('TEST Memo sender model requires current exact receipt, actor, binding, epoch and synchronous void guard', t => {
  for (const patch of [{ receiptAccepted: false }, { currentEpoch: 2 }, { currentBinding: randomUUID() }, { currentActor: randomUUID() }]) {
    const f = model(t); Object.assign(f.state, patch);
    assert.throws(() => f.sender.execute(f.envelope), /memo_authorization_rejected/);
    assert.equal(f.state.keyCalls, 0); assert.equal(f.state.sends, 0);
  }
  for (const authorize of [() => true, () => false, () => ({ then() {} })]) {
    const f = model(t); f.sender.close(); const sender = f.open({ authorize });
    assert.throws(() => sender.execute(f.envelope), /memo_authorization_contract_invalid/);
    assert.equal(f.state.keyCalls, 0);
  }
});

test('TEST Memo sender model confirms only exact transaction readback and returns the five public outcome fields', async t => {
  const f = model(t); f.state.status = confirmed;
  const result = await f.sender.execute(f.envelope);
  assert.equal(result.status, 'confirmed'); assert.equal(result.sendAttempts, 1); assert.equal(result.historical, false);
  assert.equal(result.signature, f.state.signature); assert.deepEqual(Object.keys(result), outcomeFields);
  assert.equal(f.state.keyCalls, 1); assert.equal(f.state.sends, 1);
  assert.ok(f.state.calls.indexOf('getTransaction') > f.state.calls.indexOf('sendTransaction'));
  f.sender.close(); const row = f.row();
  assert.deepEqual(Buffer.from(row.wire_bytes), f.state.wire); assert.equal(row.build_attempts, 1);
  assert.equal(row.network_fee, 5000); assert.equal(row.network_slot, 70);
  assert.equal(statSync(f.dbPath).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.root, 'private')).mode & 0o777, 0o700);
  assert.equal(JSON.stringify(result).includes('payload'), false);
});

test('TEST Memo sender model refuses wrong genesis and finite integer fee/balance/lifetime failures before send', async t => {
  for (const [patch, error] of [
    [{ genesis: encodeTestMemoBase58(new Uint8Array(32).fill(2)) }, /wrong_devnet_genesis/],
    [{ fee: null }, /memo_fee_rejected/], [{ fee: NaN }, /memo_fee_rejected/], [{ fee: 5000.5 }, /memo_fee_rejected/],
    [{ fee: 10001 }, /memo_fee_rejected/], [{ fee: -1 }, /memo_fee_rejected/],
    [{ balance: 4999 }, /memo_balance_insufficient/], [{ balance: NaN }, /memo_balance_insufficient/],
    [{ height: 101 }, /memo_blockhash_expired/],
  ]) {
    const f = model(t); Object.assign(f.state, patch);
    await assert.rejects(f.sender.execute(f.envelope), error);
    assert.equal(f.state.sends, 0);
    if (Object.hasOwn(patch, 'genesis') || Object.hasOwn(patch, 'height')) assert.equal(f.state.keyCalls, 0);
  }
});

test('TEST Memo sender model checks wallet derivation and exact signed grant before any send', async t => {
  const f = model(t); f.sender.close();
  const other = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  const sender = f.open({ keyProvider: () => Buffer.from(other.d, 'base64url') });
  await assert.rejects(sender.execute(f.envelope), /memo_wallet_not_bound/);
  assert.equal(f.state.sends, 0);
  const parsed = JSON.parse(f.envelope);
  assert.throws(() => sender.execute(JSON.stringify({ ...parsed,
    payload: Buffer.from(JSON.stringify({ ...f.grant, memo: 'other memo' })).toString('base64url') })), /memo_policy_signature_rejected/);
});

test('TEST Memo sender model rejects authority rotation after each pre-send RPC await and key await', async t => {
  for (const [method, occurrence] of [['getGenesisHash', 1], ['getLatestBlockhash', 1], ['getBlockHeight', 1],
    ['getFeeForMessage', 1], ['getBalance', 1], ['getBlockHeight', 2], ['getGenesisHash', 2]]) {
    let count = 0;
    const f = model(t, { onRpc: async (value, state) => { if (value === method && ++count === occurrence) state.currentEpoch++; } });
    await assert.rejects(f.sender.execute(f.envelope), /memo_authorization_rejected/);
    assert.equal(f.state.sends, 0, `${method} ${occurrence}`);
    const keys = f.state.keyCalls;
    assert.equal((await f.sender.execute(f.envelope)).status, 'cancelled');
    assert.equal(f.state.keyCalls, keys);
  }
  const gate = deferred(), entered = deferred();
  const f = model(t, { onKey: async () => { entered.resolve(); await gate.promise; } });
  const pending = f.sender.execute(f.envelope); await entered.promise;
  f.state.currentEpoch++; gate.resolve();
  await assert.rejects(pending, /memo_authorization_rejected/); assert.equal(f.state.sends, 0);
});

test('TEST Memo sender model checks fresh authority again after durable marker commit and retains ambiguous attempt on refusal', async t => {
  let guardsAfterFinalGenesis = 0, armed = false;
  const f = model(t, {
    onAuth: state => { if (state.calls.filter(value => value === 'getGenesisHash').length === 2 && ++guardsAfterFinalGenesis === 2) armed = true; },
    onNow: state => { if (armed) { state.currentEpoch++; armed = false; } },
  });
  const result = await f.sender.execute(f.envelope);
  assert.equal(result.status, 'pending'); assert.equal(result.sendAttempts, 1);
  assert.ok(result.signature); assert.equal(f.state.sends, 0);
  const keys = f.state.keyCalls;
  // Fake status lookup has no received wire, so it is unavailable; no new send.
  const historical = await f.sender.execute(f.envelope);
  assert.equal(historical.status, 'pending'); assert.equal(historical.signature, result.signature);
  assert.equal(f.state.keyCalls, keys); assert.equal(f.state.sends, 0);
});

test('TEST Memo sender model expiration during fee await preserves bytes but cancels all unsent retries', async t => {
  const f = model(t, { onRpc: async (method, state) => { if (method === 'getFeeForMessage') state.time += 70_000; } });
  await assert.rejects(f.sender.execute(f.envelope), /memo_grant_expired/);
  const result = await f.sender.execute(f.envelope);
  assert.equal(result.status, 'cancelled'); assert.ok(result.signature); assert.equal(result.sendAttempts, 0);
  assert.equal(f.state.keyCalls, 1); assert.equal(f.state.sends, 0);
  f.sender.close(); assert.ok(f.row().wire_bytes.length);
});

test('TEST Memo sender model shares concurrent exact execution, uses one blockhash/key/send and holds exclusive DB lock', async t => {
  const gate = deferred(), entered = deferred();
  const f = model(t, { onSend: async () => { entered.resolve(); await gate.promise; } });
  const attempts = Array.from({ length: 20 }, () => f.sender.execute(f.envelope));
  await entered.promise;
  assert.throws(() => f.open(), /memo_journal_rejected/);
  assert.throws(() => f.sender.close(), /memo_sender_busy/);
  gate.resolve(); const results = await Promise.all(attempts);
  assert.equal(new Set(results.map(value => value.signature)).size, 1);
  assert.equal(results.filter(value => !value.historical).length, 1);
  assert.equal(f.state.sends, 1); assert.equal(f.state.keyCalls, 1);
  assert.equal(f.state.calls.filter(value => value === 'getLatestBlockhash').length, 1);
});

test('TEST Memo sender model timeout/null status stays pending across restart and reconciles old rotated/expired signature without re-sign', async t => {
  const f = model(t, { onSend: async () => { throw new Error('PRIVATE MODEL wallet location timeout'); } });
  const first = await f.sender.execute(f.envelope);
  assert.equal(first.status, 'pending'); assert.equal(first.sendAttempts, 1);
  f.sender.close(); const before = f.row();
  f.state.time += 70_000; f.state.currentEpoch++; f.state.height = 101;
  const sender = f.open({ keyProvider: () => { throw new Error('must never reload wallet'); }, executeEnabled: false });
  const expired = await sender.execute(f.envelope);
  assert.equal(expired.status, 'expired_pending'); assert.equal(expired.signature, first.signature); assert.equal(expired.historical, true);
  f.state.status = confirmed;
  const recovered = await sender.execute(f.envelope);
  assert.equal(recovered.status, 'confirmed'); assert.equal(recovered.signature, first.signature);
  assert.equal(f.state.sends, 1); assert.equal(f.state.keyCalls, 1);
  sender.close(); assert.deepEqual(Buffer.from(f.row().wire_bytes), Buffer.from(before.wire_bytes));
  assert.deepEqual(Object.keys(recovered), outcomeFields);
});

test('TEST Memo sender model rotation after a first send still permits exact historical network readback', async t => {
  const f = model(t, { onSend: async state => { state.currentEpoch++; state.time += 70_000; } });
  f.state.status = confirmed;
  assert.equal((await f.sender.execute(f.envelope)).status, 'confirmed');
  assert.equal((await f.sender.execute(f.envelope)).historical, true);
  assert.equal(f.state.sends, 1); assert.equal(f.state.keyCalls, 1);
});

test('TEST Memo sender model status/send acknowledgement alone cannot confirm missing or altered transaction readback', async t => {
  for (const change of ['missing', 'wrong_wire', 'over_fee', 'inner_instruction', 'loaded_address', 'malformed_fee']) {
    const f = model(t); f.state.status = confirmed;
    f.state.transaction = null;
    const first = await f.sender.execute(f.envelope); assert.equal(first.status, 'pending');
    const transaction = { slot: 70, version: 0, transaction: [f.state.wire.toString('base64'), 'base64'],
      meta: { err: null, fee: 5000, innerInstructions: [], loadedAddresses: { readonly: [], writable: [] } } };
    if (change === 'wrong_wire') { const bytes = Buffer.from(f.state.wire); bytes[bytes.length - 1] ^= 1; transaction.transaction[0] = bytes.toString('base64'); }
    if (change === 'over_fee') transaction.meta.fee = 10001;
    if (change === 'malformed_fee') transaction.meta.fee = NaN;
    if (change === 'inner_instruction') transaction.meta.innerInstructions = [{ index: 0, instructions: [] }];
    if (change === 'loaded_address') transaction.meta.loadedAddresses.readonly = [f.grant.walletAddress];
    f.state.transaction = change === 'missing' ? null : transaction;
    const result = await f.sender.execute(f.envelope); assert.equal(result.status, 'pending', change);
    assert.equal(f.state.sends, 1); assert.equal(f.state.keyCalls, 1);
  }
});

test('TEST Memo sender model marks failed only for explicit signature-status or transaction meta network errors', async t => {
  for (const via of ['status', 'transaction']) {
    const f = model(t); const networkError = { InstructionError: [0, 'InvalidInstructionData'] };
    f.state.status = via === 'status' ? { ...confirmed, err: networkError } : confirmed;
    if (via === 'transaction') f.state.transaction = null;
    const first = await f.sender.execute(f.envelope);
    if (via === 'status') assert.equal(first.status, 'failed');
    else {
      f.state.transaction = { slot: 70, version: 0, transaction: [f.state.wire.toString('base64'), 'base64'], meta: { err: networkError, fee: 5000 } };
      assert.equal((await f.sender.execute(f.envelope)).status, 'failed');
    }
    assert.equal(f.state.sends, 1);
  }
});

test('TEST Memo sender model processed/null-commitment network error stays pending then finalized exact success can confirm', async t => {
  for (const commitment of ['processed', null]) {
    const f = model(t);
    f.state.status = { slot: 70, confirmations: 0, err: { InstructionError: [0, 'InvalidInstructionData'] }, confirmationStatus: commitment };
    const first = await f.sender.execute(f.envelope);
    assert.equal(first.status, 'pending');
    f.state.status = { ...confirmed, confirmations: null, confirmationStatus: 'finalized' };
    const result = await f.sender.execute(f.envelope);
    assert.equal(result.status, 'confirmed'); assert.equal(result.signature, first.signature);
    assert.equal(f.state.keyCalls, 1); assert.equal(f.state.sends, 1);
  }
});

test('TEST Memo sender model deleting a completed transaction row refuses restart before a live anchor can re-sign or resend', async t => {
  const f = model(t); f.state.status = confirmed;
  assert.equal((await f.sender.execute(f.envelope)).status, 'confirmed'); f.sender.close();
  const db = new DatabaseSync(f.dbPath);
  db.prepare('DELETE FROM devnet_memo_transactions WHERE grant_id=?').run(f.grant.grantId); db.close();
  assert.throws(() => f.open(), /memo_journal_rejected/);
  assert.equal(f.state.keyCalls, 1); assert.equal(f.state.sends, 1);
});

test('TEST Memo sender model globally rejects changed grant ID payload and different grants for one intent/event', async t => {
  const f = model(t); await f.sender.execute(f.envelope);
  assert.throws(() => f.sender.execute(f.seal({ ...f.grant, maxFeeLamports: '9999' })), /memo_grant_conflict/);
  for (const patch of [{ grantId: randomUUID() }, { grantId: randomUUID(), intentHash: 'c'.repeat(64) }]) {
    const envelope = f.seal({ ...f.grant, ...patch });
    // Different grant bytes require an independent trusted assertion, still losing uniqueness.
    f.sender.close(); const sender = f.open({ authorize: () => {} });
    assert.throws(() => sender.execute(envelope), /memo_order_already_granted/); sender.close();
  }
  assert.equal(f.state.sends, 1);
});

test('TEST Memo sender model corrupt payload/wire/attempt/status/MAC/metadata fails closed on restart with no key/send', async t => {
  for (const mutation of [
    db => db.prepare("UPDATE devnet_memo_transactions SET grant_hash=?").run('f'.repeat(64)),
    db => db.prepare("UPDATE devnet_memo_transactions SET grant_payload='private garbage'").run(),
    db => db.prepare('UPDATE devnet_memo_transactions SET wire_bytes=?').run(Buffer.alloc(289)),
    db => db.prepare('UPDATE devnet_memo_transactions SET send_attempts=0').run(),
    db => db.prepare("UPDATE devnet_memo_transactions SET status='signed'").run(),
    db => db.prepare("UPDATE devnet_memo_transactions SET integrity=?").run('0'.repeat(64)),
    db => db.prepare("DELETE FROM devnet_memo_meta WHERE key='integrity_key'").run(),
  ]) {
    const f = model(t); await f.sender.execute(f.envelope); f.sender.close();
    const db = new DatabaseSync(f.dbPath); mutation(db); db.close();
    assert.throws(() => f.open(), /memo_journal_rejected/);
    assert.equal(f.state.keyCalls, 1); assert.equal(f.state.sends, 1);
  }
});

test('TEST Memo sender model refuses another store and configuration without changing unrelated tables or WAL mode', t => {
  const f = model(t); f.sender.close();
  const other = join(f.root, 'other', 'private.sqlite'); preparePrivateTestDatabase(other);
  const db = new DatabaseSync(other); db.exec('CREATE TABLE personal_test_binding(id TEXT); PRAGMA journal_mode=WAL;'); db.close();
  assert.throws(() => f.open({ dbPath: other }), /memo_journal_rejected/);
  const check = new DatabaseSync(other);
  assert.equal(check.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.deepEqual(check.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name), ['personal_test_binding']); check.close();
  for (const patch of [{ expectedGenesisHash: 'mainnet' }, { executeEnabled: true, authorize: async () => {} },
    { walletAddress: 'bad' }, { dbPath: ':memory:' }])
    assert.throws(() => f.open(patch), /invalid_memo_sender_configuration/);
  mkdirSync(join(f.root, 'insecure'), { mode: 0o755 });
  assert.throws(() => f.open({ dbPath: join(f.root, 'insecure', 'sender.sqlite') }), /memo_journal_rejected/);
});
