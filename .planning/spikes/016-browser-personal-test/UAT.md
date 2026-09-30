# Manual personal TEST enrollment checkpoint, 30 September 2026

Source: clean local `main` at `5be310bb243a1629e58524779cdd61c6a7b47092`.
This records the human signing/retry/close check after the local WAL crash
mitigation. It is TEST binding evidence, **not account login or wallet access**.

## What is confirmed, and by which source

- **Human signing plus persisted receipt:** after the user reported `готово`,
  the private operator registry contained one intent, one personal binding and
  one receipt. Receipt `d097c31c-d45f-4e46-9aaf-6fb23cf1c606` records
  `enroll_test_person`, `test_personal_binding_only`, epoch0, `test_ocsp`, verified
  at `2026-09-30T14:52:33.008Z` (19:52:33 Asia/Almaty). Its hash matches the
  stored exact intent; the binding certificate digest/epoch matches the receipt.
  This is the operator registry, not a synthetic or SDK-run temporary fixture.
- **Retry/close reported by the human:** the instruction was to retry in the same
  tab, observe the same historical receipt ID, then close the TEST session and
  see cleared page state. The user replied `сделал`. That is the source of manual
  confirmation; the agent did not replay the CMS or independently inspect that UI.
- **Post-check readback:** one binding, one intent, one receipt remain, with the
  same receipt JSON/signature hash/MAC as the saved pair. Registry and retained
  checkpoint are both revision2. No duplicate receipt or epoch change exists.
  The current pair passes the library's checkpoint/schema/state availability
  checks. No new signature or fresh certificate-status request was performed by
  either readback; stored OCSP evidence is not a new status assertion.
- **Closure evidence limit:** browser session deletion is in memory, not a
  durable registry event. Unchanged DB counts alone do NOT prove logout. Closure
  is human-confirmed; agent browser access is still blocked by mandatory access-
  policy verification, so real-cookie revocation/late-response UI checks remain
  unobserved. Existing automated HTTP/frontend negatives cover those code paths,
  not an independent observation of this human's closed session.

## Current protected backup and recovery rule

Current pair:
`.local/nca-personal-bindings-enrollment-backup-r2-20260930T145233Z`.
Publication returned `{published:true,durability:'synced'}`. Directory0700,
key/DB0600, original mapping key preserved, integrity `ok`, revision2, one binding
and receipt. Opening it against the SAME retained checkpoint and comparing the
binding/certificate succeeds without issuing an intent or advancing the root.
It is a snapshot for recovery, **not another concurrent writer**.

Retained checkpoint stays at
`/Volumes/dev/dev/.dalahold-test-control/personal-bindings-anchor/checkpoint.sqlite`.
Do not replace/reset it or restore its old revision to accept a historical pair.
The previous `.local/nca-personal-bindings-retained-checkpoint-backup` (revision0)
is preserved but now refuses with `binding_state_stale`; it is no longer a current
restore candidate. Future state changes require a new matching protected backup.
The TEST key is owner-file protected, not encrypted production custody. Successful
backup/readback does not prove physical-fault tolerance or full-host anti-rollback.

## Acceptance and remaining work

The narrow human enrollment/retry/close sequence is recorded as **human-confirmed,
with persisted enrollment and no-duplicate evidence independently read back**.
Spike016 remains PARTIAL: automated real-browser keyboard/responsive/console and
session revocation observations are not accepted. No source code or HTTP behavior
changed at this checkpoint, so the earlier 161 Node +7 offline Solana and four
SDK run results are historical code-test evidence, not new tests run here.

Next gated cryptographic scenario: an eligible second, currently valid personal
TEST certificate for the SAME test person/profile, exact replacement intent,
stable binding ID, advanced epoch and refusal of old pending authorization.
Positive genuine renewal is still missing its certificate pair; the existing
model-only replacement tests are not that acceptance. The browser currently has
no replacement endpoint, login, business powers, wallet, payment or devnet grant.
