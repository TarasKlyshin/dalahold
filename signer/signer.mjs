// DalaHold signer boundary, offline only. The HTTP transfer route still hands
// a fake transaction ID to a send simulation. A separate programmatic method
// can assemble signed wire bytes, but it never broadcasts them or calls send.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export const SIGNING_PREFIX = Buffer.from('DALAHOLD-SIGNER-V1\n');
export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
export const MAX_AMOUNT_LAMPORTS = 1_000_000n;
export const FEE_LAMPORTS = 5_000n;
export const MAX_GRANT_TTL_MS = 300_000;
const MAX_BODY_BYTES = 16_384;
const FIELDS = {
  test_transfer: [
    'v', 'kind', 'grant_id', 'owner_id', 'auth_epoch', 'cluster', 'expires_at', 'order_hash',
    'wallet_address', 'program_id', 'asset', 'recipient', 'amount_lamports', 'max_fee_lamports',
  ],
  epoch: ['v', 'kind', 'owner_id', 'auth_epoch'],
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const LAMPORTS = /^[1-9][0-9]{0,18}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const JSON_TYPE = /^application\/json(?:;\s*charset=utf-8)?$/i;
const LOOPBACK = new Set(['127.0.0.1', '::ffff:127.0.0.1']);
// RFC 8032 test 1 public key. It signs the README vector, so the CLI refuses it as a policy key.
const PUBLISHED_TEST_KEY = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo';
const SCHEMA = `
CREATE TABLE IF NOT EXISTS transfers (
  grant_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  order_hash TEXT NOT NULL UNIQUE,
  tx_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'submitted', 'cancelled')),
  reason TEXT,
  send_attempts INTEGER NOT NULL DEFAULT 0,
  grant_payload TEXT NOT NULL,
  grant_sig TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS epochs (
  owner_id TEXT PRIMARY KEY,
  auth_epoch INTEGER NOT NULL,
  notice_payload TEXT NOT NULL,
  notice_sig TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS assemblies (
  grant_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  order_hash TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  auth_epoch INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'assembled', 'cancelled')),
  wire_bytes BLOB,
  signature TEXT,
  reason TEXT,
  build_attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((status = 'assembled' AND wire_bytes IS NOT NULL AND signature IS NOT NULL) OR
    (status != 'assembled' AND wire_bytes IS NULL AND signature IS NULL))
) STRICT;`;

export class Rejection extends Error {
  constructor(status, code, detail = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function reject(status, code, detail) {
  throw new Rejection(status, code, detail);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isText = (value, pattern) => typeof value === 'string' && pattern.test(value);
const isUint = (value) => Number.isSafeInteger(value) && value >= 0;

export function isAddress(value) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) return false;
  let number = 0n;
  for (const char of value) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return false;
    number = number * 58n + BigInt(digit);
  }
  let size = 0;
  for (; number > 0n; number >>= 8n) size += 1;
  for (let i = 0; value[i] === '1'; i += 1) size += 1;
  return size === 32;
}

function decodeBase64url(value) {
  if (!isText(value, BASE64URL)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.toString('base64url') === value ? bytes : null;
}

function hasExactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

// The signature is checked over the raw payload bytes before anything is parsed. The parsed value
// must then re-encode to exactly those bytes, so one grant has exactly one accepted encoding.
function openEnvelope(body, policyKey, kind) {
  let envelope;
  try { envelope = JSON.parse(body); }
  catch { reject(400, 'bad_envelope'); }
  if (!hasExactKeys(envelope, ['payload', 'sig'])) reject(400, 'bad_envelope');
  const payload = decodeBase64url(envelope.payload);
  const sig = decodeBase64url(envelope.sig);
  if (!payload || !sig) reject(400, 'bad_envelope');
  if (sig.length !== 64 || !verify(null, Buffer.concat([SIGNING_PREFIX, payload]), policyKey, sig)) {
    reject(403, 'bad_signature');
  }
  const text = payload.toString('utf8');
  let value;
  try { value = JSON.parse(text); }
  catch { reject(400, 'payload_not_json'); }
  if (!hasExactKeys(value, FIELDS[kind])) reject(400, 'payload_fields');
  if (value.v !== 1 || value.kind !== kind) reject(400, 'payload_kind');
  if (JSON.stringify(value, FIELDS[kind]) !== text) reject(400, 'payload_not_canonical');
  return { value, payloadB64: envelope.payload, sigB64: envelope.sig, payloadHash: sha256(payload) };
}

function checkTransferShape(grant) {
  if (!isText(grant.grant_id, UUID) || !isText(grant.owner_id, UUID) || !isUint(grant.auth_epoch) ||
      typeof grant.cluster !== 'string' || !isUint(grant.expires_at) ||
      !isText(grant.order_hash, SHA256_HEX) || !isAddress(grant.wallet_address) ||
      !isAddress(grant.program_id) || typeof grant.asset !== 'string' || !isAddress(grant.recipient) ||
      !isText(grant.amount_lamports, LAMPORTS) || !isText(grant.max_fee_lamports, LAMPORTS)) {
    reject(400, 'payload_invalid');
  }
}

function outcome(row, replayed) {
  const detail = {
    grant_id: row.grant_id, order_hash: row.order_hash, status: row.status, tx_id: row.tx_id,
    send_attempts: row.send_attempts, simulated: true, replayed,
  };
  if (row.status === 'cancelled') reject(403, row.reason, detail);
  if (row.status === 'prepared') reject(502, 'send_failed', detail);
  return detail;
}

export class Signer {
  #db;
  #sql;
  #policyKey;
  #policyPublicKey;
  #wallets;
  #send;
  #now;
  #inflight = new Map();
  #assemblyInflight = new Map();

  constructor({ dbPath, policyPublicKey, wallets, send, now = Date.now }) {
    if (decodeBase64url(policyPublicKey)?.length !== 32) {
      throw new TypeError('policy public key must be a base64url raw 32-byte Ed25519 key');
    }
    const bindings = new Map(Object.entries(wallets ?? {}));
    if (!bindings.size || new Set(bindings.values()).size !== bindings.size ||
        [...bindings].some(([owner, address]) => !UUID.test(owner) || !isAddress(address))) {
      throw new TypeError('wallets must map owner UUIDs to distinct base58 addresses');
    }
    if (typeof send !== 'function') throw new TypeError('a send simulation callback is required');
    this.#policyKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: policyPublicKey }, format: 'jwk' });
    this.#policyPublicKey = policyPublicKey;
    this.#wallets = bindings;
    this.#send = send;
    this.#now = now;
    this.#db = new DatabaseSync(dbPath);
    try {
      // The exclusive lock is held until close(), so a second signer on the same store cannot start.
      this.#db.exec(`PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
        BEGIN EXCLUSIVE; COMMIT; ${SCHEMA}`);
    } catch (error) {
      this.#db.close();
      throw error;
    }
    const sql = (text) => this.#db.prepare(text);
    this.#sql = {
      transfer: sql('SELECT * FROM transfers WHERE grant_id = ?'),
      orderUsed: sql('SELECT 1 FROM transfers WHERE order_hash = ?'),
      insert: sql(`INSERT INTO transfers (grant_id, payload_hash, order_hash, tx_id, status,
        grant_payload, grant_sig, created_at, updated_at) VALUES (?, ?, ?, ?, 'prepared', ?, ?, ?, ?)`),
      attempt: sql('UPDATE transfers SET send_attempts = send_attempts + 1, updated_at = ? WHERE grant_id = ?'),
      submitted: sql(`UPDATE transfers SET status = 'submitted', updated_at = ? WHERE grant_id = ?`),
      cancel: sql(`UPDATE transfers SET status = 'cancelled', reason = ?, updated_at = ?
        WHERE grant_id = ? AND status = 'prepared'`),
      assembly: sql('SELECT * FROM assemblies WHERE grant_id = ?'),
      assemblyOrderUsed: sql('SELECT 1 FROM assemblies WHERE order_hash = ?'),
      reserveAssembly: sql(`INSERT INTO assemblies
        (grant_id, payload_hash, order_hash, owner_id, auth_epoch, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?)`),
      assemblyAttempt: sql(`UPDATE assemblies SET build_attempts = build_attempts + 1,
        updated_at = ? WHERE grant_id = ? AND status = 'reserved'`),
      assemblyComplete: sql(`UPDATE assemblies SET status = 'assembled', wire_bytes = ?, signature = ?,
        updated_at = ? WHERE grant_id = ? AND status = 'reserved'`),
      assemblyCancel: sql(`UPDATE assemblies SET status = 'cancelled', reason = ?, wire_bytes = NULL,
        signature = NULL, updated_at = ? WHERE grant_id = ? AND status != 'cancelled'`),
      assembliesStale: sql(`UPDATE assemblies SET status = 'cancelled', reason = 'stale_epoch',
        wire_bytes = NULL, signature = NULL, updated_at = ?
        WHERE owner_id = ? AND auth_epoch < ? AND status != 'cancelled'`),
      epoch: sql('SELECT auth_epoch FROM epochs WHERE owner_id = ?'),
      raiseEpoch: sql(`INSERT INTO epochs (owner_id, auth_epoch, notice_payload, notice_sig, updated_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT (owner_id) DO UPDATE SET auth_epoch = excluded.auth_epoch,
        notice_payload = excluded.notice_payload, notice_sig = excluded.notice_sig,
        updated_at = excluded.updated_at WHERE excluded.auth_epoch > epochs.auth_epoch`),
    };
  }

  close() {
    this.#db.close();
  }

  #epochOf(ownerId) {
    return this.#sql.epoch.get(ownerId)?.auth_epoch ?? 0;
  }

  #violation(grant) {
    const now = this.#now();
    if (grant.cluster !== 'devnet') return 'cluster_not_allowed';
    if (grant.program_id !== SYSTEM_PROGRAM_ID) return 'program_not_allowed';
    if (grant.asset !== 'SOL') return 'asset_not_allowed';
    if (BigInt(grant.amount_lamports) > MAX_AMOUNT_LAMPORTS) return 'amount_over_cap';
    if (BigInt(grant.max_fee_lamports) < FEE_LAMPORTS) return 'fee_cap_too_low';
    if (!this.#wallets.has(grant.owner_id)) return 'unknown_owner';
    if (this.#wallets.get(grant.owner_id) !== grant.wallet_address) return 'wallet_not_bound';
    if (grant.expires_at <= now) return 'grant_expired';
    if (grant.expires_at > now + MAX_GRANT_TTL_MS) return 'grant_ttl_too_long';
    const epoch = this.#epochOf(grant.owner_id);
    if (grant.auth_epoch < epoch) return 'stale_epoch';
    if (grant.auth_epoch > epoch) return 'epoch_ahead';
    return null;
  }

  // Synchronous until the send callback starts, so concurrent requests cannot interleave checks.
  async transfer(body) {
    const { value: grant, payloadB64, sigB64, payloadHash } = openEnvelope(body, this.#policyKey, 'test_transfer');
    checkTransferShape(grant);
    const row = this.#sql.transfer.get(grant.grant_id);
    if (row && row.payload_hash !== payloadHash) reject(409, 'grant_conflict');
    if (this.#sql.assembly.get(grant.grant_id) || this.#sql.assemblyOrderUsed.get(grant.order_hash)) {
      reject(409, 'order_already_assembled');
    }
    let attempt = this.#inflight.get(grant.grant_id);
    if (!attempt) {
      if (row && row.status !== 'prepared') return outcome(row, true);
      if (!row && this.#sql.orderUsed.get(grant.order_hash)) reject(409, 'order_already_granted');
      const violation = this.#violation(grant);
      if (violation && !row) reject(403, violation);
      if (violation) {
        // A prepared but unacknowledged grant is never resent once its epoch or window has passed.
        this.#sql.cancel.run(violation, this.#now(), grant.grant_id);
        return outcome(this.#sql.transfer.get(grant.grant_id), true);
      }
      if (!row) {
        const now = this.#now();
        this.#sql.insert.run(grant.grant_id, payloadHash, grant.order_hash, `sim_${payloadHash}`,
          payloadB64, sigB64, now, now);
      }
      attempt = this.#startSend(grant);
    }
    return outcome(await attempt, Boolean(row));
  }

  #startSend(grant) {
    this.#sql.attempt.run(this.#now(), grant.grant_id);
    const attempt = this.#sendOnce(grant).finally(() => this.#inflight.delete(grant.grant_id));
    this.#inflight.set(grant.grant_id, attempt);
    return attempt;
  }

  async #sendOnce(grant) {
    const { tx_id: txId } = this.#sql.transfer.get(grant.grant_id);
    try {
      await this.#send(Object.freeze({
        tx_id: txId, grant_id: grant.grant_id, order_hash: grant.order_hash, cluster: grant.cluster,
        program_id: grant.program_id, wallet_address: grant.wallet_address,
        recipient: grant.recipient, amount_lamports: grant.amount_lamports,
      }));
    } catch {
      // Outcome unknown: the row stays prepared with the same tx ID; only a retry of this grant resends it.
      return this.#sql.transfer.get(grant.grant_id);
    }
    this.#sql.submitted.run(this.#now(), grant.grant_id);
    return this.#sql.transfer.get(grant.grant_id);
  }

  // Internal offline proof only; deliberately absent from the HTTP routes.
  // The policy key and wallet binding come from this signer's configuration.
  async prepareOfflineTransfer(request) {
    if (!hasExactKeys(request, ['envelope', 'signerPrivateKey',
      'recentBlockhash', 'lastValidBlockHeight'])) reject(400, 'invalid_assembly_request');
    const { envelope, signerPrivateKey, recentBlockhash, lastValidBlockHeight } = request;
    const { value: grant, payloadHash } = openEnvelope(envelope, this.#policyKey, 'test_transfer');
    checkTransferShape(grant);
    // Re-derive on every call, including cached replays: possession of a valid
    // grant alone must not retrieve already signed transaction bytes.
    const { deriveOfflineSignerAddress } = await import('./solana/transaction-builder.mjs');
    if (await deriveOfflineSignerAddress(signerPrivateKey) !== grant.wallet_address) {
      reject(403, 'signer wallet not bound to grant');
    }
    const transfer = this.#sql.transfer.get(grant.grant_id);
    if (transfer && transfer.payload_hash !== payloadHash) reject(409, 'grant_conflict');
    if (transfer || this.#sql.orderUsed.get(grant.order_hash)) reject(409, 'order_already_granted');
    const row = this.#sql.assembly.get(grant.grant_id);
    if (row && row.payload_hash !== payloadHash) reject(409, 'grant_conflict');
    if (!row && this.#sql.assemblyOrderUsed.get(grant.order_hash)) {
      reject(409, 'order_already_assembled');
    }
    if (row?.status === 'cancelled') reject(403, row.reason);
    const violation = this.#violation(grant);
    if (violation) {
      if (row) this.#sql.assemblyCancel.run(violation, this.#now(), grant.grant_id);
      reject(403, violation);
    }
    if (row?.status === 'assembled') return this.#assemblyOutcome(row, true);
    if (!row) {
      const now = this.#now();
      this.#sql.reserveAssembly.run(grant.grant_id, payloadHash, grant.order_hash,
        grant.owner_id, grant.auth_epoch, now, now);
    }
    let attempt = this.#assemblyInflight.get(grant.grant_id);
    const replayed = Boolean(attempt);
    if (!attempt) {
      this.#sql.assemblyAttempt.run(this.#now(), grant.grant_id);
      attempt = this.#assembleOnce(grant, request).finally(() => {
        this.#assemblyInflight.delete(grant.grant_id);
      });
      this.#assemblyInflight.set(grant.grant_id, attempt);
    }
    const assembled = await attempt;
    const after = this.#violation(grant);
    if (after) {
      this.#sql.assemblyCancel.run(after, this.#now(), grant.grant_id);
      reject(403, after);
    }
    return this.#assemblyOutcome(assembled, replayed);
  }

  async #assembleOnce(grant, { envelope, signerPrivateKey, recentBlockhash,
    lastValidBlockHeight }) {
    const { buildOfflineTransfer } = await import('./solana/transaction-builder.mjs');
    const result = await buildOfflineTransfer({
      envelope, policyPublicKey: this.#policyPublicKey, signerPrivateKey,
      recentBlockhash, lastValidBlockHeight, now: this.#now(),
    });
    const violation = this.#violation(grant);
    if (violation) {
      this.#sql.assemblyCancel.run(violation, this.#now(), grant.grant_id);
      reject(403, violation);
    }
    const { changes } = this.#sql.assemblyComplete.run(result.wireBytes,
      result.signature, this.#now(), grant.grant_id);
    if (changes !== 1) reject(403, 'assembly_cancelled');
    return this.#sql.assembly.get(grant.grant_id);
  }

  #assemblyOutcome(row, replayed) {
    if (row.status !== 'assembled' || !row.wire_bytes || !row.signature) {
      reject(500, 'assembly_incomplete');
    }
    return {
      grant_id: row.grant_id, order_hash: row.order_hash, status: 'assembled',
      wireBytes: Buffer.from(row.wire_bytes), signature: row.signature,
      broadcast: false, replayed,
    };
  }

  epoch(body) {
    const { value: notice, payloadB64, sigB64 } = openEnvelope(body, this.#policyKey, 'epoch');
    if (!isText(notice.owner_id, UUID) || !Number.isSafeInteger(notice.auth_epoch) || notice.auth_epoch < 1) {
      reject(400, 'payload_invalid');
    }
    if (!this.#wallets.has(notice.owner_id)) reject(403, 'unknown_owner');
    this.#db.exec('BEGIN IMMEDIATE');
    let changes;
    try {
      ({ changes } = this.#sql.raiseEpoch.run(notice.owner_id, notice.auth_epoch,
        payloadB64, sigB64, this.#now()));
      if (changes > 0) {
        this.#sql.assembliesStale.run(this.#now(), notice.owner_id, notice.auth_epoch);
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return { owner_id: notice.owner_id, auth_epoch: this.#epochOf(notice.owner_id), applied: changes > 0 };
  }
}

function readBody(request) {
  return new Promise((done, fail) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    request.on('end', () => (size > MAX_BODY_BYTES
      ? fail(new Rejection(413, 'body_too_large'))
      : done(Buffer.concat(chunks).toString('utf8'))));
    request.on('error', fail);
  });
}

// Loopback only by construction: there is no host parameter to misconfigure.
export async function serve(signer, port = 0) {
  const routes = new Map([
    ['/transfers', (body) => signer.transfer(body)],
    ['/epochs', (body) => signer.epoch(body)],
  ]);
  const server = createServer(async (request, response) => {
    let status = 200;
    let result;
    try {
      const { localPort, remoteAddress } = request.socket;
      if (!LOOPBACK.has(remoteAddress)) reject(403, 'loopback_only');
      if (![`127.0.0.1:${localPort}`, `localhost:${localPort}`].includes(request.headers.host)) {
        reject(403, 'bad_host');
      }
      const route = request.method === 'POST' ? routes.get(request.url) : undefined;
      if (!route) reject(404, 'not_found');
      if (!JSON_TYPE.test(request.headers['content-type'] ?? '')) reject(415, 'unsupported_media_type');
      result = await route(await readBody(request));
    } catch (error) {
      if (!(error instanceof Rejection)) console.error(error);
      status = error instanceof Rejection ? error.status : 500;
      result = error instanceof Rejection ? { error: error.code, ...error.detail } : { error: 'internal_error' };
    }
    const text = JSON.stringify(result);
    response.writeHead(status, {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store',
    });
    response.end(text);
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', done);
  });
  return server;
}

async function main() {
  const dir = process.env.DALAHOLD_SIGNER_DIR;
  if (!dir) throw new Error('set DALAHOLD_SIGNER_DIR to a local directory outside the repository');
  process.umask(0o077);
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  if (config.policy_public_key === PUBLISHED_TEST_KEY) {
    throw new Error('the README vector key is public; configure a locally generated test key');
  }
  const signer = new Signer({
    dbPath: join(dir, 'signer.sqlite'),
    policyPublicKey: config.policy_public_key,
    wallets: config.wallets,
    // Simulation only: nothing is signed or broadcast; the fake ID is reported on stdout.
    send: ({ grant_id, tx_id }) => {
      process.stdout.write(`${JSON.stringify({ event: 'simulated_send', grant_id, tx_id })}\n`);
    },
  });
  const server = await serve(signer, config.port ?? 0);
  process.stdout.write(`${JSON.stringify({ event: 'listening', host: '127.0.0.1', port: server.address().port })}\n`);
  const stop = () => server.close(() => signer.close());
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`signer: ${error.message}`);
    process.exitCode = 1;
  });
}
