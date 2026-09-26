# DalaHold build context

## Scope

Desktop-first agricultural transaction web cabinet for Kazakhstan. The first
technical proof is a persistent Solana wallet controlled by verified NCA EDS
authorization, one exact operation, and access after certificate replacement.
Devnet lamports are a test rail; KZT and escrow are not yet implemented.

## Current stack and trust boundaries

- Node 22, ESM and built-in SQLite for the local authority and offline signer.
- `authority/`: opaque owner ID, certificate binding, epoch, durable nonce and
  one-time grant issuance. The injected Ed25519 verifier is a **test double**,
  not an NCA verifier.
- `signer/`: loopback grant boundary and durable replay state. Current send is
  simulated, not a Solana transaction.
- `prototype/`: pre-existing UX-only browser prototype, not a working backend.
- No real NCA SDK/test certificates yet; owner has requested the SDK. No real
  certificate container, private key, password or IIN/BIN belongs in the repo.

## Build status

| Milestone | Status | Acceptance |
|---|---|---|
| 1. Exact order and one-time authority | complete, offline only | Local tests pass for replay, tampering, rotation, signer bypass and restart |
| 2. Actual Solana transaction assembly | in progress | Offline exact System Program transfer signed by a separate ephemeral test key; no broadcast |
| 3. Web/API deal workflow | offline challenge fixture implemented; API/UI pending | Persisted deal terms and canonical challenge, then private document slots and visible mock-vs-verified states; browser interaction tests |
| 4. NCA verifier and NCALayer | blocked on requested SDK | Real test certificate, status and powers verification; negative tests |
| 5. Devnet acceptance | pending | Confirmed exact test transfer and all required negative cases; no real KZT |

`mvp_complete: false`  
`tests_passing: true` (18 offline unit/integration tests, including workflow, as of 2026-09-26)  
`devnet_deployed: false`  
`program_id: null` (no custom on-chain program in this slice)

The master plan and acceptance criteria remain in `IMPLEMENTATION_PLAN.md` and
`TECHNICAL_PROTOTYPE.md`; this file does not supersede them.
