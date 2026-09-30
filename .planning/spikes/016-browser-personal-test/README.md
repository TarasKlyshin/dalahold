---
spike: 016
name: browser-personal-test
type: standard
verdict: PARTIAL
related: [012, 014, 015]
tags: [web, ncalayer, enrollment, session, csrf, test-only]
---

# Spike 016: narrow browser personal TEST enrollment

Baseline `main`: `0a0c86bae2ba70fefedffb82d086f24421e5f30a`, clean.
Approved next local step: a browser/NCALayer interface to the existing personal
TEST binding library. This is enrollment evidence, **not login or a business grant**.

## Scope and acceptance

- Separate `/personal/` page on the existing loopback stand. Explicit operator
  opt-in to an EXISTING private registry and retained checkpoint; no automatic
  key/root provisioning, no binding of historical signature-probe receipts.
- Separate server-issued, bounded, expiring HTTP-only/SameSite=Strict TEST session
  and CSRF token. Exact Host/Origin/Fetch-Metadata checks, strict bounded JSON/CMS,
  per-session/global request limits and shared verifier concurrency ceiling.
- Only `enroll_test_person` can be issued through this first HTTP slice. Exact
  server intent, five-minute expiry, fresh TEST OCSP personal CMS, atomic retained
  checkpoint and one-use/history semantics remain enforced. Session expiry or
  logout during verification must refuse before the binding/checkpoint commit.
- Unknown/forged/foreign sessions, wrong/missing CSRF, corporate/revoked/wrong-
  purpose evidence, altered bytes, replay conflicts, stale registry, expiry,
  verifier failure and exhausted limits refuse without minting identity access.
- UI: exact bytes/hash/expiry, NCALayer connectivity and cancel handling, create/
  sign/submit/history retry, explicit session close. Password/key stays in
  NCALayer; CMS/CSRF stay in browser memory, never logs/export/localStorage.
- Real browser interaction, semantic inspection, desktop/mobile smoke, keyboard
  and accessibility checks. Automated HTTP with bundled SDK personal CMS can
  prove integration, but a manual NCALayer signing UAT is a separate acceptance.

## Contract

- `GET /api/personal-test/status`: requires the server-issued personal TEST
  session from `/personal/`; returns scope, readiness, TEST chain, CSRF token and
  session expiry. No personal subject/organization, mapping key or business grant.
- `POST /api/personal-test/intents`: JSON `{action:"enroll_test_person"}` plus
  `X-DalaHold-CSRF`; 201 `{intent:{id,text,bytesBase64,hash,expiresAt}}`.
- `POST /api/personal-test/receipts`: JSON `{intentId,cms}` plus CSRF; 200
  `{receipt,historical}`. Receipt is strictly TEST binding evidence; historical
  repeats do not mint a fresh status receipt or grant access. An already stored
  identical retry skips SDK verification; parallel pending submissions may each
  verify, but only one can commit and the loser returns the original receipt.
- `POST /api/personal-test/session/close`: empty JSON plus CSRF; invalidate server
  session/cookie. Pending signatures cannot commit after this boundary.
- Disabled mode: personal API refuses; the existing signature-only probe remains
  independent. No replacement endpoint, wallet, corporate powers, deal or money.

## Implemented local slice

- `nca/personal-http.mjs` owns a separate server-generated TEST session/CSRF,
  fixed 15-minute TTL, bounded records/requests and whitelisted responses.
  Defaults stay closed; the page cannot choose its own session, key, subject,
  directory, binding or business grant. Both existing registry/checkpoint paths
  and explicit TEST OCSP are required by the CLI operator.
- The HTTP handler rechecks the session after a body read and SDK await.
  The storage layer repeats the trusted guard inside the joint transaction,
  including after checkpoint hashing, so closure/expiry can still roll back both
  databases. Readiness refuses a stale registry instead of silently replacing it.
- The existing two-slot SDK ceiling is shared with the signature probe. Bodies
  are capped at 140000 bytes, CMS at 98304 bytes; unfinished requests have a
  15-second total body deadline. Headers/request timeouts are also configured
  to 15 seconds.
  Session close bypasses rate limiting. Disconnected verification drains before
  storage/SDK cleanup; an invalidated session cannot commit while draining.
- `/personal/`, `personal-client.mjs` and `personal.css` display and validate the
  exact canonical text/base64/hash/expiry, use shared NCALayer helpers, distinguish
  fresh vs saved evidence, clear local state on expiry/close and ignore late
  responses. A failed close explicitly leaves server closure unconfirmed, with
  retry. Semantic headings/labels, skip link, focus targets and mobile CSS are
  prepared; their real-browser acceptance is still open.
