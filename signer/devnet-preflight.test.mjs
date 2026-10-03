import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MAX_FEE_LAMPORTS,
  DEVNET_PREFLIGHT_ENV,
  PREFLIGHT_MEMO,
  PREFLIGHT_PROGRAM_ID,
  parsePreflightConfig,
  parsePreflightCli,
  runDevnetPreflight,
} from './devnet-preflight.mjs';
import { DEVNET_GENESIS_HASH } from './test-memo-grant.mjs';
import { encodeTestMemoBase58 } from './solana/memo-builder.mjs';
import { compilePreflightMemoMessage } from './solana/preflight-message.mjs';

const WALLET = encodeTestMemoBase58(new Uint8Array(32).fill(7));
const BLOCKHASH = encodeTestMemoBase58(new Uint8Array(32).fill(8));
const OTHER_GENESIS = encodeTestMemoBase58(new Uint8Array(32).fill(9));

function fixture(overrides = {}) {
  const requests = [];
  const values = {
    genesis: DEVNET_GENESIS_HASH,
    latest: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 },
    height: 50,
    balance: 10_000,
    fee: 5_000,
    ...overrides,
  };
  const rpc = {};
  for (const [name, key] of [['getGenesisHash', 'genesis'], ['getLatestBlockhash', 'latest'],
    ['getBlockHeight', 'height'], ['getBalance', 'balance'], ['getFeeForMessage', 'fee']]) {
    rpc[name] = async (...args) => {
      requests.push({ method: name, args });
      const value = values[key];
      if (value instanceof Error) throw value;
      return typeof value === 'function' ? value(...args) : value;
    };
  }
  return { rpc, requests };
}

function fixedConfig(overrides = {}) {
  return { walletAddress: WALLET, maxFeeLamports: DEFAULT_MAX_FEE_LAMPORTS, ...overrides };
}

test('model no-wallet preflight is read-only partial and does not check signer, balance or fee', async () => {
  const f = fixture();
  delete f.rpc.getBalance;
  delete f.rpc.getFeeForMessage;
  const report = await runDevnetPreflight({}, { rpc: f.rpc });
  assert.equal(report.status, 'PARTIAL');
  assert.equal(report.network.ready, true);
  assert.equal(report.network.genesis.status, 'READY');
  assert.equal(report.network.latestBlockhash.status, 'READY');
  assert.equal(report.network.blockHeight.status, 'READY');
  assert.equal(report.wallet.status, 'NOT CONFIGURED');
  assert.equal(report.balance.status, 'NOT CHECKED');
  assert.equal(report.fee.status, 'NOT CHECKED');
  assert.equal(report.signer.status, 'NOT CONFIGURED');
  assert.equal(report.overallReady, false);
  assert.equal(report.executionEnabled, false);
  assert.deepEqual(f.requests.map(item => item.method), ['getGenesisHash', 'getLatestBlockhash', 'getBlockHeight']);
});

test('model wallet preflight compiles one fixed unsigned v0 Memo message and performs only read calls', async () => {
  const f = fixture();
  const report = await runDevnetPreflight(fixedConfig(), { rpc: f.rpc });
  assert.equal(report.status, 'PARTIAL');
  assert.equal(report.network.ready, true);
  assert.equal(report.wallet.status, 'CONFIGURED');
  assert.equal(report.wallet.address, WALLET);
  assert.equal(report.balance.status, 'READY');
  assert.equal(report.balance.lamports, 10_000);
  assert.equal(report.fee.status, 'READY');
  assert.equal(report.fee.lamports, 5_000);
  assert.equal(report.fee.maxLamports, DEFAULT_MAX_FEE_LAMPORTS);
  assert.equal(report.signer.status, 'NOT CONFIGURED');
  assert.equal(report.overallReady, false);
  assert.equal(report.executionEnabled, false);
  assert.deepEqual(f.requests.map(item => item.method), [
    'getGenesisHash', 'getLatestBlockhash', 'getBalance', 'getFeeForMessage', 'getBlockHeight',
  ]);
  const feeRequest = f.requests.find(item => item.method === 'getFeeForMessage');
  assert.equal(feeRequest.args.length, 1);
  assert.ok(feeRequest.args[0] instanceof Uint8Array);
  assert.ok(feeRequest.args[0].length > 0 && feeRequest.args[0].length <= 1_232);
  assert.equal(report.fixedMessage.programId, PREFLIGHT_PROGRAM_ID);
  assert.equal(report.fixedMessage.memo, PREFLIGHT_MEMO);
  assert.equal(Object.hasOwn(report, 'signature'), false);
  assert.equal(Object.hasOwn(report, 'wireBytes'), false);
});

