# DalaHold

Evidence-led agricultural deals in Kazakhstan, with transaction-specific e-signature approval and a Solana devnet settlement demonstration.

> Status: discovery and architecture planning. No application, live escrow, digital-tenge integration, or production payment service has been built yet.

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
