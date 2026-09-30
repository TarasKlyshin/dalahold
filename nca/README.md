# Local NCA test-signature stand

## Current result, 30 September 2026

The browser/API/Java verifier is implemented at <http://127.0.0.1:4175/>.
It stores exact session-bound, expiring test instructions in SQLite, verifies
detached CMS in a bounded Java process and commits a digest-only test receipt
with one-time consumption. An identical retry returns the historical receipt;
it does not perform a new authorization or status check. No owner, deal,
corporate permission, Solana grant or payment is created.

**Strict TEST OCSP passes SDK-to-HTTP and supervised NCALayer browser acceptance** using the official
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

The user completed the NCALayer dialog in Chrome without a TLS bypass and
obtained a verified test receipt, then the identical historical receipt on
retry. Browser journal, server events and persisted SQLite digests agree.
The accepted certificate matches the bundled legal-entity **employee with
signing rights** test profile. That profile is not proof of corporate powers.
The earlier CMS PEM/base64 transport failure is fixed; see the dated evidence
below. The Java app window is not controlled by the UI connector; the user
selected the bundled test key and entered its password only in NCALayer.
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

Current verification: 126 Node cases + 7 offline Solana cases; 4 additional SDK
runs (default CRL refusal, 47 signed synthetic/transport checks, live TEST OCSP
CMS-to-HTTP acceptance including genuine bundled revoked/wrong-purpose
certificate refusals, plus identity/parser/offline-storage compatibility).
Synthetic responses separately establish policy and
transport behavior. The genuine revoked fixture returns trusted, bound, fresh
TEST OCSP `revoked`; the wrong-purpose fixture is refused before status lookup.
Official rules, archive provenance, stable identity, powers,
browser identity/rotation and full independent review remain unaccepted. Claude Opus 5.5/max's
read-only review timed out after 240 seconds with no findings.

The continuation sections below are a chronological trail: their pending
browser/fixture statements describe those earlier checkpoints, not current status.

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

### Official fixture negatives and supervised UAT, 30 September 2026

Negative-fixture baseline: local `main` at
`38801b38ec230f7afee52aaf731759822649ef6b`; no push or deployment in this step.
No new dependency, service, private document or personal key was introduced.

- Manual NCALayer success: `test_signature_verified` at `2026-09-30T09:29:46Z`
  (14:29:46 Almaty); retry: `historical_receipt` at `2026-09-30T09:33:21Z`.
  Receipt ID `290ec6f5-7b71-4633-8ac4-b7f4f2f74517`, exact challenge SHA-256
  `d33c57818f48ffa84d3d59f883b8586f19e39d2b6f93deaabddb671f0e9682fd`,
  original `verifiedAt: 2026-09-30T09:29:46.079Z`,
  `scope: test_signature_only`, `statusSource: test_ocsp`.
  The retry preserved all these fields and did not check status again.
  The stored certificate digest matches exactly one of 12 current bundled
  profiles: `Юридическое лицо/Сотрудник с правом подписи/valid`.
  No certificate subject, serial, CMS or private key is included in this record.
- Genuine revoked fixture: current `Физическое лицо/revoked`. Its exact detached
  CMS, purpose, validity and pinned TEST CA signature pass before OCSP. The
  verified TEST response then reports `revoked`: internal safe reason
  `ocsp_status_revoked`, public `status_unavailable` / HTTP 503. This is not
  merely a timeout or an unknown-status failure.
