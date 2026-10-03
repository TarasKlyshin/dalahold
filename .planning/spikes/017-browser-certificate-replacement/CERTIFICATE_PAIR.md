# Current personal TEST valid/revoked pair — 3 October 2026

Source: clean `eecd0b515fc23145c21a5ad07780f06406ab550f` on the mounted canonical
checkout. The user explicitly authorized checking the bundled pair and the
browser run. Only SDK TEST material was used; no personal key, password, CMS,
subject, IIN/BIN or mapping key is included in this evidence.

## What the pair actually proves

Current-period bundled personal `valid` and `revoked` certificates are distinct
and identify the same test person, with no organization context. Both passed
current date, the stand's signing-purpose requirement, pinned TEST issuer and
exact detached CMS checks. Comparison of their CA-authenticated subjects used
one ephemeral mapping key, returning only a same-person boolean. That comparison
is explicitly **signature-only**, not fresh authority for a revoked certificate.

| Fixture | SHA-256 of X.509 DER | Strict current TEST OCSP |
|---|---|---|
| personal `valid` | `f9305218f91240e329afea23a250e67534c535ae6f217807e268cfe630e63d34` | accepted, personal identity returned |
| personal `revoked` | `6e5aa13bc638680bd5b873e30d9bf62ac4c65140f1f9de6c6a6dae0be417d3b3` | refused: `status_unavailable / ocsp_status_revoked`; no identity returned |

The folder name says `2026.05.08-2027.05.07`; actual certificate validity ends
8 May 2027. Neither folder name nor the ability to produce a CMS is a trusted
certificate-status result. Strict TEST OCSP is independently checked.

Sources: fixed SDK selector `nca/TestCmsSigner.java`; pinned chain/exact CMS,
typed subject mapping and OCSP-before-identity in `nca/CmsVerifier.java`;
strict SDK boundary in `nca/sdk.mjs`. The sanitized inspection used temporary
`PersonalPairProbe.java` and `run.mjs` under
`/tmp/dalahold-personal-pair-probe.aqm6dU/`; those are audit-session artifacts,
not shipped production adapters. Their temporary compilation is cleaned up.

## Renewal requirement — clarified

Two simultaneously good certificates are **not** a fundamental replacement
requirement. The implemented replacement verifies the **new** certificate/CMS
and compares its mapped person, candidate digest and expected epoch with the
existing protected binding. It does not require a fresh signature/status from
the old credential. Therefore revoked-old → good-new can work if the old
certificate was genuinely bound while it was eligible, before revocation.

We do not have that historical revoked-certificate binding in the retained
operator registry. Read-only current readback: integrity `ok`, one accepted
binding/receipt, epoch 0, zero retired certificates; the bound digest is the
`valid` certificate above. It would be wrong to silently rewrite its history or
enroll `revoked` with a fake status to claim successful genuine renewal.

This pair suffices for genuine revoked-key refusal tests. Positive renewal from
the actual retained state needs a different eligible new personal certificate
of the same person, OR an authentic prior enrollment record for the revoked-old
credential in a suitable independent test registry. A seeded historical fixture
would be model evidence and must be labelled as such. Two-party deal acceptance
separately requires a valid certificate of a **different** person; this pair does
not supply a second counterparty.

## Genuine current SDK/store run

Four acceptance scenarios passed in a newly created disposable registry and
separate checkpoint (Node reports 5/5 including the parent, no skips/failures):

1. The genuine revoked CMS failed fresh enrollment with trusted current
   `ocsp_status_revoked`. No binding/receipt/retirement or checkpoint mutation.
2. The genuine valid CMS then accepted that **same** unconsumed enrollment
   intent: one binding/receipt, epoch 0, no retired credential.
3. Replacement named the **actual revoked DER digest** and used its genuine
   CMS. Rejection preserved binding ID/current valid digest/epoch/receipt,
   retirement records and checkpoint/revision relative to post-issuance state.
4. Exact valid enrollment CMS replay returned the same historical receipt with
   zero new SDK verification calls or state changes.

Three strict current TEST OCSP SDK calls were made. No status, clock or historical
enrollment was simulated. Temporary execution registry/key/checkpoint/compiler
directories were removed. The test source remains an audit-session artifact at
`/tmp/dalahold-personal-pair-probe.aqm6dU/bindings-revoked.test.mjs`; reproduction:

```sh
node --test --test-reporter=spec /tmp/dalahold-personal-pair-probe.aqm6dU/bindings-revoked.test.mjs
```

The ordinary personal storage/HTTP/client suites also passed 92/92 against the
unchanged production source. These are model regression cases, not genuine
positive renewal or browser tests. Read-only retained-registry checks before and
after confirm the same valid digest/epoch 0, one receipt, zero retired and
integrity `ok`. No retained registry or running signed workspace was mutated.

## Browser authorization and technical result

Explicit human permission was received. The requested navigation to
`http://127.0.0.1:4177/participants/` still failed before page access:

`The admin-enforced policy could not be verified, so access was not granted.`

This is not a missing user consent. No alternative browser, different port,
headless transport or indirect UI workflow was used. Browser QA remains blocked
by the service's mandatory security check; no screenshot, DOM interaction,
keyboard, responsive, console, performance or NCALayer browser pass is claimed.
SDK/isolated storage tests are independent cryptographic evidence, not browser QA.
