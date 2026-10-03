// Bounded read-only devnet readiness probe.
// This module never loads state or keys, signs, simulates, funds or broadcasts.
import { realpathSync } from 'node:fs';
import { types as nodeTypes } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createDevnetRpc, DEVNET_RPC_URL, MAX_DEVNET_RPC_REPLY_BYTES } from './solana/devnet-rpc.mjs';
import {
  DEVNET_GENESIS_HASH,
  isTestMemoBase58,
  isTestMemoUint,
  rejectTestMemo,
  TestMemoRejection,
} from './test-memo-grant.mjs';
import {
  compilePreflightMemoMessage,
  PREFLIGHT_MEMO,
  PREFLIGHT_PROGRAM_ID,
} from './solana/preflight-message.mjs';

export { PREFLIGHT_MEMO, PREFLIGHT_PROGRAM_ID };

export const DEFAULT_MAX_FEE_LAMPORTS = 10_000;
export const MAX_PREFLIGHT_RPC_CALLS = 5;
export const DEVNET_PREFLIGHT_ENV = Object.freeze({
  wallet: 'DALAHOLD_DEVNET_PUBLIC_WALLET',
  maxFeeLamports: 'DALAHOLD_DEVNET_MAX_FEE_LAMPORTS',
});
const DEVNET_PREFLIGHT_WALLET_ENV_ALIAS = 'DALAHOLD_DEVNET_WALLET';
const ALLOWED_CONFIG_KEYS = Object.freeze(['walletAddress', 'maxFeeLamports']);
const ALLOWED_DEPENDENCY_KEYS = Object.freeze(['rpc']);
const CLI_FLAGS = Object.freeze({ wallet: '--wallet', maxFeeLamports: '--max-fee-lamports' });
const BASE58_DECIMAL = /^[1-9][0-9]{0,4}$/;
const CONFIG_PREFIX = 'DALAHOLD_DEVNET_';
const RPC_FAILURE_CODES = new Set([
  'devnet_rpc_error', 'devnet_rpc_http_rejected', 'devnet_rpc_reply_too_large',
  'devnet_rpc_timeout', 'devnet_rpc_unavailable', 'invalid_devnet_rpc_response',
]);
const SAFE_FAILURE_CODES = new Set([
  ...RPC_FAILURE_CODES,
  'wrong_devnet_genesis', 'devnet_blockhash_expired', 'devnet_fee_unavailable',
  'devnet_fee_over_cap', 'devnet_insufficient_balance', 'preflight_rpc_failed',
  'preflight_invalid_rpc_result', 'preflight_call_limit', 'invalid_preflight_fee_message',
  'invalid_devnet_preflight_config',
  'invalid_devnet_rpc_configuration', 'devnet_rpc_url_not_allowed',
]);

function rejectConfig() { rejectTestMemo('invalid_devnet_preflight_config'); }

function copyOwnDataObject(value, allowedKeys, onInvalid) {
  const reject = typeof onInvalid === 'function' ? onInvalid : rejectConfig;
  if (nodeTypes.isProxy(value)) reject();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject();
  let prototype;
  let names;
  let symbols;
  try {
    prototype = Object.getPrototypeOf(value);
    names = Object.getOwnPropertyNames(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    reject();
  }
  if ((prototype !== Object.prototype && prototype !== null) || symbols.length !== 0 ||
      (allowedKeys && names.some(name => !allowedKeys.includes(name)))) reject();
  const entries = [];
  for (const name of names) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, name); } catch { reject(); }
    if (!descriptor || !('value' in descriptor) || descriptor.get || descriptor.set) reject();
    entries.push([name, descriptor.value]);
  }
  const copy = Object.create(null);
  for (const [name, entry] of entries) Object.defineProperty(copy, name, {
    value: entry, enumerable: true, writable: true, configurable: true,
  });
  return copy;
}

function copyCliArgv(argv) {
  if (nodeTypes.isProxy(argv)) rejectConfig();
  if (!Array.isArray(argv)) rejectConfig();
  let names;
  let symbols;
  let lengthDescriptor;
  try {
    names = Object.getOwnPropertyNames(argv);
    symbols = Object.getOwnPropertySymbols(argv);
    lengthDescriptor = Object.getOwnPropertyDescriptor(argv, 'length');
  } catch {
    rejectConfig();
  }
  if (symbols.length !== 0 || !lengthDescriptor || !('value' in lengthDescriptor) ||
      !isTestMemoUint(lengthDescriptor.value) || lengthDescriptor.value > 32) rejectConfig();
  const length = lengthDescriptor.value;
  if (names.length !== length + 1 || !names.includes('length')) rejectConfig();
  const entries = [];
  for (let index = 0; index < length; index++) {
    const name = String(index);
    if (!names.includes(name)) rejectConfig();
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(argv, name); } catch { rejectConfig(); }
    if (!descriptor || !('value' in descriptor) || descriptor.get || descriptor.set || typeof descriptor.value !== 'string') rejectConfig();
    entries.push(descriptor.value);
  }
  return entries;
}

