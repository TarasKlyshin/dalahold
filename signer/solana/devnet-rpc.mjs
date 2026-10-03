// Fixed devnet JSON-RPC transport; never accepts an arbitrary URL or redirects.
import {
  exactTestMemoKeys, isTestMemoBase58, isTestMemoUint, rejectTestMemo,
} from '../test-memo-grant.mjs';

export const DEVNET_RPC_URL = 'https://api.devnet.solana.com';
export const MAX_DEVNET_RPC_REPLY_BYTES = 65_536;
const MAX_WIRE_BYTES = 1_232;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const allowedKeys = (value, required, optional = []) => record(value) &&
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const fail = () => rejectTestMemo('invalid_devnet_rpc_response');

export function isDevnetTransactionError(value) {
  return (typeof value === 'string' && value.length > 0 && value.length <= 256) ||
    (record(value) && Object.keys(value).length > 0 && JSON.stringify(value).length <= 2_048);
}

function contextValue(result) {
  if (!exactTestMemoKeys(result, ['context', 'value']) ||
      !allowedKeys(result.context, ['slot'], ['apiVersion']) || !isTestMemoUint(result.context.slot) ||
      (Object.hasOwn(result.context, 'apiVersion') && (typeof result.context.apiVersion !== 'string' || result.context.apiVersion.length > 64))) fail();
  return result.value;
}

export function decodeDevnetWireBase64(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_WIRE_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 1 || bytes.length > MAX_WIRE_BYTES || bytes.toString('base64') !== value) fail();
  return bytes;
}

export function validateDevnetSignatureStatus(value) {
  if (value === null) return null;
  if (!allowedKeys(value, ['slot', 'confirmations', 'err', 'confirmationStatus'], ['status']) ||
      !isTestMemoUint(value.slot) || (value.confirmations !== null && !isTestMemoUint(value.confirmations)) ||
      (value.err !== null && !isDevnetTransactionError(value.err)) ||
      ![null, 'processed', 'confirmed', 'finalized'].includes(value.confirmationStatus)) fail();
  if (Object.hasOwn(value, 'status') &&
      !(value.err === null ? exactTestMemoKeys(value.status, ['Ok']) && value.status.Ok === null :
        exactTestMemoKeys(value.status, ['Err']) && JSON.stringify(value.status.Err) === JSON.stringify(value.err))) fail();
  return { slot: value.slot, confirmations: value.confirmations, err: value.err,
    confirmationStatus: value.confirmationStatus };
}

