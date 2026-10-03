---
spike: 020
name: signed-participant-test
type: standard
verdict: PARTIAL
related: [012, 013, 017, 018, 019, 021]
tags: [nca, participants, exact-terms, identity, test-only]
---

# Spike 020 — personal TEST signatures for private participants

Baseline `752878fa472fb5341e7f05ad592d7d70eac2dabc` plus the preserved,
uncommitted Spike 019 cabinet. On 3 October 2026 the user authorized all three
next scoped steps: finish cabinet verification, connect TEST EDS, then a limited
devnet signer after authorization gates. No push/deploy or real money is implied.

## Acceptance

- Separate loopback 4178 and new protected DB kind; unsigned 4177 and the retained
  personal registry/checkpoint are neither migrated nor connected.
- Explicit personal TEST certificate enrollment; one verified SDK HMAC identity
  cannot occupy two accounts/sides. Corporate signing/authority is closed.
- Both roles sign the same immutable conditions and full document manifest.
  Handover/accept/dispute use their own exact fresh CMS, state revision and nonce.
- Only the trusted SDK supplies identity/status evidence. Direct unsigned events,
  outsider writes, foreign/changed certificates, stale snapshots, replay,
  expired/closed sessions and unavailable status cannot advance the signed deal.
- Receipt/event writes are atomic; exact CMS retry is historical, never a fresh
  verification, nonce consumption or second business effect.
- A separate operation intent, not an agreement, authorizes TEST Memo fields.

## Scope and limits

This is personal TEST identity and local TEST statements, not a legal contract,
corporate powers, real user identity service, physical delivery or payment.
Access still uses local pseudonymous bearer accounts. Protected local DB keys
are not production custody or protection against a full-machine rollback.

A genuine second participant certificate is required for real two-person UAT.
A different valid certificate of the same identity is separately required for
genuine renewal. Model identities do not close either gate. Old certificate
replacement remains a separate Spike 017 test; no automatic rebind here.

## Results

Implemented the separate signed store/listener and shared cabinet, explicit
personal TEST enrollment, protected distinct-identity bindings, exact CMS for
each role-specific statement, immutable snapshot/manifest checks and historical
retry. No retained 017 registry or unsigned 019 rows are reused. Contract is in
[API.md](API.md); manual steps and missing certificates are in [UAT.md](UAT.md).

Stable-code checks on 3 October 2026:

- 17 signature-core tests; 8 isolated model HTTP scenarios; 3 regressions against
  the actual ParticipantStore adapter; 12 signed client/DOM model tests plus 20
  shared unsigned-client regressions. These do not establish browser acceptance.
- Genuine bundled personal TEST CMS through isolated HTTP: enrollment, exact
  historical retry without a new SDK check, duplicate same-person refusal,
  corporate/revoked/wrong-purpose/altered-byte refusals, outage and closed-session
  gates. Database has one accepted binding/receipt and no deal event afterwards.
  Only one genuine eligible personal identity was used; no signed two-person
  deal or positive certificate renewal is claimed.
- Final integrated regression: 395 Node/model tests, 20 offline Solana tests and
  5 SDK/Java gates passed. The initial general run skipped 2 opt-in tests; both
  were subsequently run with the official SDK and passed, as did 3 explicit SDK
  integration files. Four SDK gates use genuine bundled CMS flows; the OCSP
  gate uses cryptographically signed adversarial fixtures. No remaining skip
  is hidden in this count.

Independent read-only review found a real adapter defect: final domain/session
checks were not retained past nested RELEASE. Three failing-before regressions
reproduced expiry, session closure and manifest change, then passed after the
outer-COMMIT registration fix. Follow-up review found no unresolved issue in
those specific fixes; this is not a production security certification.

Runtime started from current code on 4178, PID 40615, TEST OCSP SDK ready. Readback:
HTTP session bootstrap 200 with signed TEST scope; legacy `/api/deals` 404;
unauthenticated broadcast request 401 (authenticated nonexistent route covered by
the model HTTP test). New DB integrity `ok`, kind explicitly signed, 0 participants,
deals/events/bindings/intents, directory 700 and file 600. Memo configuration is
absent/disabled. This is backend readiness, not a browser or signing UAT.

Browser service previously denied 4177. Renewed permission was requested but not
received during that implementation run; no alternative browser/port/headless workaround was used. 4178 is the
new signed backend slice, not a way to bypass that decision. Real-browser
interaction, manual NCALayer enrollment, genuine two-person signing and
same-person certificate replacement remain open. Verdict stays PARTIAL.

Follow-up on 3 October: human permission is now explicit, but the attempted
4177 navigation again failed because the browser service could not verify the
admin-enforced policy. No bypass was attempted. The SDK valid/revoked personal
pair is confirmed same-person/distinct; it proves revoked-key refusal, not a
second counterparty. Renewal does not require both certificates to be good now,
but revoked-old → valid-new needs authentic prior enrollment of the old digest.
The retained operator binding currently uses `valid`, not `revoked`. Details:
[certificate-pair evidence](../017-browser-certificate-replacement/CERTIFICATE_PAIR.md).

## Reproduce automated gates

```sh
node --test --test-reporter=spec web/*.test.mjs authority/*.test.mjs workflow/*.test.mjs signer/*.test.mjs nca/client.test.mjs nca/identity.test.mjs nca/ocsp.test.mjs nca/participant-signatures.test.mjs nca/personal-bindings.test.mjs nca/personal-client.test.mjs nca/personal-http.test.mjs nca/server.test.mjs nca/terms-evidence.test.mjs
(cd signer/solana && node --test --test-reporter=spec)
NCA_SDK_ROOT='/Users/tarasklyshin/Downloads/SDK/SDK/SDK/SDK 2.0' NCA_TEST_STATUS_SOURCE=ocsp node --test --test-reporter=spec nca/sdk.test.mjs nca/terms-evidence-sdk.test.mjs nca/participant-http-sdk.test.mjs
NCA_SDK_ROOT='/Users/tarasklyshin/Downloads/SDK/SDK/SDK/SDK 2.0' node --test --test-reporter=spec nca/identity.test.mjs nca/ocsp.test.mjs
```

These SDK checks use bundled TEST material locally and do not print or persist
its container password. No live wallet/policy key, funding, send or push occurred.
