# Local verification — Spike 025

Date: 3 October 2026. Baseline: clean `main`,
`31c98abb0baf7eb6f177fce8f1bd1f6c9147b343`. This is a local TEST change,
not a public deployment, production identity workflow, live devnet send or payment.

## Acceptance and execution

| Check | Result | Evidence level |
|---|---|---|
| New delivery helper, shared-controller integration and runtime suite | 38/38 passed; zero failures/cancellations/skips | Node protocol, disposable HTTP/storage and cooperative local runtime |
| Helper portion of the above | 20 passed | Strict schemas/roles/limits/WebCrypto; no browser or SDK execution |
| Controller portion of the above | 10 passed | Unsigned and explicitly MODEL personal-signed fixtures; not genuine identities |
| Runtime portion of the above | 8 passed | Real disposable listener shutdown/restart, persistence and stopped unsigned recovery |
| Stable full default Node regression | 476 passed, 6 deliberately skipped SDK groups; zero failures/cancellations | All SDK opt-in groups disabled, never replaced with a genuine-flow claim |
| Offline Solana suite | 20/20 passed; zero failures/cancellations/skips | Offline bytes and transport models; no live RPC/send |
| Independent recovery review | All four original findings and the final cleanup P1 closed; no new actionable blocker | Deterministic disposable real-filesystem races, not hostile same-UID or production certification |
| Syntax and whitespace | All changed/new JS `node --check` and `git diff --check` passed | Source checks only |
| Rendered UI/visual/a11y/download interaction | **Not performed / blocked** | Approved browser service refused before navigation |
| Genuine two-person NCALayer flow and positive renewal | **Not performed / material absent** | SDK file inventory only this turn; no P12/password access or genuine SDK rerun |

The 38 focused tests are included in the default regression, not additional
unique tests. Existing client/signing protocol regressions also pass, including
existing MODEL DOM cases; none constitutes actual browser interaction.
The final detailed stable run reports 482 total checks (476 pass, 6 skip) in
16.641 seconds, exit 0. A preceding stable dot-reporter run also exited 0; its
compact output was not used as the source of numerical counts.

The first seven newly added controller checks were run before implementation:
all seven failed on absent `refreshFeedback` / `exportEvidence` methods, then
passed after integration. Three additional checks exercise a confirmed review
followed by 401 (no replay), invalid/private/wrong-role evidence (no returned
payload), and session expiry during the WebCrypto await (no late download).
Both scopes serve the new JS asset with correct MIME and no-store headers in
ordinary disposable HTTP tests. These are server/client contracts, not UI QA.

Recovery review initially reproduced recursive cleanup deleting a replacement
directory, a restore checksum/copy mismatch, a snapshot/startup lease race and
ancestor-alias overlap. After those fixes the reviewer reproduced a narrower
last-identity-check-to-unlink data-loss window. The final implementation removes
all automatic data-file/directory deletion from failed operations; private
residue is retained for owner inspection. Independent snapshot AND restore
post-write failure probes preserve generated and replacement-owner data, with
zero data-artifact deletions. Only the cooperative own lease marker is released.

## Actual fresh runtime and recovery

Main created `.local/ui-025.b5sbJm` as a new private empty unsigned stand.
The initial direct server was gracefully stopped before use of the new launcher;
no absence-of-marker assumption was applied to a still-running direct caller.

The stopped source was snapshotted and restored through the reviewed helpers:

- Backup: `.local/ui-025-owner-backup-c568c951-4a13-47be-b3f9-ad5b8c66536e`.
- Restored stand: `.local/ui-025-owner-restore-c568c951-4a13-47be-b3f9-ad5b8c66536e`.
- Database: 135168 bytes, SHA-256
  `969cea8b155823d9686cb47dd75cc9bebf66b8595b3cac5a9bf8c8683d15c8af`.
- Source/backup/restored directories are `0700`, databases `0600`.
- Restored kind is `dalahold.local-test-participants.v1`; SQLite integrity is
  `ok`; participants/deals/events/reviews counts are all zero.
- A real restored listener started on an ephemeral port, returned anonymous
  unsigned TEST session scope, closed, removed its own lease, and retained the
  identical database digest. This is backend verification, not denied UI access.

The current-code CLI launcher was then left running on **127.0.0.1:4177**,
PID **58578** at verification time, using the original new empty directory.
An actual anonymous API read returned 200, the unsigned scope, no-store and an
HttpOnly/SameSite=Strict capability cookie. No token/cookie/CSRF value was printed.
This proves local listener/API readiness, not rendered usability or a signed deal.

Persistence of non-empty accounts, exact documents, immutable events, both role
reviews and full evidence is proven separately in disposable runtime fixtures:
stop/restart invalidates memory sessions, private bearer login recovers the same
records, and stopped snapshot/new-directory restore recovers exact bytes.
The operator's new empty stand was not seeded to imitate human or browser UAT.

Snapshot exclusion is cooperative with `startParticipantRuntime`, not other
direct server callers or a hostile same-UID process. Stale leases/sidecars refuse;
there is no automatic stale-lock removal, power-loss durability or production
recovery claim. Signed backup/restore is closed pending its protected key/MAC
contract. Failure residue is not treated as a valid complete backup.

## Browser and certificate gates

The approved tool successfully read its empty enabled-tab inventory, then
refused `http://127.0.0.1:4177/participants/` before navigation. Its current reason
was a **saved user permission setting blocking the origin**. This is a fresh
reason, distinct from earlier historical administrative-policy failures.
The user was asked to restore permission. No alternate browser/port, raw CDP,
headless, screenshot or indirect UI substitute was attempted. Source inspection,
ordinary API/asset contracts and protocol tests are not reported as a browser
download, keyboard/visual/anti-slop pass or natural acceptance.

Read-only SDK inventory found 2 public CA `.cer` files and 24 TEST P12 containers:
2 current personal, 2 old personal and 20 organization profiles. No separate
public personal leaf certificate or additional eligible fixture was found.
The bundled current good/revoked personal pair belongs to the same identity,
as previously established by the genuine Spike 022 gate. It is not two signers.
The inventory opened no P12, read no password and did not reopen retained
binding/key/checkpoint data. No existing genuine result was relabelled as a
new successful renewal or two-person acceptance.

The user has been asked for a different-person personal TEST public certificate
path for the second party, and eligible same-person renewal material separately.
The supervised [UAT](UAT.md) is prepared but unexecuted. No historic revoked
binding is fabricated; organization profiles do not grant personal role authority.
The participant signed cabinet still pins epoch 0; renewal is the distinct
Spike 017 workflow, not an automatic participant permission update.

## Repeatable commands

From repository root:

```sh
env -u NCA_SDK_ROOT node --test --test-reporter=spec web/*.test.mjs authority/*.test.mjs workflow/*.test.mjs signer/*.test.mjs nca/*.test.mjs .planning/spikes/001-order-policy/policy.test.mjs
node --test --test-reporter=spec web/participant-runtime.test.mjs web/participant-delivery-client.test.mjs web/participant-feedback-controller.test.mjs
git diff --check
```

From `signer/solana`: `node --test --test-reporter=spec`.
Launcher and stopped recovery commands are documented in [RUNTIME_RECOVERY.md](RUNTIME_RECOVERY.md).

Browser QA and Anti-Slop UI Audit required real rendering; the access refusal
prevented that phase. AI Regression Testing guided explicit retry/expiry and
failure cases. No skill output is treated as independent security certification.
Retained cabinets, certificate registries, keys and checkpoints remain untouched;
there is no push, external publication, live devnet transaction or payment.
