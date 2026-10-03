---
spike: 017
name: browser-certificate-replacement
type: standard
verdict: PARTIAL
related: [012, 014, 015, 016]
tags: [web, ncalayer, rebind, replay, test-only]
---

# Spike 017: explicit personal TEST certificate replacement

Baseline: clean `main` at `5064b317314472adf7b4c9761d8041eb0279afcb`.
The human approved preparing the interface and negative/retry tests without a
second eligible certificate. This is local **TEST binding evidence**, not login,
wallet creation, corporate powers, signed deals, payment or devnet.

## Implemented contract

The existing opt-in `/personal/` page offers two explicit operations. Enrollment
is unchanged; replacement adds these exact JSON fields to the same endpoint:

```text
POST /api/personal-test/intents
{action:"replace_test_certificate",bindingId:"<UUID>",newCertificateDigest:"<64 lowercase hex>"}
```

An anonymous, bounded server-issued TEST session may PROPOSE a target. ID and
digest are not proof of ownership. The core supplies the current epoch and old
certificate digest; neither identity, epoch, purpose, old digest nor session may
be supplied by the browser. Intent issuance does not replace a certificate, but
DOES persist an intent and advance the retained checkpoint. Unknown ID is 404,
same certificate is 409, malformed/extra/coerced fields are 400. Existing CSRF,
exact local Host/Origin/Fetch-Metadata, session TTL, limits and SDK slots apply.

`POST /api/personal-test/receipts` still accepts only `{intentId,cms}`. The storage
boundary requires exact signed bytes, fresh trusted TEST OCSP, eligible personal
profile, the SAME mapped person, exact candidate certificate and current epoch.
On acceptance, binding ID stays constant; epoch increments and old certificate
retirement, receipt/nonce consumption and retained checkpoint commit together.
Foreign/stale target is 409, mismatched candidate or ineligible identity is 422.
Closed/expired/foreign sessions cannot commit. No schema or mapping key changed.

Identical stored retry returns the same historical receipt, not a new status or
access grant. Parallel pending duplicates may each verify; only one transition
commits. A retired certificate cannot submit a NEW operation, but its original
stored receipt remains historical evidence, never fresh authority.

The browser validates canonical bytes/base64/hash/purpose, the requested action,
binding ID and new digest before signing. Replacement receipts must match the
same ID, exact candidate and expected epoch+1. Parameters and operation are
disabled during asynchronous work; edits invalidate intent/CMS/displayed receipt.
Close/expiry clears form and in-memory evidence, with late-response suppression.
**Close is not an undo operation.** If the server committed before closure or
expiry, suppressing a late response does not cancel that stored transition. A lost
response should be retried with the EXACT retained CMS before closing. After
closure/expiry, recovery requires protected operator readback; a new anonymous
session cannot recover the old session-bound receipt. The UI makes this explicit.
While CMS is retained after an ambiguous response, re-signing is disabled to
preserve the only matching history retry. Explicit pre-commit certificate refusals
permit a fresh signature; explicit edits/new intent still clear local evidence.
Only ID/digest text inputs exist: no key, password or container upload control.
All messages use textContent, not HTML. The public digest is SHA-256 of X.509 DER,
not SHA-256 of a P12. It is not itself a trust or revocation assertion.

## Verification, 30 September 2026

- Failing-before/passing-after HTTP and client regressions establish the added
  contract. A further regression caught regex coercion of array-valued ID/digest;
  HTTP now requires actual strings before any issuance or SDK call.
  Follow-up regressions also reject receipt intent-ID and receipt-field arrays,
  without submit-quota consumption; ambiguous re-sign is blocked, and actual
  HTTP commit-before-close-before-body-read preserves the committed transition.
  A follow-up wording regression verifies that timer expiry, expiry on delayed
  receipt delivery, missing sessions and CSRF rejection all warn that clearing
  the page does not cancel an already stored operation; lost results require
  protected operator readback after session termination.
- **23 personal HTTP +30 client cases** pass on isolated model fixtures. They
  cover stable ID/next epoch, exact history/replay conflict, malformed/injected
  fields, wrong identity/profile/candidate/bytes, foreign sessions, old pending
  requests, competing replacements, simultaneous identical duplicates, expiry,
  shared limits and closure during verification/signing. Positive replacement in
  these cases is deliberately **model-only**.
- Genuine bundled SDK CMS through an isolated HTTP registry refuses the same-IIN
  director's organization context, revoked and wrong-purpose certificates,
  modified bytes, and the old certificate signing an intent for another candidate.
  Negative retries mint no receipt; closure refuses subsequent submission.
  Each negative leaves the one personal binding/epoch0/current digest unchanged,
  with no retired credential and no consumed replacement intent. Intent creation
  itself moves that isolated registry from revision2 to revision3, as specified.
