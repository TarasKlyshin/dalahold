# Evidence ledger

[Project overview](../README.md) · [Русский обзор](README.ru.md) · [Weekly update](updates/2026-10-04.md)

**Evidence cutoff:** 4 October 2026, Asia/Almaty.

**Implementation baseline:** `01139a9cd411102eb32bdc110ec33763715ef0b7` on `main`. The documentation changes do not modify executable code.

This is a project-artifact preparation pass under ProofPilot's evidence rules. It is not a formal event score or an application-eligibility verdict. A local test, user report, API result, rendered user acceptance and confirmed chain transaction are different evidence levels.

## Claims and their support

| Claim | Inspected evidence | Supported conclusion and limit |
|---|---|---|
| Reproducible unsigned deal demo | [026–028 verification](../.planning/spikes/026-reproducible-demo/VERIFICATION.md), [demo contract](../.planning/spikes/026-reproducible-demo/README.md), fresh smoke below | Accepted/disputed anonymous local fixtures, exact text documents, role reviews and exports. No NCA signatures or browser acceptance in this demo. |
| Latest default regression | [026–028 verification](../.planning/spikes/026-reproducible-demo/VERIFICATION.md) | Recorded 498 Node passes and 6 deliberately skipped opt-in SDK groups. Focused subsets are not counted again. |
| Offline Solana regression | [026–028 verification](../.planning/spikes/026-reproducible-demo/VERIFICATION.md) | Recorded 20 passes; offline bytes/model transport. No live send. |
| Genuine TEST signing and certificate refusal | [022–024 verification](../.planning/spikes/024-participant-role-reputation/VERIFICATION.md) | Separate genuine SDK runs and same-person valid/revoked negatives. The pair is one identity; it cannot prove two-person signing or positive renewal. |
| Personal enrollment/retry/close | [016 manual UAT](../.planning/spikes/016-browser-personal-test/UAT.md) | Human-reported signing/retry/close and independently read-back one binding/receipt with no duplicate. Closure is human-reported; automated browser revocation was not observed. |
| Evidence exports and role feedback | [022–024 verification](../.planning/spikes/024-participant-role-reputation/VERIFICATION.md), [025 verification](../.planning/spikes/025-participant-runtime-ui/VERIFICATION.md) | Member-only package APIs, immutable local feedback and client contracts. Offline package integrity does not prove provenance, authentic files or physical delivery. |
| Isolated runtime and recovery | [025 verification](../.planning/spikes/025-participant-runtime-ui/VERIFICATION.md) | Local unsigned startup, stopped snapshot/restore and scoped failure checks. Signed recovery, physical-fault durability and production custody remain open. |
| Public devnet observation | [028 contract](../.planning/spikes/028-devnet-preflight/README.md), [recorded network report](../.planning/spikes/028-devnet-preflight/LIVE_NO_WALLET.json) | Historical bounded read-only observation with `PARTIAL` and `executionEnabled:false`. No wallet, balance/fee validation or persistent network-readiness claim. |
| Customer problem | [Project brief](../PROJECT_BRIEF.md), [interview cards](../INTERVIEW_CARDS_AGRI.md) | Hypothesis and research protocol. No inspected completed interview findings, customer adoption, revenue or validated demand. |
| Roadmap | [Implementation plan](../IMPLEMENTATION_PLAN.md), [master plan](../MASTERPLAN.md), [025 UAT](../.planning/spikes/025-participant-runtime-ui/UAT.md) | Relative build sequence and unresolved gates. The 5–11 October focus is proposed, not an approved dated commitment. |

## Documentation verification

On 4 October 2026, this documentation pass ran the existing CLI against unchanged implementation code with Node.js **v22.22.2**:

```sh
node web/participant-demo.mjs --port 0
node web/verify-participant-evidence.mjs /path/to/accepted-evidence.json
node web/verify-participant-evidence.mjs /path/to/disputed-evidence.json
```

The first command created a fresh anonymous unsigned fixture and exited 0, closing its own listener. The two checker commands used the actual paths printed by that run and each exited 0.

| Fresh result | Accepted package | Disputed package |
|---|---|---|
| Offline checker | `valid:true` | `valid:true` |
| State / selected terms version | accepted / 2 | disputed / 1 |
| Terms versions | 2 | 1 |
| Documents / total exact text bytes | 2 / 54 | 0 / 0 |
| Events / signed receipts | 4 / 0 | 3 / 0 |

Both reports explicitly returned `authenticityVerified:false`, `sdkVerificationPerformed:false`, `freshStatusChecked:false` and `chronologyVerified:false`. This verifies the documented backend preparation and offline consistency path. It is not browser navigation, a fresh SDK run, two-person approval or chain execution.

Generated runtime data and private bearer files stay in ignored local storage. No private runtime path, credential or certificate material is included in this documentation.

The previous detailed README was preserved byte-for-byte as [IMPLEMENTATION_STATUS.md](../IMPLEMENTATION_STATUS.md). New documentation was checked for resolving relative file links and whitespace. The full Node/Solana suites were **not rerun** for this documentation-only pass; their numbers above remain recorded implementation results.

## Next decisive experiment

Use anonymized recent-deal material with 3–4 farmer/buyer pairs. Observe whether both parties can identify the same terms version, amount, next action and source of confirmation, without prompts.

**Provisional success threshold:** at least 3 of 4 pairs finish within 10 minutes, and at least two agree to another test. **Stop/narrow condition:** if the threshold fails, simplify the process or select a narrower scenario before adding payment functionality. These are internal operating thresholds, not statistical proof of demand.

The product test does not substitute for the separate technical gates: rendered participant UAT; genuine signatures from two different people; legitimate same-person renewal; business authority where applicable; stable test-key custody; exact execution authorization and transaction readback.

## Source coverage and missing material

Checked: repository documentation and implementation reports at the stated baseline; the fresh unsigned CLI and two offline exports; the existing private GitHub repository and remote `main`.

Not checked in this pass: customer interviews, live full signed user flow, a new SDK/OCSP run, a new network preflight, public deployment, confirmed Solana execution, market/competitor research or current event eligibility rules. Those checks are outside this narrow repository-formatting task. No external corpus research or private-project upload was used to support these claims.

Remaining presentation assets include accepted browser screenshots, a recorded product video, approved interview findings, a verified two-party signing/renewal/chain demo and a completed pitch. [The weekly scripts](updates/2026-10-04.md) are editable recording drafts; they are not a published video or submitted application.
