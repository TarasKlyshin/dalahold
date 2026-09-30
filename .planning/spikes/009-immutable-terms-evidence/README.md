---
spike: 009
name: immutable-terms-evidence
type: standard
validates: "Given a saved unsigned draft and trusted test actors, when terms change, a challenge commits or a demo record is read, then exact bound terms and receipt provenance remain consistent or fail closed"
verdict: VALIDATED (offline only)
related: [003, 004, 006, 007, 008]
tags: [workflow, sqlite, snapshot, evidence, race, test-keys]
---

# Spike 009: Immutable local terms and honest demo record

## Boundary

This is an internal **offline fixture**, not a signed user-facing deal. It uses
injected Ed25519 test-key and powers callbacks. It has no public API, NCALayer,
NCA certificate/status or corporate-authority verification, private document
bytes, payment, or Solana broadcast.

## Result

- The decision row now stores the full normalized terms snapshot alongside the
  state. The stored terms are re-fingerprinted on read. A trusted refresh can
  replace them only before offer; after offer, later web-draft edits leave the
  offered snapshot unchanged. Legacy rows gain a nullable column without
  deletion; a missing snapshot cannot authorize a new challenge.
- When the draft and decision tables use **the same SQLite file**, the final
  pre-offer version/fingerprint check runs inside the ledger's `BEGIN IMMEDIATE`
  transaction. Separate-file mode remains supported as an offline fixture but
  does **not** provide that atomic draft-to-decision boundary.
- The internal `demoEvidence(dealId)` returns the bound terms, ordered local
  test receipts and unsigned document-marker metadata for only that terms
  version. It rejects missing receipts or changed archived terms. It omits
  certificate IDs and file bytes. Signature hashes are digest-only records,
  not independently verifiable signatures or legal evidence.
- Challenge hash, stored expiry and the clock are checked again inside the
  decision transaction. A changed challenge or one that expires before commit
  leaves both receipt and decision unapplied. Historical committed retries
  remain receipts rather than new actions.

## Verification

Run `node --test workflow/decision-ledger.test.mjs workflow/signed-decision-fixture.test.mjs`.
The new regression tests cover snapshot persistence, refresh/freeze, corruption,
legacy-column migration, shared-file freshness, version-filtered markers,
receipt bypass, commit-time expiry and challenge-byte mutation. The complete
local suite passes 79/79 (72 Node tests plus seven offline Solana assembly
tests) on Node 22.

## Still required before a real deal

Official NCA SDK/test certificates, exact CMS/NCALayer bytes, real certificate
status and corporate powers, authenticated participants, private file access,
and a reviewed production transaction/authorization boundary. No devnet or
money claim follows from this spike.
