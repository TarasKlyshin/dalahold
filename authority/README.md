# Owner state (internal prototype)

`owner-store.mjs` persists an opaque owner ID, opaque subject/certificate IDs,
one wallet address, an authorization epoch, and consumed nonces in SQLite.
The storage is deliberately independent from the signer. Certificate rotation
is compare-and-swap and increments the epoch without changing the address.

Run `node --test authority/owner-store.test.mjs` on Node 22. The built-in
`node:sqlite` API is experimental. This module has **no HTTP endpoint** and
does not verify EDS, certificate status, corporate powers, wallet custody, or
Solana transactions. Its `registerVerifiedOwner` and
`rotateVerifiedCertificate` methods are trusted *internal* boundaries: they
must only be called after official NCA-backed verification and power checks.
Until those are integrated, the tests use opaque fixture identities only.

The signer must check the current epoch at execution time. This store alone
does not revoke a grant already submitted to another process.
