# Participant pre-demo security review

Date: 2026-10-03. Reviewed source baseline: `fc13af1ebfc61d633d3ad492ac62716892fd3b11`.

Result: no actionable security or correctness blocker observed within the existing local unsigned and MODEL personal-signed participant paths. This is a bounded review, not certification or permission to release. The reviewed implementation files remained unchanged during the audit.

## Scope and severity

- Security first, then correctness: participant accounts/sessions, recipient-bound invitations, membership and role/state checks, documents, feedback/reputation, evidence export, personal TEST signature boundaries, client recovery behavior, source DOM sinks, and runtime snapshot/restore.
- Observed findings: P0 = 0, P1 = 0, P2 = 0. No core implementation changes or new permanent test file were made; the existing named regressions and additional disposable HTTP probes passed.
- New demo/preflight modules being developed concurrently were excluded from the initial review; their stable follow-up appears below.
- Only new disposable directories/listeners and MODEL certificates were used. No retained databases, registries, mapping keys/checkpoints, passwords/P12, genuine SDK signing, devnet/RPC, browser/headless/CDP, alternate UI port, external messages, commit or push.

## Evidence

The parent supplied the pre-review default gate: 476 passed, 6 opt-in SDK tests skipped, 0 failures; source syntax passed before review. That full-suite count is parent-provided evidence.

The independent focused rerun completed with **111 passed, 0 failed, 0 skipped**:

```sh
node --test \
  web/participant-server.test.mjs \
  web/participant-security.test.mjs \
  web/signed-participant-server.test.mjs \
  web/signed-participant-security.test.mjs \
  web/participant-client.test.mjs \
  web/participant-feedback-controller.test.mjs \
  web/participant-signing-client.test.mjs \
  web/participant-delivery-client.test.mjs \
  web/participant-runtime.test.mjs \
  nca/participant-signatures.test.mjs
```

Additional independent HTTP probes ran complete unsigned and MODEL personal-signed flows against fresh stores and loopback listeners. They exercised the following boundaries:

| Boundary | Observed negative/positive checks | Source points |
| --- | --- | --- |
| Addressed invitation | Self-target invitation refused with 403; outsider and creator could not claim the recipient's code (404); addressed buyer joined (200). | `web/participant-store.mjs:450`, `web/participant-store.mjs:471` |
| Membership and private reads | Outsider deal/documents/events/reviews/reputation/evidence reads returned 404. A participant in another deal could not fetch a known document ID from the wrong deal (404). | `web/participant-server.mjs:251`, `web/participant-store.mjs:621` |
| Sessions and signing intents | Two sessions for the same account could read that account's deal. Using one session's CSRF token in the other refused (403). A MODEL enrollment intent could not be submitted by another session or account (404). Exact CMS retry was historical; altered CMS retry refused (409). | `web/participant-server.mjs:126`, `web/participant-server.mjs:140`, `nca/participant-signatures.mjs:584` |
| Roles/state and direct EDS bypass | Buyer could not offer. Stale version and changed snapshot refused. Signed `/events` refused with 403; signed transitions used exact MODEL intent/receipt linkage. Changed review retries refused with 409. | `web/participant-store.mjs:679`, `web/participant-store.mjs:699`, `web/participant-server.mjs:286` |
| Legacy exposure | Legacy draft/personal/registry paths and attempted memo-authorization routes returned 404 on the participant listener. Only the participant API prefix and explicit assets are served. | `web/participant-server.mjs:168`, `web/participant-server.mjs:247` |
| Upload/download safety | An injected filename/CRLF extra field refused (400). Printable HTML/script-shaped TEST text round-tripped as bytes, with `application/octet-stream`, `nosniff`, `no-store`, and a UUID-derived attachment filename. | `web/participant-server.mjs:270`, `web/participant-server.mjs:304` |
| Evidence privacy | Exact package fields; raw uploaded TEST document bytes preserved; unrelated deal IDs, access codes/hashes, CSRF/session identifiers, CMS, mapping keys, person/organization IDs absent. Unsigned package had no receipts; MODEL signed package linked four public event receipts. Offline verification reported only integrity/consistency. | `web/participant-store.mjs:496`, `web/participant-evidence.mjs:39`, `web/participant-evidence.mjs:303` |
| Error sanitation and expiry | Injected private internal and SDK exception messages were replaced by `unavailable` / `verifier_unavailable` error codes. Logging did not expose request/SDK contents. Logout invalidated its own session while another authorized session remained usable; expiry then refused private reads (401). | `web/participant-server.mjs:315`, `web/participant-server.mjs:202`, `nca/participant-signatures.mjs:613` |

