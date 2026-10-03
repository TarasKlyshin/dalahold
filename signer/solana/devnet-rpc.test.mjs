import assert from 'node:assert/strict';
import test from 'node:test';
import { createDevnetRpc, DEVNET_RPC_URL, MAX_DEVNET_RPC_REPLY_BYTES } from './devnet-rpc.mjs';
import { encodeTestMemoBase58 } from './memo-builder.mjs';
import { DEVNET_GENESIS_HASH } from '../test-memo-grant.mjs';

const WALLET = encodeTestMemoBase58(new Uint8Array(32).fill(2));
const BLOCKHASH = encodeTestMemoBase58(new Uint8Array(32).fill(1));
const SIGNATURE = encodeTestMemoBase58(new Uint8Array(64).fill(3));
const WIRE = new Uint8Array(289).fill(4);
const context = value => ({ context: { slot: 70, apiVersion: '3.1.8' }, value });
const STATUS = { slot: 70, confirmations: 2, err: null, confirmationStatus: 'confirmed', status: { Ok: null } };
const TRANSACTION = { slot: 70, blockTime: 1_800_000_000, version: 0, transaction: [Buffer.from(WIRE).toString('base64'), 'base64'],
  meta: { err: null, fee: 5000, innerInstructions: [], loadedAddresses: { readonly: [], writable: [] }, logMessages: ['MODEL'],
    preBalances: [10000, 1], postBalances: [5000, 1], preTokenBalances: [], postTokenBalances: [], rewards: [] } };
function modelReply(result, change = value => value) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    const request = JSON.parse(options.body); requests.push({ url, options, request });
    return new Response(JSON.stringify(change({ jsonrpc: '2.0', id: request.id, result })),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { requests, rpc: createDevnetRpc({ fetchImpl }) };
}

test('devnet transport model pins URL/TLS, request IDs, methods and preflight/retry config without live RPC', async () => {
  const values = { getGenesisHash: DEVNET_GENESIS_HASH, getLatestBlockhash: context({ blockhash: BLOCKHASH, lastValidBlockHeight: 100 }),
    getFeeForMessage: context(5000), getBalance: context(10000), getBlockHeight: 50,
    getSignatureStatuses: context([STATUS]), getTransaction: TRANSACTION, sendTransaction: SIGNATURE };
  const requests = [];
  const rpc = createDevnetRpc({ fetchImpl: async (url, options) => {
    const request = JSON.parse(options.body); requests.push({ url, options, request });
    assert.equal(url, DEVNET_RPC_URL); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.equal(options.method, 'POST'); assert.equal(options.signal instanceof AbortSignal, true);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: values[request.method] }),
      { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
  } });
  assert.equal(await rpc.getGenesisHash(), DEVNET_GENESIS_HASH);
  assert.deepEqual(await rpc.getLatestBlockhash(), { blockhash: BLOCKHASH, lastValidBlockHeight: 100 });
  assert.equal(await rpc.getFeeForMessage(WIRE), 5000);
  assert.equal(await rpc.getBalance(WALLET), 10000);
  assert.equal(await rpc.getBlockHeight(), 50);
  assert.equal((await rpc.getSignatureStatus(SIGNATURE)).confirmationStatus, 'confirmed');
  const tx = await rpc.getTransaction(SIGNATURE);
  assert.equal(tx.meta.fee, 5000); assert.equal(tx.meta.logMessages, undefined);
  assert.equal(await rpc.sendTransaction(WIRE), SIGNATURE);
  assert.deepEqual(requests.map(value => value.request.id), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(requests.at(-1).request.params[1], { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 });
  assert.deepEqual(requests.at(-2).request.params[1], { commitment: 'confirmed', encoding: 'base64', maxSupportedTransactionVersion: 0 });
  assert.deepEqual(requests[5].request.params, [[SIGNATURE], { searchTransactionHistory: true }]);
  assert.equal(Object.hasOwn(rpc, 'requestAirdrop'), false);
});

test('devnet transport model rejects all other URLs, non-HTTPS, timeout/size expansion and untrusted input types', async () => {
  for (const url of ['https://api.mainnet-beta.solana.com', 'http://api.devnet.solana.com', 'https://api.devnet.solana.com/',
    'https://api.devnet.solana.com?key=private', 'https://api.devnet.solana.com.evil.example', 'https://user:secret@api.devnet.solana.com'])
    assert.throws(() => createDevnetRpc({ url }), /devnet_rpc_url_not_allowed/);
  for (const patch of [{ timeoutMs: 15001 }, { timeoutMs: 0 }, { maxResponseBytes: MAX_DEVNET_RPC_REPLY_BYTES + 1 },
    { fetchImpl: null }, { maxResponseBytes: 255 }]) assert.throws(() => createDevnetRpc(patch), /invalid_devnet_rpc_configuration/);
  const f = modelReply(null);
  await assert.rejects(f.rpc.sendTransaction('raw browser string'), /invalid_memo_wire/);
  await assert.rejects(f.rpc.getFeeForMessage(new Uint8Array(1233)), /invalid_memo_wire/);
  await assert.rejects(f.rpc.getBalance('mainnet'), /invalid_memo_wallet/);
  await assert.rejects(f.rpc.getSignatureStatus('bad'), /invalid_memo_signature/);
  assert.equal(f.requests.length, 0);
});

