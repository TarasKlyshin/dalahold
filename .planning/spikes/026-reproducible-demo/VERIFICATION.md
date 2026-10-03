# Local verification — Spikes 026–028

Date: 3–4 October 2026 (Asia/Almaty). Source baseline: clean `main`,
`fc13af1ebfc61d633d3ad492ac62716892fd3b11`. This is a local TEST implementation
and public read-only network observation, not a release, signed deal, payment
or confirmed Solana transaction.

## Acceptance and source of truth

- One explicit CLI prepares a fresh anonymous unsigned store through the real
  participant HTTP API, verifies accepted/disputed evidence and closes by
  default. Existing targets/listeners must never be overwritten or replaced.
- Two accounts, all terms versions, exact document bytes, both role reviews
  only on the accepted deal, zero signed receipts, and safe artifact permissions
  are checked independently after CLI shutdown.
- Security evidence comes from named regressions, independent source review
  and fresh HTTP/model probes, not a generated verdict or screenshot alone.
- Devnet preflight uses the fixed endpoint and pinned genesis, makes bounded
  read calls only, and never changes its `executionEnabled:false` boundary.
  Wallet/balance/fee and genuine acceptance are separate from network reachability.

The pre-change default gate was 476 passed, 6 deliberately skipped opt-in SDK
groups, zero failures/cancellations. The stable final gate is recorded below
after the integration follow-up; focused counts are subsets, not extra unique
tests.

## Actual one-command demo and readback

Main ran `node web/participant-demo.mjs --port 0` on the new implementation.
This was backend preparation only, not navigation to an alternate UI origin.
The default intended UI port 4177 was already occupied by the untouched earlier
stand; no attempt was made to kill, replace, seed or resume it.

The successful command created the ignored, private run directory
`.local/participant-demo-44608fbae3643660`, then closed its own ephemeral listener
and released its cooperative lease. Its report's origin is a historical
preparation value, **not a running application link**. The owner may inspect:

- `run-report.json` — anonymous states/counts/hashes/limitations;
- `accepted-evidence.json` and `disputed-evidence.json` — exact full API packages;
- `operator-access.json` — private `0600` bearer codes; do not share or commit.

Independent read-only SQLite and artifact checks after shutdown observed:

| Check | Observed result |
| --- | --- |
| Store kind / SQLite integrity | `dalahold.local-test-participants.v1` / `ok` |
| Accounts / deals / terms versions | 2 / 2 / 3 |
| Events / reviews | 7 / 2 |
| Accepted deal | Version 2; 4 events; 2 exact 27-byte documents; reviews buyer→seller 5 and seller→buyer 4 |
| Disputed deal | Version 1; 3 events; no documents or reviews |
| Both full packages | Offline verifier passed; zero receipts; authenticity/SDK verification false |
| Private permissions | Run/runtime directories `0700`; database/operator file `0600` |
| Shareable files | Readback SHA-256 matches report; neither actual account bearer code appears |
| Shutdown | Own lease absent; CLI exit 0 |

Accepted raw-package SHA-256:
`da48760def5231bcdbe3b30ea3eaf4445c3dd783bf5a4e89918b1d794df60a1e`.
Disputed raw-package SHA-256:
`1f7000a5c1e5e81392b43f58ba384ae406b2351ec0408133ca554660d67dec51`.
These are integrity checks on this fixture, not identity/provenance evidence.
Fresh runs intentionally use new anonymous IDs/timestamps/hashes; the scenario
is reproducible, not byte-identical between runs.

The earlier 4177 listener remained PID 58578 before and after this preparation.
Retained participant cabinets, binding registries, keys/checkpoints and SDK
containers were not opened, copied, seeded, migrated or restarted.

## Integration findings and regressions

The demo's initial destructured programmatic options ignored unknown keys.
It now accepts only exact own plain data fields `runDirectory`, `port`, `now`;
privileged/CLI-only fields, proxies, symbols and accessors refuse before disk
or network access. CLI `serve/help` controls are kept outside that API.
The deterministic regression checks getter non-invocation and no target
creation. The worker did not restore the historical implementation for a
red-before run, so that initial hardening is not reported as an observed
red-before result. A separate final revoked-proxy edge was reproduced by main
with the new regression first: it failed on native `IsArray` TypeError. Moving
proxy detection before `Array.isArray` then passed the same regression with
fixed `demo_options_invalid` and no created target.

The first actual no-wallet preflight CLI exited 2 before any RPC despite its
eight model tests passing: this platform's `process.env` has a nonplain
prototype. The precise parser rejection was reproduced separately. CLI now
copies own environment data descriptors into a null-prototype snapshot before
strict parsing; unsupported prefixed options remain refused. The fixed config
error no longer collapses into an unrelated network-failure code. The actual
CLI then reached the public endpoint with no wallet configuration.

Independent review reproduced a P2 in the injected RPC boundary: changing
getters were validated once then copied again, allowing private sentinel fields
and an altered expiry height into a partial report. Own data-descriptor capture
now refuses those fields before invoking any getter. The follow-up also found
late clone-based proxy detection executing reflection/nested-value getters.
Early Node proxy refusal and non-recursive descriptor snapshots replace that
path across config, compiler, argv, dependencies and RPC results/methods.
Main's three targeted final P2 regressions passed with zero getter/trap reads.
A revoked proxy delivered synchronously is a malformed result; an async adapter
that rejects during native promise assimilation is a sanitized RPC failure.
Both refuse, without forcing one error code onto these distinct failure paths.