The source DOM-sink scan found text rendered through `textContent`/element creation, UUID-derived API download links, and object-URL JSON exports. No `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `eval`, or `new Function` sink was found in the reviewed participant UI modules (`web/participant-client.mjs:673`, `web/participant-client.mjs:697`, `web/participant-client.mjs:946`). This is source inspection, not rendered XSS acceptance.

## Named recovery/security regressions

The focused run included existing cases for session expiry during mutation and feedback persistence; invitation expiry during redemption; nested signature session/expiry guards; changed manifest and wrong signer; confirmed review followed by an expired read; expiry during WebCrypto evidence checking; cross-role/private-field evidence rejection; real listener restart; captured backup byte identity; concurrent launcher exclusion; canonical ancestor-alias overlap; and preservation of replacement owner files after post-write failure.

The confirmed-write/failed-read distinction is enforced before subsequent reads (`web/participant-client.mjs:413`, `web/participant-client.mjs:447`) and checked by `confirmed review followed by an expired read is never replayable`. The catch path distinguishes an already-confirmed write from an unresolved pinned request (`web/participant-client.mjs:468`).

Runtime recovery retains the previously reviewed fixes: canonical overlap paths, a shared exclusive launcher/snapshot lease, one captured byte image for restore plus readback verification, refusal to overwrite existing destinations, and no automatic data-artifact deletion on failure (`web/participant-runtime.mjs:77`, `web/participant-runtime.mjs:343`, `web/participant-runtime.mjs:385`, `web/participant-runtime.mjs:397`). Signed backups/restores remain explicitly refused because their key/MAC recovery contract is separate.

## Unproven gates and limits

- Browser QA at 4177 is denied by saved user preference. No rendered interaction, visual/accessibility acceptance, NCALayer browser interaction, or natural two-person user acceptance was performed. Disposable HTTP listeners are backend boundary probes, not an alternate UI-port workaround.
- Genuine SDK/EDS/certificate status and replacement, real identity/business authority, wallet custody/payment, Solana/devnet publication, production deployment and release acceptance are unproven here. MODEL tests and historical receipt fields do not establish them.
- Evidence exports intentionally contain the uploaded document text. Schema whitelisting excludes credential/identity machinery; it does not automatically redact personal information that an operator places inside a TEST document. Use anonymized fixtures.
- Runtime leases coordinate cooperative owner-process launchers. Direct server/library callers are outside that lease contract. No hostile same-UID/full-host custody or protection against complete coordinated database rewrites is claimed. Failed operations retain private residue for owner inspection.
- The initial review did not cover concurrent demo/preflight work. The follow-up below is bounded local review; the parent still owns integrated gates and acceptance.

The Code Reviewer and AI Regression Testing guidance informed security-first source inspection and focused negative/error-path checks. Existing regression evidence was reused; no blanket performance/style rewrite or new testing infrastructure was introduced.

## New-module follow-up — 2026-10-04

This follow-up covers the final stable uncommitted `signer/devnet-preflight.mjs`, `signer/solana/preflight-message.mjs`, and `web/participant-demo.mjs` on baseline `fc13af1`. The original no-findings conclusion did not cover their earlier versions. After the corrections below, no remaining actionable P0/P1/P2 blocker was observed in the bounded local tooling. Only disposable local fixtures and mocked RPC/fetch were used; no network, genuine SDK signing, retained state or browser was accessed.

### Resolved startup finding

The parent reproduced a real standalone CLI failure: the platform `process.env` prototype was rejected before RPC, and its configuration code collapsed to a generic RPC failure. The owner added a descriptor-only null-prototype environment snapshot at the standalone entry point and preserved the fixed configuration error code (`signer/devnet-preflight.mjs:407`, `signer/devnet-preflight.mjs:439`, `signer/devnet-preflight.mjs:43`). The new unsupported-CLI subprocess regression passes. Independent positive startup checks on the final patch, using normal platform environment plus an in-memory fetch stub, also reach `PARTIAL` for walletless/public-wallet inputs with exactly 3/5 fixed read calls, exit 0, and `overallReady`/`executionEnabled` still false. These are transport-mocked CLI checks, not live-chain evidence.

### Resolved P2 — changing model values bypassed result sanitation

The pre-fix `validateLatest()` (`signer/devnet-preflight.mjs`, then lines 187–190) validated `getLatestBlockhash()` properties, then reread them when copying. An enumerable accessor returned a valid 32-byte hash and integer height 100 on its first read, then private sentinel strings on the second. With final block height 200 the walletless probe returned `PARTIAL`, `network.ready=true`, and echoed both unvalidated strings instead of refusing the malformed/expired result.

Deterministic failing-before reproduction: inject an RPC whose genesis is the fixed devnet genesis, latest result is `{ get blockhash() { return ++b === 1 ? VALID_HASH : 'PRIVATE_SENTINEL'; }, get lastValidBlockHeight() { return ++h === 1 ? 100 : 'PRIVATE_HEIGHT'; } }`, and final height is 200. Both getters ran twice; the returned report contained the sentinel strings. The default JSON transport cannot return accessors, so this concerned the declared programmatic/MODEL boundary, not network signer or execution authority.

The related exact-data boundaries originally admitted config/compiler proxies, CLI argument accessors, and injected method getters. The first correction copied descriptors but detected proxies via raw `structuredClone()` after reflection. Independent probes still invoked 4/6/5 config/compiler/argv metadata traps; a dependency proxy was accepted; cloning invalid nested wallet/fee-payer objects invoked their getters. Those mechanisms were reported before acceptance and corrected too.

The final implementation checks `node:util` proxy identity before reflection and uses descriptor-only copying, with no raw recursive clone (`signer/devnet-preflight.mjs:49`, `signer/devnet-preflight.mjs:79`, `signer/solana/preflight-message.mjs:26`). Latest values come from the single copied data snapshot (`signer/devnet-preflight.mjs:232`). Injected RPCs require own data-valued, non-proxied methods and capture those functions once (`signer/devnet-preflight.mjs:259`); synchronous proxy results are refused before `await` assimilation (`signer/devnet-preflight.mjs:303`).

Independent final rerun: the original latest-getter reproduction returns exactly `REFUSED` / `preflight_invalid_rpc_result`, `network.ready=false`, zero getter evaluations, and no sentinel echo. Nineteen independent checks, including that reproduction, cover metadata traps/revoked proxies at config/compiler/argv/env/dependency/RPC boundaries, nested getter values, injected method getters, and indexed CLI accessors: all relevant callback counts are zero and refusal codes are fixed. An async adapter returning a revoked proxy rejects during native Promise assimilation before result validation; this correctly sanitizes to `preflight_rpc_failed`. A directly returned proxy remains specifically `preflight_invalid_rpc_result`; plain malformed/accessor/symbol result regressions were not weakened to a broad error match.

### Resolved P3 — revoked demo option error shape

The final demo options guard checks proxy identity before `Array.isArray` (`web/participant-demo.mjs:48`). A revoked options proxy previously threw a native `TypeError` instead of `demo_options_invalid`, still before disk/network. The parent's failing-before named regression and the independent final check now produce the fixed refusal with no new directory. This was a non-blocking error-shape issue, not an authorization or data-loss bypass.

### Final bounded verification

The final focused command completed with **35 passed, 0 failed, 0 skipped** (28 preflight/RPC/offline Memo tests plus 7 demo tests):

```sh
node --test signer/devnet-preflight.test.mjs \
  signer/solana/devnet-rpc.test.mjs signer/solana/memo-builder.test.mjs \
  web/participant-demo.test.mjs