function parseMaxFee(value) {
  if (typeof value === 'number') {
    if (!isTestMemoUint(value) || value < 1 || value > DEFAULT_MAX_FEE_LAMPORTS) rejectConfig();
    return value;
  }
  if (typeof value === 'string' && BASE58_DECIMAL.test(value)) {
    const parsed = Number(value);
    if (isTestMemoUint(parsed) && parsed >= 1 && parsed <= DEFAULT_MAX_FEE_LAMPORTS) return parsed;
  }
  rejectConfig();
}

/** Normalize the only two public preflight inputs. */
export function parsePreflightConfig(config = {}) {
  const source = copyOwnDataObject(config, ALLOWED_CONFIG_KEYS, rejectConfig);
  let walletAddress;
  if (Object.hasOwn(source, 'walletAddress')) {
    walletAddress = source.walletAddress;
    if (walletAddress !== undefined && !isTestMemoBase58(walletAddress, 32)) rejectConfig();
  }
  const maxFeeLamports = Object.hasOwn(source, 'maxFeeLamports')
    ? parseMaxFee(source.maxFeeLamports)
    : DEFAULT_MAX_FEE_LAMPORTS;
  return { walletAddress, maxFeeLamports };
}

function readEnvValue(env, name) {
  if (!Object.hasOwn(env, name)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(env, name);
  if (!descriptor || !('value' in descriptor) || descriptor.get || descriptor.set || typeof descriptor.value !== 'string')
    rejectConfig();
  return descriptor.value;
}

/**
 * Parse the narrow CLI/env boundary. No endpoint, key, signer, execution or
 * gate override is accepted. The environment argument is only injectable in
 * process tests; the CLI uses process.env.
 */
export function parsePreflightCli(argv = [], env = {}) {
  const args = copyCliArgv(argv);
  const environment = copyOwnDataObject(env, undefined, rejectConfig);
  const envNames = Object.getOwnPropertyNames(environment);
  for (const name of envNames) {
    if (name.startsWith(CONFIG_PREFIX) && ![
      DEVNET_PREFLIGHT_ENV.wallet, DEVNET_PREFLIGHT_ENV.maxFeeLamports, DEVNET_PREFLIGHT_WALLET_ENV_ALIAS,
    ].includes(name)) rejectConfig();
  }

  const values = {};
  const seenFlags = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const key = flag === CLI_FLAGS.wallet ? 'walletAddress' : flag === CLI_FLAGS.maxFeeLamports ? 'maxFeeLamports' : null;
    if (!key || seenFlags.has(key) || index + 1 >= args.length || args[index + 1].startsWith('--')) rejectConfig();
    seenFlags.add(key);
    values[key] = args[++index];
  }

  const envWallet = readEnvValue(environment, DEVNET_PREFLIGHT_ENV.wallet);
  const aliasWallet = readEnvValue(environment, DEVNET_PREFLIGHT_WALLET_ENV_ALIAS);
  if (envWallet !== undefined && aliasWallet !== undefined) rejectConfig();
  const envValues = {
    walletAddress: envWallet ?? aliasWallet,
    maxFeeLamports: readEnvValue(environment, DEVNET_PREFLIGHT_ENV.maxFeeLamports),
  };
  for (const key of Object.keys(envValues)) {
    if (envValues[key] !== undefined && Object.hasOwn(values, key)) rejectConfig();
    if (envValues[key] !== undefined) values[key] = envValues[key];
  }
  return Object.keys(values).length === 0 ? {} : parsePreflightConfig(values);
}

function initialReport(config) {
  return {
    version: 1,
    endpoint: DEVNET_RPC_URL,
    status: 'REFUSED',
    network: {
      ready: false,
      genesis: { status: 'NOT CHECKED' },
      latestBlockhash: { status: 'NOT CHECKED' },
      blockHeight: { status: 'NOT CHECKED' },
      limits: { maxRpcCalls: MAX_PREFLIGHT_RPC_CALLS, timeoutMs: 15_000, maxResponseBytes: MAX_DEVNET_RPC_REPLY_BYTES },
    },
    wallet: config.walletAddress === undefined
      ? { status: 'NOT CONFIGURED' }
      : { status: 'CONFIGURED', address: config.walletAddress },
    balance: { status: 'NOT CHECKED' },
    fee: { status: 'NOT CHECKED', maxLamports: config.maxFeeLamports },
    signer: { status: 'NOT CONFIGURED' },
    gates: {
      authority: 'NOT ACCEPTED',
      renewal: 'NOT ACCEPTED',
      ui: 'NOT ACCEPTED',
      security: 'NOT ACCEPTED',
      executionAuthorization: 'NOT ACCEPTED',
    },
    overallReady: false,
    ready: false,
    executionEnabled: false,
  };
}

