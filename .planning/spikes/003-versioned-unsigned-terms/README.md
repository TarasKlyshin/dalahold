---
spike: 003
name: versioned-unsigned-terms
type: standard
validates: "Given a saved unsigned draft, when terms change, then old versions remain visible after restart and a stale editor cannot overwrite the current version"
verdict: VALIDATED
related: [002]
tags: [web, sqlite, versions, conflict]
---

# Spike 003: Versioned unsigned terms

The local web cabinet now creates a new SQLite revision when a saved draft's
scenario, quantity, amount or date changes. The API requires an expected
version; an outdated tab receives HTTP 409 and cannot silently overwrite newer
terms. An unchanged submission is idempotent. Existing pre-version drafts are
migrated to version 1 without deleting their terms. The browser shows current
and prior versions and resets transient demo steps when a revision is opened.

## Evidence

- `node --test web/server.test.mjs` covers create, update, stale and malformed
  writes, history across restart, and migration of an existing database.
- Browser QA on `http://127.0.0.1:4174/` created an anonymized v1 draft,
  changed its quantity and amount to v2, and saw both versions after reload.
  A second tab created v3 while the first held v2; the stale save was rejected
  with an actionable message. The history area was visually inspected at the
  normal desktop viewport and at 390×844, with no clipping observed.

## Boundary

Versions are **unsigned, unauthenticated local drafts**. The loopback API is
not a shared multi-user service. Neither version is an agreed contract; the
buyer/seller labels, route steps, file labels and payments remain simulations.
No NCA SDK, verified powers, private document storage, Solana broadcast, or
real KZT integration is established by this spike.