```

- Fixed fee-message bytes were independently decoded: version 0, exactly two static accounts (public fee payer and the fixed Memo program), one fixed Memo instruction, zero instruction account arguments, zero address lookups, no signature bytes or appended transaction data. The preflight path invokes only genesis/latest/balance/fee/height reads, with genesis first and height last; null fee, over-cap fee, insufficient balance, expiry and failures remain refusal, never execution permission (`signer/devnet-preflight.mjs:318`, `signer/devnet-preflight.mjs:357`). All authority/security/UI/renewal/execution gates stay `NOT ACCEPTED`; signer stays `NOT CONFIGURED`.
- Nineteen independent demo input/target checks passed: signed/SDK/mode/unknown keys, accessors, ordinary/revoked proxies, non-enumerable options and invalid ports refused before new target creation; metadata traps/getters remained zero. Existing owner file and symlink targets were preserved. Only `runDirectory`, `port` and the trusted test clock are accepted (`web/participant-demo.mjs:46`, `web/participant-demo.mjs:355`).
- A real-filesystem post-write failure probe replaced the newly generated final report with a pre-existing disposable owner file immediately before verification. `demo_artifact_changed` preserved both replacement owner bytes and the moved generated report, retained run/runtime modes 0700 and operator-file mode 0600, and released the runtime lease (`web/participant-demo.mjs:157`, `web/participant-demo.mjs:422`). No automatic data-artifact cleanup or overwrite occurred. Existing tests independently cover occupied-port residue and explicit `--serve` SIGTERM shutdown.
- Bearer codes are confined to the owner-only operator file, not public reports/evidence or CLI output; fixtures remain explicitly anonymous unsigned TEST statements, with zero signed receipts (`web/participant-demo.mjs:247`, `web/participant-demo.mjs:382`, `web/participant-demo.mjs:390`).

Acceptance remains narrow: injected RPC methods/test clocks are trusted in-process callbacks, not a hostile same-UID security boundary; offline Memo tests use synthetic cryptography, not genuine certificate SDK signing or custody acceptance. No browser interaction, natural two-person acceptance, certificate/identity/business authority, payment, publication or release was proved here. The parent separately owns actual prepared-fixture/live-walletless checks and final full-suite integration. This report is not certification or execution authorization.

The parent subsequently supplied final stable integration evidence: 498 Node tests passed, 6 opt-in genuine SDK tests skipped (504 total), 20 offline Solana tests passed, 3 critical P2 checks passed, and syntax/diff/document-link checks passed. The parent also checked the final actual walletless read-only snapshot and left the pre-existing 4177 listener untouched. These are parent-provided gates, not independently repeated full-suite/live-network/browser evidence from this reviewer.
