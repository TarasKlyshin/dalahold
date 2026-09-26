# Spike Conventions

The first experiment does not establish a production stack or reusable application architecture.

## Explicit product choices

- The required signature flow is a desktop web cabinet using NCALayer, not a Telegram bot.
- NCA signatures and Solana keys have different owners and trust boundaries.
- Corporate authority and real money remain closed until independently verified.

## Experiment choices, not production commitments

- Spike 001 uses Node 22 built-ins and no dependencies to isolate policy behavior.
- Local Ed25519 test keys are never represented as NCA certificates.
- Console test output is appropriate for this binary security property; user-facing transaction UX remains in the separate `prototype/` folder.
