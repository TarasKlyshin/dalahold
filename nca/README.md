# Local NCA test-signature stand

## Current result, 30 September 2026

The browser/API/Java verifier is implemented at <http://127.0.0.1:4175/>.
It stores exact session-bound, expiring test instructions in SQLite, verifies
detached CMS in a bounded Java process and commits a digest-only test receipt
with one-time consumption. An identical retry returns the historical receipt;
it does not perform a new authorization or status check. No owner, deal,
corporate permission, Solana grant or payment is created.

**Strict TEST OCSP now passes SDK-to-HTTP acceptance** using the official
`http://test.pki.gov.kz/ocsp/` endpoint and a bundled test certificate. This is
a separate explicit mode (`NCA_TEST_STATUS_SOURCE=ocsp`), never an automatic
fallback. The default CRL mode remains closed for the incompatible bundle.
The adapter pins the local approved TEST CA snapshot, checks the CMS first,
then verifies responder ID/trust/purpose/signature, exact CertID, a random
32-byte nonce echo and bounded freshness. Delegated responders without a
valid OCSP noCheck extension refuse. Unknown, revoked, malformed, weakly
signed, stale and unavailable responses refuse. Redirects, wrong MIME,
oversized bodies and timeouts refuse; no certificate-supplied URL is used.
Status expires within five minutes and is rechecked at receipt commit.
The instruction and receipt bind the selected status source; switching mode
requires a new instruction. A ready page means **local trust/config ready**,
not that a particular certificate has a verified status.

