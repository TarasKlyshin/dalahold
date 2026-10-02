---
spike: 018
name: test-deal-workspace
type: standard
verdict: PARTIAL
related: [009, 012, 017]
tags: [web, evidence, ncalayer, documents, test-only]
---

# Spike 018 — three local TEST workspace steps

Baseline: clean `main` at `3e98e7c7866396ce9921bcc34a5d6860a6eca9ef`.
On 2 October 2026 the human authorized all three local steps: read-only TEST
deal evidence, a signature over the exact terms version, and storage of
anonymized TEST files. No push, deployment, public upload, real account access,
corporate powers, wallet action, money or devnet broadcast is authorized here.

ProofPilot run context: coach; plan → review; web2/web3/physical_world; startup;
hackathon context; confidential local artifacts. The current work tests a
technical workflow, not demand or eligibility. Colosseum `/status` confirmed
read authentication on 2026-10-02; no corpus query or private artifact upload.
API Design guides the strict resource contracts; Browser QA requires real UI
interaction and cannot be replaced by a DOM fixture.

## Promise and core experiment

A builder can open one local TEST deal, inspect a durable immutable evidence
snapshot, add an anonymized text file and obtain a separate personal TEST CMS
receipt bound to the exact current terms and file manifest. A change in terms
or documents before commit refuses the pending signature. Old evidence stays
historical; it never approves a different version or provides a participant role.
The buyer/seller role switcher does not become authentication.

## Owned milestones and gates

1. Root: read-only HTTP/UI for a trusted operator-prepared offline fixture using
   existing `SignedDecisionFixture.demoEvidence`. Frozen v1 remains v1 after v2;
   v2 markers never leak into v1, missing/corrupt evidence refuses.
2. Terms worker + root adapter: new `test_terms_evidence_only` exact-byte intent,
   genuine personal TEST CMS verification, fresh strict TEST OCSP, atomic snapshot
   recheck and one-use receipt. Altered bytes, stale terms/file manifest,
   corporate/revoked/wrong-purpose certificates, closed/foreign session and
   competing retry paths must refuse or return only the exact historical receipt.
3. Documents worker + root HTTP/UI: private SQLite BLOB storage of TEST UTF-8
   `.txt` files only, max262144 bytes each and ten per version; download digest
   matches upload after restart. Generated names, explicit version binding,
   idempotent request ID, quotas and tamper refusal; no raw filename or identity.

Tests use isolated stores. Runtime uses a NEW private workspace DB, not the
retained personal registry or the existing unsigned drafts DB. SDK keys/passwords
stay in the existing bundled TEST helper/NCALayer and never enter chat or Git.
No production private custody claim: filesystem owner/mode is not encryption,
local anonymous TEST sessions are not user auth, and a full-host rollback is not
prevented. Files are untrusted; metadata/digest do not establish author or truth.

## Stop and fallback conditions

Any wrong-version signature acceptance, cross-session commit, duplicated receipt,
corrupt downloaded file or undisclosed simulated authority blocks this slice.
Unavailable SDK/OCSP disables new signatures; evidence and documents remain local
TEST data. Browser policy refusal leaves UI QA open, with no alternate-policy
workaround. A second certificate is not required for a one-sided terms test but
genuine replacement/two-party acceptance remain separate gates.

## Measurement and demo

Record implementation, isolated tests, SDK verification, runtime readback and
natural human acceptance separately. Demo: open prepared TEST deal → inspect
snapshot/journal → upload anonymized text → create exact intent → manually sign
with personal TEST certificate in NCALayer → see scoped receipt → retry SAME
CMS → revise conditions/add another document → show that new evidence needs
a new intent while the original snapshot remains historical → download file
and compare digest after restart. No source-market claims or PMF score.

## Results

### CODE and isolated TESTED — 2 October 2026

All three parts are integrated. `web/test-server.mjs` explicitly starts a new
loopback-only cabinet at `/test-workspace/`, with an independent private store
and a startup-only six-decision synthetic fixture. There is no decision-write
HTTP route. The old unsigned draft cabinet only shows its new link on an opt-in
server. This is not business authentication or a two-party signed deal.

One personal TEST CMS covers the exact canonical intent, current terms and
complete sorted document manifest. Session/snapshot/status are rechecked within
the acceptance transaction, including after asynchronous verification. Exact CMS
replay returns only the original historical receipt. History has persisted caps
of 500 accepted receipts and 16 MiB CMS, separate from the 500 pending-intent cap.
Limits can only tighten. Lost metadata with retained state refuses rather than
silently provisioning another receipt key. Full DB/host rollback is not prevented.

Text documents have generated names, no uploaded original filename, strict UTF-8
validation, ten files per version, 8 MiB total bytes and 1024 total rows. Version,
archive association and actual byte digest are validated on read/download.
Content is untrusted and not legally validated; PDFs/images and malware scanning
are not implemented. Owner-only storage is not encryption or tenant isolation.

