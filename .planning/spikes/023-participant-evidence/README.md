# Portable anonymous local TEST evidence

This prepared format carries one participant deal's immutable terms versions,
anonymous participant labels, public text-document metadata and bytes, the event
journal, and (for personal TEST statements) the public event receipt fields.
It includes neither enrollment/anchor receipts nor executable grants, CMS,
certificate subjects, identity mapping keys, session/access/invitation codes,
original attachment filenames, filesystem paths, wallet instructions or ratings.
The integration owns authenticated collection from one consistent database read;
this module does not read a database or contact a verifier.

The package is a local TEST artifact. A valid offline report establishes only
internal consistency and agreement with the SHA-256 values in that file. Hashes
are recomputable and are not signatures. A counterparty can alter every record,
change the claimed mode from personal TEST statements to unsigned statements,
and recompute a consistent file. The verifier cannot discover that rewrite
without an independently trusted original digest or authenticity mechanism.
It does reject mixed scopes, missing required signed authorizations, incompatible
actions and broken receipt links within the supplied file.

The signed scope means `local_personal_test_signed_deal_only`, with event source
`personal_test_nca_statement`. It does not mean that this offline verifier ran the
NCA SDK or authenticated a CMS/signing certificate. Public receipts are historical
local assertions; certificate status may have expired since their creation.
The unsigned scope is `local_test_participant_statements_only`, with event source
`unsigned_test_participant_statement`, and has no signature receipts.
Neither scope proves fresh OCSP, signer identity, corporate authority, a legal
contract, a Solana transaction, payment or document provenance.

Attachment bytes remain the exact approved `.txt` bytes, including any text
written in them. Omitting identity metadata does not anonymize the document's
contents; participants must use anonymous TEST text. The builder cannot redact
content while retaining its existing digest. Text is decoded only to check UTF-8
and the existing plain-text policy, and is never evaluated or rendered as HTML.

## Library contract

`web/participant-evidence.mjs` exposes:

```js
buildParticipantEvidence({ exportedAt, deal, versions, documents, receipts });
verifyParticipantEvidence(packageObject);
```

`exportedAt` is a nonnegative safe-integer millisecond timestamp. All public
document/event creation and receipt verification timestamps must be no later
than it; `validUntil` is checked against historical `verifiedAt`, not wall time.
The existing service samples an injectable `now`/`Date.now` wall clock and does
not guarantee nondecreasing samples. It fences receipt and event times against
their signed intent independently and rechecks status at commit samples; it does
not persist an invariant `verifiedAt <= event.createdAt < validUntil` between
those fields. Consequently this offline format does not infer a monotonic
journal, document-before-offer wall-clock ordering, or that additional receipt
time inequality. A protected MODEL service record reproduces an event timestamp
before its receipt's `verifiedAt` under a backward clock. A second protected
MODEL record reproduces an event timestamp after the historical `validUntil`
with lower valid status samples before and after it. The report explicitly sets
`chronologyVerified: false`; sequence integrity is checked by contiguous state
revisions. Historical records remain exportable after status expiry.
`deal` is the exact public ParticipantStore snapshot including `documentHistory`,
the current terms, role, anonymous participants and complete event journal.
Historical response decorations such as `historical` or `unchanged` do not belong
in this snapshot. Every object and array is validated before values are used;
extra keys, accessors, proxies, symbols, sparse arrays and coercions reject.

Each input version has exactly:

```js
{ version, scenario, quantity, amount, date, termsFingerprint }
```

The outer deal ID supplies the canonical terms' `dealId`. Versions must cover
every integer from 1 through the current version. The builder enriches each
with `canonicalTerms`, `byteLength`, `sha256`, `documentManifest`, and
`documentManifestHash`. Terms canonical bytes use the existing LF-terminated
`web/terms.mjs` formula, and `sha256` equals `termsFingerprint`.

Each input document has all nine existing public metadata fields in addition
to `contentBase64`:

```js
{
  id, dealId, termsVersion, category, byteLength, sha256, createdAt,
  scope: 'local_test_document_only', fileKind: 'text', contentBase64
}
```

Base64 must be canonical, represent exactly the declared number of bytes, and
match the declared digest. The complete flattened set must equal
`deal.documentHistory`, each version's full metadata manifest, and the current
version's `deal.documents`. IDs cannot repeat across versions.

