import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  MAX_AMOUNT_LAMPORTS, MAX_GRANT_TTL_MS, SIGNING_PREFIX, SYSTEM_PROGRAM_ID, Signer, serve,
} from './signer.mjs';

const SIGNER_PATH = fileURLToPath(new URL('./signer.mjs', import.meta.url));
const README_PATH = fileURLToPath(new URL('./README.md', import.meta.url));
const OWNER_A = 'f1d05a12-5849-4a6b-9f47-a7a11dfa0132';
const OWNER_B = '140dd252-8ae6-43a2-a5f1-44379c0124e7';
const WALLET_A = '6MHGUvei2atca6cz6yHPDqi6WKwYkNWRVLLCrwvoazsp';
const WALLET_B = 'Ct1n6q1gXuAwznqFjzCp8hjbAEAuGo61AREtDVayskos';
const RECIPIENT = 'DNJtnMP3CbEN5Wvio7zFDEUcBAEfdzrxdQVj2i4sYXwY';
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const WALLETS = { [OWNER_A]: WALLET_A, [OWNER_B]: WALLET_B };
const NOW = 1_799_999_940_000;
// RFC 8032 test 1 key pair, published on purpose for the README vector.
const KAT_SEED_HEX = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const KAT_PUBLIC_KEY = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo';

const policy = generateKeyPairSync('ed25519');
const foreign = generateKeyPairSync('ed25519');
const POLICY_KEY = policy.publicKey.export({ format: 'jwk' }).x;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function grant(changes = {}) {
  return {
    v: 1, kind: 'test_transfer', grant_id: randomUUID(), owner_id: OWNER_A, auth_epoch: 0,
    cluster: 'devnet', expires_at: NOW + 60_000, order_hash: sha256(randomUUID()),
    wallet_address: WALLET_A, program_id: SYSTEM_PROGRAM_ID, asset: 'SOL', recipient: RECIPIENT,
    amount_lamports: '1200', max_fee_lamports: '5000', ...changes,
  };
}

const epochNotice = (owner_id, auth_epoch) => ({ v: 1, kind: 'epoch', owner_id, auth_epoch });

function envelope(value, { key = policy.privateKey, text = JSON.stringify(value), prefix = SIGNING_PREFIX } = {}) {
  const payload = Buffer.from(text);
  return JSON.stringify({
    payload: payload.toString('base64url'),
    sig: sign(null, Buffer.concat([prefix, payload]), key).toString('base64url'),
  });
}

