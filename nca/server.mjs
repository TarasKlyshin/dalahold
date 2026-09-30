// Loopback test-signature probe. No identity, grants, deal writes or signer calls.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { prepareSdk } from './sdk.mjs';

const directory = fileURLToPath(new URL('./', import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']],
  ['/client.mjs', ['client.mjs', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]]);
const cookieName = 'dalahold_nca_test';

function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function body(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) {
    throw Object.assign(new Error('content_type'), { status: 415 });
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 140_000) throw Object.assign(new Error('body_too_large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw Object.assign(new Error('invalid_body'), { status: 400 }); }
}

function session(req) {
  const value = (req.headers.cookie || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  return /^[a-f0-9]{64}$/.test(value || '') ? value : null;
}

export function createProbeServer({ dbPath, sdk, now = Date.now, ttlMs = 300_000 }) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS nca_test_challenges (
      id TEXT PRIMARY KEY, session_hash TEXT NOT NULL, bytes BLOB NOT NULL,
      bytes_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
      signature_hash TEXT, receipt_json TEXT
    ) STRICT;`);
  const find = db.prepare('SELECT * FROM nca_test_challenges WHERE id = ? AND session_hash = ?');
  const insert = db.prepare('INSERT INTO nca_test_challenges (id, session_hash, bytes, bytes_hash, expires_at) VALUES (?, ?, ?, ?, ?)');
  const commit = db.prepare('UPDATE nca_test_challenges SET signature_hash = ?, receipt_json = ? WHERE id = ? AND receipt_json IS NULL');
  const events = [];
  let inflight = 0;

  function event(owner, code, started = now()) {
    events.push({ owner, code, at: new Date(now()).toISOString(), durationMs: Math.max(0, now() - started) });
    if (events.length > 100) events.shift();
  }

  async function runSdk(fn) {
    // ponytail: two JVMs maximum; use a worker pool only if this leaves loopback testing.
    if (inflight >= 2) throw Object.assign(new Error('verifier_busy'), { status: 503 });
    inflight++;
    try { return await fn(); }
    finally { inflight--; }
  }

  async function inspect() {
    const result = await runSdk(() => sdk.inspect());
    if (result.ready !== true || result.statusSource !== 'test_crl_fixture' ||
        !Number.isSafeInteger(result.validUntil) || result.validUntil <= now() ||
        !Array.isArray(result.chain) || result.chain.length !== 2 ||
        !result.chain.every((item) => typeof item === 'string' && item.startsWith('-----BEGIN CERTIFICATE-----'))) {
      throw Object.assign(new Error('status_unavailable'), { status: 503,
        reason: result.reason === 'crl_pair' ? 'crl_pair' : undefined });
    }
    return { ready: true, statusSource: result.statusSource, validUntil: result.validUntil, chain: result.chain };
  }

  function history(row, signatureHash) {
    if (row.signature_hash !== signatureHash) return { status: 409, error: 'replay_conflict' };
    return { status: 200, receipt: JSON.parse(row.receipt_json), replay: true };
  }

  async function verify(owner, input) {
    if (Object.keys(input).sort().join(',') !== 'challengeId,cms' ||
        !/^[0-9a-f-]{36}$/.test(input.challengeId || '') || typeof input.cms !== 'string' ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.cms)) {
      return { status: 400, error: 'invalid_signature_request' };
    }
    const cms = Buffer.from(input.cms, 'base64');
    if (!cms.length || cms.length > 98304 || cms.toString('base64') !== input.cms) {
      return { status: 400, error: 'invalid_signature_request' };
    }
    const signatureHash = hash(cms);
    const row = find.get(input.challengeId, owner);
    if (!row) return { status: 404, error: 'challenge_not_found' };
    if (row.receipt_json) return history(row, signatureHash);
    if (row.expires_at <= now()) return { status: 410, error: 'challenge_expired' };
    const bytes = Buffer.from(row.bytes);
    if (hash(bytes) !== row.bytes_hash) return { status: 409, error: 'challenge_changed' };
    const outcome = await runSdk(() => sdk.verify(bytes, cms));
    if (outcome.verified !== true) {
      return { status: outcome.error === 'status_unavailable' ? 503 : 422,
        error: outcome.error === 'status_unavailable' ? 'status_unavailable' : 'signature_rejected' };
    }
    if (!/^[a-f0-9]{64}$/.test(outcome.certificateDigest || '') ||
        !Number.isSafeInteger(outcome.validUntil) || outcome.validUntil <= now()) {
      return { status: 503, error: 'status_unavailable' };
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = find.get(input.challengeId, owner);
      let result;
      if (current.receipt_json) result = history(current, signatureHash);
      else if (current.expires_at <= now()) result = { status: 410, error: 'challenge_expired' };
      else if (outcome.validUntil <= now()) result = { status: 503, error: 'status_unavailable' };
      else if (current.bytes_hash !== row.bytes_hash || !Buffer.from(current.bytes).equals(bytes)) {
        result = { status: 409, error: 'challenge_changed' };
      } else {
        const receipt = { id: randomUUID(), challengeHash: row.bytes_hash,
          certificateDigest: outcome.certificateDigest, verifiedAt: now(),
          validUntil: outcome.validUntil, scope: 'test_signature_only',
          statusSource: 'test_crl_fixture' };
        commit.run(signatureHash, JSON.stringify(receipt), row.id);
        result = { status: 200, receipt, replay: false };
      }
      db.exec('COMMIT');
      return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' wss://127.0.0.1:13579; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const expectedHost = `127.0.0.1:${server.address()?.port}`;
    const origin = `http://${expectedHost}`;
    if (req.headers.host !== expectedHost ||
        (req.headers.origin && req.headers.origin !== origin) ||
        ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site']) ||
        (req.method === 'POST' && req.headers.origin !== origin)) {
      return send(res, 403, { error: 'local_origin_required' });
    }
    const pathname = new URL(req.url, origin).pathname;
    const token = session(req);
    const owner = token ? hash(token) : null;
    const started = now();
    try {
      if (req.method === 'GET' && assets.has(pathname)) {
        if (pathname === '/' && !token) res.setHeader('Set-Cookie',
          `${cookieName}=${randomBytes(32).toString('hex')}; HttpOnly; SameSite=Strict; Path=/`);
        const [name, type] = assets.get(pathname);
        res.setHeader('Content-Type', type);
        return res.end(await readFile(resolve(directory, name)));
      }
      if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (!owner) return send(res, 403, { error: 'test_session_required' });
      if (pathname === '/api/status' && req.method === 'GET') {
        return send(res, 200, await inspect());
      }
      if (pathname === '/api/events' && req.method === 'GET') {
        return send(res, 200, { scope: 'test_signature_only', events: events
          .filter((item) => item.owner === owner).map(({ owner: _, ...item }) => item) });
      }
      if (pathname === '/api/challenges' && req.method === 'POST') {
        const input = await body(req);
        if (Object.keys(input).length) return send(res, 400, { error: 'server_fields_only' });
        await inspect();
        // Bound local storage; historical receipts remain for restart-safe retries.
        db.prepare('DELETE FROM nca_test_challenges WHERE receipt_json IS NULL AND expires_at <= ?').run(now());
        const count = db.prepare('SELECT count(*) AS n FROM nca_test_challenges').get().n;
        if (count >= 1000) return send(res, 429, { error: 'test_limit_reached' });
        const id = randomUUID();
        const issuedAt = now();
        const expiresAt = issuedAt + ttlMs;
        const instruction = { domain: 'dalahold:nca-test-probe:v1',
          purpose: 'ПРОВЕРКА ТЕСТОВОЙ ПОДПИСИ. Доступ и платёж не разрешаются.',
          operation: 'test_signature_probe', nonce: id, issuedAt, expiresAt,
          sample: { dealId: 'test-livestock-001', version: 1, quantity: 12,
            amountKztForDisplay: 8_400_000, recipient: 'test-buyer' } };
        const bytes = Buffer.from(JSON.stringify(instruction, null, 2) + '\n', 'utf8');
        const bytesHash = hash(bytes);
        insert.run(id, owner, bytes, bytesHash, expiresAt);
        event(owner, 'challenge_issued', started);
        return send(res, 201, { challenge: { id, text: bytes.toString('utf8'),
          bytesBase64: bytes.toString('base64'), hash: bytesHash, expiresAt } });
      }
      if (pathname === '/api/verify' && req.method === 'POST') {
        const result = await verify(owner, await body(req));
        event(owner, result.error || (result.replay ? 'historical_receipt' : 'test_signature_verified'), started);
        const { status, ...value } = result;
        return send(res, status, value);
      }
      send(res, 404, { error: 'not_found' });
    } catch (error) {
      event(owner, 'request_failed', started);
      const known = ['verifier_busy', 'status_unavailable', 'content_type', 'body_too_large', 'invalid_body'];
      send(res, error.status || 503, { error: known.includes(error.message) ? error.message : 'verifier_unavailable',
        ...(error.reason === 'crl_pair' ? { reason: 'crl_pair' } : {}) });
    }
  });
  server.on('close', () => db.close());
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const sdk = await prepareSdk({ sdkRoot: process.env.NCA_SDK_ROOT, javaBin: process.env.NCA_JAVA_BIN,
      crlDirectory: process.env.NCA_TEST_CRL_DIR });
    const server = createProbeServer({ dbPath: resolve(directory, '../.local/nca-test.sqlite'), sdk });
    server.listen(4175, '127.0.0.1', () => process.stdout.write('DalaHold test signature: http://127.0.0.1:4175/\n'));
    const stop = () => server.close(async () => { await sdk.close(); process.exit(0); });
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  } catch { process.stderr.write('NCA test server unavailable: check SDK root and Java 17.\n'); process.exitCode = 1; }
}