function refusal(report, code) {
  report.status = 'REFUSED';
  report.error = SAFE_FAILURE_CODES.has(code) ? code : 'preflight_rpc_failed';
  report.overallReady = false;
  report.ready = false;
  report.executionEnabled = false;
  return report;
}

function safeFailureCode(error, fallback = 'preflight_rpc_failed') {
  try {
    const code = error?.code;
    return typeof code === 'string' && SAFE_FAILURE_CODES.has(code) ? code : fallback;
  } catch {
    return fallback;
  }
}

function rejectMalformedResult() { rejectTestMemo('preflight_invalid_rpc_result'); }

function validateLatest(value) {
  const source = copyOwnDataObject(value, ['blockhash', 'lastValidBlockHeight'], rejectMalformedResult);
  if (Object.getOwnPropertyNames(source).length !== 2 ||
      !isTestMemoBase58(source.blockhash, 32) || !isTestMemoUint(source.lastValidBlockHeight)) rejectMalformedResult();
  return { blockhash: source.blockhash, lastValidBlockHeight: source.lastValidBlockHeight };
}

function validateGenesis(value) {
  if (!isTestMemoBase58(value, 32)) rejectMalformedResult();
  return value;
}

function validateHeight(value) {
  if (!isTestMemoUint(value)) rejectMalformedResult();
  return value;
}

function validateBalance(value) {
  if (!isTestMemoUint(value)) rejectMalformedResult();
  return value;
}

function validateFee(value) {
  if (value !== null && !isTestMemoUint(value)) rejectMalformedResult();
  return value;
}

function validateDependencies(dependencies, needsWallet) {
  if (dependencies === undefined) return undefined;
  const dependencyConfig = copyOwnDataObject(dependencies, ALLOWED_DEPENDENCY_KEYS, rejectConfig);
  if (!Object.hasOwn(dependencyConfig, 'rpc')) rejectConfig();
  const rpc = dependencyConfig.rpc;
  if (nodeTypes.isProxy(rpc)) rejectConfig();
  if (rpc === null || typeof rpc !== 'object' || Array.isArray(rpc)) rejectConfig();
  const methods = ['getGenesisHash', 'getLatestBlockhash', 'getBlockHeight'];
  if (needsWallet) methods.push('getBalance', 'getFeeForMessage');
  let symbols;
  try { symbols = Object.getOwnPropertySymbols(rpc); } catch { rejectConfig(); }
  if (symbols.length !== 0) rejectConfig();
  const captured = Object.create(null);
  for (const method of methods) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(rpc, method);
    } catch {
      rejectConfig();
    }
    if (!descriptor || !('value' in descriptor) || descriptor.get || descriptor.set ||
        typeof descriptor.value !== 'function' || nodeTypes.isProxy(descriptor.value)) rejectConfig();
    try { captured[method] = Function.prototype.bind.call(descriptor.value, rpc); }
    catch { rejectConfig(); }
  }
  return Object.freeze(captured);
}

/**
 * Run the fixed read-only devnet probe. A dependency-injected RPC is allowed
 * only for in-process tests; the CLI always creates the fixed-endpoint adapter.
 */