- Persistent intent history is capped at 1000 without purging or checkpoint
  reset. Parallel pending duplicates may spend two SDK slots but cannot produce
  two binding writes/receipts. No fresh-status claim is made for the saved receipt.

## Verification, 30 September 2026

- **159 Node tests + 7 offline Solana tests**, no failures or skips. This includes
  13 personal HTTP cases, 18 new frontend cases, 39 storage cases (two new guards/
  ceiling cases), and the unchanged signature-probe regressions.
- **Four SDK runs** pass: default incompatible-CRL refusal; 47 strict synthetic/
  transport OCSP assertions; 30 subject-parser checks plus genuine personal
  library/HTTP enrollment; explicit TEST OCSP signature-probe integration.
  Genuine bundled corporate/revoked/wrong-purpose/altered CMS all refuse through
  personal HTTP. A genuine bundled personal CMS produces one receipt; identical
  stored retry returns it; closed-session retry refuses. Those HTTP runs use
  isolated temporary registries, not the operator's retained personal registry.
- Narrow internal read-only review found no blocking P0/P1 in the reviewed
  session/transaction/checkpoint path. Its slow-body and post-body session-check
  P2 findings were addressed with a bounded body deadline and recheck, with a
  shutdown regression. Duplicate SDK work for parallel pending submissions
  remains an explicit efficiency limitation. This is not a full independent
  production security review or a confirmed Claude review.
  Follow-up static review of the timeout/recheck/drain changes found no blocker.
  Graceful process shutdown is not an immediate session-close barrier: an
  already connected body-complete SDK request may finish before the server's
  `close` event invalidates sessions. Explicit HTTP session close remains the
  tested immediate invalidation boundary. The drain regression covers a
  disconnected request, not an assertion that SIGTERM cancels every commit.
- After a protected signature-database backup, exact old PID `27184` (verified
  repository cwd/listener) was stopped normally. New opt-in PID **81836** started
  at **18:57:01 Asia/Almaty**, bound only to `127.0.0.1:4175`, with the existing
  private registry and retained checkpoint. No remote deployment or push.
- Backup `.local/nca-before-personal-browser-5PtzOd/nca-test.sqlite` passed
  integrity/readback. The prior supervised signature-only receipt
  `290ec6f5-7b71-4633-8ac4-b7f4f2f74517`, its challenge bytes hash and original
  verification time match that backup after restart. No prior receipt was
  upgraded to identity evidence.
- Operator registry and retained checkpoint remain at **revision 0**:
  **0 bindings, 0 intents, 0 receipts**. Original mapping key matches the
  protected current pair. Live/current-pair availability checks pass; preserved
  initial legacy backup refuses. Current revision-0 backup remains applicable
  because browser navigation did not issue an intent. No personal key/password
  or raw subject values were printed, committed or entered by the agent.
- **Browser QA blocked, not passed.** Reload of the existing signature page
  showed the new link; actual click opened `/personal/` with correct title,
  purpose, TEST-container instructions and initially disabled controls. The next
  observation and one later retry were refused because the browser service could
  not verify its mandatory admin access policy. No policy bypass, alternative
  browser transport, screenshot or responsive/keyboard success is claimed.
  Creation/NCALayer/close interaction and settled readiness remain unverified in
  the real browser. The user-owned tab remains on the personal page.

## Next manual acceptance

The earlier PID 81836 later crashed in SQLite WAL shared memory. The loopback
store has been recovered with preserved rows and rollback journaling; current
counts are 161 Node + 7 offline Solana and four SDK runs. See the separate
[recovery record](RECOVERY.md) for the crash evidence, current listener and limits.

1. After browser access recovers, reload `/personal/`, confirm settled TEST
   readiness and connectivity, create an exact intention and inspect text/hash/
   expiry. Check desktop/mobile overflow, keyboard navigation/focus and console.
2. The human selects the bundled **Физическое лицо / signing TEST P12** and enters
   its password only inside NCALayer. Observe a fresh personal TEST receipt, then
   identical retry returning the same historical receipt. A corporate employee
   certificate is intentionally not eligible for this narrow personal path.
3. Close the TEST session; confirm cleared evidence, no late restoration and old
   pending submission refusal. Take a NEW protected registry backup matching the
   advanced retained checkpoint. Do not restore the revision-0 checkpoint/pair
   after a state change just to make it available again.

## Remaining gates

Encrypted production key custody, full-host rollback, storage physical-fault
acceptance, official rules/provenance and complete independent review remain open.
Positive genuine personal renewal still needs an eligible same-person certificate
pair; this step does not resolve that missing material or add production auth.