test('devnet transport model rejects ID/version/extra-result ambiguity and sanitizes JSON-RPC errors', async () => {
  for (const change of [value => ({ ...value, id: value.id + 1 }), value => ({ ...value, id: String(value.id) }),
    value => ({ ...value, jsonrpc: '1.0' }), value => ({ ...value, extra: true }),
    value => ({ ...value, error: { code: -32000, message: 'also result' } }), () => []])
    await assert.rejects(modelReply(DEVNET_GENESIS_HASH, change).rpc.getGenesisHash(), /invalid_devnet_rpc_response/);
  const f = modelReply(null, value => ({ jsonrpc: '2.0', id: value.id,
    error: { code: -32002, message: 'PRIVATE MODEL preflight content', data: { logs: ['PRIVATE'] } } }));
  await assert.rejects(f.rpc.sendTransaction(WIRE), error => error.code === 'devnet_rpc_error' && !error.message.includes('PRIVATE'));
});

test('devnet transport model enforces each RPC schema and preserves null as missing evidence', async () => {
  for (const result of ['bad', 1, null]) await assert.rejects(modelReply(result).rpc.getGenesisHash(), /invalid_devnet_rpc_response/);
  for (const result of [context({ blockhash: BLOCKHASH, lastValidBlockHeight: 1.5 }),
    context({ blockhash: 'bad', lastValidBlockHeight: 100 }), context({ blockhash: BLOCKHASH, lastValidBlockHeight: 100, extra: 1 }),
    { context: { slot: -1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } }])
    await assert.rejects(modelReply(result).rpc.getLatestBlockhash(), /invalid_devnet_rpc_response/);
  for (const number of [-1, 5000.5, '5000', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(modelReply(context(number)).rpc.getFeeForMessage(WIRE), /invalid_devnet_rpc_response/);
    await assert.rejects(modelReply(context(number)).rpc.getBalance(WALLET), /invalid_devnet_rpc_response/);
    await assert.rejects(modelReply(number).rpc.getBlockHeight(), /invalid_devnet_rpc_response/);
  }
  assert.equal(await modelReply(context(null)).rpc.getFeeForMessage(WIRE), null);
  assert.equal(await modelReply(context([null])).rpc.getSignatureStatus(SIGNATURE), null);
  assert.equal(await modelReply(null).rpc.getTransaction(SIGNATURE), null);
  for (const status of [{ ...STATUS, confirmationStatus: 'success' }, { ...STATUS, slot: -1 },
    { ...STATUS, err: true }, { ...STATUS, err: { InstructionError: [0, 'Custom'] } }, { ...STATUS, unknown: true }])
    await assert.rejects(modelReply(context([status])).rpc.getSignatureStatus(SIGNATURE), /invalid_devnet_rpc_response/);
  for (const value of [context([]), context([null, null])])
    await assert.rejects(modelReply(value).rpc.getSignatureStatus(SIGNATURE), /invalid_devnet_rpc_response/);
});

test('devnet transport model validates base64 version-0 readback, actual fee and essential metadata', async () => {
  for (const tx of [{ ...TRANSACTION, version: 'legacy' }, { ...TRANSACTION, extra: true },
    { ...TRANSACTION, transaction: [Buffer.from(WIRE).toString('base64'), 'base58'] },
    { ...TRANSACTION, transaction: ['not base64', 'base64'] },
    { ...TRANSACTION, meta: { err: null, fee: 5.1 } },
    { ...TRANSACTION, meta: { err: undefined, fee: 5000 } },
    { ...TRANSACTION, meta: { err: null, fee: 5000, loadedAddresses: { writable: 'bad', readonly: [] } } },
    { ...TRANSACTION, meta: { err: null, fee: 5000, innerInstructions: 'bad' } }])
    await assert.rejects(modelReply(tx).rpc.getTransaction(SIGNATURE), /invalid_devnet_rpc_response/);
  assert.equal((await modelReply({ ...TRANSACTION, meta: null }).rpc.getTransaction(SIGNATURE)).meta, null);
});

test('devnet transport model refuses redirects, altered destination, HTTP errors and non-JSON content', async () => {
  for (const response of [new Response('{}', { status: 302, headers: { location: 'https://api.mainnet-beta.solana.com' } }),
    new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } }),
    new Response('{}', { status: 200, headers: { 'content-type': 'text/html' } })])
    await assert.rejects(createDevnetRpc({ fetchImpl: async () => response }).getGenesisHash(), /devnet_rpc_http_rejected/);
  for (const property of [{ key: 'redirected', value: true }, { key: 'url', value: 'https://api.mainnet-beta.solana.com' }]) {
    const response = new Response('{}', { headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, property.key, { value: property.value });
    await assert.rejects(createDevnetRpc({ fetchImpl: async () => response }).getGenesisHash(), /devnet_rpc_http_rejected/);
  }
});

test('devnet transport model caps actual streamed/body length and invalid UTF-8 rather than trusting Content-Length', async () => {
  for (const headers of [{ 'content-type': 'application/json' }, { 'content-type': 'application/json', 'content-length': '1' },
    { 'content-type': 'application/json', 'content-length': '300' }]) {
    const rpc = createDevnetRpc({ maxResponseBytes: 256, fetchImpl: async () => new Response('x'.repeat(300), { headers }) });
    await assert.rejects(rpc.getGenesisHash(), /devnet_rpc_reply_too_large/);
  }
  const rpc = createDevnetRpc({ fetchImpl: async () => new Response(new Uint8Array([0xff, 0xfe]),
    { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(rpc.getGenesisHash(), /invalid_devnet_rpc_response/);
});

test('devnet transport model bounds both unresponsive fetch and unfinished body to the configured timeout', async () => {
  const never = createDevnetRpc({ timeoutMs: 10, fetchImpl: async () => new Promise(() => {}) });
  await assert.rejects(never.getGenesisHash(), /devnet_rpc_timeout/);
  const unfinished = createDevnetRpc({ timeoutMs: 10, fetchImpl: async () => new Response(new ReadableStream({ start() {} }),
    { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(unfinished.getGenesisHash(), /devnet_rpc_timeout/);
});