export function validateDevnetTransaction(value) {
  if (value === null) return null;
  if (!allowedKeys(value, ['slot', 'transaction', 'meta', 'version'], ['blockTime']) ||
      !isTestMemoUint(value.slot) || value.version !== 0 ||
      (Object.hasOwn(value, 'blockTime') && value.blockTime !== null && !isTestMemoUint(value.blockTime)) ||
      !Array.isArray(value.transaction) || value.transaction.length !== 2 || value.transaction[1] !== 'base64') fail();
  decodeDevnetWireBase64(value.transaction[0]);
  if (value.meta === null) return { slot: value.slot, version: 0, transaction: [...value.transaction], meta: null };
  const meta = value.meta;
  const optional = ['computeUnitsConsumed', 'costUnits', 'innerInstructions', 'loadedAddresses', 'logMessages',
    'preBalances', 'postBalances', 'preTokenBalances', 'postTokenBalances', 'rewards', 'status', 'returnData'];
  if (!allowedKeys(meta, ['err', 'fee'], optional) || !isTestMemoUint(meta.fee) ||
      (meta.err !== null && !isDevnetTransactionError(meta.err))) fail();
  for (const key of ['computeUnitsConsumed', 'costUnits'])
    if (Object.hasOwn(meta, key) && !isTestMemoUint(meta[key])) fail();
  for (const key of ['preBalances', 'postBalances'])
    if (Object.hasOwn(meta, key) && (!Array.isArray(meta[key]) || meta[key].length > 256 || !meta[key].every(isTestMemoUint))) fail();
  for (const key of ['innerInstructions', 'preTokenBalances', 'postTokenBalances', 'rewards'])
    if (Object.hasOwn(meta, key) && meta[key] !== null &&
        (!Array.isArray(meta[key]) || meta[key].length > 256 || !meta[key].every(record))) fail();
  if (Object.hasOwn(meta, 'logMessages') && meta.logMessages !== null &&
      (!Array.isArray(meta.logMessages) || meta.logMessages.length > 256 ||
        !meta.logMessages.every(line => typeof line === 'string' && line.length <= 2_048))) fail();
  if (Object.hasOwn(meta, 'loadedAddresses') &&
      (!exactTestMemoKeys(meta.loadedAddresses, ['readonly', 'writable']) ||
        !['readonly', 'writable'].every(key => Array.isArray(meta.loadedAddresses[key]) && meta.loadedAddresses[key].length <= 256 &&
          meta.loadedAddresses[key].every(address => isTestMemoBase58(address, 32))))) fail();
  if (Object.hasOwn(meta, 'status') &&
      !(meta.err === null ? exactTestMemoKeys(meta.status, ['Ok']) && meta.status.Ok === null :
        exactTestMemoKeys(meta.status, ['Err']) && JSON.stringify(meta.status.Err) === JSON.stringify(meta.err))) fail();
  if (Object.hasOwn(meta, 'returnData') && meta.returnData !== null &&
      (!exactTestMemoKeys(meta.returnData, ['programId', 'data']) || !isTestMemoBase58(meta.returnData.programId, 32) ||
        !Array.isArray(meta.returnData.data) || meta.returnData.data.length !== 2 || meta.returnData.data[1] !== 'base64' ||
        typeof meta.returnData.data[0] !== 'string' || meta.returnData.data[0].length > 2_048)) fail();
  // Omit logs and unrelated RPC metadata from the trusted sender's evidence.
  return { slot: value.slot, version: 0, transaction: [...value.transaction], meta: {
    err: meta.err, fee: meta.fee, innerInstructions: meta.innerInstructions ?? [],
    loadedAddresses: meta.loadedAddresses ?? { readonly: [], writable: [] },
  } };
}

