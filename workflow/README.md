# Offline deal workflow

`DealFlow` is a **local technical fixture**, not an HTTP endpoint or a production
deal database. A trusted test setup imports immutable deal terms into SQLite;
the workflow derives a short-lived challenge from those stored terms and the
verified owner binding. The client can sign the returned exact bytes but cannot
choose a different recipient, amount, wallet, authority epoch or terms hash at
submission time. A second challenge for the same deal cannot issue a second
grant. The signer still produces only a `sim_*` transaction ID.

The KZT number is a document field. The capped SOL amount is a separate devnet
test-transfer field; **it is not digital tenge, escrow or settlement**. Until
official NCA SDK integration exists, `verifySigned` and `verifyPowers` are
injected test doubles. Do not import a personal certificate, key or password.

Run from the repository root: `node --test workflow/*.test.mjs`.
