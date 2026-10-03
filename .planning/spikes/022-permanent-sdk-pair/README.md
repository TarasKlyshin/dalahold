---
spike: 022
name: permanent-sdk-pair
type: standard
verdict: PARTIAL
related: [012, 013, 014, 015, 017]
tags: [test-only, sdk, ocsp, personal-binding, replay]
---

# Spike 022: permanent genuine personal TEST pair regression

Prepared from clean `main` at `e2dc825a8a123cdee0d2cca62422aa94249e1f65`.
`nca/personal-pair-sdk.test.mjs` promotes the reviewed temporary valid/revoked
probe into an opt-in repository regression. The SDK/runtime, signer and retained
operator databases are unchanged. This is local TEST cryptographic/storage
evidence; browser interaction and natural NCALayer acceptance remain separate.

## Running the gate

Default runs skip the genuine gate. The SDK is not vendored; supply the locally
downloaded SDK root explicitly. Java defaults to the existing OpenJDK 17 binary
directory; `NCA_JAVA_BIN` may select another compatible Java binary directory.

```sh
env -u NCA_SDK_ROOT node --test --test-reporter=spec nca/personal-pair-sdk.test.mjs
NCA_SDK_ROOT='/path/to/downloaded/SDK 2.0' node --test --test-reporter=spec nca/personal-pair-sdk.test.mjs
```

The opt-in run requires the pinned bundled current-period personal TEST P12s,
pinned TEST CA assets and genuinely fresh trusted TEST OCSP. Missing fixtures,
changed certificate pins, unavailable/unknown OCSP or unexpected status fail the
gate. No fake verifier, CRL fallback, clock adjustment or seeded historical
revoked enrollment is substituted. Fixture expiry eventually requires a reviewed
fixture/pin update; a passing old run is not a claim of current status.

## Observable assertions

1. `PersonalPairFixtureProbe.java` selects only bundled personal `sign`/`revoked`
   fixtures through the existing confined `TestCmsSigner.entity` selector. Both
   exact detached CMS signatures, pinned TEST CA chains, current validity and
   required signing purpose authenticate before subject comparison. One
   ephemeral mapping key produces only a same-person boolean, confirming two
   distinct personal certificates. This is signature-only comparison, with no
   fresh authority granted to the revoked certificate.
2. Strict TEST OCSP refuses a fresh genuine revoked enrollment as
   `status_unavailable / ocsp_status_revoked` before returning identity evidence.
   The intent remains unconsumed; every registry row, receipt MAC, mapping key
   and checkpoint is unchanged.
3. Genuine valid CMS accepts that exact same enrollment intent: one binding and
   receipt, epoch 0, no retired credential.
4. A replacement intent names the exact revoked DER digest and is signed by
   that genuine revoked key. Refusal leaves all protected state unchanged
   relative to the state after intent issuance. The existing valid binding,
   epoch, receipt and retirement records are preserved.
5. Exact accepted enrollment/CMS replay returns the same historical receipt,
   with zero new SDK calls and no row/MAC/key/checkpoint changes.

The regression pins the reviewed public SHA-256 X.509 DER digests:

| Bundled personal fixture | SHA-256 X.509 DER |
|---|---|
| `valid` | `f9305218f91240e329afea23a250e67534c535ae6f217807e268cfe630e63d34` |
| `revoked` | `6e5aa13bc638680bd5b873e30d9bf62ac4c65140f1f9de6c6a6dae0be417d3b3` |

## Verification, 3 October 2026

The commands above ran with Node `v22.22.2`; the opt-in command selected the
reviewed downloaded SDK and OpenJDK 17. The default run reported one skipped
parent and zero failures. The genuine run reported **6/6 passed**, zero skips
and failures: five subcases plus the parent, including the authenticated
same-person comparison.

Three real strict TEST OCSP `verifyIdentity` calls ran: refused revoked
enrollment, accepted valid enrollment and refused exact revoked replacement.
Historical replay made zero new SDK calls. The disposable registry finished
with one binding, one receipt, zero retired certificates, two intents, revision
3 and epoch 0. This result is the regression's isolated state, not a readback of
any retained operator registry.

