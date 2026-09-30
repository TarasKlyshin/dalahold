# DalaHold build context

## Scope

Desktop-first agricultural transaction web cabinet for Kazakhstan. The first
technical proof is a persistent Solana wallet controlled by verified NCA EDS
authorization, one exact operation, and access after certificate replacement.
Devnet lamports are a test rail; KZT and escrow are not yet implemented.

## Current stack and trust boundaries

- Node 22, ESM and built-in SQLite for the local authority and offline signer.
- `authority/`: opaque owner ID, certificate binding, epoch, durable nonce and
  one-time grant issuance. The injected Ed25519 verifier is a **test double**,
  not an NCA verifier.
- `signer/`: loopback grant boundary and durable replay state. The HTTP send is
  simulated. An internal-only method now reserves a grant and uses
  `signer/solana/` to assemble signed transaction bytes from an ephemeral test
  key. It does not broadcast or report a network submission.
- `prototype/` + `web/`: browser demo and loopback-only API. The API saves
  versioned unsigned draft terms in a separate SQLite database with stale-write
  rejection and returns a canonical SHA-256 fingerprint for each version. It also
  saves metadata-only document markers bound to an exact draft version, with
  stale-write rejection and request-id idempotency. The selected file name and
  bytes are not sent automatically, while user-entered descriptions persist;
  the claimed browser role is not authenticated.
  The fingerprint is for equality checks, not a signature or tamper-evident
  ledger. Route steps, claimed roles and payments remain browser-only simulations;
  saved document markers are unauthenticated local metadata, not files. It does not
  expose the trusted `DealFlow` fixture or any signing method.
- `workflow/decision-policy.mjs` + `workflow/decision-ledger.mjs`: a separate
  offline state machine for exact-version offers, acceptance, demo reserve,
  handover, delivery acceptance or dispute, demo release and one role rating per
  side. The SQLite ledger survives restart and rejects altered or cross-deal
  decision-ID reuse. Actors are trusted fixtures, not NCA-verified identities;
  the web server does not expose this policy, and demo reserve/release moves no funds.
- `workflow/signed-decision-fixture.mjs`: internal offline bridge that reads the
  server-saved current draft version/fingerprint, stores exact expiring
  challenge bytes, invokes injected test-key signature and powers checks, and
  advances the ledger only for the same actor and version. The verified receipt,
  decision ID and state transition now commit together in the decision database.
  It also keeps a full terms snapshot and an internal version-filtered demo
  record with clearly labelled unsigned document-marker metadata. Same-file
  mode checks draft freshness inside the decision transaction; separate-file
  mode does not. It has no HTTP route or NCA implementation.
- `nca/`: separate loopback browser/API/Java test-signature stand, exact
  session-bound challenge bytes and atomic one-use test receipts. It is not
  connected to owner/deal/grant state. The SDK and test keys remain outside
  Git; no personal certificate is used. Cryptography and NCALayer TLS connect
  are tested. In explicit TEST OCSP mode, strict responder trust/CertID/nonce/
  freshness checks now pass SDK-generated CMS → one-use HTTP test receipt.
  Incompatible base/delta CRLs still close default CRL mode, without fallback.
  A browser signing request returned an unsupported NCALayer response; no
  usable NCALayer CMS or browser receipt has passed acceptance. Independent
  review, identity/powers and official negative fixtures remain open.

## Build status

| Milestone | Status | Acceptance |
|---|---|---|
| 1. Exact order and one-time authority | complete, offline only | Local tests pass for replay, tampering, rotation, signer bypass and restart |
| 2. Actual Solana transaction assembly | integrated with the offline signer only | Exact transfer assembled once, persisted and replayed after restart; decoded and verified; no broadcast |
| 3. Web/API deal workflow | versioned unsigned-draft slice, canonical fingerprint, visible version comparison and metadata-only document markers implemented; signed workflow still pending | Draft creation, revision history, changed-field comparison, stale-write rejection, fingerprint binding and version-scoped marker history persist through local API; next: authenticated participants, real private document storage and signed deal states |
| 3a. Offline deal decisions | complete as a test policy and durable ledger; not in browser | Ordered actor/terms-bound decisions, replay and altered-request rejection, dispute stop, restart and cross-deal checks |
| 3b. Signed-byte handoff | complete as an offline fixture; not in browser | Exact persisted challenge over server-read unsigned terms, test signature/powers, stale/expired/replay/dispute checks |
| 3c. Immutable local terms and demo record | complete as an offline fixture; not in browser | Full bound terms persist, pre-offer refresh and post-offer freeze, same-file transactional draft check, version-filtered metadata, fail-closed receipt record |
| 4. NCA verifier and NCALayer | Strict explicit TEST OCSP passes SDK-to-HTTP test acceptance; default CRL mode remains blocked | Actual NCALayer CMS roundtrip, independent review, identity/powers and official negative/rotation fixtures still open |
| 5. Devnet acceptance | pending | Confirmed exact test transfer and all required negative cases; no real KZT |

