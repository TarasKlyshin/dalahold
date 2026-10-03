// Internal bounded TEST Memo sender. No HTTP/CLI, airdrop, key loading or funding.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { preparePrivateTestDatabase } from '../web/private-test-store.mjs';
import {
  checkTestMemoAuthorization, decodeTestMemoBase64url, DEVNET_GENESIS_HASH, exactTestMemoKeys,
  isTestMemoBase58, isTestMemoUint, openTestMemoEnvelope, rejectTestMemo, testMemoHash,
  testMemoPolicyPublicKey, TestMemoRejection, validateTestMemoGrant,
} from './test-memo-grant.mjs';
import { buildOfflineTestMemo, inspectTestMemoTransaction } from './solana/memo-builder.mjs';
import { decodeDevnetWireBase64, isDevnetTransactionError,
  validateDevnetSignatureStatus, validateDevnetTransaction } from './solana/devnet-rpc.mjs';

const METHODS = ['getGenesisHash', 'getLatestBlockhash', 'getFeeForMessage', 'getBalance',
  'getBlockHeight', 'getSignatureStatus', 'getTransaction', 'sendTransaction'];
const STATES = ['reserved', 'building', 'signed', 'cancelled', 'pending', 'expired_pending', 'confirmed', 'failed'];
const METADATA_FIELDS = ['version', 'policy_public_key', 'wallet_address', 'genesis_hash', 'integrity_key', 'row_set_integrity'];
const ROW_SET_PREFIX = 'DALAHOLD-TEST-MEMO-JOURNAL-ROWS-V1\n';
const COLUMNS = ['grant_id', 'grant_hash', 'intent_hash', 'deal_id', 'event_id', 'grant_payload', 'grant_sig',
  'status', 'wire_bytes', 'message_bytes', 'signature', 'blockhash', 'last_valid_height', 'build_attempts',
  'send_attempts', 'quoted_fee', 'network_fee', 'network_slot', 'readback_hash', 'network_error', 'created_at', 'updated_at'];
const SCHEMA = `
CREATE TABLE devnet_memo_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE devnet_memo_transactions (
  grant_id TEXT PRIMARY KEY, grant_hash TEXT NOT NULL UNIQUE, intent_hash TEXT NOT NULL UNIQUE,
  deal_id TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE, grant_payload TEXT NOT NULL, grant_sig TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('reserved','building','signed','cancelled','pending','expired_pending','confirmed','failed')),
  wire_bytes BLOB, message_bytes BLOB, signature TEXT UNIQUE, blockhash TEXT, last_valid_height TEXT,
  build_attempts INTEGER NOT NULL CHECK(build_attempts IN (0,1)),
  send_attempts INTEGER NOT NULL CHECK(send_attempts IN (0,1)),
  quoted_fee INTEGER, network_fee INTEGER, network_slot INTEGER, readback_hash TEXT, network_error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, integrity TEXT NOT NULL,
  CHECK((wire_bytes IS NULL AND message_bytes IS NULL AND signature IS NULL) OR
        (wire_bytes IS NOT NULL AND message_bytes IS NOT NULL AND signature IS NOT NULL)),
  CHECK(send_attempts = 0 OR (build_attempts = 1 AND wire_bytes IS NOT NULL)),
  CHECK((blockhash IS NULL AND last_valid_height IS NULL) OR (blockhash IS NOT NULL AND last_valid_height IS NOT NULL))
) STRICT;`;

function safeExecutionError(error) {
  return error instanceof TestMemoRejection ? error : new TestMemoRejection('memo_execution_rejected');
}

/**
 * authorize is a trusted synchronous assertion of the exact accepted TEST-NCA
 * anchor, current personal binding and epoch. Returning true is NOT approval.
 * The caller must keep executeEnabled=false until its genuine adapter is ready.
 */
export class DevnetMemoSender {
  #db; #key; #policyPublicKey; #walletAddress; #keyProvider; #rpc; #authorize; #executeEnabled; #now;
  #inflight = new Map(); #closed = false;