## Isolation and security limits

Each opt-in run creates a new `mkdtemp` parent with a disposable private registry,
mapping key, separate checkpoint and Java build. Only those newly created test
directories and the SDK adapter's own temporary build are removed on cleanup.
The test never opens a retained database, real user P12 or browser session.

The bundled README password is read in memory and supplied only through stdin.
No password, raw CMS, subject, IIN/BIN, private pseudonym or mapping key is logged,
placed in argv/environment, written into test artifacts or committed. State
comparisons use fingerprints of complete rows so assertion failures cannot dump
private contents. The comparison helper emits only bounded booleans and public
certificate digests; SDK failure details are sanitized by the existing adapter.

This proves genuine revoked-key refusal and genuine valid enrollment/replay.
It does not prove positive certificate replacement, a historical enrollment of
the currently revoked certificate, two distinct participants, browser UAT,
business authority, wallet/payment, devnet integration or production readiness.

## Identity-suite timeout diagnosis, 3 October 2026

The integration gate found two cancellations of the pre-existing
`nca/identity.test.mjs` monolithic suite at its explicit 60-second outer deadline:
once alongside four other SDK gates, then once in isolation. Those original
cancellations did not contain stage timing, so their exact cancellation stages
remain unknown. Neither later diagnostic run establishes that the old 60-second
gate passed.

Two bounded 180-second diagnostic runs kept all original assertions, runtime,
TEST OCSP configuration and each `javaProcess` 15-second deadline unchanged.
Both completed normally, with one reported Node test passed and no failure,
cancellation or skip. The 79 original assertion lines remain unchanged; the
parser still checks all 30 synthetic subject cases.

| Fixed stage | Diagnostic 1, 180 s budget | Diagnostic 2, 180 s budget | Final 120 s budget |
|---|---:|---:|---:|
| Fixture setup and Java compilation | 3.258 s | 3.884 s | 5.257 s |
| Profiles and SDK negative checks | 15.437 s | 16.085 s | 21.284 s |
| Personal-binding library, backup and replay | 13.479 s | 14.215 s | 27.089 s |
| Personal HTTP enrollment and refusals | 10.630 s | 10.487 s | 16.402 s |
| Personal HTTP replacement refusals and retry | 13.594 s | 13.364 s | 19.097 s |
| Offline owner-storage compatibility | 0.006 s | 0.008 s | 0.009 s |
| Complete test body | 56.405 s | 58.044 s | 89.139 s |

Each complete run made **61 serial Java process calls**: two compilations,
one subject-parser check, one confined-key negative check, 25 genuine CMS signs,
27 SDK identity verifications, one signature-only SDK verification and four SDK
status inspections. The malformed mapping-key check refused synchronously,
making no Java call. The longest individual measured call was 1.523 s in the
first diagnostic, 2.061 s in the second and 4.397 s in the final 120-second run;
no active call remained at completion. The measured Java-related calls accounted
for approximately 99.5%/99.4%/99.4% of total elapsed time. The two diagnostics had
only 3.6 s/1.95 s below the old outer deadline; the final complete normal run
actually exceeded it.

This supports an insufficient aggregate harness deadline, with no stalled
operation observed in any complete run. The main agent accepted **120 seconds** for
this serial suite, matching the existing exact-terms SDK HTTP budget. Only the
outer test budget changed; no Java deadline, authorization/status gate, runtime
or original assertion was relaxed. Sanitized `IDENTITY_GATE_METRICS` output now
records fixed stage labels, call counts, elapsed/max durations and active call
labels on completion or failure, without sensitive arguments or outputs.

The final harness uses the same SDK-root/Java selection:

```sh
NCA_SDK_ROOT='/path/to/downloaded/SDK 2.0' NCA_JAVA_BIN='/path/to/java-17/bin' node --test --test-reporter=spec nca/identity.test.mjs
```

That final 120-second command passed **1/1** in 89.152 s (runner total 89.402 s),
with zero failures, cancellations or skips, all original assertions and all 61
Java calls completed. The final default run still skipped one test with zero
failures. This verifies the new harness budget; it does not turn either old
60-second cancellation into a passing result or identify their exact stages.