`mvp_complete: false`

`tests_passing: true` (83 Node + 7 offline Solana cases, plus 3 SDK runs including 47 synthetic/transport checks, CRL refusal and live TEST OCSP HTTP acceptance, as of 2026-09-30; not NCALayer end-to-end acceptance)

`devnet_deployed: false`
`program_id: null` (no custom on-chain program in this slice)

The master plan and acceptance criteria remain in `IMPLEMENTATION_PLAN.md` and
`TECHNICAL_PROTOTYPE.md`; this file does not supersede them.

## 2026-09-28 night-session handoff

- Source baseline: `main` at `a0696ad390556306f2c8285769ad5158fc59357d`;
  existing user changes were preserved. No commit, push, PR or deployment.
- Added the offline decision policy/SQLite ledger, ten focused tests, Spike 007
  evidence and `NCA_ADAPTER_CONTRACT.md`. A Claude Opus 5.5 read-only review
  found a second-read decision-ID flaw; it was fixed and regression-tested.
- Full local suite: 53 Node tests plus 7 Solana assembly tests pass. The local
  browser demo at `127.0.0.1:4174` still serves HTTP 200, but this new policy
  is intentionally not connected to that demo and no new UI was claimed.
- Next safe step after SDK arrival: verify exact NCALayer/SDK signed bytes,
  certificate status and corporate powers against test fixtures; then bind
  server-owned deal terms and authenticated actors to the policy. Do not send a
  devnet transaction or claim demo settlement until those gates pass.

## 2026-09-28 signed-decision handoff

- Added Spike 008 and seven focused tests. Full local suite: 60 Node tests plus
  seven offline Solana assembly tests pass. No new dependencies or browser API.
- Claude Opus 5.5 read-only review found that a live draft edit could block a
  post-offer dispute and that late retries could look rejected. Both were fixed:
  trusted pre-offer refresh, frozen offered terms, and a same-credential
  historical receipt for already applied decisions.
- The bridge still uses injected Ed25519 test-key callbacks and trusted fixture
  actor IDs. Real NCA certificate status, organization powers and multi-store
  atomicity remain outside this proof. No commit, push or deployment.

## 2026-09-29 offline receipt atomicity

- Source baseline remains `main` at `a0696ad390556306f2c8285769ad5158fc59357d`;
  earlier uncommitted work is preserved. No commit, push or deployment.
- A failing regression showed that a ledger write error left a verified receipt
  behind. The receipt, unique decision ID and deal-state update now share one
  SQLite transaction. Failure at either update point rolls back all three;
  two concurrent identical submissions commit one event and return a replay.
- Claude's read-only review identified a mutable caller-owned signature, a late
  concurrent replay edge, unstable receipt-field reads and masked SQLite
  rollback errors. All four were fixed with failing-before/passing-after
  regressions.
- Full local suite: 65 Node tests plus seven offline Solana assembly tests pass.
  This does not make the separate unsigned-draft database atomic with the
  decision ledger or prove NCA, powers, payment or devnet execution.

## 2026-09-29 immutable-terms and local-record handoff

- Baseline remains `main` at `a0696ad390556306f2c8285769ad5158fc59357d`;
  preserved all earlier uncommitted work. No commit, push, public route or deployment.
- Added Spike 009: full terms snapshot in the decision row, safe legacy-column
  migration, integrity check, pre-offer refresh and post-offer freeze. Same-file
  mode now checks draft freshness inside the ledger transaction. Separate-file
  mode remains non-atomic across databases.
- Internal `demoEvidence` combines the frozen terms, ordered local receipt
  digests and metadata-only markers from that exact version; no file bytes,
  independently verifiable signature or authenticated export. The final ledger
  transaction rechecks expiry and challenge-byte hash after asynchronous test
  verification.