Each personal TEST event requires exactly one receipt containing the existing
16 public fields:

```js
{
  id, intentId, intentHash, actorId, action, dealId, eventId, snapshotHash,
  bindingId, authEpoch, certificateDigest, verifiedAt, validUntil,
  statusSource: 'test_ocsp', scope: 'local_personal_test_signed_deal_only'
}
```

Only `offer`, `agree`, `handover`, `accept`, and `dispute` actions belong here.
Receipts must match event ID, actor, action, snapshot, and every public event
authorization field. Per-actor binding/certificate metadata must stay consistent,
and different actors cannot share a binding or certificate digest. The collector
must obtain receipts through the existing protected accepted-record validation;
raw unvalidated receipt JSON is not an integration boundary. Unsigned packages
and personal TEST drafts without events use an empty receipts array.

The package top-level schema is exactly:

```js
{
  schema: 'dalahold.local-test-participant-evidence.v1',
  scope, exportedAt, verification: 'offline_integrity_and_consistency_only',
  limitations, deal, versions, documents, receipts, packageSha256
}
```

`limitations` is the fixed array exported as
`PARTICIPANT_EVIDENCE_LIMITATIONS`; changing it invalidates the schema.
The builder normalizes ordered arrays. Offline verification requires versions
in ascending order; documents/history by terms version then ID; each version
and current manifest by ID; participants by role then ID; events by state
revision; receipts by their linked event revision then ID.
Object property order does not affect the package digest.

For the existing `snapshotHash` and `documentManifestHash`, metadata objects
retain TestDocuments' field insertion order and use compact `JSON.stringify`;
the snapshot uses the existing ordered `{schema,canonicalTerms,documents,participants}`
formula. The event journal is replayed from `draft`, checking exact current
terms/documents, actor roles, legal state transitions, contiguous revisions,
and the reported final state.

`packageSha256` is SHA-256 of UTF-8 compact JSON of the entire package payload
with `packageSha256` omitted, recursively sorting object keys lexicographically
and retaining the ordered arrays. This is a deterministic checksum, with no
secret, MAC, digital signature or external trust anchor.

Limits: 2000 versions, 1024 documents, 10 documents per version, 262144 bytes
per text document, 8 MiB total decoded text bytes, and 16 MiB serialized JSON.
The structural verifier computes the bounded canonical package size. The CLI
also bounds the actual input file size, including whitespace.

The builder returns a fresh validated package or throws
`ParticipantEvidenceError` with a fixed safe code. The verifier returns a
sanitized report with `valid`, mode, safe error codes, limitations, and on success
the anonymous deal ID, scope, current state/version, counts, and package digest.
Its `authenticityVerified`, `sdkVerificationPerformed`, `freshStatusChecked`, and
`chronologyVerified` fields are always `false`. It never prints supplied text or
private field values.

## Offline CLI

```sh
node web/verify-participant-evidence.mjs /absolute/path/to/evidence.json
```

The CLI opens only the supplied regular file, reads at most the bounded size,
rejects invalid UTF-8/JSON, duplicate JSON keys (including escaped equivalents),
and excessive nesting, and prints a sanitized JSON report. It returns status 0
for integrity/consistency success, 1 for rejection. It performs no extraction,
copying, document execution, network calls or writes. Running this command does
not prove the source server, SDK, chain, identity or payment state.

## Verification evidence

```sh
node --test web/participant-evidence.test.mjs
```

22 focused checks pass with actual ParticipantStore snapshots for unsigned
accepted/disputed/draft deals and actual store transitions using an explicit
model SDK for personal TEST statements. Model inputs are never labeled genuine
SDK, CMS, OCSP or natural user acceptance. Tests cover old/current terms and
document bytes, deterministic ordering, text policy, missing/duplicate/unknown
records, byte/count limits, journal replay, receipt links/binding, mixed scope
and action downgrades, serialized JSON ambiguity, CLI sanitization and the
all-content rewrite/rehashed-file limitation, plus accepted backward-clock
service records. Server/HTTP integration and real
SDK/browser acceptance belong to the main integration and are not established
by these tests.
