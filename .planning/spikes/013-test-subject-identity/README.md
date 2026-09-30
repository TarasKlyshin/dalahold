---
spike: 013
name: test-subject-identity
type: standard
validates: "Only exact, trusted, fresh TEST CMS can yield opaque typed subject IDs; two eligible certificates for one actor map to the same actor, not corporate powers"
verdict: PARTIAL
related: [001, 012]
tags: [nca, identity, privacy, rotation, test-only]
---

# Spike 013: opaque TEST subject identity

Baseline: local `main` at `513214fd7c47477c95662c102d863e7172f78b20`.
User approved the next identity/replacement step. No push, production key,
wallet creation, devnet, corporate grant or HTTP account mutation is authorized
by this spike's test-signature receipt.

## Plan and acceptance

1. Extract structured X.509 subject attributes from the **server-verified leaf**,
   never browser fields or a split DN string. Enforce a single KZ country and
   IIN attribute; distinguish an optional BIN organization context. Reject
   missing, duplicate, malformed or ambiguous identity attributes. Map person
   and organization separately with a caller-supplied 32-byte HMAC key. Raw
   identifiers, subject names and that key never leave the Java process output.
2. Add an opt-in internal SDK identity call, only after exact CMS, trust,
   purpose, expiry and fresh TEST status pass. Keep the existing test-signature
   API unchanged: no owner or business permission from a probe receipt.
   Reuse Java SDK primitives and Node crypto/SQLite, no new dependency.
3. Prove mandatory genuine SDK cases: individual and director have different
   certificates but one person mapping with different organization context;
   the signing employee is a different person within that organization. The
   ordinary employee in `valid` is actually revoked according to fresh TEST
   OCSP and must produce no identity. Revoked, wrong-purpose
   and tampered CMS yield no identity. Test the mapping with the existing
   isolated OwnerStore, restart and stale-credential rejection; any wallet
   address/powers in that storage test are explicitly trusted offline fixtures.

The 12 current bundled profiles were inspected locally without `getKey` or
raw subject output. Individual valid/revoked share one person; signing/ordinary
employees share another. The director shares the individual's person ID;
legal-entity profiles share one organization ID. Treasury lacks an IIN and
the required signing EKU, and remains ineligible. Sharing a BIN must not merge
employees or grant representation rights.

The first genuine positive-pair test failed because the `Сотрудник организации/valid`
certificate received trusted/fresh TEST OCSP `revoked`. No guard was weakened
and that refusal is now mandatory. Folder labels are not status evidence. A
same-role renewed employee certificate is still needed for the full user rebind.

## Workflow and safety limits

Ponytail reuses the existing SDK and owner-store test boundary. GSD quick was
inspected but its required active ROADMAP and gsd-sdk are absent; no full GSD
execution or generated replacement roadmap is claimed. Use the existing spike
manifest and an atomic local commit instead. No independent review is yet claimed.

The optional HMAC key in tests is ephemeral and never argv/env/logged. A future
durable deployment must protect and back up a stable mapping key and reject
accidental key replacement; it must not silently remap existing owners.
Corporate powers and personal-vs-organization account policy remain separate
gates. Parsing a subject is not authenticating it; a probe receipt is not an
enrolment/rebind instruction. Do not automatically bind historical probe receipts.

## Evidence and sources, 30 September 2026

