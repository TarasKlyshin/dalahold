# Local NCA test-signature stand

## Current result, 30 September 2026

The browser/API/Java verifier is implemented at <http://127.0.0.1:4175/>.
It stores exact session-bound, expiring test instructions in SQLite, verifies
detached CMS in a bounded Java process and commits a digest-only test receipt
with one-time consumption. An identical retry returns the historical receipt;
it does not perform a new authorization or status check. No owner, deal,
corporate permission, Solana grant or payment is created.

**Status acceptance is BLOCKED.** The SDK's base CRL has number **166**, while
its delta CRL has number **2228** and BaseCRLNumber **167**. On 30 September,
the public official test endpoints returned the same numbers and publication
times (11 August 2026). The complete CRL must be at least the delta's
BaseCRLNumber and below its CRL number, with matching issuer and scope:
[RFC 5280, section 5.2.4](https://www.rfc-editor.org/rfc/rfc5280.html#section-5.2.4).
The previous isolated probe checked signatures/dates but missed this
relationship; its earlier status acceptance does not establish coherent
revocation coverage. The probe now invokes the common pair guard and rejects
this bundle. Do not edit CRL numbers, ignore the delta, or disable the guard.

The installed NCALayer's TLS connection was also tested through the browser.
Its CMS output is still untested: no certificate selection or signing dialog
was completed. Current tests prove SDK exact-byte cryptography and refusal of
the incompatible status fixtures; they do not prove a complete NCALayer flow.

An isolated diagnostic also queried **TEST** OCSP for a bundled test
certificate. The SDK utility returned `good`, but bytecode inspection of
`knca_provider_util-0.8.5` shows that `OCSPUtil.verify` checks the response
signature against a certificate included in the response without establishing
responder authorization; it returns the first status without matching its
CertID to the request or checking freshness. A nonce is compared only when
the response contains one. `TestCmsSigner` labels this diagnostic
`authorizationUsable: false`; it is never called by the server. No automatic
OCSP fallback is enabled. A strict adapter must validate pinned issuer or
authorized responder trust/purpose, response binding, freshness, nonce policy,
critical extensions and unavailable/unknown/revoked responses before it can
replace the CRL gate.

## Start and check

From the project root, use the SDK directory containing `Java/` and
`Keys and Certs/`. The SDK and keys remain outside Git.

```sh
export NCA_SDK_ROOT='/path/to/SDK 2.0'
export NCA_JAVA_BIN='/opt/homebrew/opt/openjdk@17/bin'
node nca/server.mjs
```

The server binds only `127.0.0.1:4175`. The current bundle shows a clear
status error and disables instruction issuance. Public assets, purpose,
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
request a coherent current base/delta pair from NCA before signing on this stand.

```sh
node --test nca/server.test.mjs nca/client.test.mjs
NCA_SDK_ROOT='/path/to/SDK 2.0' node --test nca/sdk.test.mjs
```

The first command uses injected callbacks for HTTP/replay tests only. The
second uses SDK test keys, reading their shared test password locally from
the SDK's test README into stdin, never argv/env/logs. It always checks
exact-byte cryptography and the current bundle's status rejection. If an
explicit `NCA_TEST_CRL_DIR` supplies a coherent pair, it additionally runs the
full SDK-to-HTTP acceptance/tampering/attached/multiple/expired CMS checks.
Those conditional checks are **not passed** while the status gate is closed.
No separate authentication-only certificate was found in the current
individual test bundle; wrong-purpose and genuinely revoked-certificate
acceptance tests still require suitable fixtures. Unit callbacks are not a
substitute for those fixtures.

After the CRL gate passes: create a new instruction → review its exact text →
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
"$NCA_JAVA_BIN/javac" -d "$NCA_PROBE_BUILD" -cp "$NCA_PROBE_CP" nca/SdkProbe.java nca/CmsVerifier.java
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