- Full local suite: 72 Node tests plus seven offline Solana assembly tests pass.
  Real NCA/corporate powers, private document access, payment and devnet are
  still blocked by missing external integrations and acceptance gates.

## 2026-09-30 downloaded SDK and exact-decision handoff

- Baseline remains `main` at `a0696ad390556306f2c8285769ad5158fc59357d`;
  earlier uncommitted work was preserved. No commit, push, public API or
  deployment.
- User supplied SDK 2.0 in Downloads. The SDK and bundled test P12/CRLs stay
  outside Git. The isolated Java 17 probe in `nca/` tested detached CMS on
  exact bytes, altered-byte rejection, the local test chain/CRLs and refusal
  without CRLs. NCALayer's local TLS listener and Basics service responded,
  but no signing dialog or CMS from NCALayer was tested. This is not a browser
  or production verification adapter.
- Added a failing-before/passing-after regression for a ledger caller trying
  to apply a different decision with a valid challenge hash. Canonical
  persisted bytes and the validated decision now match in one transaction.
- Full local suite: 73 Node tests and seven offline Solana tests pass; Java
  SDK probe also passed. NCALayer output, official rules, live status,
  corporate authority, web auth, certificate rotation and devnet remain open.

## 2026-09-30 NCALayer test stand and CRL correction

- Baseline remains `main` at `a0696ad390556306f2c8285769ad5158fc59357d`;
  all earlier dirty work preserved. No commit, push, external release or payment.
- Added Spike 011: exact expiring session-bound instruction, native NCALayer
  client, bounded Java verifier, one-use SQLite test receipt, safe journal
  preview/export and a public test-CRL refresh script. GSD quick spike and
  Ponytail reuse existing SDK/Node primitives; no new service or dependency.
- The old probe's CRL acceptance was incomplete: base number 166 is below
  delta BaseCRLNumber 167 (delta number 2228). Bundled and newly downloaded
  official public test assets have the same mismatch. Both verifier and old
  probe now reject it. Refresh does not alter SDK files or bypass the guard.
- Official TEST OCSP answered a bundled test-certificate diagnostic with the
  SDK utility's `good` value. Inspection of that utility shows no responder
  authorization, request CertID binding or freshness checks. Diagnostic is
  explicitly non-authorizing; no automatic OCSP fallback was enabled.
- Tests: 81 Node + 7 offline Solana + 1 actual SDK integration case pass.
  The SDK case proves exact-byte cryptography and HTTP refusal, not current
  happy-path acceptance. Revoked/wrong-purpose fixtures still needed.
- Browser confirms NCALayer TLS connection, closed creation/signing while
  status is unavailable and a safe visible event log. No test-certificate
  selection or NCALayer CMS response was completed. Full roundtrip remains open.
- Claude Opus 5.5/max read-only review timed out after 240 seconds without
  findings. No independent review is claimed. Next: coherent public test CRLs
  or a separately implemented/reviewed strict OCSP adapter, then supervised
  NCALayer output acceptance. Identity, powers, rotation and devnet remain gated.

## 2026-09-30 push and strict TEST OCSP stage

- Preserved and pushed the prior local work to private `main` at
  `acc193c8df402370ef59784865e47f45e2280de3`; remote SHA readback matched.
  This is source publication to the existing private repo, not deployment.
- Spike 012 adds strict fixed-endpoint TEST OCSP with pinned public TEST CAs,
  responder trust/purpose/signature, exact CertID, random 32-byte nonce, bounded
  freshness and fail-closed transport. No new dependency or service. CRL mode
  is unchanged and remains closed for the incoherent public test pair.
- Signed source is fixed per instruction. Status expiry is rechecked at commit;
  changing mode cannot reinterpret a pending request. No user/business grants.
- All 90 local cases and 3 SDK runs pass. The synthetic test includes 47 policy/
  transport checks, including a failing-before/passing-after weak-signature
  regression. Official revoked/wrong-purpose keys are still needed.
- Browser shows OCSP-mode local trust readiness and exact instruction; NCALayer
  connects normally but signing returned an unsupported response. No usable
  CMS/browser receipt, certificate selection or natural-user acceptance claimed.
- Claude Opus 5.5/max read-only review timed out after 240 seconds with no
  output. Independent review remains open, as do official rules/provenance,
  stable identity, powers, rotation, private documents, payments and devnet.
