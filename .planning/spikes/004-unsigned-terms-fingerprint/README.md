---
spike: 004
name: unsigned-terms-fingerprint
type: standard
validates: "Given a local unsigned deal version, when its identity, version or terms change, then its canonical SHA-256 fingerprint changes and the browser labels it as non-signature evidence"
verdict: VALIDATED
related: [002, 003]
tags: [web, hash, canonical, version]
---

# Spike 004: Unsigned terms fingerprint

`web/terms.mjs` defines schema-prefixed canonical bytes with a fixed six-field
order and computes SHA-256. Claude Code Opus 5.5 at max effort authored this
isolated module and its tests; the main agent reviewed and integrated it into
the loopback API and browser. Each saved version and stale-write response gets
its own fingerprint. Nothing is broadcast to Solana.

## Evidence

- `node --test web/terms.test.mjs web/server.test.mjs`: fixed bytes, input key
  order, all six bindings, malformed fields, API revisions, restart and stale
  writes pass.
- Full local suite: 43/43 tests pass, including the offline signer tests.
- Browser: switching between two saved deals displays distinct fingerprints;
  the full hash wraps within the card at desktop and 390×844 widths.

## Boundary

The fingerprint is **not** an NCA electronic signature, authorization,
agreement, private storage proof, tamper-evident ledger, delivery proof, or
Solana transaction. It is recomputed from the local database on every read;
an operator who changes the database can change the resulting fingerprint.
