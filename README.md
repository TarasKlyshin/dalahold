# DalaHold

A local TEST prototype for evidence-led agricultural deals in Kazakhstan: shared terms, versioned documents, participant statements and separate buyer/seller feedback.

[Русская версия](docs/README.ru.md) · [Evidence and limits](docs/EVIDENCE.md) · [Weekly update: 5–11 October](docs/updates/2026-10-11.md)

## Problem and intended users

Farmers and buyers may agree on terms across messages and documents, then struggle to establish what was accepted or delivered. This is a **problem hypothesis awaiting user validation**, not a measured market result.

DalaHold explores one shared version of the deal, explicit sources for each statement, and a clear acceptance or dispute path. The current plan starts with a livestock deal; milk and crop scenarios remain candidates for interviews.

## Current state

Source snapshot: `01139a9`, 4 October 2026. The project is local TEST software. Full two-person signing, browser acceptance, certificate renewal, verified business authority, wallet custody and confirmed chain execution remain open.

| Area | Evidence-supported status |
|---|---|
| Deal workflow | Anonymous unsigned TEST demo reproduces accepted and disputed deals, terms versions, exact anonymous text attachments and role feedback through the participant HTTP API. |
| Evidence export | Full deal packages and an offline consistency checker are implemented. Checksums establish internal integrity; they do not establish authenticity, identity or physical delivery. |
| NCA signatures | Separate genuine personal TEST-certificate verification and supervised one-person enrollment are recorded. Genuine two-person deal approval and positive certificate replacement are still missing. |
| Recovery and access | Local isolated runtime, private member access, retries and unsigned backup/restore have scoped verification. Full browser UAT and production recovery are unaccepted. |
| Solana | Read-only devnet preflight is implemented. The recorded network check was partial; no configured wallet or confirmed transaction is claimed. Execution is disabled by default. |
| Demand | Interview cards and a test protocol exist. No validated demand, traction or revenue is claimed. |

The [evidence ledger](docs/EVIDENCE.md) links each claim to its report and identifies missing acceptance. Real payments, digital tenge and production escrow are outside the completed scope.

## Run the unsigned demo

Verified locally with **Node.js v22.22.2**, which provides the built-in SQLite used here. The unsigned demo needs no npm installation, NCA SDK, certificate or wallet.

```sh
git clone https://github.com/TarasKlyshin/dalahold.git
cd dalahold
node web/participant-demo.mjs --port 0
```

Repository access is required while it is private. This command creates fresh anonymous data, checks two evidence packages and closes its listener. It is backend preparation; it does not open a browser or create signatures.

The command prints paths to `run-report.json`, `accepted-evidence.json` and `disputed-evidence.json`. Check a package with:

```sh
node web/verify-participant-evidence.mjs /path/to/accepted-evidence.json
```

A valid report means structural consistency only. Keep `operator-access.json` private; it contains local bearer codes.

For a separate rendered walkthrough on an available loopback port:

```sh
node web/participant-demo.mjs --serve
```

Open <http://127.0.0.1:4177/participants/> on the same computer. Serving creates a fresh unsigned fixture and stays open until Ctrl+C. An occupied port fails; existing listeners and retained records are not replaced. Browser usability must be checked separately using the [UAT protocol](.planning/spikes/025-participant-runtime-ui/UAT.md). See [demo details](.planning/spikes/026-reproducible-demo/README.md) for permissions, retries and failure residue.

## Verification

Recorded at the implementation snapshot: **498 default Node checks passed**, with **6 opt-in SDK groups skipped**, and **20 offline Solana checks passed**. Genuine SDK runs have separate reports. These are not browser acceptance or a security certification.

Run the default checks from the repository root:

```sh
env -u NCA_SDK_ROOT node --test --test-reporter=spec \
  web/*.test.mjs authority/*.test.mjs workflow/*.test.mjs \
  signer/*.test.mjs nca/*.test.mjs \
  .planning/spikes/001-order-policy/policy.test.mjs
```

Run the offline Solana suite from `signer/solana`:

```sh
node --test --test-reporter=spec
```

The documentation pass rechecked demo preparation and both offline exports; it did not rerun the full suites. Details: [latest implementation verification](.planning/spikes/026-reproducible-demo/VERIFICATION.md) and [documentation verification](docs/EVIDENCE.md#documentation-verification).

## Next evidence to obtain

1. Complete rendered participant UAT: documents, exports, feedback, dispute, retry and expired-session paths.
2. Complete one exact deal with genuine TEST signatures from two different people.
3. Demonstrate legitimate same-person certificate replacement, stable binding ID and rejection of old authorization.
4. Test the workflow with 3–4 farmer/buyer pairs. The provisional continuation threshold is at least 3 of 4 pairs completing within 10 minutes, with at least two agreeing to a next test; otherwise simplify or narrow the workflow.
5. After the authority, security, custody and execution-authorization gates, verify one exact devnet transaction and prepare demo media from accepted evidence.

This sequence comes from the [implementation plan](IMPLEMENTATION_PLAN.md), [user-test protocol](PROJECT_BRIEF.md) and [proposed next-week focus](docs/updates/2026-10-04.md). It is not a claim that these milestones are already achieved or an approved calendar commitment.

## Repository guide

| Material | Purpose |
|---|---|
| [Project brief](PROJECT_BRIEF.md) | Users, hypothesis, first scenario and validation threshold |
| [Implementation plan](IMPLEMENTATION_PLAN.md) / [master plan](MASTERPLAN.md) | Scope, sequence and acceptance conditions |
| [Technical prototype](TECHNICAL_PROTOTYPE.md) | Intended signature-to-Solana trust boundary; specification |
| [Implementation status](IMPLEMENTATION_STATUS.md) | Previous detailed README preserved from the source snapshot |
| [Spike manifest](.planning/spikes/MANIFEST.md) | Experiments and their scoped verdicts |
| [NCA stand](nca/README.md) | TEST signing, certificate status and enrollment boundaries |
| [Signer](signer/README.md) | Restricted test operation and execution contracts |
| [Interview cards](INTERVIEW_CARDS_AGRI.md) | Farmer/buyer discussions; no interview results implied |
| [Weekly video scripts](docs/updates/2026-10-11.md) | English and Russian one-minute updates ([previous week](docs/updates/2026-10-04.md)) |

Use anonymous TEST material. Credentials, certificate containers, private keys, local databases and real transaction records must stay outside Git. A license has not been selected; no open-source license is claimed.
