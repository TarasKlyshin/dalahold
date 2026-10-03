# Isolated DalaHold TEST Memo rail

Prepared internal library, default execution disabled. No CLI, HTTP route,
airdrop, runtime wallet key, funding, payment, escrow, mainnet or live broadcast
was added or exercised by this slice. Tests use synthetic policy/wallet keys,
synthetic authority assertions and fake RPC. These tests do not establish genuine
NCA authority, certificate renewal, two-party acceptance or a confirmed devnet
transaction. The existing transfer simulation/offline builder is independent.

## Trusted server contract

`test-memo-grant.mjs` exports `createTestMemoEnvelope(grant, policyPrivateKey,
{now})` and `openTestMemoEnvelope(envelope, policyPublicKey, {now,allowExpired})`.
The private policy key must be an Ed25519 Node KeyObject from trusted server
configuration. The public key is its raw 32-byte JWK `x`, encoded as canonical
base64url. Browser-provided keys, wallets, memos, programs or wire bytes must not
be accepted. The opener returns `{grant,grantHash,payload,sig}` internally;
`grantHash` is SHA-256 of the exact canonical payload bytes.

The envelope is a JSON string containing only `{payload,sig}`. Payload uses the
following exact field order, no whitespace or duplicate/extra fields:

```text
v, kind, grantId, actorId, bindingId, authEpoch, cluster, expiresAt,
intentHash, dealId, eventId, snapshotHash, walletAddress, programId, memo,
maxFeeLamports
```

`v=1`, `kind=test_memo`, `cluster=devnet`; all IDs are lowercase UUIDs,
`authEpoch` is a nonnegative safe integer, hashes are lowercase SHA-256 hex,
`now < expiresAt <= now + 300000`. Fee cap is a canonical decimal string from
`1` through `10000` lamports. Wallet is a 32-byte base58 address. Program is
`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` and memo is exactly
`DalaHold TEST v1 <snapshotHash> <eventId>`. Pure Ed25519 signs
`DALAHOLD-TEST-MEMO-V1\n` followed by canonical UTF-8 payload bytes. This prefix
is distinct from the existing transfer grant domain.

`new DevnetMemoSender({dbPath,policyPublicKey,walletAddress,keyProvider,rpc,
authorize,executeEnabled:false,now})` creates an independent private journal.
`dbPath` must be absolute and pass `web/private-test-store.mjs`: private 0700
leaf, owner-only 0600 file, no symlinks/hardlinks or automatic chmod of existing
files. The sender refuses unrelated databases before changing their journaling.
`keyProvider(grant)` supplies only a 32-byte ephemeral **Solana test-wallet**
private seed in trusted process memory. Do not derive it from an NCA key or store
wallet/policy private keys in the journal. Local copies are erased after use.

`authorize(grant,grantHash)` must be a synchronous trusted assertion that throws
unless the exact NCA TEST anchor receipt was accepted and its actor, current
personal binding, epoch, deal, event, intent and snapshot still agree. Only a
void return is allowed: booleans, promises and thenables refuse. The issuer must
implement this check against the actual server registries, never browser state.
It must not substitute fixture evidence or an SDK result without the accepted
receipt. Genuine certificate replacement/renewal and the complete genuine
anchor workflow remain release gates; keep `executeEnabled=false` until they
are independently demonstrated and execution is explicitly authorized.

`await sender.execute(envelope)` owns reservation, assembly, fee/balance checks,
the single send and reconciliation. It returns only:

```json
{"grantId":"...","signature":"<saved base58 signature>","status":"pending","historical":false,"sendAttempts":1}
```

`signature` is null until assembly is durably stored; an attempted row always
has a saved signature. No signed
payload/envelope, wire/message bytes, private key or RPC diagnostics are returned.
`sender.close()` refuses while work is in flight and releases the exclusive DB
lock afterwards. There is no resend/reset/re-sign API.

## Durable execution and history

The builder creates and cryptographically checks one version-0 transaction with
one writable signer/fee payer, the readonly Memo program, one exact Memo
instruction, no instruction accounts and no address lookup tables. Raw wire and
message bytes remain internal to the sender and its private journal. Derived
wallet must equal the signed grant and trusted sender configuration.

