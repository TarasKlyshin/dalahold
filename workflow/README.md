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
an actual NCA SDK adapter is connected, `verifySigned` and `verifyPowers` are
injected test doubles. Do not import a personal certificate, key or password.

`decision-policy.mjs` is a second, deliberately separate offline slice of the
planned deal lifecycle. It binds a deal to one terms version and fingerprint,
derives seller/buyer role from a trusted fixture `actorId`, and permits the
ordered path offer → accept terms → demo reserve → handover → delivery accept
or dispute → demo release → one demo rating per side. A dispute is terminal.
`reserve_demo` and `release_demo` change **only local test state**, not a bank,
Solana account or escrow. `decision-ledger.mjs` persists that test state in
SQLite and makes decision IDs unique across deals and durable across restart.
Neither module is exposed by `web/server.mjs`; the browser's role switcher is
not identity or authorization. The offline ledger does not fetch or verify the
fingerprint against the web draft database; a trusted fixture supplies it.
Integrating them into a real deal requires server-side terms lookup, verified
signatures, corporate powers and private evidence storage first.

`signed-decision-fixture.mjs` now proves the **offline handoff** from that local
web draft database to the decision ledger. A trusted setup binds distinct
test actor IDs to the server-read current draft version and fingerprint. The
fixture persists a short-lived challenge with exact UTF-8 bytes, passes those
bytes to injected test signature and powers verifiers, and only then applies
the matching decision. Before the first offer, a draft revision invalidates
pending challenges; a trusted fixture may refresh the bound unsigned version.
After offer, the ledger's version is frozen, so editing the separate draft
cannot block the buyer's acceptance or dispute. A new expired challenge,
wrong actor, revoked test credential or failed powers check leaves the deal
unchanged. A retry of an **already committed** decision returns its historical
receipt only for the same signature and certificate, even after expiry or
revocation; it does not re-execute the decision.
The verified receipt, decision ID and state transition now commit in one
transaction in the decision database. Injected write failures leave all three
unchanged, and concurrent retries create one event. The submitted signature is
copied before asynchronous verification, so later caller changes cannot alter
the receipt hash. A delayed retry of an already committed decision returns its
historical receipt even if the certificate or challenge has since expired.
The ledger now also stores the exact normalized terms snapshot and checks its
fingerprint on read. New challenges require that snapshot; a trusted pre-offer
refresh replaces it, while an offered snapshot remains fixed. If the draft and
decision tables are in one SQLite file, the ledger compares the current draft
inside its decision transaction. With separate files this cross-database race
is still open. The ledger also checks challenge bytes and expiry inside the
transaction after asynchronous test verification.
It also compares the persisted canonical challenge bytes against the exact
decision being applied inside that transaction; a receipt hash for one action
cannot authorize a different actor or action.

`demoEvidence(dealId)` is an internal, read-only **test record**: it combines
the bound terms, ordered test-key receipt digests, and unsigned document-marker
metadata from that same terms version. It rejects missing receipts or a
changed archived version. It does not contain files or a verifiable signature,
and it is not exposed to the browser. The markers' claimed roles and notes are
not authenticated.
The browser cannot call it: there is no decision HTTP route. The callback is
not an NCA adapter. Shared-file local atomicity is not a production authorization
design; separate files do not form one transaction. Do not use real certificates
or identify this as a signed deal.

Run from the repository root: `node --test workflow/*.test.mjs`.