Final enumerated regression command (278/278, no skips):

```sh
node --test --test-reporter=spec authority/*.test.mjs signer/signer.test.mjs \
  workflow/*.test.mjs web/*.test.mjs nca/client.test.mjs nca/server.test.mjs \
  nca/personal-bindings.test.mjs nca/personal-http.test.mjs \
  nca/personal-client.test.mjs nca/terms-evidence.test.mjs
cd signer/solana && npm test
```

The separate offline Solana suite passes 7/7 without RPC/broadcast. A new genuine
SDK/HTTP gate passes 1/1, no skip, using private temporary databases and bundled
personal TEST CMS with strict TEST OCSP:

```sh
NCA_SDK_ROOT='/absolute/path/to/SDK 2.0' \
  node --test nca/terms-evidence-sdk.test.mjs
```

It proves one receipt, exact historical retry, exact document download, two
corporate refusals, revoked/wrong-purpose/altered-byte refusals, stale manifest
and version refusal, closed session, persisted expiry and SDK outage refusal.
Expiry uses a deliberately altered private fixture, not a human wait. This gate
does not use NCALayer or establish genuine renewal/two-party approval.

All four pre-existing SDK gates were also rerun without skips: `sdk.test.mjs`
in CRL mode, `ocsp.test.mjs`, `sdk.test.mjs` in explicit OCSP mode, and
`identity.test.mjs`. Thus five SDK runners pass including the new terms gate.
The CRL runner passes by confirming fail-closed behavior: base166 is below delta
BaseCRLNumber167, so full CRL status acceptance remains blocked and no receipt
is issued. The identity runner's positive genuine replacement remains open;
its synthetic replacement is not genuine renewal evidence.

Focused separate-context code review identified missing-key reprovisioning,
unbounded accepted history and initialization DB-handle leakage. Regressions
failed before their fixes; all three were reread as resolved. Strict readiness
also had a failing-before HTTP regression. This is not a full independent
production security audit or a confirmed Claude review.

### RUNTIME and actual browser observation

New stand: `http://127.0.0.1:4176/test-workspace/`, explicit TEST OCSP. The existing
personal binding DB/key/checkpoint and older servers were not used or restarted.
The new stores are under `.local/test-deal-workspace/` (directory0700, SQLite0600).
A separate owner-only SQLite backup exists at
`.local/test-deal-workspace-backup-20261002/`; both copies pass integrity checks.
This is a snapshot of this TEST stand, not production disaster-recovery acceptance.

Actual browser interactions observed:

- Select the seeded grain draft, inspect current v1 and the separate six-event
  `local_test_fixture_only` journal. No personal signatures were fabricated.
- Explicit consent, upload one 96-byte anonymized TEST `.txt`, visible saved
  version/SHA-256; a `.md` submission gets a visible format refusal.
- Download using the generated attachment name. `cmp` succeeds; original and
  downloaded SHA-256 match. Browser file transport had long service delays; this
  does not establish app performance.
- Prepare exact intent; rendered bytes include the file's matching96-byte
  digest manifest. No NCALayer signature was made against the running stand.
- Close session: volatile values clear and actions disable. An earlier delayed
  file-picker interaction outlived the 15-minute session and observed the same
  expiry clearing. API races/cookie refusal are covered separately by tests.
- Restart after the SQLite backup, reload, select the same draft: the same file,
  digest and six decisions remain. DB readback: one document, one unsigned intent,
  zero personal terms receipts; integrity `ok`.
- Browser console sample: no errors/warnings. Horizontal scrollWidth equals
  clientWidth at375,768,1440px. One labelled file input/main landmark; keyboard
  Tab from refresh reaches close. This is a narrow interaction/geometry check,
  not full WCAG, all-network, web-vitals or visual-regression acceptance. JSON
  export is controller-tested, not independently downloaded in the browser.

Local screenshot: `.local/test-deal-workspace/qa-desktop.jpg` (900px viewport).
The browser tab is retained as a deliverable; temporary viewport overrides reset.

### Next observable gate

Human UAT: open the stand on the same PC, select the TEST draft, prepare a NEW
snapshot and sign through NCALayer with the bundled personal TEST certificate.
Password/key selection happens only in NCALayer. Check a new scoped receipt,
retry the SAME CMS and verify exactly one stored receipt. Never substitute a
corporate certificate or a historical enrollment receipt. Then create a separate
draft version/add a file and confirm old evidence stays historical. Do not mark
this gate passed until human feedback and protected readback agree.

Suitable genuine second-certificate renewal, two-party roles/invitations/powers,
tenant-private production storage, physical-fault acceptance, legal SDK rules,
devnet and real funds remain separate open gates. No push/deploy/public upload
was performed for this slice. ProofPilot keeps the result an evidence-bounded
technical experiment, not a market/demand or eligibility verdict.