The independent [security review](../027-demo-security-review/REVIEW.md)
records the existing-path review and final new-module follow-up separately.
Its initial 111-test focused gate and extra fresh HTTP probes cover member/role
access, recipient/session binding, stale/exact retries, EDS bypass refusal,
export privacy, safe attachment headers, sanitized exceptions and expiry.
The final review records original reproductions and closure separately from
the existing-path audit; none is production certification.

## Public devnet observation

A no-wallet CLI run at 2026-10-03 19:05:19 UTC observed the pinned genesis and
a latest blockhash whose last valid height (494343608) exceeded the final
read height (494343458). It reported `PARTIAL`, `network.ready:true`, no wallet
or signer, unchecked balance/fee, and all genuine/execution gates unaccepted.
This time-sensitive snapshot is not persistent readiness or a transaction.
The final stable-source run started at 19:16:49 UTC and its result was read
back by 19:17:22 UTC: final height 494346410, last-valid height 494346560,
same pinned genesis, `PARTIAL`, unchecked wallet/balance/fee and execution
disabled. The exact safe report and module hashes are preserved in
[LIVE_NO_WALLET.json](../028-devnet-preflight/LIVE_NO_WALLET.json).
There is no airdrop, simulation, key creation/loading, signature, grant, send
or transaction readback in this slice.

## Stable verification gates

| Gate | Stable result | Evidence level |
| --- | --- | --- |
| Full default Node regression | **498 passed, 6 SDK groups skipped**, 504 total; zero failures/cancellations, exit 0, 21.398 seconds | Local TEST/model/protocol/storage; no genuine SDK run |
| Offline Solana | **20/20 passed**, zero failures/cancellations/skips, exit 0 | Offline bytes and model transports, no live send |
| Demo suite | **7/7 passed** | Real disposable HTTP/storage and subprocess lifecycle; part of default gate |
| Final preflight suite | **15/15 passed** | In-process models, pure compiler and real CLI invalid-config subprocess; part of default gate |
| Main critical preflight follow-up | **3/3 passed** | Getter/symbol/privacy, proxy/revoked and nested-value refusal; subset of final preflight gate |
| Main demo revoked-proxy regression | Observed red before fix, then **1/1 passed** | Fixed error and no filesystem target; subset of demo gate |
| Independent final security follow-up | **35 focused tests and 38 adversarial boundary checks passed**, all scoped findings closed | Separate bounded reviewer source/model/disposable-filesystem checks, not a production or browser certification |
| Actual prepared demo | Exit 0, independent SQLite/evidence/mode/bearer readback passed | Fresh anonymous unsigned runtime, closed by default |
| Actual final wallet-less preflight | Exit 0, `PARTIAL`, network observed, `executionEnabled:false` | Public fixed-endpoint read-only snapshot |
| New JS syntax / whitespace | All 5 source/test files passed `node --check`; `git diff --check` passed | Source checks |
| Browser / genuine two-person / renewal / chain execution | **Not accepted** | Permission/material/authority gates remain separate |

The first integration run (before the final exact-input follow-up) also passed
496 tests with 6 skipped; it is superseded by the stable 498-pass gate above.
The offline 20 checks and default 498 checks are separate suites; no focused
subset count is added again to inflate the total.

From repository root:

```sh
env -u NCA_SDK_ROOT node --test --test-reporter=spec web/*.test.mjs authority/*.test.mjs workflow/*.test.mjs signer/*.test.mjs nca/*.test.mjs .planning/spikes/001-order-policy/policy.test.mjs
node --test --test-reporter=spec web/participant-demo.test.mjs signer/devnet-preflight.test.mjs
node web/participant-demo.mjs --port 0
env -u DALAHOLD_DEVNET_PUBLIC_WALLET -u DALAHOLD_DEVNET_WALLET -u DALAHOLD_DEVNET_MAX_FEE_LAMPORTS -u NCA_TEST_MEMO_WALLET node signer/devnet-preflight.mjs
git diff --check
```

From `signer/solana`: `node --test --test-reporter=spec`.
The demo's `--port 0` command is preparation-only disposable backend work, not
a workaround for the denied browser origin. Default intended serving remains
4177, with explicit `--serve` and no automatic listener replacement.

## Remaining acceptance and safety boundaries

- Browser QA remains blocked by the saved permission for 4177. No browser,
  headless/CDP, alternate browser/port or indirect UI substitute was attempted
  this turn. HTTP fixtures/CLI preparation do not prove rendering, downloads,
  visual/anti-slop, accessibility or natural UAT.
- Genuine different-person TEST signing, legitimate same-person renewal,
  business authority, stable wallet custody, real devnet execution and monetary
  pilot acceptance remain open. No SDK/P12/password was used in this turn.
  Six genuine opt-in groups remain explicitly skipped in the default gate.
- Only local capability statements and unsigned role feedback are created.
  Neither score, hash nor stored document proves physical delivery or identity.
- Evidence intentionally contains TEST document content; the schema is not a
  personal-data redactor. This command uses fixed anonymized text only.
- Cooperative owner-process isolation is not hostile same-UID/full-host
  security. Failures retain private residue; no automatic data deletion or
  stale-lock removal is performed. Signed recovery remains a separate contract.
- No push, external publication, public deployment, real certificate operation,
  funding, paid service, Solana send or payment is authorized by these results.

AI Regression Testing guided exact retry/refusal and escaped-CLI regressions;
Code Reviewer guidance prioritized auth/privacy/correctness over style changes.
Neither skill output substitutes for independently observed acceptance.