test('wrong genesis refuses before dependent calls without echoing returned hash', async () => {
  const f = fixture({ genesis: OTHER_GENESIS });
  const report = await runDevnetPreflight(fixedConfig(), { rpc: f.rpc });
  assert.equal(report.status, 'REFUSED');
  assert.equal(report.error, 'wrong_devnet_genesis');
  assert.equal(report.network.ready, false);
  assert.equal(report.executionEnabled, false);
  assert.equal(report.network.genesis.status, 'MISMATCH');
  assert.equal(JSON.stringify(report).includes(OTHER_GENESIS), false);
  assert.deepEqual(f.requests.map(item => item.method), ['getGenesisHash']);
});

test('null and over-cap fee quotes are not ready and do not become zero or permission', async () => {
  const nullFee = fixture({ fee: null });
  const nullReport = await runDevnetPreflight(fixedConfig(), { rpc: nullFee.rpc });
  assert.equal(nullReport.status, 'REFUSED');
  assert.equal(nullReport.error, 'devnet_fee_unavailable');
  assert.equal(nullReport.fee.status, 'UNAVAILABLE');
  assert.equal(Object.hasOwn(nullReport.fee, 'lamports'), false);

  const overCap = fixture({ fee: DEFAULT_MAX_FEE_LAMPORTS + 1 });
  const overReport = await runDevnetPreflight(fixedConfig({ maxFeeLamports: DEFAULT_MAX_FEE_LAMPORTS }), { rpc: overCap.rpc });
  assert.equal(overReport.status, 'REFUSED');
  assert.equal(overReport.error, 'devnet_fee_over_cap');
  assert.equal(overReport.fee.status, 'OVER_CAP');
  assert.equal(overReport.fee.lamports, DEFAULT_MAX_FEE_LAMPORTS + 1);
});

test('low balance and expired latest blockhash remain negative despite read-only network success', async () => {
  const low = fixture({ balance: 4_999, fee: 5_000 });
  const lowReport = await runDevnetPreflight(fixedConfig(), { rpc: low.rpc });
  assert.equal(lowReport.status, 'REFUSED');
  assert.equal(lowReport.error, 'devnet_insufficient_balance');
  assert.equal(lowReport.balance.status, 'INSUFFICIENT');
  assert.equal(lowReport.overallReady, false);

  const expired = fixture({ latest: { blockhash: BLOCKHASH, lastValidBlockHeight: 50 }, height: 51 });
  const expiredReport = await runDevnetPreflight({}, { rpc: expired.rpc });
  assert.equal(expiredReport.status, 'REFUSED');
  assert.equal(expiredReport.error, 'devnet_blockhash_expired');
  assert.equal(expiredReport.network.ready, false);
  assert.equal(expiredReport.network.latestBlockhash.status, 'EXPIRED');
  assert.deepEqual(expired.requests.map(item => item.method), ['getGenesisHash', 'getLatestBlockhash', 'getBlockHeight']);
});

test('network and malformed model failures use fixed codes and never leak untrusted errors', async () => {
  for (const [key, error] of [['genesis', new Error('PRIVATE_SECRET_RPC_MESSAGE')],
    ['latest', Object.assign(new Error('private latest'), { code: 'PRIVATE_CODE' })],
    ['height', new Error('PRIVATE HEIGHT')], ['balance', new Error('PRIVATE BALANCE')],
    ['fee', new Error('PRIVATE FEE')]]) {
    const f = fixture({ [key]: error });
    const report = await runDevnetPreflight(key === 'genesis' || key === 'latest' || key === 'height' ? {} : fixedConfig(), { rpc: f.rpc });
    assert.equal(report.status, 'REFUSED');
    assert.equal(report.error, 'preflight_rpc_failed');
    assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
  }
  for (const [key, value] of [['genesis', {}], ['latest', { blockhash: BLOCKHASH }],
    ['latest', { blockhash: BLOCKHASH, lastValidBlockHeight: '50' }], ['height', '50'],
    ['balance', -1], ['fee', { value: 5_000 }]]) {
    const f = fixture({ [key]: value });
    const report = await runDevnetPreflight(key === 'genesis' || key === 'latest' || key === 'height' ? {} : fixedConfig(), { rpc: f.rpc });
    assert.equal(report.status, 'REFUSED');
    assert.equal(report.error, 'preflight_invalid_rpc_result');
  }
});

