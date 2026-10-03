# Spike 026: reproducible anonymous unsigned TEST demo

This slice prepares a fresh, local unsigned participant TEST fixture through
the existing HTTP API. It is backend preparation and evidence verification
only. Browser interaction, browser permission, NCALayer, certificate inventory,
identity, authority, payment and Solana acceptance remain separate gates; a
successful CLI run does not claim browser UAT.

## One-command preparation

From `Solana/DalaHold`:

```sh
node web/participant-demo.mjs
```

The default uses a fresh random `.local/participant-demo-*` directory and the
intended unsigned loopback port `4177`. A custom target must not already exist:

```sh
node web/participant-demo.mjs \
  --run-dir "$PWD/.local/participant-demo-my-run" \
  --port 4177
```

Preparation creates two separate anonymous capability accounts, then uses the
real unsigned participant API to produce:

- one accepted deal at terms version 2, with exact version-1/version-2 text
  documents and one role-separated unsigned TEST review from each side;
- one separate disputed deal at version 1, with no reviews;
- raw full API evidence responses for both deals, verified offline with
  `verifyParticipantEvidence` and checked to contain zero signed receipts;
- a safe `run-report.json` containing only anonymous IDs, states, versions,
  counts, review role/score summaries, artifact hashes and limitations;
- `operator-access.json` at `0600`, containing only the two local random
  account bearer codes. Invitation codes, session cookies and CSRF tokens stay
  in memory and are never written to this file, stdout, errors, report or
  evidence.

The default command prepares and verifies the fixture, then closes the
listener. The explicit serving mode keeps the fresh runtime open until
SIGINT/SIGTERM:

```sh
node web/participant-demo.mjs \
  --run-dir "$PWD/.local/participant-demo-serving" \
  --port 4177 \
  --serve
```

`--port 0` is useful only for disposable automated fixtures. An occupied port
fails with a sanitized error; the command never kills, replaces or resumes an
existing listener.

## Fresh-target and failure boundary

The run directory and nested runtime are owner-only (`0700`); the runtime
database is created by the reviewed isolated runtime at `0600`. The report and
raw evidence artifacts contain no bearer/session data and are written without
group/world write or execute permission. Existing run targets are refused
before any write. Parents must already exist and be owner-controlled/non-group-
writable; no broad recursive directory creation is used.

Failures do not auto-delete directories or files. A port conflict or later
verification failure may leave a private runtime/database residue for explicit
owner inspection. Existing target data and unrelated retained participant
cabinet, signed cabinet, registry, checkpoint and certificate state are never
opened, copied, seeded or migrated.

The demo selects only unsigned runtime/API/evidence execution. The shared
runtime module contains a separate explicit signed branch, but this demo never
selects it or supplies SDK/signer inputs. It does not fabricate signer
identities, CMS, receipts or Solana transactions.

## CLI contract

```text
node web/participant-demo.mjs [--run-dir PATH] [--port 4177|0] [--serve]
```

`prepareParticipantDemo({ runDirectory?, port?, now? })` is the programmatic
entry point used by the focused tests. Its input must be an exact plain-data
object with only those three own data properties (no accessors, proxies,
symbols or CLI-only flags); validation happens before disk/network access. It
returns the fresh directory paths, safe report, live stand and an explicit
`close()` function. `parseDemoArgs` exposes the separate CLI contract; `serve`
and `help` are handled by the CLI and are never passed to the preparation API.

Focused verification:

```sh
node --test --test-reporter=spec web/participant-demo.test.mjs
```

The tests exercise fresh artifact modes, accepted/disputed/version/document/
review/evidence correctness, exact document bytes, idempotent action retry,
strict request rejection, disputed-review refusal, target overwrite refusal,
occupied-port safe residue, sanitized output, explicit serve lifecycle and
absence of signed receipts or auth leakage.