Reservation globally consumes grant ID/hash, intent hash and event ID. A build
marker with the fixed blockhash/lifetime is saved before requesting the key;
exact wire bytes/message/signature are saved before the send marker. Only one
build and one send marker are possible. SQLite uses DELETE/FULL, mmap disabled
and a lifetime EXCLUSIVE lock, excluding a second sender while RPC awaits run.
Concurrent exact calls join one execution. An interrupted reserved/building/
signed row is historical and cannot fetch a new blockhash, sign or send. A
pre-send refusal preserves any existing signed bytes and marks `cancelled`.

The sender checks the current assertion/expiry after every pre-send RPC and
crypto await, before assembly, before the durable send marker, then again after
the marker commit immediately before invoking RPC send. A refusal after the
marker preserves `pending` with its signature even if the RPC was never invoked;
this conservative ambiguity can only be reconciled by reads.

Live fee must be a finite nonnegative safe integer no greater than the signed
cap, and the wallet balance must cover it. Recent blockhash lifetime and the
fixed devnet genesis are checked before signing and again before send. There
is no actual SOL transfer instruction or priority fee.

Timeout, preflight/transport error, a null/processed status or unavailable/missing
transaction remains `pending`. `sendAttempts` counts durable markers, not proven
provider deliveries. `confirmed` requires confirmed/finalized signature status
and exact base64 version-0 transaction readback: identical wire/message/signature,
one exact Memo/payer, `meta.err=null`, fee within the signed cap, no inner
instructions or loaded accounts. A send acknowledgement or signature status
alone cannot confirm. `failed` requires an explicit transaction error at
confirmed/finalized commitment or from confirmed transaction readback. A
processed/null-commitment error remains pending and may later reconcile to
finalized success. Block height past the original lifetime only produces
`expired_pending`; it never causes re-signing or a replacement grant.

After the first marker, expiry/certificate rotation cannot revoke the existing
transaction cryptographically. Repeats/restarts only read that original
signature; they never obtain a key, blockhash or fee quote and never send again.
Read-only reconciliation may confirm the old attempt after rotation, even when
execution is disabled. A recorded confirmed/failed result is historical evidence
and can be returned without repeating network reads.

Stored canonical policy signatures, transaction signatures, exact row shape and
an HMAC catch malformed/partial/uncoordinated journal changes before new work.
A keyed seal over the ordered row IDs/MACs and count is updated atomically with
each insert/update and checked at startup and every row access. Deleting a
consumed transaction row refuses restart instead of enabling another execution.
The HMAC integrity key is stored in the private journal; this is not protection
against a malicious owner with access to that entire store, nor an intact
rollback of the entire database and its metadata. Do not edit status,
attempts or bytes manually. Stop execution if the journal is missing or lost and
restore its protected backup; starting another empty journal loses the replay
history and must never be used as an automatic recovery mechanism. Back up only
after draining work/closing the sender and preserve the private directory modes.

## RPC adapter and verification

`createDevnetRpc({url,fetchImpl,timeoutMs,maxResponseBytes})` accepts only
`https://api.devnet.solana.com`, HTTPS with redirects refused, no ambient browser
credentials, timeout from 1 through 15000 ms for headers/body, and measured reply
size at most 65536 bytes. JSON-RPC IDs, envelopes, context/value types, safe
integers, signature/base64 encodings and relevant transaction metadata are
checked. Send uses `skipPreflight:false`, `maxRetries:0`; getTransaction uses
confirmed commitment, base64 encoding and `maxSupportedTransactionVersion:0`.
Genesis must be exactly
`EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`; no alternative override is allowed.

Sources: [Memo program](https://www.solana-program.com/docs/memo),
[getLatestBlockhash](https://solana.com/docs/rpc/http/getlatestblockhash),
[signature statuses](https://solana.com/docs/rpc/http/getsignaturestatuses),
[transaction readback](https://solana.com/docs/rpc/http/gettransaction).

Run offline checks from the repository root (existing pinned `@solana/kit` 8.3.0
must already be installed under `signer/solana/`; no new dependency is needed):

```sh
node --test signer/test-memo-grant.test.mjs signer/devnet-memo-sender.test.mjs signer/solana/memo-builder.test.mjs signer/solana/devnet-rpc.test.mjs
```

All tests explicitly describe models, use temporary private journals and delete
only their own temporary roots. They cover signed tampering/domain separation,
wallet/program/memo/account/header limits, disabled/unknown/stale authority,
await rotation/expiry, post-marker fencing, fee/balance/genesis, timeout/null
status/restart, exact concurrent execution/no re-sign, network readback and
corrupt journals/deleted rows. No live mutating RPC is used.
