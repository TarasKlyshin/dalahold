---
spike: 001
name: exact-order-policy
type: standard
validates: "Given a test-verified identity and canonical operation, when it is authorized, executed, replayed or rotated, then only the current one-use approval can pass"
verdict: PARTIAL
related: []
tags: [identity, replay, rotation, policy]
---

# Spike 001: Exact order policy

## What This Validates

The in-process authorization policy binds exact bytes, a stable owner, a replaceable certificate, a one-use nonce, an authorization epoch, and a single simulated transfer instruction. It does **not** validate Kazakhstan NCA signatures or send Solana transactions.

## Research

| Approach | Benefit | Cost / limit | Decision |
|---|---|---|---|
| Node 22 `node:crypto` + `node:test` | Already available; real local Ed25519 signatures and runnable checks | Test keys are not NCA certificates; memory state is not durable | Chosen for policy experiment |
| Official NCA developer kit + NCALayer | Required for the actual EDS proof | Kit and two matching test certificates are not yet available | Next integration gate |
| UI-only button or mocked success response | Quick visual demo | Cannot prove signature, replay or rotation behavior | Rejected as technical evidence |

Checked 2026-09-26: [NCA developer requirements](https://pki.gov.kz/ru/developers/), [official NCALayer example](https://github.com/pkigovkz/NCALayerJSExample), [Node 22 crypto](https://nodejs.org/docs/latest-v22.x/api/crypto.html), [Solana transaction model](https://solana.com/docs/core/transactions). These docs describe interfaces; local behavior still needs tests.

## How to Run

`node --test .planning/spikes/001-order-policy/policy.test.mjs`

## What to Expect

One simulated operation succeeds. Replay, tampering, stale epoch, revoked or unknown certificate, and direct execution without approval fail. A new test certificate for the same owner keeps the same stored wallet address.

## Investigation Trail

- 2026-09-26: selected an in-memory policy experiment because the official NCA kit is missing. The result cannot count as EDS or devnet acceptance.
- 2026-09-26: six Node tests passed. A rotation test initially revoked the old test certificate, which did not isolate the platform's certificate-unlink rule; it was strengthened to make the old certificate valid again and verify rejection by the new epoch/binding alone.

## Results

**PARTIAL:** `node --test .planning/spikes/001-order-policy/policy.test.mjs` passed 6/6 on Node 22.22.2. Exact signed bytes and exact simulated instruction are checked; one nonce receives one approval even for two concurrent calls in this single process; a new test key for the same subject keeps the stored wallet address and invalidates an old approval. The old certificate is rejected even when the test CA still reports it valid.

This is intentionally not a working EDS-to-Solana prototype. The test verifier uses ephemeral Ed25519 keys, not NCA CMS, trust chain, OCSP/CRL or real corporate powers. `seedPerson` is a fixture, not authenticated wallet creation. Nonces, wallet bindings and approvals are in memory, so crash/restart and multi-instance idempotency remain unproven. `execute` is a simulated restricted operation, not an isolated signer or a devnet transaction. The next build gate is a durable store and official NCA-backed verifier; until then no wallet or payment claim is allowed.