- Genuine wrong-purpose fixture: current legal-entity `Казначейство клиент/valid`.
  The certificate is currently valid, has signing key usage, is signed by the
  approved TEST CA and creates cryptographically valid exact CMS, but lacks
  the stand's required signing EKU `1.3.6.1.5.5.7.3.4`:
  [official KNCA Basics purpose definitions](https://github.com/pkigovkz/sdkinfo/wiki/KNCA-Basics-Module).
  It is not called an invalid certificate globally or an authentication-only
  certificate. Java returns `signature_rejected` / reason `cms`; HTTP returns 422.
- After each genuine negative, SQLite contains neither a signature digest nor
  a receipt. The same unconsumed challenge subsequently accepts one eligible
  signature and returns the same historical receipt on retry. Fixture selection
  now explicitly chooses `valid`, `revoked` or wrong-purpose material; an
  unsupported mode cannot silently select a valid key.
- Safe internal OCSP reasons distinguish trusted revoked and unknown responses
  only after trust, CertID, nonce and freshness checks. Acceptance remains
  **good-only**, public errors remain generic, and default CRL mode is unchanged.
- Regressions failed before the selector/diagnostic changes and pass after them.
  Stable suite: 88 Node + 7 offline Solana cases and all 3 SDK runs, including
  47 synthetic/transport checks, default CRL refusal and live TEST OCSP acceptance
  with the genuine negative fixtures. No skipped SDK cases in these runs.
- The local stand was gracefully restarted with the same explicit TEST OCSP
  configuration to load the updated Java verifier. HTTP 200 and local trust/config
  readiness pass; the saved UAT receipt, challenge hash, signature digest and
  original verification time match the pre-restart SQLite backup exactly.
  Backup: ignored `.local/nca-before-negative-fixtures-pMxS9g/nca-test.sqlite`.
  This readiness check performs no new signing, certificate-status authorization
  or business operation; a fresh manual dialog was not repeated in this step.

This completes the test-signature browser/retry and genuine negative-fixture
gate only. Next is a reviewed stable-identity mapping and a same-identity
certificate-replacement test; corporate powers, business grants, signed deals,
wallet ownership and devnet remain unconnected. Independent security review,
official validation rules and SDK provenance remain open.

### Opt-in opaque subject mapping, 30 September 2026

[Spike 013](../.planning/spikes/013-test-subject-identity/README.md) adds internal
`sdk.verifyIdentity(bytes, cms, mappingKey)`. Only exact, trusted, purpose-valid,
currently valid and fresh-status TEST CMS can return opaque person and optional
organization IDs. A caller-provided 32-byte HMAC key goes to stdin only; raw
IIN/BIN, names and roles are not output. Structured DN attributes reject ambiguity;
person and organization are separate domains. The TEST issuer and namespace
prevent accidental use as a production identity scheme.

Genuine current individual/director certificates have distinct digests and one
person mapping; a signing employee of the same organization is a different person.
The ordinary employee certificate in `valid` is actually **revoked according to
fresh TEST OCSP** and yields no identity. Revoked, wrong-purpose and altered CMS
also yield no identity. Thirty synthetic parser checks and genuine SDK/storage
checks pass. Temporary OwnerStore rotation retains its owner ID and **fake,
non-Solana address**, then refuses foreign/stale credentials; it is not a complete
user-authorized rebind or corporate powers proof.

The HTTP stand **does not call this mapper**, expose identity fields, create an
account or bind historical probe receipts. No durable mapping key or wallet was
created. Browser enrolment/rebind requires a dedicated signed intent, stable-key
protection and recovery, atomic freshness checks, account-type policy, suitable
same-role replacement fixtures and independent review. Actual model/review from
the requested Claude Opus 5.5/max attempt remains unconfirmed after its timeout.
This paragraph records Spike 013; the following step adds a separate internal
key/binding library but still does not enable browser enrollment.

### Protected personal binding intents, 30 September 2026

[Spike 014](../.planning/spikes/014-personal-binding-intents/README.md) adds a
separate internal TEST personal registry, with explicit operator provisioning,
one private mapping key, SQLite metadata and protected backup. Enrollment and
replacement each require their own exact, session-bound, five-minute CMS intent.
Only strict fresh TEST OCSP personal evidence qualifies. Organization context
always refuses; a legal certificate sharing a person's IIN does not become a
personal replacement. Historical probe receipts cannot enroll anyone.

Binding/epoch/retired-certificate/receipt updates commit together. Replays,
foreign/stale credentials, byte/candidate substitution, lost/changed keys and
transaction failures refuse or return the same clearly historical receipt.
Twenty-three policy/storage tests and genuine bundled personal CMS enrollment,
backup/restart/re-enrollment and corporate/revoked/wrong-purpose/tampered refusals
pass. Stored historical receipts have a domain-separated MAC; tampered history
refuses. Backups use private staging, integrity checks and atomic publication;
failed unpublished copies remove only their temporary staging, permitting retry.
Positive renewal between two eligible personal certificates is **synthetic
only**; the bundle has no suitable second currently valid personal fixture.

The HTTP stand does not import this library or enable login, wallet creation or
grants. A local private-file key is not an encrypted vault. An older backup is an
older epoch/retirement snapshot, not global anti-rollback; public authorization
must stay disabled until recovery, key custody and HTTP boundaries are reviewed.
No new browser UAT or actual wallet is claimed.

The operator procedure below is the current Spike 015 procedure, not the original
Spike 014 initialization API. Provisioning is explicit, non-overwriting and
separate from server start:

```sh
# From the repo root; NEW paths only, private existing parent directories.
# Both locations must be on the same filesystem/device, outside one another.
# Creates an empty TEST registry/checkpoint, never an account.
node --input-type=module -e 'import { initializePersonalBindings } from "./nca/personal-bindings.mjs"; initializePersonalBindings("/path/to/new-private-registry", {anchorDirectory:"/path/to/separate-control/new-checkpoint"});'
node --test nca/personal-bindings.test.mjs
```

Never rerun initialization as recovery or delete an existing key to regenerate it.
Back up key/database together to a new private directory with `backupTo`; point a
new internal store at that protected pair **and the original retained checkpoint**
for TEST restore checks. A missing/changed key or stale pair fails closed; do not
overwrite existing state. Private registries and
backups remain ignored by Git and are not used by `nca/server.mjs`.
On 30 September an empty local registry was explicitly provisioned at
`.local/nca-personal-bindings` with its protected current backup at
`.local/nca-personal-bindings-initial-backup`; both were **prepared, not active**.
Do not rerun the provisioning example against either existing path. No personal
binding or intent exists in this local registry yet; genuine SDK acceptance above
used isolated temporary test state.
Inspect the backup result: `{published:true,durability:'synced'}` is the normal
local result; `parent_sync_unconfirmed` means the complete target exists but its
final directory-sync durability is not established. Do not overwrite it or treat
it as an unpublished failure. Publication assumes a trusted, cooperative parent;
adversarial same-user empty-directory races and power-loss acceptance are not proven.

### Retained local TEST checkpoint and recovery, 30 September 2026

[Spike 015](../.planning/spikes/015-retained-binding-checkpoint/README.md) requires
an operator-retained `checkpoint.sqlite` outside ordinary key/database backups.
It binds registry ID, mapping-key ID, revision and a canonical digest of the main
schema/data. Every intent or new receipt advances both files in one attached
SQLite transaction, with DELETE rollback journals and FULL synchronization.
Every current-state read and historical retry also validates the checkpoint;
historical receipts are still not current authorization. Thirty-seven focused
cases pass, including stale copies/clones, same-inode restore, concurrent copies,
missing/replaced checkpoints, tampering, expiry and joint-write rollback/retry.

This is **administrative separation in a local TEST environment**, not an
encrypted key vault or independent production monotonic authority. The checkpoint
file/schema and its owner are trusted. Rolling back both files/the whole volume,
malicious same-OS-user or privileged changes, power failure and disk loss are not
covered. Same-device placement is required; actual storage/VFS durability must
be reviewed before production. Full-state hashing is O(n), suitable only for this
small internal registry. Browser login, business grants and wallets remain off.

Operator rules:

1. Stop all users/writers of this internal registry, including old Spike 014
   code, before an upgrade or restore. Do not stop the independent signature-only
   HTTP stand for this library upgrade; it does not load the registry.
2. Protect the mapping key and every backup as credentials: owner-only directories
   `0700`, files `0600`, trusted owner-controlled parents without group/other write
   permission. Never put keys, CMS, private subjects or checkpoint data in Git/logs.
   Plaintext owner-only files are only the current local TEST custody boundary.
3. Upgrade an **empty** legacy registry explicitly with
   `enablePersonalBindingAnchor({directory,anchorDirectory})`. The existing key
   is retained. A nonempty legacy registry is refused; it requires a separately
   reviewed reconciliation, not reset, clearing tables or trusting a snapshot.
   Constructors and server startup never bootstrap checkpoints.
4. If initial bootstrap was interrupted before the joint commit, keep all files.
   Only after confirming an empty legacy main and a private no-schema checkpoint
   may the operator explicitly use `resumeEmptyBootstrap:true`. Initialized or
   nonempty checkpoints cannot be reset this way. A missing checkpoint on an
   initialized registry is a recovery incident, not a reason to initialize again.
5. Create a new backup with `backupTo`, check publication/durability, and retain
   the checkpoint separately. Restore/open the latest pair against that SAME
   retained checkpoint. If it refuses, retain the evidence and find/reconcile the
   latest state; never restore an older checkpoint to make an old pair pass.
6. Multiple copies may open for checks, but only one can remain the writer: any
   state change in one makes the other copies stale. Taking a backup does not
   authorize that backup as a new concurrent writer. Never infer physical-fault
   durability or successful recovery merely from a copied file.

The empty `.local/nca-personal-bindings` is now explicitly upgraded, preserving
its original key at revision 0. The retained checkpoint is
`/Volumes/dev/dev/.dalahold-test-control/personal-bindings-anchor/checkpoint.sqlite`;
the new current pair is `.local/nca-personal-bindings-retained-checkpoint-backup`.
Current-pair open passes, and the old initial pair refuses as a current registry.
The old initial backup is preserved as a historical artifact, **not a current
restore candidate**. This state is prepared, not runtime authentication; see
Spike 015 for readback evidence and remaining limits.

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
NCA_SDK_ROOT='/path/to/SDK 2.0' node --test nca/identity.test.mjs
```

The first command uses injected callbacks for HTTP/replay tests only. The
second uses SDK test keys, reading their shared test password locally from
the SDK's test README into stdin, never argv/env/logs. It always checks
exact-byte cryptography and the current bundle's status rejection. If an
explicit `NCA_TEST_CRL_DIR` supplies a coherent pair, it additionally runs the
full SDK-to-HTTP acceptance/tampering/attached/multiple/expired CMS checks.
Those CRL-mode conditional checks are **not passed** while its gate is closed.
The fourth command runs actual detached CMS/tampering/attached/multiple/expired,
genuine revoked/wrong-purpose CMS and historical retry checks through strict TEST OCSP and the HTTP API;
it is not a NCALayer browser test. The third generates ephemeral synthetic
RSA fixtures, saving public test certificates only for the pin-negative test;
private keys remain in memory. No official assets are replaced.
The current individual `revoked` and legal-entity Treasury `valid` certificates
provide mandatory genuine negative fixtures in explicit OCSP mode; their
properties and refusal/no-consumption results are documented above. They are
separate from the signed synthetic OCSP cases and injected HTTP callbacks.

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
