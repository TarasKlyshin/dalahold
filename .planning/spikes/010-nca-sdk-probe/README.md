---
spike: 010
name: nca-sdk-probe
type: standard
validates: "Given the downloaded SDK and one bundled test P12, when a detached CMS is verified against exact bytes and local test CRLs, then altered bytes or missing status fail"
verdict: PARTIAL (CMS cryptography passed; CRL-pair coverage invalidated by 011)
related: [001, 008, 009]
tags: [nca, sdk, cms, test-certificate, crl, exact-bytes]
---

# Spike 010: Local KalkanCrypt SDK test

Correction from Spike 011, 30 September: the original status checks omitted
base/delta CRL number consistency. Bundled base number 166 is below delta
BaseCRLNumber 167. The initial positive status result is therefore incomplete;
the corrected common guard now rejects it. The official public test endpoints
returned the same mismatch. Exact-byte CMS cryptography remains validated.
See [Spike 011](../011-ncalayer-roundtrip/README.md) for the current server/UI
and the blocked status acceptance. No production claim follows from this spike.

The owner provided a local `SDK 2.0` archive and extracted directory. They
remain outside Git. Java provider `0.7.8-current`, util `0.8.5`, bundled test
certificates and current base/delta CRLs were found. JDK 17 was already
installed on this Mac. `nca/SdkProbe.java` compiles against those external
JARs and only accepts a P12 beneath the SDK's test directory.

The probe generated detached CMS with a bundled test key in memory. The SDK
accepted the original exact bytes and rejected altered bytes. The probe
checked test CA, signer and CRL signatures/dates; SDK signature, test-chain and
local-status validation passed. Removing the CRLs did not yield acceptance.
Empty test password and an outside test-key path were rejected. No personal
certificate, saved signature or production credential was used. Reproduction
instructions and the archive fingerprint are in [nca/README.md](../../../nca/README.md).
The installed NCALayer listener and Basics service were observed over a
TLS-validated local WebSocket, but no user signing dialog or CMS response was
tested.

Separately, a failing regression proved that the offline decision ledger could
accept a signed challenge's hash while applying a different decision supplied
by a trusted caller. The ledger now compares the full canonical challenge bytes
to the validated decision in its transaction. All 73 Node and seven offline
Solana tests pass. This is hardening of a local test fixture, not an NCA claim.

**Not validated:** NCALayer browser output, official verification-rule
document, online OCSP availability/revocation behavior, corporate powers,
identity-to-owner mapping, certificate replacement, web auth, signer/devnet or
KZT payment. The local test CRLs expire; they are not a production status
source. The SDK archive's provenance is not established by a SHA-256 hash or
the local JAR signature check alone.
