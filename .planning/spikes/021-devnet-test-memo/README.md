---
spike: 021
name: devnet-test-memo
type: standard
verdict: PARTIAL
related: [008, 017, 020]
tags: [solana, signer, devnet, memo, reconciliation, test-only]
---

# Spike 021 — bounded exact-authorized TEST Memo

Same source baseline and user authorization as Spike 020. The selected first
rail is a non-payment Memo over an anonymized snapshot/event hash, expressly
allowed by IMPLEMENTATION_PLAN.md. It neither reserves/releases demo-KZT nor
issues digital tenge. A Memo is an on-chain statement, not proof of its truth.

## Acceptance and send gates

- A distinct fresh TEST CMS authorizes the exact devnet wallet, Memo program,
  event/snapshot, purpose, deadline and maximum test-SOL fee.
- Trusted internal policy signs one canonical grant. No browser chooses a
  policy key, signing key, program, arbitrary memo/instruction or network.
- Independent signer defaults to execution disabled. No HTTP broadcast endpoint
  or wire-byte export; the old transfer simulation remains unchanged.
- Verify the live devnet genesis, actual fee/balance, current binding/epoch and
  exact persisted authorization before build and immediately before send.
- Persist the single signature/wire bytes/lifetime before the network attempt;
  never replace a blockhash/re-sign the same grant after uncertainty or restart.
- Timeout/null status stays pending. Confirm only after exact transaction
  readback, correct Memo/program/fee payer and successful metadata within cap.
- Rotation/expiry prevents new send attempts, not read-only reconciliation of
  an already attempted transaction. Never erase its signature/wire bytes.

## Evidence and limits

Primary references consulted on 3 October 2026:
[Memo](https://www.solana-program.com/docs/memo),
[getGenesisHash](https://solana.com/docs/rpc/http/getgenesishash),
[sendTransaction](https://solana.com/docs/rpc/http/sendtransaction),
[transaction structure](https://solana.com/docs/core/transactions).
Read-only `getGenesisHash` at `https://api.devnet.solana.com` returned
`EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` (HTTP 200). This is network
readiness evidence only: no wallet funding, signature, send or confirmed tx.

Before real execution, the genuine two-party TEST-signing/renewal and negative
authorization gates must be closed; an explicit stable TEST wallet and fee-only
devnet funding must be available. Do not substitute model SDK/RPC success.

## Results

Implemented internal canonical Ed25519 policy grants, one fixed Memo builder,
strict fixed-endpoint RPC adapter, private durable sender journal and protected
signed-cabinet policy issuer. Contract/recovery limitations are in
[DEVNET_MEMO.md](../../../signer/DEVNET_MEMO.md). Existing transfer simulation,
dependencies and packages were not changed.

Stable-code verification on 3 October 2026: 36 focused Memo model/offline tests,
52 including existing signer/Solana regressions, and 3 MODEL SDK→signed cabinet
anchor→private issuer→fake network/readback integration cases. These overlap
the final integrated 395 Node/model +20 offline Solana +5 SDK/Java gates, not
additional counts. Genuine personal enrollment is verified separately in 020;
it does not close genuine two-party anchor or renewal acceptance.

Independent review findings were reproduced failing-before and fixed: permission
can expire/rotate during durable send-marker commit; deleting an executed journal
row must not permit a second signature/send after restart; processed/null fork-local
errors must not become terminal failure. A keyed row-set/count seal is updated
atomically with each row, the post-marker fence refuses before RPC invocation,
and reconciliation can accept later finalized exact success using the same
signature. A validly signed writable-program/readonly-payer message is also
rejected. The bridge fixture now supplies expected signature to strict inspection.
Follow-up review found no unresolved issue in those specific fixes.

No sender was wired into the running HTTP stand, no runtime key/envelope was
provisioned, and no airdrop, funding or send was attempted. Default issuer
acceptance and sender execution flags are both false. Signed 4178 starts with
Memo disabled; setting its public fee-payer configuration would expose only an
exact anchor preview, not broadcast. Real read-only genesis observation is the
only live Solana network evidence. There is no genuine confirmed transaction.

Whole-store loss/rollback and a machine owner who holds the integrity key remain
outside the journal seal guarantee; never recover uncertainty by deleting the
journal or signing the same accepted event again. Runtime/certificate/renewal/
browser gates are still open. Verdict stays PARTIAL.