**CRL-mode acceptance is BLOCKED.** The SDK's base CRL has number **166**, while
its delta CRL has number **2228** and BaseCRLNumber **167**. On 30 September,
the public official test endpoints returned the same numbers and publication
times (11 August 2026). The complete CRL must be at least the delta's
BaseCRLNumber and below its CRL number, with matching issuer and scope:
[RFC 5280, section 5.2.4](https://www.rfc-editor.org/rfc/rfc5280.html#section-5.2.4).
The previous isolated probe checked signatures/dates but missed this
relationship; its earlier status acceptance does not establish coherent
revocation coverage. The probe now invokes the common pair guard and rejects
this bundle. Do not edit CRL numbers, ignore the delta, or disable the guard.

The browser connected to NCALayer without a TLS bypass and issued exact
OCSP-bound instructions. An earlier request returned an unsupported response.
The user's later Chrome journal records a signature container followed by
HTTP format rejection; the CMS PEM transport correction below fixes that
boundary. No browser test receipt is yet verified. The Java app window cannot
be controlled by the available UI connector; supervised retest remains open.
Responsive checks at 375/768/1440 found no horizontal overflow; keyboard focus,
status live-region and control states were inspected, with no captured console
errors. Web Vitals and a real file-download result were not measured.

An isolated diagnostic also queried **TEST** OCSP for a bundled test
certificate. The SDK utility returned `good`, but bytecode inspection of
`knca_provider_util-0.8.5` shows that `OCSPUtil.verify` checks the response
signature against a certificate included in the response without establishing
responder authorization; it returns the first status without matching its
CertID to the request or checking freshness. A nonce is compared only when
the response contains one. `TestCmsSigner` labels this diagnostic
`authorizationUsable: false`; it is never called by the server. No automatic
OCSP fallback is enabled. The separate adapter above now validates these
conditions; it does not call that utility for acceptance.

Current verification: 88 Node cases + 7 offline Solana cases; 3 additional SDK
runs (default CRL refusal, 47 signed synthetic/transport checks, live TEST OCSP
CMS-to-HTTP acceptance). Synthetic revoked/delegated responders establish
policy behavior, not coverage of genuine official revoked/wrong-purpose
certificates. Official rules, archive provenance, stable identity, powers,
rotation and independent review remain unaccepted. Claude Opus 5.5/max's
read-only review timed out after 240 seconds with no findings.

### Client continuation, 30 September 2026

Baseline `445908b8125b4ee3a58c8813a26c5250d21d9ec7`. Read-only inspection of
the installed Basics/Commons module confirms that dismissing its dialog returns
`EmptyResponse`; `CommonInvoker` wraps normal returns as `status:true`, with
`body:{}` for that response. This is **not a successful signature**. The client
now classifies it as cancellation instead of unsupported data; malformed or
nonempty unexpected bodies still refuse. The exact historical unsupported
frame was not captured, so that earlier event's cause is not independently
confirmed from its payload.

Two failing-before/passing-after regressions cover the cancellation label and
a late `onopen` sending a signing request after timeout. Finished sockets now
ignore late open/message callbacks. A 160,000-character frame cap applies
before JSON parsing, including large extra fields around a small signature.
The server's CMS/status/source/expiry acceptance is unchanged.

A shape-only local protocol diagnostic observed the greeting, then timed out
without a method response. No container, subject, identity or password was
printed. Browser recheck confirms normal TLS connection, exact OCSP-bound
instruction issuance, disabled retry without CMS and a safe journal; no
browser receipt or actual cancel/positive-signing acceptance is claimed.
The Java dialog remains inaccessible through the UI connector, so user-assisted
dialog dismissal and bundled-test-certificate selection are still required.

Claude Code 2.1.283 reports an authenticated first-party session. A tools-disabled
read-only patch review requested `claude-opus-5-5` / max and timed out after
60 seconds with no output. Actual model execution and independent review are
not confirmed; no model fallback or authentication change was attempted.

### CMS PEM transport correction, 30 September 2026

Baseline `e4a3b247068c53fa8f4d68de807127514bb85bd8`. The user's Chrome
journal records `cms_received` followed by server `invalid_signature_request`:
the request was rejected before certificate or OCSP verification. Installed
Basics bytecode writes CMS through Kalkan `PEMWriter`, whereas the HTTP API
requires canonical base64. No raw user CMS was retained or logged.

The client now accepts exactly one `BEGIN CMS` PEM block (LF or CRLF), removes
only its wrapper/line breaks and checks canonical base64 before submission.
Ambiguous blocks, trailing text, certificate PEM, malformed/noncanonical base64
and oversized responses refuse. The server and its cryptographic/status gates
are unchanged. Format rejection now has a specific safe browser message/code.
Three regressions failed before the fix and pass after it. The live SDK test
now uses Kalkan's actual PEM writer → client normalizer → strict TEST OCSP →
one-use HTTP receipt/retry; it is not a completed desktop NCALayer dialog.
All 95 local cases and the 3 SDK runs pass. Browser receipt acceptance for the
user's legal-entity certificate still requires a supervised retest; certificate
validity/status and corporate powers are not inferred from `cms_received`.

## Start and check

From the project root, use the SDK directory containing `Java/` and
`Keys and Certs/`. The SDK and keys remain outside Git.

```sh
export NCA_SDK_ROOT='/path/to/SDK 2.0'
export NCA_JAVA_BIN='/opt/homebrew/opt/openjdk@17/bin'
node nca/server.mjs

# Explicit separate TEST OCSP mode (not a CRL fallback):
NCA_TEST_STATUS_SOURCE=ocsp node nca/server.mjs
```

The server binds only `127.0.0.1:4175`. In default CRL mode the current bundle
shows a clear status error and disables instruction issuance. Public assets, purpose,
certificates, CRL signatures, freshness, base/delta relationship and scope are
checked before a test signature can be accepted. Session-bound API writes
require the exact local Origin; no keys/passwords enter the API. CMS exists
in memory only; SQLite stores its hash and a test receipt, never the CMS or
certificate subject fields. The journal is visibly previewable and its JSON
link contains event codes/timings only. The in-app browser did not expose a
download event for an automatic Blob click; the preview remains usable, and
a separate explicit download link avoids that automatic-click dependency.
Saving the JSON file through that link is still unconfirmed in this browser.

Fetch public test CRLs without modifying the downloaded SDK:

```sh
node nca/refresh-crls.mjs
```

The script uses the fixed `http://test.pki.gov.kz/crl/` endpoints published in
the SDK, bounded downloads, and validation against the local test CA. HTTPS
did not respond in this run; no TLS checks were disabled. Authenticity for
HTTP-delivered CRLs must come from their verified CA signature. If a coherent
pair passes all checks, the script prints `NCA_TEST_CRL_DIR` for a new ignored
`.local/nca-test-crls-*` directory. Set that variable, restart the server and
run the tests. At present the refresh also rejects the incompatible pair;
request a coherent current base/delta pair from NCA before CRL-mode acceptance.

```sh
node --test nca/server.test.mjs nca/client.test.mjs
NCA_SDK_ROOT='/path/to/SDK 2.0' node --test nca/sdk.test.mjs
NCA_SDK_ROOT='/path/to/SDK 2.0' node --test nca/ocsp.test.mjs
NCA_SDK_ROOT='/path/to/SDK 2.0' NCA_TEST_STATUS_SOURCE=ocsp node --test nca/sdk.test.mjs
```

The first command uses injected callbacks for HTTP/replay tests only. The
second uses SDK test keys, reading their shared test password locally from
the SDK's test README into stdin, never argv/env/logs. It always checks
exact-byte cryptography and the current bundle's status rejection. If an
explicit `NCA_TEST_CRL_DIR` supplies a coherent pair, it additionally runs the
full SDK-to-HTTP acceptance/tampering/attached/multiple/expired CMS checks.
Those CRL-mode conditional checks are **not passed** while its gate is closed.
The fourth command runs actual detached CMS/tampering/attached/multiple/expired
CMS and historical retry checks through strict TEST OCSP and the HTTP API;
it is not a NCALayer browser test. The third generates ephemeral synthetic
RSA fixtures, saving public test certificates only for the pin-negative test;
private keys remain in memory. No official assets are replaced.
No separate authentication-only certificate was found in the current
individual test bundle; wrong-purpose and genuinely revoked-certificate
acceptance tests still require suitable fixtures. Unit callbacks are not a
substitute for those fixtures.

In explicit OCSP mode, or after the CRL gate passes: create a new instruction → review its exact text →
sign with the current SDK individual test P12 in NCALayer → observe the test
receipt → resend and observe the same historical receipt. The browser uses
an explicit test CA chain and never an empty chain. Password entry belongs
only in NCALayer. Personal certificates are unnecessary and production CAs
are not trusted by this stand.

## Historical isolated probe

This is a **local test-fixture experiment**, not DalaHold's NCA adapter. It
uses only a PKCS#12 test key bundled with the downloaded SDK, never a personal
certificate. The Java source does not contain a key or password and rejects a
P12 outside the SDK's `Keys and Certs/Gost2015` directory. It writes no CMS,
private key, certificate identity or personal data to disk or stdout.

Observed local SDK (30 September 2026): `SDK 2.0`, Java KalkanCrypt provider
`0.7.8-current`, provider util `0.8.5`, test root/intermediate certificates and
base/delta CRLs. The SDK itself stays outside this repository. Use JDK 17 and
set `NCA_SDK_ROOT` to the directory containing `Java/` and `Keys and Certs/`:

```sh
NCA_SDK_ROOT='/path/to/SDK 2.0'
NCA_JAVA_BIN='/opt/homebrew/opt/openjdk@17/bin'
NCA_TEST_P12=$(find "$NCA_SDK_ROOT/Keys and Certs/Gost2015/2026.05.08-2027.05.07" -type f -name '*.p12' -print -quit)
NCA_PROBE_BUILD=$(mktemp -d)
NCA_PROBE_CP="$NCA_SDK_ROOT/Java/provider/kalkancrypt-0.7.8-current.jar:$NCA_SDK_ROOT/Java/utils/knca_provider_util-0.8.5.jar"
"$NCA_JAVA_BIN/javac" -d "$NCA_PROBE_BUILD" -cp "$NCA_PROBE_CP" nca/SdkProbe.java nca/CmsVerifier.java nca/OcspVerifier.java
"$NCA_JAVA_BIN/java" -cp "$NCA_PROBE_BUILD:$NCA_PROBE_CP" SdkProbe "$NCA_SDK_ROOT" "$NCA_TEST_P12"
```

The probe requests the **bundled test** P12 password interactively; do not
put it in the command line, Git, logs or chat. A non-interactive run may pipe
the password to stdin from a protected local source. Do not use this path for
a personal or production certificate.

The probe creates a detached CMS in memory, checks the exact challenge bytes
and rejects altered bytes. It then validates the bundled test root/NCA
signatures, the current base/delta CRL signatures and dates, the test signer,
and the SDK's signature/chain/status result. It also asserts that an absent
CRL is not accepted. The original 30 September run passed these incomplete
checks; an empty password and a key path outside the test directory failed.
That run did **not** validate the base/delta relationship. The corrected
probe now rejects this same SDK bundle at the common CRL-pair gate, before
reporting certificate status acceptance. See the current result above.
The installed NCALayer was also started locally: its TLS endpoint at
`wss://127.0.0.1:13579/` responded, reported protocol version `1.4`, and
`getServices` listed the Basics signing service. A Node client needed
`NODE_USE_SYSTEM_CA=1` to use macOS's trusted certificate store; TLS checking
was **not** disabled. The installed NCALayer reported Kalkan provider `0.7.8`
and util `0.9.1`, versus util `0.8.5` in the downloaded SDK; their CMS output
compatibility is not yet tested. No signing request was sent to NCALayer.

Limits of that historical run: the CMS is generated by the Java SDK,
**not NCALayer**. No desktop signing roundtrip, official validation-rules
review, trusted online OCSP path or revocation fixture, verified corporate
powers, certificate rotation, owner
binding, private documents, Solana transaction or KZT operation was tested.
The bundled CRLs expire; the probe fails closed after `nextUpdate`. Its output
must never be interpreted as a verified user deal or production acceptance.
The downloaded archive's SHA-256 is
`c2699969765f15b3c74669eac4e5dbdac6b5888632d98b72acde2eb0a95d6b29`;
that identifies this local copy, not its provenance. JAR entry signatures
verified locally, but the JDK reported expired/untrusted signer or timestamp
chains, so source authenticity still needs independent confirmation.
