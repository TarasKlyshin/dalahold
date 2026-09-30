---
spike: 015
name: retained-binding-checkpoint
type: standard
verdict: PARTIAL
related: [014]
tags: [identity, recovery, checkpoint, rollback, sqlite, test-only]
---

# Spike 015: retained local TEST checkpoint

Baseline `main`: `5dd3019188f11c75be7ce8e259524cff80a8370b`, clean.
Implement the approved first next step, not browser login or wallet/payment/devnet.

## Acceptance and threat boundary

1. A retained private checkpoint, configured independently of ordinary binding
   backups, binds registry ID, mapping-key ID, revision and canonical state digest.
   Missing/insecure/replaced/mismatched checkpoints refuse; never auto-initialize
   a checkpoint when opening/restoring a database. A stale database/key backup
   cannot enroll, rebind, issue an intent, replay history or read current binding.
2. Main state and checkpoint advance in one SQLite attached-database transaction,
   with rollback journals and FULL synchronization, not WAL. Failure, concurrent
   stale clones, restart and backup during concurrent writes must fail closed or
   retain one consistent state. Only explicit empty-legacy upgrade is permitted.
3. Demonstrate the old-backup failure before/after; test checkpoint loss/change,
   same-revision state mutation, write/receipt/checkpoint failure and latest restore.
   Preserve current mapping key and inactive local state; do not enable HTTP auth.

This is an **administratively independent local TEST checkpoint**, not hardware
or a production third-party monotonic authority. It must not be copied backwards
with the ordinary backup. Full-host rollback, a privileged/same-OS-user attacker,
restoring both checkpoint and binding state together, disk-loss/power-loss proofs
and encrypted production key custody remain outside acceptance. Production auth
and corporate powers stay closed. Current personal renewal is still synthetic-only.

## Implementation choice

Reuse `node:sqlite`, crypto, private-file checks and the existing PersonalBindings
module. No dependency, service, Keychain permission change or credentials.
SQLite documents attached-database atomicity only with non-memory main databases
and non-WAL journals: [ATTACH](https://www.sqlite.org/lang_attach.html),
[multi-file commit](https://www.sqlite.org/atomiccommit.html#multi_file_commit).
Power-loss acceptance is not inferred from ordinary unit tests.

## Implemented

- Opening requires the existing owner-private checkpoint and registry/key identity.
  The source and retained control directory cannot contain one another; both must
  be on the same device. Missing/checkpoint replacements, WAL, unsafe permissions
  and revision/digest mismatches refuse instead of recreating state.
- Snapshot-consistent current reads and historical receipt validation; a stale
  long-lived clone cannot read/issue/submit/replay/publish a backup. History remains
  historical evidence, never a fresh permission.
- Intent insertion, successful enrollment/replacement, receipt and checkpoint
  share an attached `BEGIN IMMEDIATE`. Full-tuple compare-and-swap, post-update
  checkpoint validation and expiry recheck precede commit. Injected checkpoint
  failures roll back BOTH state files and allow a safe retry.
- The existing mapping key is preserved on explicit empty-legacy upgrade.
  Nonempty legacy snapshots refuse. No automatic bootstrap during open/restore;
  interrupted empty bootstrap permits only explicitly requested no-schema resume.
- Backups contain a private key/main-database pair, never the retained checkpoint.
  A copy must match the captured revision/digest and pass integrity checks before
  atomic publication. Unpublished failures clean only owned staging. Restore
  always checks against the SAME retained authority, not a backed-up old anchor.

No package/dependency was added: Ponytail guided reuse of Node crypto/fs/sqlite and
existing storage checks. No HTTP/UI, identity grant, corporate powers, key-vault
permission or Solana/network-money path was added.

## Evidence, 30 September 2026

- Failing-before regression at baseline: opening a pre-replacement backup was
  accepted (assertion `Missing expected exception`). After this change, both the
  ordinary old clone and an in-place restore with unchanged inode/key refuse with
  `binding_state_stale`; the old credential cannot regain the current binding.
- 37 focused storage/policy cases pass: stale clone/restart, joint-write failure,
  same-revision schema/data tampering, checkpoint loss/identity/permissions,
  parallel copies, current restore, backup retry/concurrent source changes,
  explicit empty migration/resume and expiry after checkpoint hashing.
- Stable suite: **126 Node + 7 offline Solana cases**, no skips. All **4 additional
  SDK runs** pass: default CRL refusal, 47 signed synthetic/transport OCSP checks,
  explicit live TEST OCSP CMS-to-HTTP/genuine negatives, genuine subject parser/
  personal binding/current-backup/restart compatibility. Personal certificate
  renewal is still synthetic only; no eligible second bundled personal fixture.
- Bounded independent read-only code review found no remaining blocker in these
  fixes. This is not full production security review or a confirmed Claude review.
  Legacy writers must be stopped before migration; otherwise the next modern
  read fails closed on a legacy write that did not advance the checkpoint.

### Prepared local state, not active runtime auth

No open legacy-registry writer was found before explicit empty upgrade. Existing
`.local/nca-personal-bindings` was upgraded with its **original key**, no bindings,
intents or retired certificates. Retained checkpoint:
`/Volumes/dev/dev/.dalahold-test-control/personal-bindings-anchor/checkpoint.sqlite`.
It is on the same device but outside project/ordinary backup directories, with
private control/anchor directories. Revision is **0** and registry/key IDs match.

New protected current pair:
`.local/nca-personal-bindings-retained-checkpoint-backup`, publication result
`{published:true,durability:'synced'}`. Opening that pair against the retained
checkpoint succeeds without issuing an intent or changing its revision. Key/DB
files are `0600`, directories `0700`, owned by the current operator; local pairs
are Git-ignored. No key or subject value was printed or committed.

The old `.local/nca-personal-bindings-initial-backup` remains untouched. It refuses
as a current registry (`rollback_anchor_required`); never upgrade a historical
pair to bypass a newer retained checkpoint. No actual personal account exists.

Signature-only stand remains PID **27184**, loopback `127.0.0.1:4175`; page/status
return HTTP 200, explicit TEST OCSP `ready:true`. The prior supervised receipt's
bytes/signature hashes and receipt JSON exactly match its earlier protected
database backup; original time remains `2026-09-30T09:29:46.079Z`. No owner/personal
binding tables exist in that stand. This is readback, **not new signing/UAT**.

## Residual limits and next gate

The checkpoint file/schema is trusted operator state, not protected against a
same-UID/privileged adversary. Restoring BOTH files backwards is deliberately
demonstrated as outside this retained-checkpoint guarantee. Keep it out of normal
snapshot restores; no automatic root/key regeneration or force-reset recovery.

A write from another process after a backup's last source check may make the
published pair stale. Opening it still fails closed against the checkpoint; a
published file is not proof of a current restore. Cooperative operator quiescence
and restore validation are required. True disk/power loss and storage/VFS behavior
were not fault-injected; local plaintext key files are not encrypted custody.

Next: review HTTP personal-TEST enrollment/session/CSRF/rate/storage boundaries
and decide the narrow TEST interface; obtain two suitable current personal test
certificates for actual same-profile renewal/NCALayer UAT. Production key custody,
independent full-volume anti-rollback, official rules/provenance, corporate powers,
wallets, signed deals, payments and devnet remain separate closed gates.