function call(port, path, body, { method = 'POST', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path, method, agent: false,
      headers: { 'content-type': 'application/json', ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function start(t, { dbPath = ':memory:', now = () => NOW, send } = {}) {
  const sent = [];
  const signer = new Signer({
    dbPath, policyPublicKey: POLICY_KEY, wallets: WALLETS, now,
    send: send ?? (async (tx) => { sent.push(tx); await delay(20); }),
  });
  const server = await serve(signer);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await new Promise((resolve) => server.close(resolve));
    signer.close();
  };
  t.after(stop);
  return { port: server.address().port, server, sent, stop };
}

async function expectError(s, body, status, error, path = '/transfers') {
  const result = await call(s.port, path, body);
  assert.equal(result.status, status, `${error}: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.error, error);
  return result;
}

function launch(dir) {
  const child = spawn(process.execPath, [SIGNER_PATH], {
    env: { PATH: process.env.PATH, DALAHOLD_SIGNER_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const events = [];
  let stderr = '';
  let pending = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    pending += chunk;
    for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
      events.push(JSON.parse(pending.slice(0, end)));
      pending = pending.slice(end + 1);
    }
  });
  const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  const port = () => events.find(({ event }) => event === 'listening')?.port;
  const sends = () => events.filter(({ event }) => event === 'simulated_send').map(({ tx_id }) => tx_id);
  const waitFor = async (predicate, what) => {
    for (const deadline = Date.now() + 10_000; !predicate();) {
      if (Date.now() > deadline || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`signer never reported ${what}; stderr: ${stderr}`);
      }
      await delay(10);
    }
  };
  return { child, exited, port, sends, waitFor, stderr: () => stderr };
}

test('an exact grant is simulated once and a replay returns the same fake tx without resending', async (t) => {
  const s = await start(t);
  const value = grant();
  const body = envelope(value);
  const expected = {
    grant_id: value.grant_id, order_hash: value.order_hash, status: 'submitted',
    tx_id: `sim_${sha256(JSON.stringify(value))}`, send_attempts: 1, simulated: true, replayed: false,
  };
  assert.deepEqual(await call(s.port, '/transfers', body), { status: 200, body: expected });
  assert.deepEqual(s.sent, [{
    tx_id: expected.tx_id, grant_id: value.grant_id, order_hash: value.order_hash, cluster: 'devnet',
    program_id: SYSTEM_PROGRAM_ID, wallet_address: WALLET_A, recipient: RECIPIENT, amount_lamports: '1200',
  }]);
  assert.deepEqual(await call(s.port, '/transfers', body), { status: 200, body: { ...expected, replayed: true } });
  assert.equal(s.sent.length, 1);
});

test('tampered bytes, foreign keys, a missing domain prefix and client-supplied keys never reach send', async (t) => {
  const s = await start(t);
  const value = grant();
  const good = JSON.parse(envelope(value));
  const withPayload = (changed) => JSON.stringify({
    ...good, payload: Buffer.from(JSON.stringify(changed)).toString('base64url'),
  });
  for (const change of [
    { amount_lamports: '1201' }, { recipient: WALLET_B }, { wallet_address: WALLET_B }, { owner_id: OWNER_B },
    { order_hash: sha256('another order') }, { auth_epoch: 1 }, { expires_at: value.expires_at + 1 },
    { grant_id: randomUUID() }, { cluster: 'mainnet-beta' }, { program_id: MEMO_PROGRAM_ID },
  ]) {
    await expectError(s, withPayload({ ...value, ...change }), 403, 'bad_signature');
  }
  const flipped = Buffer.from(good.sig, 'base64url');
  flipped[10] ^= 1;
  await expectError(s, JSON.stringify({ ...good, sig: flipped.toString('base64url') }), 403, 'bad_signature');
  await expectError(s, envelope(value, { key: foreign.privateKey }), 403, 'bad_signature');
  await expectError(s, envelope(value, { prefix: Buffer.alloc(0) }), 403, 'bad_signature');
  const attackerEnvelope = JSON.parse(envelope(value, { key: foreign.privateKey }));
  const attackerKey = foreign.publicKey.export({ format: 'jwk' }).x;
  await expectError(s, JSON.stringify({ ...attackerEnvelope, policy_public_key: attackerKey }), 400, 'bad_envelope');
  await expectError(s, JSON.stringify({ ...good, transaction: 'AQAB' }), 400, 'bad_envelope');
  await expectError(s, JSON.stringify({ message: good.payload }), 400, 'bad_envelope');
  await expectError(s, JSON.stringify({ ...good, payload: `${good.payload}=` }), 400, 'bad_envelope');
  await expectError(s, 'not json', 400, 'bad_envelope');
  assert.equal(s.sent.length, 0);
});

test('the policy key cannot authorize alternate encodings or anything but the exact test transfer', async (t) => {
  const s = await start(t);
  const value = grant();
  const { max_fee_lamports: _omitted, ...missing } = value;
  const { v, kind, ...rest } = value;
  const cases = [
    [envelope(value, { text: JSON.stringify(value, null, 1) }), 400, 'payload_not_canonical'],
    [envelope(value, { text: JSON.stringify({ kind, v, ...rest }) }), 400, 'payload_not_canonical'],
    [envelope(value, { text: JSON.stringify(value).replace('{', '{"asset":"SOL",') }), 400, 'payload_not_canonical'],
    [envelope(value, { text: 'not json' }), 400, 'payload_not_json'],
    [envelope({ ...value, policy_public_key: POLICY_KEY }), 400, 'payload_fields'],
    [envelope(missing), 400, 'payload_fields'],
    [envelope(epochNotice(OWNER_A, 1)), 400, 'payload_fields'],
    [envelope(grant({ v: 2 })), 400, 'payload_kind'],
    [envelope(grant({ kind: 'transfer' })), 400, 'payload_kind'],
    ...[
      { amount_lamports: 1200 }, { amount_lamports: '0' }, { amount_lamports: '01' }, { amount_lamports: '-5' },
      { auth_epoch: -1 }, { auth_epoch: '0' }, { expires_at: 1.5 }, { grant_id: value.grant_id.toUpperCase() },
      { owner_id: 'owner-1' }, { order_hash: value.order_hash.toUpperCase() }, { recipient: 'O0Il' },
      { recipient: `1${RECIPIENT}` }, { wallet_address: [WALLET_A] }, { cluster: null },
    ].map((change) => [envelope(grant(change)), 400, 'payload_invalid']),
    [envelope(grant({ cluster: 'mainnet-beta' })), 403, 'cluster_not_allowed'],
    [envelope(grant({ program_id: MEMO_PROGRAM_ID })), 403, 'program_not_allowed'],
    [envelope(grant({ asset: 'USDC' })), 403, 'asset_not_allowed'],
    [envelope(grant({ amount_lamports: String(MAX_AMOUNT_LAMPORTS + 1n) })), 403, 'amount_over_cap'],
    [envelope(grant({ max_fee_lamports: '4999' })), 403, 'fee_cap_too_low'],
    [envelope(grant({ owner_id: randomUUID() })), 403, 'unknown_owner'],
    [envelope(grant({ wallet_address: WALLET_B })), 403, 'wallet_not_bound'],
    [envelope(grant({ expires_at: NOW })), 403, 'grant_expired'],
    [envelope(grant({ expires_at: NOW + MAX_GRANT_TTL_MS + 1 })), 403, 'grant_ttl_too_long'],
    [envelope(grant({ auth_epoch: 1 })), 403, 'epoch_ahead'],
  ];
  for (const [body, status, error] of cases) await expectError(s, body, status, error);
  assert.equal(s.sent.length, 0);
  const edge = await call(s.port, '/transfers', envelope(grant({
    amount_lamports: String(MAX_AMOUNT_LAMPORTS), expires_at: NOW + MAX_GRANT_TTL_MS,
  })));
  assert.equal(edge.status, 200);
  assert.equal(s.sent.length, 1);
});

test('twenty parallel duplicates yield one send; a second grant for one order or a reused grant ID conflicts', async (t) => {
  const s = await start(t);
  const body = envelope(grant());
  const burst = await Promise.all(Array.from({ length: 20 }, () => call(s.port, '/transfers', body)));
  assert.ok(burst.every(({ status, body: result }) => status === 200 && result.tx_id === burst[0].body.tx_id));
  assert.equal(burst.filter(({ body: result }) => !result.replayed).length, 1);
  assert.equal(s.sent.length, 1);

  const order_hash = sha256('one order, many grants');
  const racers = await Promise.all(Array.from({ length: 10 }, () => (
    call(s.port, '/transfers', envelope(grant({ order_hash })))
  )));
  assert.deepEqual(racers.map(({ status }) => status).sort(), [200, ...Array(9).fill(409)]);
  assert.ok(racers.every(({ status, body: result }) => status === 200 || result.error === 'order_already_granted'));
  assert.equal(s.sent.length, 2);

  const value = grant();
  assert.equal((await call(s.port, '/transfers', envelope(value))).status, 200);
  await expectError(s, envelope({ ...value, amount_lamports: '1300', order_hash: sha256('changed') }), 409, 'grant_conflict');
  assert.equal(s.sent.length, 3);
});

test('epoch notices are policy-signed and monotonic; stale grants fail while the wallet binding stays', async (t) => {
  const s = await start(t);
  const pending = envelope(grant());
  assert.equal((await call(s.port, '/transfers', envelope(grant()))).status, 200);
  await expectError(s, envelope(epochNotice(OWNER_A, 1), { key: foreign.privateKey }), 403, 'bad_signature', '/epochs');
  await expectError(s, envelope(epochNotice(randomUUID(), 1)), 403, 'unknown_owner', '/epochs');
  await expectError(s, envelope(epochNotice(OWNER_A, 0)), 400, 'payload_invalid', '/epochs');
  await expectError(s, envelope(grant()), 400, 'payload_fields', '/epochs');
  const raise = (epoch) => call(s.port, '/epochs', envelope(epochNotice(OWNER_A, epoch)));
  assert.deepEqual(await raise(2), { status: 200, body: { owner_id: OWNER_A, auth_epoch: 2, applied: true } });
  assert.deepEqual(await raise(2), { status: 200, body: { owner_id: OWNER_A, auth_epoch: 2, applied: false } });
  assert.deepEqual(await raise(1), { status: 200, body: { owner_id: OWNER_A, auth_epoch: 2, applied: false } });
  await expectError(s, pending, 403, 'stale_epoch');
  await expectError(s, envelope(grant({ auth_epoch: 1 })), 403, 'stale_epoch');
  await expectError(s, envelope(grant({ auth_epoch: 3 })), 403, 'epoch_ahead');
  assert.equal((await call(s.port, '/transfers', envelope(grant({ auth_epoch: 2 })))).status, 200);
  assert.equal(s.sent.at(-1).wallet_address, WALLET_A);
  const other = await call(s.port, '/transfers', envelope(grant({ owner_id: OWNER_B, wallet_address: WALLET_B })));
  assert.equal(other.status, 200);
  assert.equal(s.sent.length, 3);
});

test('a failed send keeps one prepared tx ID; after restart it is resent unchanged or cancelled for good', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dalahold-signer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'signer.sqlite');
  let clock = NOW;
  const attempts = [];
  const failing = async (tx) => {
    attempts.push(tx.tx_id);
    throw new Error('simulated ambiguous send failure');
  };
  let s = await start(t, { dbPath, now: () => clock, send: failing });
  const resend = envelope(grant());
  const revoke = envelope(grant());
  const lapse = envelope(grant({ owner_id: OWNER_B, wallet_address: WALLET_B, expires_at: NOW + 1_000 }));
  for (const body of [resend, revoke, lapse]) {
    const result = await expectError(s, body, 502, 'send_failed');
    assert.equal(result.body.status, 'prepared');
    assert.equal(result.body.send_attempts, 1);
  }
  assert.throws(() => new Signer({ dbPath, policyPublicKey: POLICY_KEY, wallets: WALLETS, send() {} }), /locked/);
  await s.stop();

  s = await start(t, { dbPath, now: () => clock });
  const resent = await call(s.port, '/transfers', resend);
  assert.equal(resent.status, 200);
  assert.deepEqual([resent.body.status, resent.body.replayed, resent.body.send_attempts], ['submitted', true, 2]);
  assert.equal(resent.body.tx_id, attempts[0]);
  assert.deepEqual(s.sent.map(({ tx_id }) => tx_id), [attempts[0]]);
  assert.equal((await call(s.port, '/epochs', envelope(epochNotice(OWNER_A, 1)))).body.applied, true);
  const revoked = await expectError(s, revoke, 403, 'stale_epoch');
  assert.deepEqual([revoked.body.status, revoked.body.tx_id], ['cancelled', attempts[1]]);
  clock = NOW + 1_000;
  assert.equal((await expectError(s, lapse, 403, 'grant_expired')).body.status, 'cancelled');
  assert.equal(s.sent.length, 1);
  await s.stop();

  clock = NOW;
  s = await start(t, { dbPath, now: () => clock });
  assert.equal((await expectError(s, revoke, 403, 'stale_epoch')).body.status, 'cancelled');
  assert.equal((await expectError(s, lapse, 403, 'grant_expired')).body.status, 'cancelled');
  assert.equal((await call(s.port, '/transfers', resend)).body.status, 'submitted');
  await expectError(s, envelope(grant()), 403, 'stale_epoch');
  assert.equal(s.sent.length, 0);
});

test('a SIGKILLed signer process restarts with grants still idempotent and epochs still current', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dalahold-signer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ policy_public_key: POLICY_KEY, wallets: WALLETS }));
  const expires_at = Date.now() + 120_000;
  const body = envelope(grant({ expires_at }));

  let run = launch(dir);
  t.after(() => run.child.kill('SIGKILL'));
  await run.waitFor(run.port, 'listening');
  const burst = await Promise.all(Array.from({ length: 20 }, () => call(run.port(), '/transfers', body)));
  assert.ok(burst.every(({ status, body: result }) => status === 200 && result.tx_id === burst[0].body.tx_id));
  const first = burst.filter(({ body: result }) => !result.replayed);
  assert.equal(first.length, 1);
  assert.equal((await call(run.port(), '/epochs', envelope(epochNotice(OWNER_A, 1)))).body.applied, true);
  await run.waitFor(() => run.sends().length === 1, 'one simulated send');
  run.child.kill('SIGKILL');
  assert.equal((await run.exited).signal, 'SIGKILL');
  assert.deepEqual(run.sends(), [first[0].body.tx_id]);

  run = launch(dir);
  await run.waitFor(run.port, 'listening');
  assert.deepEqual(await call(run.port(), '/transfers', body), { status: 200, body: { ...first[0].body, replayed: true } });
  const stale = await call(run.port(), '/transfers', envelope(grant({ expires_at })));
  assert.deepEqual([stale.status, stale.body.error], [403, 'stale_epoch']);
  const fresh = await call(run.port(), '/transfers', envelope(grant({ expires_at, auth_epoch: 1 })));
  assert.equal(fresh.status, 200);
  run.child.kill('SIGTERM');
  assert.equal((await run.exited).code, 0);
  assert.deepEqual(run.sends(), [fresh.body.tx_id]);
});

test('the HTTP surface has no other operation and serves loopback only', async (t) => {
  const s = await start(t);
  assert.equal(s.server.address().address, '127.0.0.1');
  const body = envelope(grant());
  for (const [method, path] of [
    ['GET', '/transfers'], ['PUT', '/transfers'], ['POST', '/sign'], ['POST', '/wallets'],
    ['POST', '/transfers/'], ['POST', '/transfers?raw=1'],
  ]) {
    assert.deepEqual(await call(s.port, path, body, { method }), { status: 404, body: { error: 'not_found' } });
  }
  assert.deepEqual(await call(s.port, '/transfers', body, { headers: { 'content-type': 'text/plain' } }),
    { status: 415, body: { error: 'unsupported_media_type' } });
  assert.deepEqual(await call(s.port, '/transfers', body, { headers: { host: 'signer.example' } }),
    { status: 403, body: { error: 'bad_host' } });
  assert.deepEqual(await call(s.port, '/transfers', 'x'.repeat(20_000)), { status: 413, body: { error: 'body_too_large' } });
  assert.equal(s.sent.length, 0);
});

test('the README known-answer vector reproduces byte for byte, and the CLI refuses its public key', async (t) => {
  const payload = '{"v":1,"kind":"test_transfer","grant_id":"883a901e-f291-4c95-90c9-d41ba817e45c","owner_id":"f1d05a12-5849-4a6b-9f47-a7a11dfa0132","auth_epoch":0,"cluster":"devnet","expires_at":1800000000000,"order_hash":"f74d87868c148cb45caa471c7548526b8f013b1c5729ffa0d0f02b75e64c015f","wallet_address":"6MHGUvei2atca6cz6yHPDqi6WKwYkNWRVLLCrwvoazsp","program_id":"11111111111111111111111111111111","asset":"SOL","recipient":"DNJtnMP3CbEN5Wvio7zFDEUcBAEfdzrxdQVj2i4sYXwY","amount_lamports":"1200","max_fee_lamports":"5000"}';
  const sig = 'fozL84S0-q3b5_cNonNrdBBz_BvuzU4H1YP4o6EQpKiqzqjWSE_2p99xnMGngoh_-ALX7vGBbS41K5Lv6xCwCg';
  const txId = 'sim_60008555fcc214ede9458d70392fa7cdf11821f52fee929db50c5bcae547c9e7';
  const readme = readFileSync(README_PATH, 'utf8');
  for (const value of [payload, sig, txId, KAT_SEED_HEX, KAT_PUBLIC_KEY, SIGNING_PREFIX.toString('hex'), String(NOW)]) {
    assert.ok(readme.includes(value), `README must contain ${value.slice(0, 32)}`);
  }
  const key = createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', d: Buffer.from(KAT_SEED_HEX, 'hex').toString('base64url'), x: KAT_PUBLIC_KEY },
    format: 'jwk',
  });
  assert.equal(sign(null, Buffer.concat([SIGNING_PREFIX, Buffer.from(payload)]), key).toString('base64url'), sig);

  const sent = [];
  const signer = new Signer({
    dbPath: ':memory:', policyPublicKey: KAT_PUBLIC_KEY, wallets: WALLETS, now: () => NOW,
    send: (tx) => { sent.push(tx.tx_id); },
  });
  const server = await serve(signer);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    signer.close();
  });
  const result = await call(server.address().port, '/transfers',
    JSON.stringify({ payload: Buffer.from(payload).toString('base64url'), sig }));
  assert.deepEqual([result.status, result.body.tx_id, sent], [200, txId, [txId]]);

  const dir = mkdtempSync(join(tmpdir(), 'dalahold-signer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ policy_public_key: KAT_PUBLIC_KEY, wallets: WALLETS }));
  const run = launch(dir);
  assert.equal((await run.exited).code, 1);
  assert.match(run.stderr(), /README vector key is public/);
});