test('strict config rejects accessors, inherited/extra privileged fields and overcap before network', async () => {
  const f = fixture();
  const accessed = { count: 0 };
  const accessor = {};
  Object.defineProperty(accessor, 'walletAddress', { enumerable: true, get() { accessed.count++; return WALLET; } });
  await assert.rejects(runDevnetPreflight(accessor, { rpc: f.rpc }), /invalid_devnet_preflight_config/);
  assert.equal(accessed.count, 0);
  assert.equal(f.requests.length, 0);
  for (const bad of [
    { ...fixedConfig(), privateKey: 'secret' },
    { ...fixedConfig(), keyPath: '/tmp/private.key' },
    { ...fixedConfig(), rpcUrl: 'https://evil.example' },
    { ...fixedConfig(), executeEnabled: true },
    { ...fixedConfig(), authorityVerified: true },
    { ...fixedConfig(), renewalReady: true },
    Object.assign(Object.create({ walletAddress: WALLET }), { maxFeeLamports: DEFAULT_MAX_FEE_LAMPORTS }),
    { ...fixedConfig({ maxFeeLamports: DEFAULT_MAX_FEE_LAMPORTS + 1 }) },
  ]) await assert.rejects(runDevnetPreflight(bad, { rpc: f.rpc }), /invalid_devnet_preflight_config/);
  assert.equal(f.requests.length, 0);
});

test('config and CLI accessors accept only public bounded inputs and reject privileged flags/env before RPC', () => {
  assert.deepEqual(parsePreflightConfig({}), { walletAddress: undefined, maxFeeLamports: DEFAULT_MAX_FEE_LAMPORTS });
  assert.deepEqual(parsePreflightConfig({ walletAddress: WALLET, maxFeeLamports: '9000' }), {
    walletAddress: WALLET, maxFeeLamports: 9_000,
  });
  assert.deepEqual(parsePreflightCli([], {}), {});
  assert.deepEqual(parsePreflightCli(['--wallet', WALLET, '--max-fee-lamports', '9000'], {}), {
    walletAddress: WALLET, maxFeeLamports: 9_000,
  });
  assert.deepEqual(parsePreflightCli([], {
    [DEVNET_PREFLIGHT_ENV.wallet]: WALLET,
    [DEVNET_PREFLIGHT_ENV.maxFeeLamports]: '9000',
  }), { walletAddress: WALLET, maxFeeLamports: 9_000 });
  for (const args of [['--rpc-url', 'https://evil.example'], ['--private-key', 'secret'], ['--execute-enabled', 'true'], ['--wallet']])
    assert.throws(() => parsePreflightCli(args, {}), /invalid_devnet_preflight_config/);
  assert.throws(() => parsePreflightCli([], { DALAHOLD_DEVNET_RPC_URL: 'https://evil.example' }), /invalid_devnet_preflight_config/);
  assert.throws(() => parsePreflightConfig({ walletAddress: WALLET, signature: 'secret' }), /invalid_devnet_preflight_config/);
});

test('real CLI process.env startup normalizes the platform environment and preserves fixed config refusal without RPC', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('DALAHOLD_DEVNET_')));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./devnet-preflight.mjs', import.meta.url)), '--unsupported'], {
    cwd: process.cwd(), env, encoding: 'utf8', maxBuffer: 64 * 1024,
  });
  assert.equal(result.status, 2);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'REFUSED');
  assert.equal(report.error, 'invalid_devnet_preflight_config');
  assert.equal(report.executionEnabled, false);
  assert.equal(result.stdout.includes('unsupported'), false);
  assert.equal(result.stdout.includes('preflight_rpc_failed'), false);
});

