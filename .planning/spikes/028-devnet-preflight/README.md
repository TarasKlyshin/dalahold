---
spike: 028
name: devnet-preflight
type: standard
verdict: PARTIAL
related: [020, 021, 025]
tags: [solana, devnet, read-only, preflight, test-only]
---

# Spike 028 — bounded read-only devnet preflight

This slice checks only public Solana devnet network state. It does not enroll a
person, prove two-party authority, renew a certificate, create or custody a
wallet key, sign a message, fund an account, simulate or broadcast a
transaction, or claim a confirmed transaction.

## Contract

`signer/devnet-preflight.mjs` accepts only these public inputs:

- `walletAddress`: optional base58 public address. It is never a private key,
  key path, signer input or authority assertion.
- `maxFeeLamports`: optional positive integer from 1 through 10,000; the fixed
  default is 10,000.

The CLI accepts `--wallet` and `--max-fee-lamports`, or the matching
`DALAHOLD_DEVNET_PUBLIC_WALLET` and `DALAHOLD_DEVNET_MAX_FEE_LAMPORTS`
environment variables. It rejects unsupported, privileged, accessor-backed or
ambiguous configuration before the first network call. The endpoint is always
`https://api.devnet.solana.com`; redirects and arbitrary RPC URLs are not
accepted.

The bounded call sequence is at most five confirmed, read-only RPC methods:

1. `getGenesisHash`, which must equal the repository's pinned devnet hash
   `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`;
2. `getLatestBlockhash`;
3. when a public wallet is configured, `getBalance` and `getFeeForMessage`;
4. `getBlockHeight` last, after all balance/fee awaits, to reject an expired
   blockhash.

The fee request is the serialized message bytes for exactly one unsigned
version-0 Memo instruction using the fixed Memo program and fixed text
`DalaHold devnet preflight v1`. No arbitrary program, memo, instruction,
transaction, signature or wire transaction is accepted. A `null` or
over-cap fee quote is not ready. A wallet-less run reports wallet, balance and
fee as `NOT CONFIGURED`/`NOT CHECKED`; signer readiness remains
`NOT CONFIGURED`, and execution is always disabled.

Reports keep network readiness separate from the unaccepted authority,
renewal, UI, security and execution-authorization gates. Even a successful
network/fee read therefore remains `PARTIAL` with `overallReady:false` and
`executionEnabled:false`.

Failures expose fixed codes only (`wrong_devnet_genesis`,
`devnet_blockhash_expired`, `devnet_fee_unavailable`,
`devnet_fee_over_cap`, `devnet_insufficient_balance`,
`preflight_invalid_rpc_result` or `preflight_rpc_failed`). Untrusted RPC
errors, configuration values and private-looking inputs are never echoed.

## Offline verification

The model suite injects a pure in-process read-only RPC double; the CLI has no
test-double flag and no stateful/runtime dependency.

```sh
node --test signer/devnet-preflight.test.mjs
node --test signer/devnet-preflight.test.mjs signer/solana/devnet-rpc.test.mjs signer/solana/memo-builder.test.mjs
```

The focused cases cover the no-wallet partial result, fixed unsigned message,
read-call ordering, wrong genesis, null/over-cap fee, low balance, expired
blockhash, malformed/network errors, fixed-code sanitization, accessor and
privileged-field rejection, and the absence of signing/send methods in the
preflight call path.

## Boundary and next gate

This spike is a network-configuration observation only. A genuine two-party
TEST authorization, certificate renewal, browser/UI acceptance, security
review, stable wallet/key custody and execution authorization remain open.
No wallet is configured by default, and no funding or transaction attempt is
part of this spike.

The final [wallet-less live observation](LIVE_NO_WALLET.json) preserves one
time-bound safe report and exact implementation hashes. It is `PARTIAL`, not
current/persistent network readiness or execution permission. CLI exit 0 means
the bounded read-only check succeeded; exit 1 means a refused preflight and
exit 2 an invalid CLI/config. Callers must inspect the report, not treat exit 0
as authorization. Integrated tests and the genuine/browser limits are recorded
in the [026–028 verification](../026-reproducible-demo/VERIFICATION.md).

Primary RPC references:

- [getGenesisHash](https://solana.com/docs/rpc/http/getgenesishash)
- [getLatestBlockhash](https://solana.com/docs/rpc/http/getlatestblockhash)
- [getFeeForMessage](https://solana.com/docs/rpc/http/getfeeformessage)
- [getBalance](https://solana.com/docs/rpc/http/getbalance)
- [getBlockHeight](https://solana.com/docs/rpc/http/getblockheight)
