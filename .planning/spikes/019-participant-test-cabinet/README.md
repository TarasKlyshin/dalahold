---
spike: 019
name: participant-test-cabinet
type: standard
validates: "Given distinct local TEST participants, when invitations, documents and exact-version statements are submitted, then server-scoped roles and private access persist and unauthorized/stale/replayed transitions refuse"
verdict: PARTIAL
related: [007, 009, 018]
tags: [web, participants, authorization, documents, workflow, test-only]
---

# Spike 019 — private two-party TEST cabinet

Baseline: clean `752878fa472fb5341e7f05ad592d7d70eac2dabc`.
User authorized continuing the available local development on 3 October 2026.
No external publication, push/deploy, SDK key use, retained personal registry,
real identity/authority, payments or devnet broadcast is part of this slice.

## What this validates

A locally issued high-entropy TEST access code identifies a durable pseudonymous
participant, not a verified person. Role is scoped to a deal, never taken from a
request for an existing deal. One account can be a buyer and a seller in different
deals. A creator invites a particular already registered participant; invitation
tokens expire and cannot be claimed by an outsider or the creator.

Members see only their own deals and bounded anonymized UTF-8 text documents.
Seller offer, buyer agreement, seller handover and buyer acceptance or either
party's dispute are explicitly **unsigned TEST participant statements**. They
are not NCA signatures, physical delivery proof, money movement or bank records.
After an offer the exact terms and complete file manifest are frozen. A distinct
proposal requires a new deal; this slice does not implement amendments.

## Implementation and acceptance plan

1. Store: private separate SQLite; participant capability hashes, recipient-bound
   invitations, deal memberships, bounded documents and transactional events.
2. HTTP: new isolated loopback listener, server sessions/CSRF, strict Host/Origin
   and Fetch-Metadata, input/body/rate caps. No anonymous legacy draft routes.
3. UI: register/login/logout, deal creation, target invitation, documents, exact
   snapshot confirmation, role-specific statements, journal and safe JSON export.
4. Verify outsider reads/writes/downloads, role injection, token theft/self-claim,
   stale version/manifest, action order, duplicate/conflicting retry, terminal
   dispute, expiry/logout and restart. Actual browser interaction is required.

## Research and reuse

No external API or library is added; the security boundary is local application
logic. Reuse `TestDocuments`, canonical terms fingerprints and private-file
checks from 018. The existing offline ledger requires simulated reserve/release
and is deliberately not exposed as a browser permission service.

Extending only the anonymous 018 handler would leave `/api/deals` open in its
host server. A distinct listener with an explicit route allowlist avoids that
bypass without changing any existing operator stand. GSD spike gates structure
the experiment; API Design guides contracts; Browser QA requires real UI checks.
Ponytail keeps Node/SQLite/native HTML and existing storage rather than adding a
framework, custody layer or speculative integrations.

## Limits and stop conditions

Access codes are bearer credentials, not identity evidence; keep them private.
Invitation recipient IDs are local pseudonyms, not certificate identities.
Local HTTP and owner-only files do not provide production encrypted custody,
multi-tenant assurance, external rollback protection or legal authority.
Only TEST/anonymized text is allowed; no real documents, IIN/BIN or keys.
Old stand 018 and the personal certificate registry remain independent.
Genuine second-certificate renewal and two real NCA signers remain open gates.

Any private-data bypass, wrong-role/changed-snapshot transition, duplicate event
or misleading signature/payment label blocks acceptance of this slice.

## How to run

Run `node web/participant-server.mjs` and open
`http://127.0.0.1:4177/participants/`. The protected database is
`.local/participant-test-cabinet/participants.sqlite`, ignored by Git. The
separate signed stand in Spike 020 never reuses this database.

## Investigation trail

- Read-only architecture check identified unguarded legacy draft routes in 018.
  Chose separate listener rather than patching only its document endpoints.
- Bound invitations to a specified registered participant ID so a stolen token
  cannot silently become the counterparty.

## Results

Implemented: separate store/HTTP/cabinet, private participant membership and
documents, recipient-bound invitation, frozen exact-version statement workflow,
actor-bound retries, journal and whitelisted JSON export. Registration cannot
recover a lost one-time access code; invitation reissue rotates its old token.

Automated verification on 3 October: the focused unsigned cabinet suite passed
**51/51** (19 store, 9 HTTP, 3 security regressions, 20 client). The preceding
full regression run had 329 Node and 7 offline Solana passes. Final integrated
019–021 verification on stable code passed 395 Node/model, 20 offline Solana and
5 SDK/Java gates; the 2 opt-in skips in the first general run were subsequently
executed successfully with the SDK. None of these are real-browser UAT.

Escaped/review regressions covered a one-time code cleared by no-deal timer
renders, session expiry reached inside a mutation, invitation expiry reached
inside redemption/final outer commit, and a journal attributing seller offer to
buyer. A delayed model submit correctly shows draft while pending and offered
after its successful response; no actual statement-submit defect was reproduced.
The permanent invitation clear button now differs from reveal/hide toggle.
The signed-mode shared client added a failing-before `POST409 → refreshGET401`
regression: its expired session now clears retained deal, keys and signing state.

Runtime readback after disk reconnection: SQLite integrity `ok`, 6 TEST accounts,
2 draft deals, 0 events, 1 document/182 bytes; DB mode600 and directory700. No
payment, NCA business permission or Solana write took place. `/Volumes/dev` is
the canonical checkout; no backup fallback or remapping occurred.

Prior actual browser observation: registration/code lifetime, draft creation,
one anonymized text upload, logout/login, recipient invitation, outsider refusal
and correct buyer role. The final offer click had no independently observed
completion; runtime now confirms 0 events. Browser service then explicitly
denied permission for4177, so no alternative browser/headless/port workaround
was used. Desktop/mobile screenshots, complete accept/dispute/export/download
journeys and human UAT remain open. This PARTIAL verdict is not UI acceptance.
