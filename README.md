# DalaHold

Evidence-led agricultural deals in Kazakhstan, with transaction-specific e-signature approval and a Solana devnet settlement demonstration.

> Status: discovery, architecture planning, a clickable UX prototype, and a loopback-only API that saves versioned unsigned local deal drafts, their fingerprints and metadata-only document markers. A separate offline test policy and SQLite ledger model deal decisions with a frozen terms snapshot and internal demo record; they are not connected to the browser or a real identity provider. A separate local NCALayer/API/Java test-signature stand is implemented, but status acceptance is blocked by incompatible official test base/delta CRLs. SDK exact-byte cryptography and the browser's NCALayer TLS connection are tested; NCALayer signature output and a verified end-to-end receipt are not. The selected file's bytes and name are not uploaded automatically; user-entered descriptions do persist. Neither a fingerprint, marker nor local test receipt proves an NCA signature or file authenticity. No verified user e-signature flow, live escrow, digital-tenge integration, or production payment service has been built yet.

## The problem

Farmers and buyers can agree on terms across messages and documents, then disagree about what was accepted, delivered, or paid. DalaHold is exploring a shared, versioned deal record that makes each party's statements and supporting evidence visible without presenting a photo or an on-chain record as proof of physical delivery.

## Proposed MVP

- One participant account can act as buyer or seller in different deals.
- Both sides review and sign the same version of terms with Kazakhstan NCA e-signatures.
- The deal records delivery claims, acceptance or dispute, payment-rail status, and separate role-based ratings.
- For the hackathon, the signed flow runs in a desktop browser with NCALayer. A separate, restricted Solana signer can execute an approved operation on devnet; the user certificate is not a Solana private key.
- Wallet ownership is tied to a verified person or organization, not a certificate serial number, so a verified certificate renewal should preserve the devnet address and revoke old permissions.
- Cash/bank payments are participant-reported. Demo KZT is simulated. Solana devnet tokens have no monetary value. Real digital tenge and government integrations are outside this MVP.

The first planned vertical is a livestock deal. The grain/oilseed alternative remains a research track until a buyer and farmer validate its specific workflow.

## Current materials

- [Project brief](PROJECT_BRIEF.md) — problem hypothesis, intended flow, clear limits, and next validation test.
- [Implementation plan](IMPLEMENTATION_PLAN.md) — 20-day build sequence and acceptance gates.
- [Technical prototype](TECHNICAL_PROTOTYPE.md) — exact EDS-to-Solana trust boundary, certificate rotation and mandatory negative tests; specification only, not a working integration.
- [NCA adapter contract](NCA_ADAPTER_CONTRACT.md) — fail-closed verification interface and receipt checklist; no user signing integration yet.
- [Local NCA test-signature stand](nca/README.md) — session-bound exact-byte CMS, one-use test receipt and SDK checks using bundled test material; incompatible CRLs block acceptance, no personal certificate or payment.
- [Spike 011](.planning/spikes/011-ncalayer-roundtrip/README.md) — implemented browser/API stand, observed checks, corrected CRL-pair gate and open NCALayer acceptance.
- [Offline deal workflow](workflow/README.md) — test-key transfer fixture, persistent decision policy, frozen terms and a local signed-byte bridge with an internal demo record; not a browser API, NCA integration or real payment.
- [Spike 009](.planning/spikes/009-immutable-terms-evidence/README.md) — local snapshot, same-file freshness and honestly labelled metadata/receipt record; offline only.
- [Clickable prototype and local unsigned-draft API](prototype/README.md) — run it locally and test both deal paths; draft terms and metadata-only markers persist, but files do not.
- [Master plan](MASTERPLAN.md) — scope, architecture, 20-day schedule, risks, and acceptance criteria.
- [Livestock interviews](INTERVIEW_CARDS_AGRI.md) — discussion cards for farmers and buyers.
- [Crop interviews](INTERVIEW_CARDS_CROPS.md) — discussion cards for growers, buyers, and grain-market participants.
- [Crop transaction research](CROP_TRANSACTIONS_RESEARCH.md) — source-bounded research and product implications.

## Demo and submission evidence

The [Superteam pitch-deck template](https://docs.google.com/presentation/d/1V9yq8B1nLpF8vPTL2buT_nlmsMwNJ_fRuyADs_k49Sg/edit) asks builders to show a clear problem, differentiation, a working product demo, real demand evidence, use cases, the team, and a roadmap. It is a presentation template, not a GitHub repository specification. The following are **not yet completed**:

- [ ] Reproducible signed two-party deal on clean test accounts.
- [ ] Verifiable Solana devnet transaction and a documented negative test for bypassing e-signature approval.
- [ ] Certificate-rebinding demo that retains the wallet address and rejects old authorization.
- [ ] Product screenshots/video from the running app.
- [ ] Interview findings and demand evidence approved for public sharing.
- [ ] Pitch deck with verified claims, team details, and next milestones.

No private keys, e-signature containers, passwords, personal data, or real transaction records belong in this repository.
