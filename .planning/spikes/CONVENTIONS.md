# Spike Conventions

The first experiment does not establish a production stack or reusable application architecture.

## Explicit product choices

- The required signature flow is a desktop web cabinet using NCALayer, not a Telegram bot.
- NCA signatures and Solana keys have different owners and trust boundaries.
- Corporate authority and real money remain closed until independently verified.

## Experiment choices, not production commitments

- The local policy and draft experiments use Node 22 built-ins and no new dependencies to isolate their behavior; this is still not a production architecture decision.
- Local Ed25519 test keys are never represented as NCA certificates.
- Console test output is appropriate for this binary security property; user-facing transaction UX remains in the separate `prototype/` folder.
- SDK and NCALayer experiments use only public test CA/status assets on the
  server. CRL signature and expiry alone are insufficient: base/delta numbers
  and scope must agree. `.local/` is ignored; downloaded SDK/private keys are
  never copied into Git. A failed status fixture blocks test receipt issuance.
- Strict TEST OCSP is an explicit separate mode, never an automatic fallback
  after a CRL failure. Source is bound into the exact instruction and receipt;
  the ready page covers local CA trust only. Good status requires trusted
  responder/signature, exact CertID/nonce and fresh time at verification/commit.
  HTTP transport never grants trust on its own. Unknown/unavailable refuses.