test('latest RPC result accessors and symbol fields are refused before any value getter or stale-blockhash decision', async () => {
  const f = fixture();
  let blockhashReads = 0;
  let heightReads = 0;
  const latest = { get blockhash() { blockhashReads++; return blockhashReads === 1 ? BLOCKHASH : 'PRIVATE_SENTINEL'; },
    get lastValidBlockHeight() { heightReads++; return heightReads === 1 ? 100 : 'PRIVATE_HEIGHT'; } };
  f.rpc.getLatestBlockhash = async () => latest;
  const report = await runDevnetPreflight({}, { rpc: f.rpc });
  assert.equal(report.status, 'REFUSED');
  assert.equal(report.error, 'preflight_invalid_rpc_result');
  assert.equal(blockhashReads, 0);
  assert.equal(heightReads, 0);
  assert.equal(JSON.stringify(report).includes('PRIVATE'), false);

  const symbol = Symbol('private');
  const withSymbol = { blockhash: BLOCKHASH, lastValidBlockHeight: 100, [symbol]: 'PRIVATE_SYMBOL' };
  const symbolFixture = fixture({ latest: withSymbol });
  const symbolReport = await runDevnetPreflight({}, { rpc: symbolFixture.rpc });
  assert.equal(symbolReport.error, 'preflight_invalid_rpc_result');
  assert.equal(JSON.stringify(symbolReport).includes('PRIVATE_SYMBOL'), false);
});

