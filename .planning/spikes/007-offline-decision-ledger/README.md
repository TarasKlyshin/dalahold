---
spike: 007
name: offline-decision-ledger
type: standard
validates: "Given trusted test actors and one exact deal version, when decisions advance, retry, conflict or restart, then only ordered role-correct events persist once and disputes block demo release"
verdict: VALIDATED
related: [001, 003, 004, 006]
tags: [workflow, sqlite, roles, dispute, idempotency]
---

# Spike 007: Offline decision policy and ledger

## What This Validates

An ordered, version-bound **offline** deal decision sequence and durable
idempotency. It does **not** validate NCA identity, corporate authority,
payment, escrow or a browser workflow.

## How to Run

From repository root:

`node --test workflow/decision-policy.test.mjs workflow/decision-ledger.test.mjs`

Full regression:

`node --test .planning/spikes/001-order-policy/policy.test.mjs authority/*.test.mjs workflow/*.test.mjs signer/signer.test.mjs web/*.test.mjs && npm test --prefix signer/solana`

## What to Expect

Seller offer → buyer accepts exact terms → buyer marks a demo reserve → seller
claims handover → buyer accepts delivery or opens a dispute. Only accepted
delivery permits buyer's demo release, then each role may leave one rating
marker. Dispute is terminal. Exact retries return the same result after restart;
altered, stale, role-wrong or cross-deal decisions are rejected.

## Investigation Trail

- The existing web draft API has no verified actor or private file store. This
  spike therefore remains a library-only state machine rather than adding an
  HTTP route that would make a browser role switch look authoritative.
- The first implementation bound decisions to terms but omitted the deal ID.
  Review found that the same decision shape could be applied to another deal
  with the same terms; `dealId` became a mandatory validated decision field.
- Independent Claude Opus 5.5 read-only review found a second-read risk: a
  hostile `Proxy` could return a different decision ID to the SQLite index than
  the ID normalized by the policy. The ledger now indexes the policy's
  validated copy, and a regression test uses a changing `Proxy` value.

## Results

**VALIDATED for the offline fixture boundary only.** Ten focused tests pass:
ordered path, both rating markers, dispute stop, wrong actor/order, stale or
altered terms, replay conflict, cross-deal ID isolation, restart persistence,
and the changing-property regression. The full local suite passes 60/60 on
Node 22, including the seven offline Solana assembly checks.

`workflow/decision-policy.mjs` reconstructs state from every stored event
before advancing it. `workflow/decision-ledger.mjs` uses SQLite `BEGIN
IMMEDIATE`, a globally unique decision-ID index and one transaction for index
and state writes. No new dependency was added.

`reserve_demo` and `release_demo` are **status labels only**. A future
integration must fetch terms from server-owned storage and bind every decision
to exact server-issued bytes, verified NCA signature, current certificate
status, and (for organizations) current powers. Actual reserve/release requires
its own payment-rail proof and legal/security gate.
