# Integrated local TEST verification: 022–024

Source baseline: clean `main`, `e2dc825a8a123cdee0d2cca62422aa94249e1f65`.
Date: 3 October 2026. This report distinguishes code, isolated tests, genuine
SDK evidence and retained runtime/browser acceptance. Test runs use disposable
directories/listeners, not the operator's current certificate/account state.

## Source and completed checks

| Check | Result | Evidence level |
|---|---|---|
| Full Node regression without SDK opt-in | 438 passed, 6 deliberately skipped SDK parents, 0 failed/cancelled | Local/model/storage/HTTP; includes the original six order-policy checks |
| Offline Solana suite | 20 passed, 0 skipped/failed | Offline bytes/model transport; no live RPC/send |
| Focused evidence/reputation/session suite | 40 passed, 0 skipped/failed | Durable storage, private HTTP fixtures, CLI and explicit MODEL SDK |
| New same-person valid/revoked SDK gate | 6 passed, 0 skipped/failed | Five subcases + parent; actual bundled CMS/strict TEST OCSP |
| Existing participant HTTP SDK gate | Passed | One genuine eligible personal identity + real negative cases, not two-person approval |
| Existing terms/document HTTP SDK gate | Passed | Genuine one-sided exact terms/manifest CMS and negatives |
| Existing basic SDK/HTTP OCSP gate | Passed | Genuine exact CMS, purpose/status negatives and historical receipt |
| Existing adversarial Java OCSP gate | Passed | 47 signed synthetic policy fixtures, not live-person approval |
| Existing identity/library/HTTP SDK gate | Passed: 1/1, 89.152 seconds under the final 120-second harness limit | Genuine isolated SDK/library/HTTP checks; no assertions or runtime policy weakened |

The 40 focused tests are included in the 438 Node pass count, not additional
unique checks. The new SDK gate counts its parent and five subcases; do not call
six Node checks six independent genuine human flows. The six default skips
correspond to explicit SDK opt-in tests, not automatically substituted models.

The new pair gate performs three actual fresh identity-verification calls and
two CA-authenticated exact CMS subject comparisons. Revoked enrollment and an
exact revoked replacement candidate refuse with unchanged rows/MAC/key/checkpoint;
valid CMS accepts the same pending enrollment. Exact replay performs no SDK
call or write. Positive renewal and a real second personal identity remain
unproven; no historical revoked binding was fabricated.

The focused package suite demonstrates why a checksum is not authenticity:
an internally consistent full rewrite with new hashes can pass. It also models
backward wall-clock samples accepted by the service; offline reports explicitly
set `chronologyVerified:false`, as well as authenticity/SDK/fresh-status false.
No current status or physical delivery claim follows from a package report.

## Commands executed

From the repository root:

```sh
env -u NCA_SDK_ROOT node --test --test-reporter=spec web/*.test.mjs authority/*.test.mjs workflow/*.test.mjs signer/*.test.mjs nca/*.test.mjs .planning/spikes/001-order-policy/policy.test.mjs
node --test --test-reporter=spec web/participant-reputation.test.mjs web/participant-delivery.test.mjs web/participant-security.test.mjs web/participant-evidence.test.mjs
NCA_SDK_ROOT='/Users/tarasklyshin/Downloads/SDK/SDK/SDK/SDK 2.0' NCA_JAVA_BIN='/opt/homebrew/opt/openjdk@17/bin' node --test --test-reporter=spec nca/personal-pair-sdk.test.mjs
NCA_SDK_ROOT='/Users/tarasklyshin/Downloads/SDK/SDK/SDK/SDK 2.0' NCA_JAVA_BIN='/opt/homebrew/opt/openjdk@17/bin' NCA_TEST_STATUS_SOURCE=ocsp node --test --test-reporter=spec nca/sdk.test.mjs nca/terms-evidence-sdk.test.mjs nca/participant-http-sdk.test.mjs nca/identity.test.mjs nca/ocsp.test.mjs
NCA_SDK_ROOT='/Users/tarasklyshin/Downloads/SDK/SDK/SDK/SDK 2.0' NCA_JAVA_BIN='/opt/homebrew/opt/openjdk@17/bin' node --test --test-reporter=spec nca/identity.test.mjs
git diff --check
```

From `signer/solana`:

```sh
node --test --test-reporter=spec
```

The five-file SDK run completed four gates and cancelled identity at 60000 ms.
The isolated original-limit retry reached the same deadline. Two bounded 180-second
diagnostic runs subsequently completed in 56.412 and 58.055 seconds; neither
was a pass of the original 60-second harness. They left only a marginal time
reserve. The final harness changes only the outer test budget from 60 to 120
seconds and adds sanitized fixed-label timings. All 79 original assertion lines,
the per-Java-process 15-second deadlines, trust/status settings and SDK/runtime
source remain unchanged.

The final 120-second run passed 1/1 in 89.152 seconds, zero failures/cancellations
or skips. All 61 sequential Java invocations completed: 25 signs, 27 identity
verifications, four inspections, one signature verification, two compilations,
one parser and one confinement check. The maximum call took 4.397 seconds;
there were no active calls at completion. Java-related durations totalled
88.615 seconds (99.4% of the measured body). This demonstrates that the complete
normal serial workload can exceed 60 seconds and supports the narrowly increased
test budget, not an authorization/status timeout change. Exact stages at the two
old cancellations were not captured; no exclusive parallel-load cause is claimed.

A final stable-code rerun again passed 438 default Node checks with six deliberate
SDK skips and no failures/cancellations (37.475 seconds). The four earlier SDK
gate passes and final identity pass are separate executions, not a claim that
the original five-file command was green.

## Review and integration

An independent read-only review of new reputation/store/API rules found no
actionable issue. Its 39 additional damaged-review/receipt probes and actual
HTTP expiry probe supplement durable checks, without production certification.
The important expiry case is now permanent: expired session during persistence
returns 401, rolls back both rows, and the same request can succeed once in a
fresh authenticated session. Main integration tests exercise both unsigned and
explicit MODEL signed export/feedback paths with real ParticipantStore adapters.
No raw receipt JSON bypass, changed request payload or outsider access was accepted.

## Acceptance levels and unchanged state

- **Implemented and tested:** permanent SDK pair gate; evidence builder/CLI and
  member-only export API; durable immutable per-deal local feedback and role
  summaries. Test fixtures are not natural user acceptance.
- **Prepared, not active in the existing UI:** new APIs and documented contracts.
  The old JSON-summary button and cabinet markup are unchanged. New rating/export
  controls are not wired or declared browser-tested.
- **Retained runtime untouched:** no operator database/schema/session/certificate
  registry/checkpoint was reopened, seeded, restored or migrated for this slice;
  no operator server restart was performed. Existing running backends therefore
  do not imply current-code runtime acceptance.
- **Browser gate open:** the browser service previously refused because its
  admin-enforced policy could not be verified, despite user authorization. No
  alternate browser, port, raw CDP, headless or indirect UI workaround was used.
- **No release/monetary mutation:** no push, public deployment, grant/broadcast,
  devnet send, airdrop, real wallet/certificate signing or payment. SDK/test P12
  passwords remain local memory/stdin only; no SDK/private fixture material is
  committed.

Genuine two-person signing, legitimate positive certificate replacement,
business authority, UI/human acceptance and production security/recovery
remain separate unfinished gates.
