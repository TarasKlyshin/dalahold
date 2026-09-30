# Local stand recovery: SQLite WAL crash, 30 September 2026

Baseline: clean `main` at `9174914f3114ba284058696a9f8eb1269f78618c`.
The reported text, `Локальный сервер недоступен. При повторной отправке результат
будет получен только один раз.`, comes from the original `/` signature-probe
client, not the new personal enrollment controller. It means fetch failed, not
that a certificate/password was rejected or a request was necessarily consumed.

## Observed cause and limits

Port 4175 had no listener and prior PID 81836 was gone. Its execution session
returned exit code 138. The matching macOS crash report
`node-2026-09-30-192238.ips` identifies PID 81836, capture time
`2026-09-30 19:22:37 +0500`, `SIGBUS / EXC_BAD_ACCESS / KERN_MEMORY_ERROR`.
The faulting frames begin with `walIndexTryHdr`, `walIndexReadHdr`,
`walTryBeginRead`, then SQLite transaction/statement execution in Node.
Runtime is Node v22.22.2 on Darwin; `/Volumes/dev` is an external USB APFS volume.
The fault is confirmed in SQLite's mapped WAL-index path. The underlying reason
that this memory mapping became unavailable is **not established**; no hardware,
USB, OS or general Node defect is asserted, and no volume repair/reformat was done.

SQLite documents that the WAL index uses a memory-mapped ordinary file:
[WAL shared-memory implementation](https://sqlite.org/wal.html#implementation_of_shared_memory_for_the_wal_index).
The WAL belongs to the database's persistent state and must not be manually
discarded to make a damaged database open:
[WAL file handling](https://sqlite.org/wal.html#the_wal_file).

## Scoped mitigation and data preservation

- No process held the original DB/WAL/SHM when the pre-change capture was made.
  Protected `.local/nca-wal-crash-recovery-nXHCxk` preserves all three original
  files: DB 12288 bytes, WAL 0 bytes, SHM 32768 bytes. Directory 0700, files 0600,
  synchronized before recovery. No manually deleted WAL, reset or old-DB restore.
- An isolated temporary copy of DB+WAL passed SQLite recovery, conversion and
  `quick_check`. It contained two request rows and one receipt. The prior manual
  receipt ID/hash/time matches the existing evidence. The forensic capture stays
  untouched; the temporary check copy is not an authorized concurrent writer.
- The small loopback signature-probe store now uses `journal_mode=DELETE`,
  `synchronous=FULL`, `mmap_size=0`, and a 5-second busy timeout. Startup checks
  these settings and refuses if they were not applied. Setup failure closes the
  database. SQLite itself converts/reconciles an existing WAL; the application
  never unlinks journal files. The personal registry/checkpoint policy remains
  separate and unchanged. No account access, money, wallet or devnet is enabled.
- Opt-in process PID **89225**, started **19:33:08 Asia/Almaty**, listens only on
  `127.0.0.1:4175`. After conversion, all rows match the recovered capture's
  canonical digest `f66e39043d84322b5073489b56945d6c9995fa70f89a0bb77b8b1850b15ae4a3`;
  integrity is `ok`, journal mode `delete`, two rows / one receipt unchanged.
  The only unconsumed old request expired at `2026-09-30T09:32:13.394Z`; it cannot
  be used for a new signature. Personal registry remains revision0, zero bindings
  and intents. No new receipt is claimed from this recovery.

## Verification and next action

Two failing-before/passing-after regression tests prove the selected storage
policy and nonempty legacy-WAL recovery. The latter preserves a committed,
uncheckpointed receipt-JSON change from DB+WAL and returns the same historical
receipt without SDK re-verification. These tests do **not** reproduce the native
SIGBUS or prove physical storage fault tolerance.

Current gates pass: **161 Node + 7 offline Solana**, plus **four SDK runs**, no
failures or skips. SDK HTTP/genuine negatives run in isolated registries. The
new two storage regressions were rerun after strengthening WAL-frame coverage.
The mitigation removes the observed WAL shared-memory path; it is not proof that
the external storage can no longer fail or that production storage is accepted.

Browser QA attempted the existing tab, but the same mandatory admin-policy
verification failure blocked access. No bypass or substitute browser transport,
live API/body interaction, screenshot, user signing or full UI acceptance is
claimed. Listener and persisted-state checks are not a substitute for UI UAT.

For the personal enrollment step, open `/personal/`, wait for readiness, create a
NEW exact intention, then sign with the bundled personal TEST signing container.
Enter its password only in NCALayer; corporate employee certificates remain
ineligible for personal enrollment. For an already received signature on the
original probe page, identical retry in that same tab may retrieve a saved
receipt; it does not guarantee a fresh successful check. An expired unconsumed
request requires a new request and signature.

The human subsequently completed the narrow personal enrollment/retry/close
sequence. Current registry/checkpoint and protected pair are now revision2 with
one binding/receipt; this recovery-time revision0 snapshot is historical. See
the [manual UAT checkpoint](UAT.md) for exact evidence sources and the new backup.
