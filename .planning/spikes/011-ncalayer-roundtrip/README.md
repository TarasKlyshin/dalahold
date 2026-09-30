---
spike: 011
name: ncalayer-roundtrip
type: standard
validates: "Given one server-owned test instruction, when NCALayer returns detached CMS, then the server verifies the stored exact bytes with the SDK test chain and fresh bundled CRLs and consumes the instruction once"
verdict: PARTIAL (software checks pass; coherent CRL and NCALayer signing acceptance pending)
related: [008, 009, 010]
tags: [nca, ncalayer, cms, web, sqlite, replay, test-certificate]
---

# Spike 011: NCALayer to local SDK verifier

## Scope and acceptance

Baseline: `main` at `a0696ad390556306f2c8285769ad5158fc59357d` plus preserved
uncommitted work. This is a local test-signature page, independent of the
unsigned deal UI, owner store and Solana signer. No commit or external release.

1. The server persists exact UTF-8 bytes with a random nonce, purpose, session
   binding and expiry. The browser cannot supply replacement operation fields.
2. The browser signs those bytes using KNCA Basics detached CMS; the private
   key and password stay in NCALayer. The server trusts only the SDK test CA.
3. SDK verification must reject altered bytes, attached content, multiple signers,
   wrong purpose, invalid chain, expired certificates and missing/stale/incoherent CRLs.
4. A verified test receipt and nonce consumption commit together; identical
   retries return that receipt, including after restart. An altered retry,
   expired pending challenge or a concurrent second result cannot pass.
5. The page handles unavailable NCALayer, cancellation and stale responses,
   shows the exact instruction and allows a safe retry. Logs contain event
   codes and timings only; CMS and personal certificate fields are not logged.
6. Real NCALayer output requires a supervised test-certificate selection.
   Prepared UI/API and SDK-generated CMS are separate evidence from that run.

## Research

Checked 2026-09-30: [KNCA Basics](https://github.com/pkigovkz/sdkinfo/wiki/KNCA-Basics-Module),
[official JS sample](https://github.com/pkigovkz/NCALayerJSExample/blob/master/js/ncalayer.js)
and the downloaded SDK's Java signatures and verifier flags.

| Approach | Benefit | Limit | Choice |
|---|---|---|---|
| Direct Java Kalkan SDK process | Already installed, public assets only on server, bounded process | JVM startup per check; local test CRLs only | Use for this small spike |
| NCANode service | Existing server wrapper | New deployment and compatibility/provenance work | Defer until needed |

Request: `format: cms`, `decode: true`, `encapsulate: false`, `digested: false`,
PKCS12, signing EKU, explicit SDK test CA chain (never an empty chain).
The official sample accepts a string result or `result.signatures`; this
spike accepts exactly one non-empty CMS string and ignores certificate claims.

## How to run

Instructions and checks will be recorded in `nca/README.md`.

## Observability

In-memory event codes and timing; browser export omits instructions, CMS,
certificate identity and paths. The local SQLite row stores only test
instruction bytes and a digest-only receipt, never the CMS container.

## Investigation trail

- Spike 010 already proved Java SDK CMS and test CRL feasibility; reused it.
- Existing deal API has no authenticated participants. Keeping this test page
  separate prevents a successful test signature from approving an actual deal.
- Use Node built-ins, SQLite, native WebSocket and the existing SDK. GSD quick
  mode applies to the already-approved scope; Ponytail avoids a new service or
  dependency. Documentation auto-commit is not enabled in this dirty checkout.

## Results

- Implemented native browser page/client, loopback session-bound API, SQLite
  exact-byte challenge and one-use receipt, bounded Java SDK verifier, public
  CRL refresh and code/timing-only event export. No new dependency.
- Eight HTTP/client tests pass, including amount/recipient tampering, foreign
  session/origin, malformed/oversized input, parallel identical or different
  containers, restart, historical replay, commit-time expiry/change and DB
  rollback. These callbacks are test doubles, not NCA verification.
- The SDK test key proves exact-byte detached-CMS cryptography. A real SDK to
  HTTP test refuses status and instruction issuance for the current bundle.
  Full CMS/HTTP happy acceptance and negative paths are conditional on a
  coherent CRL pair and remain unaccepted after the stricter guard was added.
- Found a concrete missed check in 010: base CRL number 166, delta CRL number
  2228, delta BaseCRLNumber 167. The complete base is too old for this delta.
  Both bundled and newly fetched public official test CRLs have this mismatch.
  [RFC 5280 section 5.2.4](https://www.rfc-editor.org/rfc/rfc5280.html#section-5.2.4)
  requires base number >= BaseCRLNumber and < delta number, with matching scope.
  The verifier now rejects mismatched numbers/scope; the old probe shares it.
  No CRL values were modified or ignored. Refresh fails with `crl_pair`.
- TEST OCSP answered a bundled test-certificate diagnostic with the SDK
  utility's `good` value. Inspection of `OCSPUtil.verify` showed missing
  responder authorization, response CertID binding and freshness validation;
  nonce absence is also not rejected. The diagnostic explicitly returns
  `authorizationUsable: false`. It is not wired into the server or an
  acceptance gate. Strict OCSP validation remains an alternative next spike.
- Browser interaction confirmed creation/error behavior before discovery and,
  after correction, the explicit CRL refusal and disabled issuance. The
  browser connected to installed NCALayer via its normally validated TLS
  listener. No certificate selection/signature response was completed.
- Responsive checks cover 375, 768 and 1280 pixel overrides with no horizontal
  overflow in the current blocked state. The journal preview exposes only
  event codes/timings. The initial automatic Blob download did not yield a
  browser download event; an explicit user-click link and visible preview
  replace it. Actual file saving in the in-app browser remains unconfirmed.
- Claude Opus 5.5/max read-only review was attempted with file-read tools only.
  It returned no review within the 240-second bound; no independent review
  is claimed. Main-agent inspection and runnable checks remain the evidence.

**Current blocker:** request a fresh, coherent official test base/delta pair
(or official clarification and a verified status approach). No status bypass
is allowed to obtain a positive demo. A signing-only browser interaction may
be explored separately, but it cannot issue a verified receipt here.

**Subsequent gaps:** real revoked/authentication-only test fixtures, online
status failure/revocation, official verification rules and archive provenance,
identity/organization powers, certificate rotation and devnet.