  constructor({ dbPath, policyPublicKey, walletAddress, expectedGenesisHash = DEVNET_GENESIS_HASH,
    keyProvider, rpc, authorize, executeEnabled = false, now = Date.now }) {
    if (typeof dbPath !== 'string' || !isAbsolute(dbPath) ||
        !isTestMemoBase58(walletAddress, 32) || expectedGenesisHash !== DEVNET_GENESIS_HASH ||
        typeof keyProvider !== 'function' || typeof authorize !== 'function' || authorize.constructor?.name === 'AsyncFunction' ||
        typeof executeEnabled !== 'boolean' || typeof now !== 'function' ||
        !rpc || !METHODS.every(method => typeof rpc[method] === 'function')) rejectTestMemo('invalid_memo_sender_configuration');
    testMemoPolicyPublicKey(policyPublicKey);
    this.#policyPublicKey = policyPublicKey; this.#walletAddress = walletAddress;
    this.#keyProvider = keyProvider; this.#rpc = rpc; this.#authorize = authorize;
    this.#executeEnabled = executeEnabled; this.#now = now; this.#clock();
    let db;
    try {
      db = new DatabaseSync(preparePrivateTestDatabase(dbPath)); this.#db = db;
      // Refuse an unrelated store before changing any of its journal pragmas.
      const knownTables = () => db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all().map(row => row.name);
      const initialTables = knownTables();
      if (initialTables.length && JSON.stringify(initialTables) !== JSON.stringify(['devnet_memo_meta', 'devnet_memo_transactions']))
        rejectTestMemo('memo_journal_rejected');
      // DELETE + FULL makes every marker durable, and EXCLUSIVE excludes another
      // process for the full lifetime, including RPC/crypto awaits. No stale lockfile.
      db.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA mmap_size=0; BEGIN EXCLUSIVE; COMMIT;');
      if (db.prepare('PRAGMA quick_check').all().some(row => row.quick_check !== 'ok')) rejectTestMemo('memo_journal_rejected');
      const tables = knownTables();
      if (!tables.length) {
        db.exec('BEGIN EXCLUSIVE');
        try {
          db.exec(SCHEMA);
          const insert = db.prepare('INSERT INTO devnet_memo_meta(key,value) VALUES(?,?)');
          const integrityKey = randomBytes(32);
          for (const [key, value] of Object.entries({ version: '1', policy_public_key: policyPublicKey,
            wallet_address: walletAddress, genesis_hash: DEVNET_GENESIS_HASH,
            integrity_key: integrityKey.toString('base64url'),
            row_set_integrity: createHmac('sha256', integrityKey).update(ROW_SET_PREFIX)
              .update(JSON.stringify({ count: 0, rows: [] })).digest('hex') })) insert.run(key, value);
          integrityKey.fill(0);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      } else if (JSON.stringify(tables) !== JSON.stringify(['devnet_memo_meta', 'devnet_memo_transactions'])) {
        rejectTestMemo('memo_journal_rejected');
      }
      const metadata = Object.fromEntries(db.prepare('SELECT key,value FROM devnet_memo_meta').all().map(row => [row.key, row.value]));
      if (!exactTestMemoKeys(metadata, METADATA_FIELDS) ||
          metadata.version !== '1' || metadata.policy_public_key !== policyPublicKey ||
          metadata.wallet_address !== walletAddress || metadata.genesis_hash !== DEVNET_GENESIS_HASH)
        rejectTestMemo('memo_journal_rejected');
      this.#key = decodeTestMemoBase64url(metadata.integrity_key, 32);
      if (this.#key.length !== 32) rejectTestMemo('memo_journal_rejected');
      this.#validateSet();
      const columns = db.prepare('PRAGMA table_info(devnet_memo_transactions)').all().map(row => row.name);
      if (JSON.stringify(columns) !== JSON.stringify([...COLUMNS, 'integrity'])) rejectTestMemo('memo_journal_rejected');
      if (db.prepare('SELECT count(*) AS count FROM devnet_memo_transactions').get().count > 10_000)
        rejectTestMemo('memo_journal_rejected');
      for (const row of db.prepare('SELECT * FROM devnet_memo_transactions').all()) this.#validateRow(row);
    } catch {
      try { db?.close(); } catch {}
      this.#key?.fill(0);
      rejectTestMemo('memo_journal_rejected');
    }
  }

  #clock() { const now = this.#now(); if (!isTestMemoUint(now)) rejectTestMemo('invalid_clock'); return now; }
  #assertOpen() { if (this.#closed) rejectTestMemo('memo_sender_closed'); }
  #mac(row) {
    const values = COLUMNS.map(column => row[column] instanceof Uint8Array ? Buffer.from(row[column]).toString('base64') : row[column]);
    return createHmac('sha256', this.#key).update(JSON.stringify(values)).digest('hex');
  }
  #setMac() {
    if (this.#db.prepare('SELECT count(*) AS count FROM devnet_memo_transactions').get().count > 10_000)
      rejectTestMemo('memo_journal_rejected');
    const rows = this.#db.prepare('SELECT grant_id,integrity FROM devnet_memo_transactions ORDER BY grant_id').all()
      .map(row => [row.grant_id, row.integrity]);
    return createHmac('sha256', this.#key).update(ROW_SET_PREFIX)
      .update(JSON.stringify({ count: rows.length, rows })).digest('hex');
  }
  #validateSet() {
    try {
      const metadata = Object.fromEntries(this.#db.prepare('SELECT key,value FROM devnet_memo_meta').all().map(row => [row.key, row.value]));
      if (!exactTestMemoKeys(metadata, METADATA_FIELDS) || metadata.version !== '1' ||
          metadata.policy_public_key !== this.#policyPublicKey || metadata.wallet_address !== this.#walletAddress ||
          metadata.genesis_hash !== DEVNET_GENESIS_HASH || metadata.integrity_key !== this.#key.toString('base64url') ||
          typeof metadata.row_set_integrity !== 'string' || !/^[0-9a-f]{64}$/.test(metadata.row_set_integrity) ||
          !timingSafeEqual(Buffer.from(metadata.row_set_integrity, 'hex'), Buffer.from(this.#setMac(), 'hex')))
        rejectTestMemo('memo_journal_rejected');
    } catch { rejectTestMemo('memo_journal_rejected'); }
  }
  #sealSet() {
    // Must run in the same SQLite transaction as the insert/update. A missing row
    // or a changed row MAC cannot silently restore a previously consumed grant.
    const result = this.#db.prepare("UPDATE devnet_memo_meta SET value=? WHERE key='row_set_integrity'").run(this.#setMac());
    if (result.changes !== 1) rejectTestMemo('memo_journal_rejected');
  }
  #validateRow(row) {
    try {
      if (!exactTestMemoKeys(row, [...COLUMNS, 'integrity']) || typeof row.integrity !== 'string' ||
          !/^[0-9a-f]{64}$/.test(row.integrity) ||
          !timingSafeEqual(Buffer.from(row.integrity, 'hex'), Buffer.from(this.#mac(row), 'hex')))
        rejectTestMemo('memo_journal_rejected');
      const opened = openTestMemoEnvelope(JSON.stringify({ payload: row.grant_payload, sig: row.grant_sig }),
        this.#policyPublicKey, { now: this.#clock(), allowExpired: true });
      const grant = opened.grant;
      if (row.grant_id !== grant.grantId || row.grant_hash !== opened.grantHash || row.intent_hash !== grant.intentHash ||
          row.deal_id !== grant.dealId || row.event_id !== grant.eventId || grant.walletAddress !== this.#walletAddress ||
          !STATES.includes(row.status) || ![0, 1].includes(row.build_attempts) || ![0, 1].includes(row.send_attempts) ||
          !isTestMemoUint(row.created_at) || !isTestMemoUint(row.updated_at) || row.updated_at < row.created_at)
        rejectTestMemo('memo_journal_rejected');
      const hasWire = row.wire_bytes !== null;
      if (hasWire !== (row.message_bytes !== null) || hasWire !== (row.signature !== null) ||
          (row.blockhash === null) !== (row.last_valid_height === null) ||
          (row.build_attempts === 0 && (hasWire || row.blockhash !== null)) ||
          (row.build_attempts === 1 && row.blockhash === null) ||
          (row.send_attempts === 1 && (!hasWire || !['pending', 'expired_pending', 'confirmed', 'failed'].includes(row.status))) ||
          (row.send_attempts === 0 && ['pending', 'expired_pending', 'confirmed', 'failed'].includes(row.status)) ||
          (row.status === 'reserved' && row.build_attempts !== 0) ||
          (row.status === 'building' && (row.build_attempts !== 1 || hasWire)) ||
          (row.status === 'signed' && !hasWire)) rejectTestMemo('memo_journal_rejected');
      if (row.blockhash !== null && (!isTestMemoBase58(row.blockhash, 32) ||
          typeof row.last_valid_height !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(row.last_valid_height) ||
          BigInt(row.last_valid_height) > 18_446_744_073_709_551_615n)) rejectTestMemo('memo_journal_rejected');
      if (hasWire) {
        const checked = inspectTestMemoTransaction({ wireBytes: row.wire_bytes, grant,
          recentBlockhash: row.blockhash, signature: row.signature });
        if (!(row.message_bytes instanceof Uint8Array) || !checked.messageBytes.equals(Buffer.from(row.message_bytes)))
          rejectTestMemo('memo_journal_rejected');
      }
      if (row.quoted_fee !== null && (!isTestMemoUint(row.quoted_fee) || BigInt(row.quoted_fee) > BigInt(grant.maxFeeLamports)))
        rejectTestMemo('memo_journal_rejected');
      if (row.send_attempts === 1 && row.quoted_fee === null) rejectTestMemo('memo_journal_rejected');
      if (row.status === 'confirmed') {
        if (!isTestMemoUint(row.network_fee) || BigInt(row.network_fee) > BigInt(grant.maxFeeLamports) ||
            !isTestMemoUint(row.network_slot) || row.readback_hash !== testMemoHash(row.message_bytes) || row.network_error !== null)
          rejectTestMemo('memo_journal_rejected');
      } else if (row.network_fee !== null || row.readback_hash !== null) rejectTestMemo('memo_journal_rejected');
      if (row.status === 'failed') {
        if (typeof row.network_error !== 'string' || row.network_error.length > 2_048 ||
            !isDevnetTransactionError(JSON.parse(row.network_error)) || !isTestMemoUint(row.network_slot))
          rejectTestMemo('memo_journal_rejected');
      } else if (row.network_error !== null) rejectTestMemo('memo_journal_rejected');
      return opened;
    } catch { rejectTestMemo('memo_journal_rejected'); }
  }
  #row(grantId) {
    this.#assertOpen();
    this.#validateSet();
    let row;
    try { row = this.#db.prepare('SELECT * FROM devnet_memo_transactions WHERE grant_id=?').get(grantId); }
    catch { rejectTestMemo('memo_journal_rejected'); }
    if (row) this.#validateRow(row);
    return row;
  }
  #write(row, patch) {
    this.#validateSet();
    this.#validateRow(row);
    const candidate = { ...row, ...patch, updated_at: this.#clock() };
    candidate.integrity = this.#mac(candidate);
    this.#validateRow(candidate);
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      const columns = [...COLUMNS, 'integrity'];
      const result = this.#db.prepare(`UPDATE devnet_memo_transactions SET ${columns.map(column => `${column}=?`).join(',')} WHERE grant_id=? AND integrity=?`)
        .run(...columns.map(column => candidate[column]), row.grant_id, row.integrity);
      if (result.changes !== 1) rejectTestMemo('memo_journal_rejected');
      this.#sealSet();
      this.#db.exec('COMMIT');
    } catch {
      try { this.#db.exec('ROLLBACK'); } catch {}
      rejectTestMemo('memo_journal_rejected');
    }
    return candidate;
  }
  #reserve(opened) {
    this.#validateSet();
    if (this.#db.prepare('SELECT count(*) AS count FROM devnet_memo_transactions').get().count >= 10_000)
      rejectTestMemo('memo_journal_full');
    if (this.#db.prepare('SELECT 1 FROM devnet_memo_transactions WHERE grant_hash=? OR intent_hash=? OR event_id=?')
      .get(opened.grantHash, opened.grant.intentHash, opened.grant.eventId)) rejectTestMemo('memo_order_already_granted');
    const row = Object.fromEntries(COLUMNS.map(column => [column, null]));
    Object.assign(row, { grant_id: opened.grant.grantId, grant_hash: opened.grantHash, intent_hash: opened.grant.intentHash,
      deal_id: opened.grant.dealId, event_id: opened.grant.eventId, grant_payload: opened.payload, grant_sig: opened.sig,
      status: 'reserved', build_attempts: 0, send_attempts: 0, created_at: this.#clock(), updated_at: this.#clock() });
    row.integrity = this.#mac(row); this.#validateRow(row);
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      const columns = [...COLUMNS, 'integrity'];
      this.#db.prepare(`INSERT INTO devnet_memo_transactions(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
        .run(...columns.map(column => row[column]));
      this.#sealSet();
      this.#db.exec('COMMIT');
    } catch {
      try { this.#db.exec('ROLLBACK'); } catch {}
      rejectTestMemo('memo_journal_rejected');
    }
    return row;
  }
  #fresh(opened) {
    this.#assertOpen();
    if (!this.#executeEnabled) rejectTestMemo('memo_execute_disabled');
    validateTestMemoGrant(opened.grant, { now: this.#clock() });
    if (opened.grant.walletAddress !== this.#walletAddress) rejectTestMemo('memo_wallet_not_bound');
    checkTestMemoAuthorization(this.#authorize, opened.grant, opened.grantHash);
  }
  async #awaitFresh(operation, opened) {
    try { return await operation; } finally { this.#fresh(opened); }
  }
  async #awaitReadOnly(operation, opened) {
    try { return await operation; }
    finally {
      // Observe the guard after every await, but an already attempted transaction
      // remains historical evidence even if its binding/epoch is now invalid.
      try { checkTestMemoAuthorization(this.#authorize, opened.grant, opened.grantHash); } catch {}
      this.#assertOpen();
    }
  }
  #outcome(row, historical) {
    return Object.freeze({ grantId: row.grant_id, signature: row.signature, status: row.status,
      historical, sendAttempts: row.send_attempts });
  }

  execute(envelope) {
    this.#assertOpen();
    const opened = openTestMemoEnvelope(envelope, this.#policyPublicKey, { now: this.#clock(), allowExpired: true });
    const existing = this.#row(opened.grant.grantId);
    if (existing && (existing.grant_hash !== opened.grantHash || existing.grant_payload !== opened.payload || existing.grant_sig !== opened.sig))
      rejectTestMemo('memo_grant_conflict');
    const running = this.#inflight.get(opened.grant.grantId);
    if (running) return running.then(result => Object.freeze({ ...result, historical: true }));
    let attempt;
    if (existing) {
      if (existing.send_attempts === 0 || ['confirmed', 'failed'].includes(existing.status))
        return Promise.resolve(this.#outcome(existing, true));
      attempt = this.#reconcile(existing, opened, true);
    } else {
      this.#fresh(opened);
      const row = this.#reserve(opened);
      attempt = this.#executeNew(row, opened, envelope);
    }
    const tracked = attempt.finally(() => this.#inflight.delete(opened.grant.grantId));
    this.#inflight.set(opened.grant.grantId, tracked);
    return tracked;
  }

  async #executeNew(row, opened, envelope) {
    try {
      if (await this.#awaitFresh(this.#rpc.getGenesisHash(), opened) !== DEVNET_GENESIS_HASH) rejectTestMemo('wrong_devnet_genesis');
      const lifetime = await this.#awaitFresh(this.#rpc.getLatestBlockhash(), opened);
      if (!exactTestMemoKeys(lifetime, ['blockhash', 'lastValidBlockHeight']) ||
          !isTestMemoBase58(lifetime.blockhash, 32) || !isTestMemoUint(lifetime.lastValidBlockHeight))
        rejectTestMemo('invalid_memo_lifetime');
      const height = await this.#awaitFresh(this.#rpc.getBlockHeight(), opened);
      if (!isTestMemoUint(height) || height > lifetime.lastValidBlockHeight) rejectTestMemo('memo_blockhash_expired');
      row = this.#write(row, { status: 'building', blockhash: lifetime.blockhash,
        last_valid_height: String(lifetime.lastValidBlockHeight), build_attempts: 1 });
      this.#fresh(opened);
      const providedKey = await this.#awaitFresh(this.#keyProvider(opened.grant), opened);
      if (!(providedKey instanceof Uint8Array) || providedKey.length !== 32) rejectTestMemo('memo_signer_key_required');
      const keyCopy = Uint8Array.from(providedKey);
      let built;
      try {
        built = await this.#awaitFresh(buildOfflineTestMemo({ envelope, policyPublicKey: this.#policyPublicKey,
          signerPrivateKey: keyCopy, recentBlockhash: row.blockhash, lastValidBlockHeight: BigInt(row.last_valid_height),
          now: this.#clock(), authorize: () => { this.#fresh(opened); } }), opened);
      } finally { keyCopy.fill(0); }
      row = this.#write(row, { status: 'signed', wire_bytes: Buffer.from(built.wireBytes),
        message_bytes: Buffer.from(built.messageBytes), signature: built.signature });
      const fee = await this.#awaitFresh(this.#rpc.getFeeForMessage(Buffer.from(row.message_bytes)), opened);
      if (!isTestMemoUint(fee) || BigInt(fee) > BigInt(opened.grant.maxFeeLamports)) rejectTestMemo('memo_fee_rejected');
      const balance = await this.#awaitFresh(this.#rpc.getBalance(this.#walletAddress), opened);
      if (!isTestMemoUint(balance) || balance < fee) rejectTestMemo('memo_balance_insufficient');
      const finalHeight = await this.#awaitFresh(this.#rpc.getBlockHeight(), opened);
      if (!isTestMemoUint(finalHeight) || BigInt(finalHeight) > BigInt(row.last_valid_height)) rejectTestMemo('memo_blockhash_expired');
      if (await this.#awaitFresh(this.#rpc.getGenesisHash(), opened) !== DEVNET_GENESIS_HASH) rejectTestMemo('wrong_devnet_genesis');
      row = this.#write(row, { quoted_fee: fee });
      // No await between this current authority assertion, durable marker and
      // initiating the one RPC send. A crash after the marker permits reads only.
      this.#fresh(opened);
      row = this.#write(row, { status: 'pending', send_attempts: 1 });
      // A deadline/current binding can change while the durable marker commits.
      // Refusal here keeps the marker as ambiguous; all later work is read-only.
      this.#fresh(opened);
      try {
        const signature = await this.#awaitReadOnly(this.#rpc.sendTransaction(Buffer.from(row.wire_bytes)), opened);
        if (signature !== row.signature) return this.#outcome(row, false);
      } catch { /* timeout/preflight/transport ambiguity is not a network failure */ }
      return this.#reconcile(row, opened, false);
    } catch (error) {
      const current = this.#row(row.grant_id);
      if (current?.send_attempts === 1) return this.#outcome(current, false);
      if (current && current.status !== 'cancelled') this.#write(current, { status: 'cancelled' });
      throw safeExecutionError(error);
    }
  }

  async #reconcile(row, opened, historical) {
    // Existing attempts never get another blockhash/key/fee quote/send, including
    // after restart, expiry, timeout or certificate rotation.
    try {
      if (await this.#awaitReadOnly(this.#rpc.getGenesisHash(), opened) !== DEVNET_GENESIS_HASH)
        rejectTestMemo('wrong_devnet_genesis');
      const status = validateDevnetSignatureStatus(await this.#awaitReadOnly(this.#rpc.getSignatureStatus(row.signature), opened));
      if (status?.err !== null && status?.err !== undefined && ['confirmed', 'finalized'].includes(status.confirmationStatus)) {
        row = this.#write(row, { status: 'failed', network_slot: status.slot, network_error: JSON.stringify(status.err) });
      } else if (status && ['confirmed', 'finalized'].includes(status.confirmationStatus)) {
        const readback = validateDevnetTransaction(await this.#awaitReadOnly(this.#rpc.getTransaction(row.signature), opened));
        if (readback?.meta) {
          if (readback.meta.err !== null) {
            row = this.#write(row, { status: 'failed', network_slot: readback.slot, network_error: JSON.stringify(readback.meta.err) });
          } else {
            const wire = decodeDevnetWireBase64(readback.transaction[0]);
            const checked = inspectTestMemoTransaction({ wireBytes: wire, grant: opened.grant,
              recentBlockhash: row.blockhash, signature: row.signature });
            if (!wire.equals(Buffer.from(row.wire_bytes)) || !checked.messageBytes.equals(Buffer.from(row.message_bytes)) ||
                BigInt(readback.meta.fee) > BigInt(opened.grant.maxFeeLamports) ||
                readback.meta.innerInstructions.length !== 0 || readback.meta.loadedAddresses.readonly.length !== 0 ||
                readback.meta.loadedAddresses.writable.length !== 0) rejectTestMemo('memo_readback_rejected');
            row = this.#write(row, { status: 'confirmed', network_fee: readback.meta.fee, network_slot: readback.slot,
              readback_hash: testMemoHash(checked.messageBytes) });
          }
        }
      }
      if (!['confirmed', 'failed'].includes(row.status)) {
        const height = await this.#awaitReadOnly(this.#rpc.getBlockHeight(), opened);
        if (!isTestMemoUint(height)) rejectTestMemo('invalid_memo_block_height');
        if (BigInt(height) > BigInt(row.last_valid_height) && row.status !== 'expired_pending')
          row = this.#write(row, { status: 'expired_pending' });
      }
    } catch (error) {
      // Do not hide a corrupt journal. Unavailable or incomplete network evidence
      // otherwise leaves the one signed attempt pending, never failed/confirmed.
      if (error instanceof TestMemoRejection && error.code === 'memo_journal_rejected') throw error;
    }
    return this.#outcome(row, historical);
  }

  close() {
    if (this.#closed) return;
    if (this.#inflight.size) rejectTestMemo('memo_sender_busy');
    this.#db.close(); this.#key.fill(0); this.#closed = true;
  }
}
