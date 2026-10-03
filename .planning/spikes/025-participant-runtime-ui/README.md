# Spike 025 — isolated runtime and participant delivery UI

Date: 3 October 2026. Source baseline: clean `main`,
`31c98abb0baf7eb6f177fce8f1bd1f6c9147b343`.

This slice takes the evidence and role-feedback APIs from Spikes 023–024 into
the participant client, and provides a separate current-code TEST launcher.
It never upgrades the old anonymous draft routes or old certificate registry
into participant permissions.

| Requested step | Implemented boundary | Remaining acceptance |
|---|---|---|
| Current-code runtime and recovery | New private launcher, cooperative exclusive lease, stopped unsigned snapshot/new-directory restore and persistence tests | Not production recovery; signed key/MAC backup is deliberately refused |
| Evidence, document history and role feedback UI | Full-package download handler, separate summary download, existing document history, buyer/seller summaries and one immutable unsigned review per side | Actual rendered browser interaction and human acceptance are open |
| Genuine two-person signing and legitimate renewal | Existing fail-closed signed path retained; required material inventoried and a supervised runbook prepared | No eligible different-person personal TEST credential or eligible same-person renewal fixture found; genuine positive flows are not completed |

## Client implementation

`web/participant-delivery-client.mjs` is a browser-safe transport module. It
has no SDK, filesystem, DOM or network-write capability. It rejects unexpected
fields, wrong participants/roles/scope, inconsistent aggregates and malformed
reviews. Evidence is streamed with a 16 MiB actual-byte cap, strict UTF-8 and
duplicate-JSON-key refusal, exact public schemas and a WebCrypto package SHA-256
check. It retains the exact base64 file bytes.

This thin transport check is not the Node offline business-consistency verifier.
It does not recompute every nested file/terms digest, establish CMS provenance,
perform fresh OCSP or prove chronology. The separately downloaded package can
be checked using the existing `web/verify-participant-evidence.mjs` command
documented in Spike 023. Neither check establishes authenticity, a legal
contract, delivery or payment.

The shared controller loads feedback explicitly rather than representing
unloaded data as zero. An accepted deal permits one score of 1–5, only after
explicit consent. The server derives the counterparty and their per-deal role;
the form cannot choose another target. A disputed deal has no rating action.
Even a personal TEST signed deal has unsigned TEST feedback. Lost-write retry
retains the exact request bytes/ID, and a confirmed write is never replayed just
because a subsequent read failed. Session expiry clears summaries and suppresses
late evidence results, including expiry during the checksum await.

The existing historical document list remains in place. Full evidence download
is distinct from the existing loaded-deal JSON summary. Exact anonymous TEST
text can contain whatever its author entered: schema privacy exclusion does not
redact attachment contents. Never upload actual confidential documents.

## Runtime and browser boundary

[Runtime/recovery procedure](RUNTIME_RECOVERY.md) describes private paths,
launcher leases, stopped snapshots, new-destination restore and failure residue.
No retained cabinet, personal key, binding registry or checkpoint is migrated.
This launcher does not kill another process or automatically remove a stale
lease. Direct callers of the old server API are outside its lease exclusion.

Browser QA and Anti-Slop UI Audit were selected, but the approved browser tool
refused navigation to `http://127.0.0.1:4177/participants/` because of a saved
user permission preference. No alternative port, browser, CDP, headless or
indirect interaction was used. Source changes are minimal and use existing
controls/tokens; there is no rendered visual/a11y/anti-slop pass or download-click
acceptance. Ordinary protocol/legacy DOM regression tests are not a replacement
for that gate. The user has been asked to change the browser-access preference.

## Certificate boundary

The downloaded SDK contains two public CA `.cer` files and 24 private TEST
P12 containers: two current personal, two historical personal and 20 organization
profiles. No additional public leaf certificate was found. This inventory did
not open a P12 or read a password.

The genuine current personal `valid/revoked` pair belongs to one identity. It
cannot serve as independent seller and buyer. Positive renewal needs an eligible
different current certificate for the already-bound person, or an authentic
pre-revocation binding plus its matching key/checkpoint and a freshly valid
replacement. No historical binding is fabricated. Corporate profiles cannot
fill the personal role requirement. The participant signed cabinet pins epoch 0;
renewal remains the separate Spike 017 path, not an automatic client rebind.

[Verification](VERIFICATION.md) records current execution evidence.
[Pending supervised acceptance](UAT.md) separates UI, two-person signing and
certificate renewal. No push, public deployment, live devnet send or payment
is part of this slice.