test('config and compiler proxies are refused without invoking their get traps', async () => {
  const f = fixture();
  let configReads = 0;
  const configProxy = new Proxy(fixedConfig(), { get(target, property, receiver) {
    configReads++;
    return Reflect.get(target, property, receiver);
  } });
  await assert.rejects(runDevnetPreflight(configProxy, { rpc: f.rpc }), /invalid_devnet_preflight_config/);
  assert.equal(configReads, 0);
  assert.equal(f.requests.length, 0);

  let compilerReads = 0;
  const compilerProxy = new Proxy({ feePayer: WALLET, blockhash: BLOCKHASH, lastValidBlockHeight: 100 }, {
    get(target, property, receiver) {
      compilerReads++;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(() => compilePreflightMemoMessage(compilerProxy), /invalid_preflight_fee_message/);
  assert.equal(compilerReads, 0);
});

test('injected RPC requires own data-valued methods and captures each getter-free function once', async () => {
  const f = fixture();
  let getterReads = 0;
  for (const method of ['getGenesisHash', 'getLatestBlockhash', 'getBlockHeight']) {
    const value = f.rpc[method];
    Object.defineProperty(f.rpc, method, { enumerable: true, configurable: true, get() {
      getterReads++;
      return value;
    } });
  }
  await assert.rejects(runDevnetPreflight({}, { rpc: f.rpc }), /invalid_devnet_preflight_config/);
  assert.equal(getterReads, 0);
  assert.equal(f.requests.length, 0);
});

test('CLI argv accessors and proxies are refused without evaluating elements', () => {
  let accessorReads = 0;
  const accessorArgv = [];
  Object.defineProperty(accessorArgv, '0', { enumerable: true, configurable: true, get() {
    accessorReads++;
    return '--unsupported';
  } });
  accessorArgv.length = 1;
  assert.throws(() => parsePreflightCli(accessorArgv, {}), /invalid_devnet_preflight_config/);
  assert.equal(accessorReads, 0);

  let proxyReads = 0;
  const proxyArgv = new Proxy(['--unsupported'], { get(target, property, receiver) {
    proxyReads++;
    return Reflect.get(target, property, receiver);
  } });
  assert.throws(() => parsePreflightCli(proxyArgv, {}), /invalid_devnet_preflight_config/);
  assert.equal(proxyReads, 0);
});

test('proxy and revoked-proxy boundaries refuse before reflection traps or native errors', async () => {
  const makeReflectiveProxy = target => {
    const reads = { getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 };
    const proxy = new Proxy(target, {
      getPrototypeOf() { reads.getPrototypeOf++; return Reflect.getPrototypeOf(target); },
      ownKeys() { reads.ownKeys++; return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor() {
        reads.getOwnPropertyDescriptor++;
        return Reflect.getOwnPropertyDescriptor(target, 'walletAddress');
      },
    });
    return { proxy, reads };
  };

  const configFixture = fixture();
  const configBoundary = makeReflectiveProxy(fixedConfig());
  await assert.rejects(runDevnetPreflight(configBoundary.proxy, { rpc: configFixture.rpc }),
    /invalid_devnet_preflight_config/);
  assert.deepEqual(configBoundary.reads, { getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 });
  assert.equal(configFixture.requests.length, 0);

  const latestFixture = fixture();
  const latestBoundary = makeReflectiveProxy({ blockhash: BLOCKHASH, lastValidBlockHeight: 100 });
  latestFixture.rpc.getLatestBlockhash = async () => latestBoundary.proxy;
  const latestReport = await runDevnetPreflight({}, { rpc: latestFixture.rpc });
  assert.equal(latestReport.error, 'preflight_invalid_rpc_result');
  assert.deepEqual(latestBoundary.reads, { getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 });

  const compilerBoundary = makeReflectiveProxy({ feePayer: WALLET, blockhash: BLOCKHASH, lastValidBlockHeight: 100 });
  assert.throws(() => compilePreflightMemoMessage(compilerBoundary.proxy), /invalid_preflight_fee_message/);
  assert.deepEqual(compilerBoundary.reads, { getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 });

  const argvBoundary = makeReflectiveProxy(['--unsupported']);
  assert.throws(() => parsePreflightCli(argvBoundary.proxy, {}), /invalid_devnet_preflight_config/);
  assert.deepEqual(argvBoundary.reads, { getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 });

  const dependencyBoundary = makeReflectiveProxy({ rpc: fixture().rpc });
  await assert.rejects(runDevnetPreflight({}, dependencyBoundary.proxy), /invalid_devnet_preflight_config/);
  assert.deepEqual(dependencyBoundary.reads, { getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 });

  const rpcFixture = fixture();
  const rpcBoundary = makeReflectiveProxy(rpcFixture.rpc);
  await assert.rejects(runDevnetPreflight({}, { rpc: rpcBoundary.proxy }), /invalid_devnet_preflight_config/);
  assert.deepEqual(rpcBoundary.reads, { getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 });

  for (const makeRevoked of [
    () => { const item = Proxy.revocable({}, {}); item.revoke(); return item.proxy; },
    () => { const item = Proxy.revocable([], {}); item.revoke(); return item.proxy; },
  ]) {
    const revoked = makeRevoked();
    assert.throws(() => parsePreflightConfig(revoked), /invalid_devnet_preflight_config/);
    assert.throws(() => parsePreflightCli(revoked, {}), /invalid_devnet_preflight_config/);
    assert.throws(() => compilePreflightMemoMessage(revoked), /invalid_preflight_fee_message/);
  }

  const revokedDependencies = Proxy.revocable({ rpc: fixture().rpc }, {});
  revokedDependencies.revoke();
  await assert.rejects(runDevnetPreflight({}, revokedDependencies.proxy), /invalid_devnet_preflight_config/);

  const revokedRpc = Proxy.revocable(fixture().rpc, {});
  revokedRpc.revoke();
  await assert.rejects(runDevnetPreflight({}, { rpc: revokedRpc.proxy }), /invalid_devnet_preflight_config/);

  const revokedLatest = Proxy.revocable({ blockhash: BLOCKHASH, lastValidBlockHeight: 100 }, {});
  revokedLatest.revoke();
  const revokedLatestFixture = fixture();
  revokedLatestFixture.rpc.getLatestBlockhash = () => revokedLatest.proxy;
  const revokedLatestReport = await runDevnetPreflight({}, { rpc: revokedLatestFixture.rpc });
  assert.equal(revokedLatestReport.error, 'preflight_invalid_rpc_result');
});

test('nested getter values are rejected by primitive validation without recursive reads', async () => {
  const f = fixture();
  let configReads = 0;
  const nestedConfigValue = {};
  Object.defineProperty(nestedConfigValue, 'secret', { get() { configReads++; return 'PRIVATE_CONFIG'; } });
  await assert.rejects(runDevnetPreflight({ walletAddress: nestedConfigValue }, { rpc: f.rpc }),
    /invalid_devnet_preflight_config/);
  assert.equal(configReads, 0);
  assert.equal(f.requests.length, 0);

  let compilerReads = 0;
  const nestedCompilerValue = {};
  Object.defineProperty(nestedCompilerValue, 'secret', { get() { compilerReads++; return 'PRIVATE_COMPILER'; } });
  assert.throws(() => compilePreflightMemoMessage({
    feePayer: nestedCompilerValue, blockhash: BLOCKHASH, lastValidBlockHeight: 100,
  }), /invalid_preflight_fee_message/);
  assert.equal(compilerReads, 0);
});
