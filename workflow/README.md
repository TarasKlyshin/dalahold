# Offline deal workflow

`DealFlow` is a **local technical fixture**, not an HTTP endpoint or a production
deal database. A trusted test setup imports immutable deal terms into SQLite;
the workflow derives a short-lived challenge from those stored terms and the
verified owner binding. The client can sign the returned exact bytes but cannot
choose a different recipient, amount, wallet, authority epoch or terms hash at
submission time. A second challenge for the same deal cannot issue a second
grant.

`submitTransfer` keeps the original `sim_*` send simulation. The separate
`submitOfflineAssembly` route is a library method only: a trusted runtime
callback supplies an ephemeral Solana key and blockhash, and the signer stores
one actual signed wire transaction. The method returns only an
`assembled_offline` status and signature, **never the wire bytes**, and does not
broadcast. A grant used by one path cannot be reused by the other. The mocked
certificate and powers verifier must be replaced before any real user flow.

The KZT number is a document field. The capped SOL amount is a separate devnet
test-transfer field; **it is not digital tenge, escrow or settlement**. Until
official NCA SDK integration exists, `verifySigned` and `verifyPowers` are
injected test doubles. Do not import a personal certificate, key or password.

Run from the repository root: `node --test workflow/*.test.mjs`.