The current bundled leaf schema was inspected locally as structured DER:
exactly one country `KZ`, `SERIALNUMBER` / OID `2.5.4.5` with an IIN, and an
optional organization `OU` / OID `2.5.4.11` with a BIN and organization name.
The [NCA CPS v3 subject tables](https://pki.gov.kz/docs/npa/CERTIFICATION%20PRACTICE_STATEMENT_v3.pdf)
describe these fields. That is a **2016 document**, not proof of current
production validation rules; the mapper is deliberately limited to the pinned
TEST issuer and observed fixture schema. Unsupported schemas refuse; no
inference from CN, certificate serial number, role name or wallet is used.
This validates attribute shape and CA-issued test claims, not population-register
semantics or legal representation. No date/sex/checksum heuristics are added
to the synthetic SDK identifiers.

## Implemented and tested

- `CmsVerifier.subjectIdentity` consumes structured verified-leaf DER. Duplicate
  country/IIN/BIN, missing fields, wrong prefixes, non-ASCII digits and ambiguous
  organization context refuse. Person and organization IDs use independently
  domain-separated HMAC-SHA256, including a TEST namespace and issuer pin.
  Names, roles and changing certificate digests are not identity inputs.
- `prepareSdk.verifyIdentity(bytes, cms, mappingKey)` is explicitly opt-in and
  internal. The 32-byte key is supplied through process stdin, not argv/env or
  logs. Exact CMS/CA/purpose/current validity and fresh status must pass before
  any identity appears. Status expiry is checked again before identity output.
  Normal `verify` and the HTTP stand remain signature-only.
- Genuine TEST OCSP accepts current individual, director and signing-employee
  fixtures. Individual/director have **different certificate digests and the
  same person ID**; director/signing employee have the same organization ID and
  **different person IDs**. Organization context remains explicit/null, never
  converted into powers or an owner ID. This is not a same-role renewal UAT.
- The ordinary employee under `valid`, the individual `revoked`, the wrong-
  purpose Treasury fixture and altered signed bytes all produce **no identity**.
  The employee refusal is explicitly `ocsp_status_revoked`, not a timeout.
  Changing the HMAC key changes IDs; losing/changing a future durable key must
  therefore block registration rather than silently create another owner.
- Thirty synthetic subject-parser checks pass; they are not authenticated
  certificate proofs. The separate genuine SDK run passes without skips.
- A failing regression showed that the test-key harness could follow a key-root
  symlink outside its configured SDK directory. It now checks real paths against
  both the SDK root and approved test-key subtree before opening a P12; the
  regression passes. Only bundled test keys were used to demonstrate this, not
  a personal key. Normalized legal-profile directory selection rejects ambiguity.
- Existing OwnerStore accepts the verified opaque person ID in a **trusted
  temporary storage fixture**, retains one owner ID and the literal fake address
  `OFFLINE-WALLET-FIXTURE-NOT-SOLANA` after replacement/restart, increments the
  epoch and rejects a foreign person and stale certificate/epoch. This does not
  create an actual wallet or prove a complete NCA-authorized rebind instruction;
  no corporate powers policy is connected.
- A new HTTP regression rejects browser identity fields, never invokes the
  optional mapper, drops even injected identity/powers/owner fields from its
  test receipt and creates no owners table. No public account endpoint is added.
- Stable-code verification: 89 local Node + 7 offline Solana cases; four SDK
  runs (default CRL refusal, 47 OCSP checks, live TEST OCSP HTTP/genuine negatives,
  identity/parser/storage compatibility). All pass without skipped SDK cases.
- Tools-disabled read-only Claude review requested `claude-opus-5-5` / max and
  timed out after 60 seconds without output. Actual execution model and independent
  review remain unconfirmed; no model/auth fallback was used.
- Existing runtime remains the prior signature-only stand: page/status HTTP 200,
  explicit TEST OCSP local config ready, saved manual receipt ID/hash/verifiedAt
  unchanged, and no owners table. It was not restarted or enrolled into the new
  optional mapper; the new method is library CODE/TESTED, not browser RUNTIME/UAT.

```sh
NCA_SDK_ROOT='/path/to/SDK 2.0' node --test nca/identity.test.mjs
```

## Remaining gate

PARTIAL: identity evidence and offline storage compatibility are implemented
and tested, **not deployed into browser accounts or business authority**. No
durable mapping key was generated and no existing probe receipt was bound.
Before browser enrolment/rebind: protect/back up a stable mapping key with
fail-closed key-change handling; define personal versus organization account
policy; sign a dedicated exact enrolment/rebind intent and recheck freshness at
atomic commit; obtain suitable same-role replacement fixtures; complete security
review and corporate powers verification where required. Wallet and devnet
acceptance remain separate. The existing stand and saved manual UAT receipt
are intentionally left intact.
