# Spike Manifest

## Idea

Prove the smallest security-critical DalaHold step before building the agricultural marketplace: one exact, expiring, one-use instruction must be authorized by a verified person, and certificate replacement must invalidate older permissions without changing that person's wallet binding.

## Requirements

- A certificate is an access credential, never the Solana private key or durable owner ID.
- No Kazakhstan NCA or corporate-authority claim is accepted without the official developer kit, suitable test certificates, and a verifiable authority source. These are currently unavailable.
- No real money, digital tenge, Solana signing, or devnet transfer occurs in this local spike.
- Replay, altered amount/recipient, expired instruction, revoked/unknown certificate, stale epoch, and signer bypass must fail in runnable tests.
- Keep the experiment dependency-free and independent of the existing UX-only `prototype/`.

## Spikes

| # | Name | Type | Validates | Verdict | Tags |
|---|------|------|-----------|---------|------|
| 001 | exact-order-policy | standard | Given a test-verified identity and canonical operation, when it is authorized, executed, replayed or rotated, then only the current one-use approval can pass | PARTIAL | identity, replay, rotation, policy |
