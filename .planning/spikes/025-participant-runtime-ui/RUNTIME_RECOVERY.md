# Spike 025 runtime and recovery boundary

This note covers only the current-code local participant TEST runtime. It is
not browser acceptance, NCALayer acceptance, a production deployment, a
certificate registry, a wallet, a Solana transaction or a payment rail.

## Fresh unsigned runtime

The launcher defaults to a new ignored directory and to loopback port 4177:

```sh
DALAHOLD_PARTICIPANT_RUNTIME_MODE=unsigned \
DALAHOLD_PARTICIPANT_RUNTIME_DIR="$PWD/.local/participant-runtime" \
DALAHOLD_PARTICIPANT_RUNTIME_PORT=4177 \
node web/participant-runtime.mjs
```

The directory is owner-only (`0700`) and its `participants.sqlite` is
owner-only (`0600`). The launcher prints only the loopback URL. Access codes
are returned by the existing registration API and must stay in the operator's
private session; they are not written to stdout, manifests or evidence
exports.

The runtime refuses the retained
`.local/participant-test-cabinet`,
`.local/signed-participant-test-cabinet`, and personal binding/checkpoint
spellings before opening a database. It does not copy or migrate any retained
rows. The default runtime's SQLite kind is
`dalahold.local-test-participants.v1`.

The operator must confirm that 4177 is free before launching the command. The
runtime module does not kill or replace another process. The existing browser
and UI remain outside this slice.

## Explicit signed opt-in

Signed mode is a separate path and requires the official TEST OCSP SDK:

```sh
DALAHOLD_PARTICIPANT_RUNTIME_MODE=signed \
DALAHOLD_PARTICIPANT_RUNTIME_DIR="$PWD/.local/participant-runtime-signed" \
DALAHOLD_PARTICIPANT_RUNTIME_PORT=4178 \
NCA_SDK_ROOT='/path/to/official/SDK' \
node web/participant-runtime.mjs
```

There is no SDK fallback. Omitting `NCA_SDK_ROOT` fails before a directory is
created; unsigned mode ignores SDK environment variables and rejects an
in-process SDK argument. Signed storage uses the existing incompatible kind
`dalahold.local-test-participants.v1.personal-test-signed`, so a signed DB
cannot be opened as unsigned or vice versa. The signed path remains a
personal TEST stand; it is not a second real person, production identity or
certificate-replacement flow.

## Stopped-stand snapshot and restore

`snapshotParticipantRuntime` and `restoreParticipantRuntime` are intentionally
unsigned-only owner procedures. Stop the launcher and wait for its close to
finish before taking a snapshot:

```js
import { snapshotParticipantRuntime, restoreParticipantRuntime } from './web/participant-runtime.mjs';

snapshotParticipantRuntime({
  directory: '/absolute/path/to/.local/participant-runtime',
  backupDirectory: '/absolute/path/to/new-owner-backup',
});

restoreParticipantRuntime({
  backupDirectory: '/absolute/path/to/new-owner-backup',
  directory: '/absolute/path/to/new-restored-runtime',
});
```

The snapshot destination must be new, owner-controlled and `0700`; its
database and manifest are `0600`. The manifest records only the unsigned kind,
bounded byte count, SHA-256, empty sidecar list and capture time. Restore
validates the manifest, digest, SQLite integrity and kind before copying. An
existing destination or backup is refused; no overwrite is attempted.

The launcher creates an owner-only active marker. Snapshot takes the same
exclusive marker lease for the complete integrity check and bounded byte
capture, so a concurrent launcher start is refused and cannot race the copy. A
stale marker after an unclean kill is a safe refusal that requires operator
inspection; it is not silently removed. SQLite `-wal`, `-shm` and `-journal`
sidecars also refuse the operation. A raw copy of an active database is not a
valid backup. This exclusion only covers stands using this launcher: a caller
that opens `startParticipantWorkspace` directly has no marker, so the operator
must not snapshot such a process.

All overlap checks use canonical existing ancestors plus the non-existing
suffix. Safe `/tmp` and `/var` aliases remain usable, while an ancestor alias
that would place a restore inside its own backup is rejected before any write.
Post-copy validation reads the copied bytes back and compares their digest.
Failed startup, snapshot and restore operations never unlink a copied data
artifact or remove a directory by pathname. An identity check immediately
before `unlink`/`rmdir` still has a same-UID TOCTOU window, so private
operation-created files and directories are intentionally left as recoverable
residue for owner inspection and explicit remediation. A replacement or
unrelated file is therefore never silently deleted.

Signed backup/restore is deliberately not exposed by this helper. A valid
signed backup must preserve its mapping key and every keyed MAC as separate
protected owner material alongside the database; copying only the active
SQLite file is insufficient. That separate key/MAC contract is outside this
runtime slice, so the helper fails closed with
`runtime_signed_backup_requires_key_material` or
`runtime_signed_restore_requires_key_material`.

## Verification

The focused runtime suite uses fresh disposable directories and ephemeral
ports. It performs a real listener shutdown/restart and checks that fresh
accounts (via their privately held codes), one deal, exact text bytes, both
role reviews and the member-only evidence export survive. It then snapshots a
stopped unsigned stand, restores it into a new owner-only directory and
repeats login, document download, reviews and evidence readback.

The same suite checks signed/unsigned kind refusal, explicit SDK-only signed
startup, missing-SDK no-create behavior, active/symlink/private-mode/sidecar
boundaries and backup/destination overwrite refusal. The model SDK used in
the test file is an in-process test double only; the runnable signed command
requires the official SDK and has no model fallback.

Focused command:

```sh
node --test --test-reporter=spec web/participant-runtime.test.mjs
```

This is backend/local verification only. It does not claim browser interaction,
NCALayer use, genuine two-person signing, current certificate inventory,
devnet execution or production recovery.