- Full explicitly enumerated gate: **177 Node +7 offline Solana cases**, no
  failures or skips. Four SDK runs cover incompatible-CRL fail-closed, 47 signed
  synthetic/transport OCSP checks, genuine TEST OCSP signature HTTP, and 30 parser
  checks plus genuine personal enrollment/replacement negatives. These are not
  proof of a positive renewal or natural NCALayer/browser UAT.
- Browser QA is **blocked**, not passed: selecting the existing IAB tab was denied
  because the mandatory admin access policy could not be verified. No alternate
  browser transport or policy bypass. No new screenshot, keyboard, responsive,
  console, axe or performance evidence is claimed. Controller/markup tests are
  not a replacement for actual UI interaction.
- Pre-restart operator readback: live/current revision2 pair and SAME retained
  checkpoint agree, with one binding/intent/receipt and the unchanged mapping key.
  All stored intent/receipt/hash/MAC evidence matches the protected enrollment
  backup. No positive replacement, test signature or new intent was performed in
  this operator registry by the agent.

## Local runtime and review readback

The focused read-only binding/security reviewer found no new authorization or
storage-integrity blocker after the fixes. Its remaining expiry-wording issue
was reproduced by three failing controller tests and fixed, including a simulated
committed replacement whose receipt arrives after expiry (with and without a
timer tick). This is a focused internal diff review, not full independent review.

The old loopback process PID89225 was stopped gracefully after protected readback.
The updated process PID8575 started at 21:25:22 Asia/Almaty on 30September2026,
with the same explicit SDK/TEST OCSP/personal-registry/retained-root configuration
and repository cwd. Startup and the listener at `127.0.0.1:4175` were observed;
no public listener, page-interaction acceptance or valid operator-registry intent
is inferred. The browser-policy refusal was not worked around.

Read-only checks before and after restart confirm unchanged revision2, one
binding at epoch0, one intent/receipt, zero retired certificates and the SAME
mapping key and retained checkpoint. The current state matches the protected
`.local/nca-personal-bindings-enrollment-backup-r2-20260930T145233Z` pair.
The aggregate personal evidence digest (meta/bindings/retirement/intents, with
canonical base64 bytes) is
`c4a61cb451cbf575f9aec0b1c2002105c623d3fd74f3a40ca1d40160960887e6`.
No raw identity, receipt contents, mapping key or CMS is recorded here.

A separate protected online SQLite backup was created before restart at
`.local/nca-before-replacement-browser-hQ8rWm/nca-test.sqlite` (directory0700,
file0600; file/directory/parent synced). `quick_check` is `ok` for both live
stores and backups. The signature-probe rows remain two challenges/one receipt,
with the same canonical row digest before/after restart and in the new backup:
`2645f4575c4b151d1e8a660bd22991a52fe49519c69f9887cd08b4082defd5aa`.
The retained root was not restored, reset or copied into an ordinary backup.

## How to inspect and later accept

Open `/personal/` on the loopback stand and choose **Замена TEST-сертификата**.
Review the explicit missing-pair warning and labelled ID/digest fields. Invalid
fields should produce a local error without an issuance or NCALayer dialog.
Changing fields must clear old in-memory evidence. Closing must clear the form;
a failed server closure must remain visibly unconfirmed and offer retry.

For a future positive UAT, use an eligible second current personal TEST signing
certificate for the same test person/profile and its public DER digest. Enter
the binding ID from the original personal receipt. Review the exact ID, old/new
digests and current epoch, then manually select the new TEST container and enter
its password ONLY in NCALayer. Record stable ID/epoch+1, repeat the SAME CMS for
the SAME receipt, and prove an old unconsumed request cannot commit. Create and
validate a NEW protected backup at the resulting revision; do not restore r2 or
reset the retained checkpoint. Passwords, private keys and raw person identifiers
must not enter chat, Git, logs or evidence.

## Open gates

Follow-up on 3 October 2026: [sanitized certificate-pair evidence](CERTIFICATE_PAIR.md)
confirms that the current `valid`/`revoked` personal pair is same-person and
distinct, with good/revoked strict TEST OCSP respectively. Old credential
revocation does not prevent replacement when its historical binding is authentic
and the new credential is freshly eligible. The actual retained registry binds
the good `valid` digest, not the revoked one; no historical state is rewritten.
Explicit browser permission was received, but the service again failed its
mandatory admin-policy verification before navigation. No UI workaround/pass.

The actual SDK inventory contains four personal leaf certificates of one test
person: two expired in October2025, one current accepted by strict TEST OCSP,
and one current but OCSP-revoked. Each container has one leaf, not a hidden second
eligible certificate. Same-IIN corporate certificates remain ineligible. Public
certificate inventory alone is not cryptographic/status verification; the SDK
tests independently establish the current acceptance/refusal.

**PARTIAL:** positive genuine same-profile renewal, full real-browser QA/manual
replacement UAT, full independent review, official rules/provenance, encrypted
production custody, physical-fault acceptance and full-host anti-rollback remain
open. Existing local owner/mode/key/root assumptions and historical UAT evidence
remain as documented in Spikes014–016. This slice enables no business access.
