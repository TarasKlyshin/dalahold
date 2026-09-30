---
spike: 008
name: signed-decision-handoff
type: standard
validates: "Given a saved unsigned local draft and trusted test actors, when one exact challenge is signed, retried, expired or invalidated by a revision, then only a verified matching decision advances the offline ledger"
verdict: VALIDATED
related: [001, 003, 004, 007]
tags: [workflow, sqlite, signed-bytes, test-keys, stale-terms]
---

# Spike 008: Signed test-decision handoff

## What This Validates

The **offline** handoff between saved web draft terms and the persistent deal
decision ledger. It does not verify NCA certificates, authentic web users,
corporate powers, bank payments or devnet execution.

## How to Run

`node --test workflow/signed-decision-fixture.test.mjs`

Full regression: `node --test .planning/spikes/001-order-policy/policy.test.mjs authority/*.test.mjs workflow/*.test.mjs signer/signer.test.mjs web/*.test.mjs && npm test --prefix signer/solana`

## What to Expect

A locally saved draft provides the deal ID, current version and canonical
fingerprint. A trusted test setup binds seller/buyer IDs. The fixture issues
server-stored, expiring bytes for one action. A local Ed25519 test callback
verifies a signature over those exact bytes and returns the actor; an
independent test callback checks powers. Only then does the ledger advance.
An exact retry is idempotent. Extra response fields, signature mismatch,
wrong actor, revoked status, missing powers, expiry, a newer draft version
**before offer** and a competing challenge all fail without another event.
Before offer, the trusted fixture may refresh the bound unsigned version and
must issue a new challenge. After offer, that exact version is frozen in the
ledger, so later draft edits cannot block acceptance or dispute. A dispute
blocks demo release. No new HTTP route was added.

## Investigation Trail

- Reused the existing `web/terms.mjs` fingerprint and `DecisionLedger`; no
  package or on-chain program was added. The draft database is opened read-only.
- A challenge is persisted before signing so restart does not change its
  bytes. Decision-ID uniqueness in the ledger handles retries without a second
  "consumed" flag.
- The verifier's actor ID is read once before role and powers checks, avoiding
  a mismatch from an unstable in-process object. Tests also move time and
  revise the draft during asynchronous verification to exercise the final
  rechecks.
- Claude Opus 5.5 read-only review found two lifecycle gaps: checking the live
  draft after offer could block a buyer's dispute, and a committed challenge
  retry could fail after expiry or revocation. The bridge now freezes terms at
  offer. A
  historical retry requires the same signature/certificate and never adds
  another event.
- A later failure-injection test exposed a partial-write window between the
  receipt and ledger update. They now commit in one transaction in the decision
  database. Tests inject failure at both update points and race two identical
  submissions; only one event can persist.
- A Claude read-only review exposed caller-owned signature-buffer mutation and
  a late concurrent retry that could be rejected after another call committed.
  The fixture now copies the signature before awaiting, hashes that copy, and
  rechecks for a committed decision after asynchronous verification and powers
  checks. Receipt fields are captured once; automatic SQLite rollback preserves
  the original failure. Regression tests cover all four cases.

## Results

**VALIDATED only as an offline test-key proof.** Eleven focused tests passed
at this spike's completion. The then-current full local suite passed 72/72
(65 Node tests plus seven offline Solana assembly tests) on Node 22. See
[Spike 009](../009-immutable-terms-evidence/README.md) for later work and
counts. The browser demo still has no verified participant identity and
cannot invoke this fixture.

There is no atomic transaction across the separate web-draft and decision
databases. The final pre-offer draft recheck closes the ordinary async race,
but this design is not a production freeze/commit protocol under concurrent
external database writers. Before real signing, the immutable terms snapshot, identity
verification, nonce consumption and decision write must share a designed
transaction boundary or equivalent version lock. Spike 009 adds a local full
snapshot and same-file draft check, not a production authorization boundary.
