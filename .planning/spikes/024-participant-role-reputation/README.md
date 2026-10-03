---
spike: 024
name: participant-role-reputation
type: standard
verdict: PARTIAL
related: [019, 020, 022, 023]
tags: [test-only, roles, feedback, idempotency, privacy]
---

# Local TEST role reputation and integrated delivery

Prepared from clean `main` at `e2dc825a8a123cdee0d2cca62422aa94249e1f65`.
This slice implements durable feedback and evidence collection in both isolated
participant cabinets. It does not enroll a real counterparty, migrate unsigned
events into signed ones, change the old personal certificate registry, enable
Memo execution or move money. Existing UI controls are unchanged; the new
features are library/API capabilities, not accepted browser interactions.

## Rules

- A member may submit a score from 1 through 5 only after `accepted`. Draft,
  offer, agreement, handover and terminal dispute cannot earn a rating.
- The server derives author, counterparty and the rated counterparty's role
  from that exact deal. No client-supplied target, author, role or comment is
  accepted. One account can earn distinct seller and buyer scores on different
  deals. Self-review is forbidden.
- Each side can submit one immutable review per deal. A new request ID cannot
  edit it. The original exact actor/request/payload returns the same historical
  review after restart; changed score, actor, deal or operation conflicts.
- Every review binds the accepted event, current terms version, state revision
  and full snapshot hash. Review and durable retry receipt commit together;
  the live HTTP session guard repeats before the outermost SQLite commit.
- Feedback is always `unsigned_test_participant_review`, with its own scope
  `local_test_role_reputation_only` and `signatureVerified:false` in summaries.
  `dealScope` labels the underlying unsigned or personal-TEST deal. Even on a
  personal TEST signed deal, the feedback itself is not signed by NCA.
- Reads cross-check review rows against durable exact-payload receipts and the
  validated accepted deal. Bounded damaged-row/receipt/deletion mismatches fail
  closed. This is not protection from an owner rewriting or rolling back the
  entire database. Anonymous capability accounts are not verified identities;
  sybil activity, collusion and real-world performance are not authenticated.

`participant_reviews` is an additive empty schema for the compatible dedicated
participant databases. No historical review is invented. Signed/unsigned store
kinds remain incompatible, and the old personal-binding database is not used.
This session tested migration only in disposable stores; retained runtime
databases have not been reopened/migrated or filled with sample feedback.

## API

All routes use the existing loopback Host/Origin/Fetch-Metadata, private session,
CSRF for POST, body limits, per-session/global rate limits and no-store responses.
Outsiders receive 404 before any deal/review detail lookup. There is no arbitrary
participant-ID lookup or public rating directory.

| Method | Path under `/api/participants/v1` | Result |
|---|---|---|
| GET | `/reputation` | Own account's seller/buyer summaries |
| GET | `/deals/:dealId/reputation` | The deal parties' role summaries, without unrelated deal IDs/documents |
| GET | `/deals/:dealId/reviews` | At most two reviews for this deal |
| GET | `/deals/:dealId/reviews/:reviewId` | One member-visible review |
| POST | `/deals/:dealId/reviews` | Fresh immutable review (201) or exact historical retry (200) |
| GET | `/deals/:dealId/evidence` | Full bounded JSON evidence attachment, read-only |

POST review body is exactly:

```json
{
  "requestId": "lowercase-uuid",
  "expectedVersion": 1,
  "expectedStateRevision": 4,
  "snapshotHash": "64-lowercase-hex-digits",
  "score": 5
}
```

Fresh creation and historical retry include the same safe `review` and a
`historical` boolean. Location resolves to the member-visible review resource.
Each summary has `participant`, `roles`, `scope`, `source`, `dealScope`,
`signatureVerified:false` and `eligibility:'accepted_local_test_deals_only'`.
Each role contains `count`, `scoreTotal` and a two-decimal `average`, or null
when there is no feedback. Partner summaries intentionally disclose aggregate
counts/totals/averages; they do not disclose unrelated deal identifiers or files.
The dedicated stores keep unsigned and personal TEST deal statistics separate.

Invalid fields/coercions are 400; unauthenticated/expired sessions 401;
Origin/CSRF failures 403; outsider/unknown resources 404; stale state/snapshot,
duplicate review, changed request payload or damaged storage 409; existing
capacity limits 413 and rate limits 429. There are no review edit/delete routes.

## Evidence integration

`ParticipantStore.getEvidencePackage` checks membership and collects all archived
versions, exact private `.txt` bytes and the event journal in one SQLite read
snapshot. For personal TEST events, `ParticipantSignatures.receiptForEvent`
validates the protected accepted CMS/receipt/event record and MAC before returning
only public receipt fields. It does not return CMS, subjects, mapping keys,
session/access codes, enrollment/anchor receipts or executable grants.

The GET returns `attachment; filename="test-evidence-<deal-uuid>.json"` with
JSON/no-store/nosniff. No file extraction, SDK/status check or persistent write
is performed. A historical receipt is not a new status check or authorization.
Expired historical receipts remain exportable after a new authenticated session.
The [format and CLI](../023-participant-evidence/README.md) check only bounded
file integrity and structural consistency, not provenance, live OCSP, legal
force, corporate powers, real goods, blockchain execution or payment.

## Verification and acceptance

Focused commands:

```sh
node --test --test-reporter=spec web/participant-reputation.test.mjs web/participant-delivery.test.mjs web/participant-security.test.mjs web/participant-evidence.test.mjs
```

Checks cover role separation, rejected ineligible states and input injection,
global exact retry IDs, preserved reviews after restart, damaged-row/receipt
refusal, legacy empty migration, final-commit rollback, and actual HTTP session
expiry during review persistence with a successful fresh-session retry.
Both unsigned and explicit MODEL signed HTTP flows exercise full old/current
document and version export, member privacy, no-write readback, expired-session
and historical read behavior. Corrupt protected signed receipts refuse export.
MODEL signed acceptance is not two real signers or genuine NCA/browser UAT.

Independent read-only review found no actionable issue in the feedback/store/API
scope, with 39 additional adversarial checks across 13 damaged review/receipt
variants and an HTTP expiry/rollback probe. Those probes supplement the durable
tests; they are not production certification or natural user acceptance.

The integrated stable-code test counts are recorded in `VERIFICATION.md`.
The bundled genuine valid/revoked regression is separately reported in
[Spike 022](../022-permanent-sdk-pair/README.md).

## Remaining gates

Browser QA is still administratively denied: the service cannot verify its
admin-enforced access policy. Prior user authorization did not remove that
service restriction. No alternate browser/port, indirect UI automation or
headless workaround was used. The existing cabinet's plain JSON-summary button
is unchanged; a new evidence/reputation UI can be integrated and accepted only
when permitted browser interaction is available.

No retained account, certificate registry, checkpoint or live operator database
was altered in this session. No public deployment, push, devnet send or real
payment occurred. Two genuine distinct personal TEST participants, legitimate
positive certificate replacement, business authority and full UI/human
acceptance remain independent gates.