async function readBoundedResponse(response, maxBytes, signal) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > maxBytes))
    rejectTestMemo('devnet_rpc_reply_too_large');
  if (!response.body || typeof response.body.getReader !== 'function') fail();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  const abort = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) rejectTestMemo('devnet_rpc_timeout');
      const item = await reader.read();
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) fail();
      size += item.value.length;
      if (size > maxBytes) rejectTestMemo('devnet_rpc_reply_too_large');
      chunks.push(Buffer.from(item.value));
    }
    if (signal.aborted) rejectTestMemo('devnet_rpc_timeout');
    const bytes = Buffer.concat(chunks);
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) fail();
    try { return JSON.parse(text); } catch { fail(); }
  } finally {
    signal.removeEventListener('abort', abort);
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createDevnetRpc({ url = DEVNET_RPC_URL, fetchImpl = globalThis.fetch,
  timeoutMs = 15_000, maxResponseBytes = MAX_DEVNET_RPC_REPLY_BYTES } = {}) {
  if (url !== DEVNET_RPC_URL || new URL(url).protocol !== 'https:') rejectTestMemo('devnet_rpc_url_not_allowed');
  if (typeof fetchImpl !== 'function' || !isTestMemoUint(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000 ||
      !isTestMemoUint(maxResponseBytes) || maxResponseBytes < 256 || maxResponseBytes > MAX_DEVNET_RPC_REPLY_BYTES)
    rejectTestMemo('invalid_devnet_rpc_configuration');
  let nextId = 0;
  async function call(method, params) {
    const id = ++nextId;
    if (!isTestMemoUint(id)) rejectTestMemo('devnet_rpc_id_exhausted');
    const controller = new AbortController();
    let timeout;
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => { controller.abort(); reject(new Error('devnet_rpc_timeout')); }, timeoutMs);
    });
    const request = async () => {
      let response;
      try { response = await fetchImpl(url, { method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: controller.signal }); }
      catch { rejectTestMemo(controller.signal.aborted ? 'devnet_rpc_timeout' : 'devnet_rpc_unavailable'); }
      if (!response || response.status !== 200 || response.redirected ||
          (response.url && response.url !== url && response.url !== `${url}/`) ||
          !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers?.get('content-type') ?? ''))
        rejectTestMemo('devnet_rpc_http_rejected');
      const parsed = await readBoundedResponse(response, maxResponseBytes, controller.signal);
      if (!record(parsed) || parsed.jsonrpc !== '2.0' || parsed.id !== id) fail();
      if (exactTestMemoKeys(parsed, ['jsonrpc', 'id', 'error'])) {
        if (!allowedKeys(parsed.error, ['code', 'message'], ['data']) || !Number.isSafeInteger(parsed.error.code) ||
            typeof parsed.error.message !== 'string' || parsed.error.message.length > 2_048) fail();
        rejectTestMemo('devnet_rpc_error');
      }
      if (!exactTestMemoKeys(parsed, ['jsonrpc', 'id', 'result'])) fail();
      return parsed.result;
    };
    try { return await Promise.race([request(), deadline]); }
    catch (error) {
      if (controller.signal.aborted) rejectTestMemo('devnet_rpc_timeout');
      if (typeof error?.code === 'string') throw error;
      rejectTestMemo('devnet_rpc_unavailable');
    } finally { clearTimeout(timeout); }
  }
  const signature = value => { if (!isTestMemoBase58(value, 64)) rejectTestMemo('invalid_memo_signature'); return value; };
  const encodedBytes = value => {
    if (!(value instanceof Uint8Array) || value.length < 1 || value.length > MAX_WIRE_BYTES)
      rejectTestMemo('invalid_memo_wire');
    return Buffer.from(value).toString('base64');
  };
  return Object.freeze({
    async getGenesisHash() {
      const result = await call('getGenesisHash', []);
      if (!isTestMemoBase58(result, 32)) fail();
      return result;
    },
    async getLatestBlockhash() {
      const value = contextValue(await call('getLatestBlockhash', [{ commitment: 'confirmed' }]));
      if (!exactTestMemoKeys(value, ['blockhash', 'lastValidBlockHeight']) ||
          !isTestMemoBase58(value.blockhash, 32) || !isTestMemoUint(value.lastValidBlockHeight)) fail();
      return { ...value };
    },
    async getFeeForMessage(messageBytes) {
      const value = contextValue(await call('getFeeForMessage', [encodedBytes(messageBytes), { commitment: 'confirmed' }]));
      if (value !== null && !isTestMemoUint(value)) fail();
      return value;
    },
    async getBalance(walletAddress) {
      if (!isTestMemoBase58(walletAddress, 32)) rejectTestMemo('invalid_memo_wallet');
      const value = contextValue(await call('getBalance', [walletAddress, { commitment: 'confirmed' }]));
      if (!isTestMemoUint(value)) fail();
      return value;
    },
    async getBlockHeight() {
      const value = await call('getBlockHeight', [{ commitment: 'confirmed' }]);
      if (!isTestMemoUint(value)) fail();
      return value;
    },
    async getSignatureStatus(txSignature) {
      const values = contextValue(await call('getSignatureStatuses', [[signature(txSignature)], { searchTransactionHistory: true }]));
      if (!Array.isArray(values) || values.length !== 1) fail();
      return validateDevnetSignatureStatus(values[0]);
    },
    async getTransaction(txSignature) {
      return validateDevnetTransaction(await call('getTransaction', [signature(txSignature),
        { commitment: 'confirmed', encoding: 'base64', maxSupportedTransactionVersion: 0 }]));
    },
    async sendTransaction(wireBytes) {
      const value = await call('sendTransaction', [encodedBytes(wireBytes),
        { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 }]);
      return signature(value);
    },
  });
}
