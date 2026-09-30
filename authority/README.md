# Owner state (internal prototype)

`owner-store.mjs` persists an opaque owner ID, opaque subject/certificate IDs,
one wallet address, an authorization epoch, and consumed nonces in SQLite.
The storage is deliberately independent from the signer. Certificate rotation
is compare-and-swap and increments the epoch without changing the address.
`offline-issuer.mjs` accepts a canonical signed test order, asks injected
identity and power verifiers, then signs the signer's narrow grant format with
a separate test policy key. One order hash/nonce gets one durable envelope;
retries receive the same bytes. A deal ID is also unique per owner for this
single test-transfer action, so a fresh nonce cannot authorize a second
transfer for the same deal. The integration test runs this through the
offline signer before and after certificate rotation.

Existing local SQLite files with grants issued before the deal-binding table
cannot be safely migrated automatically because those grants did not store a
deal ID. The store refuses to open them (`legacy grant state lacks deal
binding`); preserve the file for review rather than deleting it silently.

Run `node --test authority/*.test.mjs signer/signer.test.mjs` on Node 22. The built-in
`node:sqlite` API is experimental. This module has **no HTTP endpoint** and
does not verify EDS, certificate status, corporate powers, wallet custody, or
Solana transactions. Its `registerVerifiedOwner` and
`rotateVerifiedCertificate` methods are trusted *internal* boundaries: they
must only be called after official NCA-backed verification and power checks.
Until those are integrated, the tests inject local Ed25519 fixture verifiers
and a fake power decision only. Do not expose these methods or the test policy
private key to the browser. `OfflineIssuer.rebind` checks the *test* signature
from the new certificate, sends a signed epoch notice through its trusted
`notifySigner` callback, requires an acknowledgment, then rotates the store.
This is not yet an NCA-verified rebind or a hardened inter-service channel.
Corporate authorization must remain disabled until an independent source of
current powers is integrated.

[Spike 013](../.planning/spikes/013-test-subject-identity/README.md) now checks
the store with opaque person IDs from real verified TEST CMS: individual and
director certs share one subject, while an employee of the same organization is
a different subject. Temporary trusted storage rotation/restart keeps one owner
and the literal **non-Solana fake address**, then rejects foreign/stale credentials.
This is compatibility evidence only: no new owner endpoint, durable identity
mapping key, wallet creation or power policy. The HTTP signature probe never
calls `verifyIdentity`; a probe receipt cannot authorize registration/rebind.
The corporate employee's `valid` fixture is actually OCSP-revoked, so a genuine
same-role certificate-renewal UAT and independent review are still required.

The signer must check the current epoch at execution time. Rotation ordering:
send a signed `/epochs` notice and wait for acknowledgment before committing
the store's rotation. This is fail-closed but still needs a durable orchestrator
and recovery path; a fake acknowledgment would be unsafe. This store alone
does not revoke a grant already submitted to another process.