export async function runDevnetPreflight(config = {}, dependencies) {
  const normalized = parsePreflightConfig(config);
  const injectedRpc = validateDependencies(dependencies, normalized.walletAddress !== undefined);
  const report = initialReport(normalized);
  let rpc;
  try {
    rpc = injectedRpc ?? createDevnetRpc();
  } catch (error) {
    return refusal(report, safeFailureCode(error));
  }

  let callCount = 0;
  const read = async (method, ...args) => {
    if (++callCount > MAX_PREFLIGHT_RPC_CALLS) rejectTestMemo('preflight_call_limit');
    try {
      const result = rpc[method](...args);
      if (nodeTypes.isProxy(result)) rejectTestMemo('preflight_invalid_rpc_result');
      return await result;
    } catch (error) {
      rejectTestMemo(safeFailureCode(error));
    }
  };

  let latest;
  let balance;
  let fee;
  let failure;
  try {
    let genesis;
    try { genesis = validateGenesis(await read('getGenesisHash')); }
    catch (error) { return refusal(report, safeFailureCode(error)); }
    if (genesis !== DEVNET_GENESIS_HASH) {
      report.network.genesis = { status: 'MISMATCH' };
      return refusal(report, 'wrong_devnet_genesis');
    }
    report.network.genesis = { status: 'READY', hash: DEVNET_GENESIS_HASH };

    try { latest = validateLatest(await read('getLatestBlockhash')); }
    catch (error) { return refusal(report, safeFailureCode(error)); }
    report.network.latestBlockhash = {
      status: 'READY', blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight,
    };

    if (normalized.walletAddress !== undefined) {
      report.fixedMessage = { version: 0, programId: PREFLIGHT_PROGRAM_ID, memo: PREFLIGHT_MEMO };
      try { balance = validateBalance(await read('getBalance', normalized.walletAddress)); }
      catch (error) { failure = safeFailureCode(error); }
      if (balance !== undefined) report.balance = { status: 'CHECKED', lamports: balance };
      if (!failure) {
        let messageBytes;
        try {
          messageBytes = compilePreflightMemoMessage({ feePayer: normalized.walletAddress,
            blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight });
        } catch (error) { failure = safeFailureCode(error, 'invalid_preflight_fee_message'); }
        if (!failure) {
          try { fee = validateFee(await read('getFeeForMessage', messageBytes)); }
          catch (error) { failure = safeFailureCode(error); }
          if (!failure) {
            report.fee = fee === null
              ? { status: 'UNAVAILABLE', maxLamports: normalized.maxFeeLamports }
              : { status: 'CHECKED', lamports: fee, maxLamports: normalized.maxFeeLamports };
          }
        }
      }
    }

    // This is deliberately last: fee and balance awaits must not stale the
    // blockhash check used for the network-readiness result.
    let blockHeight;
    try { blockHeight = validateHeight(await read('getBlockHeight')); }
    catch (error) { failure ??= safeFailureCode(error); }
    if (blockHeight !== undefined) {
      report.network.blockHeight = { status: 'READY', value: blockHeight };
      if (blockHeight > latest.lastValidBlockHeight) {
        report.network.latestBlockhash = {
          status: 'EXPIRED', lastValidBlockHeight: latest.lastValidBlockHeight,
        };
        failure ??= 'devnet_blockhash_expired';
      }
    }
    if (failure) return refusal(report, failure);
    if (blockHeight === undefined) return refusal(report, 'preflight_invalid_rpc_result');
    report.network.ready = true;

    if (normalized.walletAddress !== undefined) {
      if (fee === null) {
        return refusal(report, 'devnet_fee_unavailable');
      }
      report.fee = { status: fee > normalized.maxFeeLamports ? 'OVER_CAP' : 'READY',
        lamports: fee, maxLamports: normalized.maxFeeLamports };
      if (fee > normalized.maxFeeLamports) return refusal(report, 'devnet_fee_over_cap');
      if (balance < fee) {
        report.balance = { status: 'INSUFFICIENT', lamports: balance, requiredLamports: fee };
        return refusal(report, 'devnet_insufficient_balance');
      }
      report.balance = { status: 'READY', lamports: balance, requiredLamports: fee };
    }
    report.status = 'PARTIAL';
    return report;
  } catch (error) {
    return refusal(report, safeFailureCode(error));
  }
}

function cliErrorReport(error) {
  return refusal(initialReport({ walletAddress: undefined, maxFeeLamports: DEFAULT_MAX_FEE_LAMPORTS }),
    safeFailureCode(error, 'invalid_devnet_preflight_config'));
}

export const PREFLIGHT_USAGE = `Usage: node signer/devnet-preflight.mjs [--wallet BASE58_PUBLIC_ADDRESS] [--max-fee-lamports 1..10000]\n` +
  `Optional env: ${DEVNET_PREFLIGHT_ENV.wallet}, ${DEVNET_PREFLIGHT_ENV.maxFeeLamports}\n` +
  'Read-only only; no keys, signing, funding, simulation, send or execution authorization.';

// Node exposes process.env with a platform-specific prototype on some hosts.
// Snapshot only own data properties at the CLI boundary, then keep the strict
// plain-object/accessor checks for all injected parser inputs.
function snapshotProcessEnv(environment) {
  if (nodeTypes.isProxy(environment)) rejectConfig();
  let names;
  try { names = Object.getOwnPropertyNames(environment); } catch { rejectConfig(); }
  const snapshot = Object.create(null);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(environment, name);
    if (!descriptor || !('value' in descriptor) || descriptor.get || descriptor.set || typeof descriptor.value !== 'string')
      rejectConfig();
    Object.defineProperty(snapshot, name, {
      value: descriptor.value, enumerable: true, writable: true, configurable: true,
    });
  }
  return snapshot;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write(`${PREFLIGHT_USAGE}\n`);
    return;
  }
  try {
    const config = parsePreflightCli(argv, snapshotProcessEnv(process.env));
    const report = await runDevnetPreflight(config);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.status === 'REFUSED') process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(cliErrorReport(error))}\n`);
    process.exitCode = 2;
  }
}

if (isMainModule()) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify(cliErrorReport(new TestMemoRejection('preflight_rpc_failed')))}\n`);
    process.exitCode = 2;
  });
}
